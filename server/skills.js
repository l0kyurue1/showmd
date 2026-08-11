'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { relPosix, isDirSync, walkMd, walkFiles } = require('./documents.js');
const { createTreeCache } = require('./tree-cache.js');

// hashes every file under a directory into one digest, so two same-name skills
// in one project (e.g. independent .agents/skills/X and .claude/skills/X
// copies) can be compared for identical content; only run on a name collision,
// so a full recursive read is cheap. includeHidden: a dotfile is real content
// here — skipping it would call two dirs identical when only one carries it
async function hashDir(dirAbs) {
  const files = await walkFiles(dirAbs, dirAbs, [], { includeHidden: true });
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const relPath of files) {
    hash.update(relPath);
    hash.update(await fsp.readFile(path.join(dirAbs, relPath)));
  }
  return hash.digest('hex');
}

function isDir(p) {
  return isDirSync(p);
}

function findPluginSkillDirs(pluginsDir, levelsLeft = 3) {
  const found = [];
  function walk(dir, remaining) {
    if (remaining < 1) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'skills') found.push(full);
      else walk(full, remaining - 1);
    }
  }
  walk(pluginsDir, levelsLeft);
  return found;
}

// scanned before "claude project" so the canonical .agents/skills store wins
// realpath dedupe over its .claude/skills symlink within Project scope
function projectSkillCandidates(dir) {
  return [
    { dir: path.join(dir, '.agents', 'skills'), label: 'project agents', project: dir },
    { dir: path.join(dir, '.claude', 'skills'), label: 'claude project', project: dir },
  ];
}

function discoverProjectRoots(projectDir) {
  const dir = path.resolve(projectDir);
  return projectSkillCandidates(dir).filter((c) => isDir(c.dir));
}

function isSkillsProjectDir(dir) {
  return isDir(path.join(dir, '.agents', 'skills')) || isDir(path.join(dir, '.claude', 'skills'));
}

function discoverGlobalRoots({ home = os.homedir() } = {}) {
  const candidates = [
    { dir: path.join(home, '.claude', 'skills'), label: 'claude user' },
    { dir: path.join(home, '.codex', 'skills'), label: 'codex' },
    { dir: path.join(home, '.agents', 'skills'), label: 'agents' },
  ];
  for (const dir of findPluginSkillDirs(path.join(home, '.claude', 'plugins'))) {
    candidates.push({ dir, label: `plugin: ${path.basename(path.dirname(dir))}` });
  }
  return candidates.filter((c) => isDir(c.dir));
}

// ~/.claude.json's top-level `projects` map is Claude Code's own record of
// every directory it has been run in; large file, read once
function harvestClaudeJsonProjects(claudeJsonPath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  } catch {
    return [];
  }
  const projects = data && typeof data === 'object' ? data.projects : null;
  if (!projects || typeof projects !== 'object') return [];
  return Object.keys(projects).filter((p) => path.isAbsolute(p));
}

// one readdir per unique parent dir of a harvested path — catches sibling
// projects Claude Code was never run in directly, no recursive walk
function siblingProjectDirs(paths) {
  const parents = new Set(paths.map((p) => path.dirname(p)));
  const found = [];
  for (const parent of parents) {
    let entries;
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = path.join(parent, entry.name);
      if (isSkillsProjectDir(child)) found.push(child);
    }
  }
  return found;
}

function discoverProjectDirs({ home = os.homedir(), claudeJsonPath = path.join(home, '.claude.json') } = {}) {
  const harvested = harvestClaudeJsonProjects(claudeJsonPath);
  const candidates = new Set([...harvested, ...siblingProjectDirs(harvested)]);
  const seenReal = new Set();
  const result = [];
  for (const dir of candidates) {
    if (!isSkillsProjectDir(dir)) continue;
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    result.push(real);
  }
  return result.sort();
}

function readLockSources(baseDir) {
  const lockPath = path.join(baseDir, '.agents', '.skill-lock.json');
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const sources = new Map();
    for (const [name, info] of Object.entries(data.skills || {})) {
      if (info && typeof info.source === 'string') {
        sources.set(name, { source: info.source, sourceUrl: info.sourceUrl, sourceType: info.sourceType, installedAt: info.installedAt, updatedAt: info.updatedAt });
      }
    }
    return sources;
  } catch {
    return new Map();
  }
}

function isPluginLabel(label) {
  return typeof label === 'string' && label.startsWith('plugin: ');
}

const AGENT_REGISTRY = require('./agent-registry.js');

function detectedAgents(home, cwd) {
  return AGENT_REGISTRY.filter((a) => a.detect(home, cwd));
}

// realpath -> registry keys of every detected agent's own dir whose entry
// resolves there; realpaths are cached per raw path since a dir can list
// many entries
function scanAgentBadges(home, cwd, detected) {
  const cache = new Map();
  const byRealpath = new Map();
  for (const agent of detected) {
    if (!agent.globalDir) continue;
    let dir, entries;
    try {
      dir = agent.globalDir(home);
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      let real = cache.get(full);
      if (real === undefined) {
        try {
          real = fs.realpathSync(full);
        } catch {
          real = null;
        }
        cache.set(full, real);
      }
      if (!real) continue;
      if (!byRealpath.has(real)) byRealpath.set(real, new Set());
      byRealpath.get(real).add(agent.name);
    }
  }
  return byRealpath;
}

function badgesFor(agentKeys) {
  return AGENT_REGISTRY.filter((a) => agentKeys.has(a.name)).map((a) => a.displayName);
}

function scopeForLabel(label) {
  return label === 'claude project' || label === 'project agents' ? 'Project' : 'Global';
}

function groupForEntry(label, name, lockSources) {
  if (label === 'agents') return lockSources.get(name)?.source || 'local';
  if (isPluginLabel(label)) return label;
  return 'local';
}

function normalizeGitUrl(raw) {
  let u = raw.trim();
  if (u.startsWith('git@github.com:')) u = 'https://github.com/' + u.slice('git@github.com:'.length);
  return u.replace(/\.git$/, '');
}

// plain-text parse of the marketplace clone's git config — no git spawn
function readMarketplaceOrigin(marketplaceName, home) {
  const configPath = path.join(home, '.claude', 'plugins', 'marketplaces', marketplaceName, '.git', 'config');
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const line of text.split('\n')) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section) { inOrigin = section[1].trim() === 'remote "origin"'; continue; }
    if (!inOrigin) continue;
    const m = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (m) {
      const sourceUrl = normalizeGitUrl(m[1]);
      return { sourceUrl, source: sourceUrl.replace(/^https?:\/\/[^/]+\//, '') };
    }
  }
  return null;
}

function resolveInstall(entry, home) {
  if (entry.creatorLabel === 'agents' || entry.creatorLabel === 'project agents') {
    if (entry.lock) {
      return {
        install: entry.lock.sourceType === 'github' ? 'npx skills' : 'npx skills (local path)',
        source: entry.lock.source,
        sourceUrl: entry.lock.sourceUrl,
        installedAt: entry.lock.installedAt,
        updatedAt: entry.lock.updatedAt,
      };
    }
    if (entry.creatorLabel === 'agents') return { install: 'manual', source: 'local' };
    return { install: 'manual' };
  }
  if (entry.pluginMarketplace) {
    const install = `Claude plugin: ${entry.pluginMarketplace}`;
    const origin = readMarketplaceOrigin(entry.pluginMarketplace, home);
    return origin ? { install, ...origin } : { install, source: `plugin: ${entry.pluginMarketplace}` };
  }
  return { install: 'manual' };
}

// a "skill" is an immediate child directory of a skill root that contains
// SKILL.md directly at its top; symlinked children (e.g. ~/.claude/skills/*
// -> ~/.agents/skills/*) resolve the same way isDir() does elsewhere here
function scanSkillDirs(rootList) {
  const found = [];
  for (const r of rootList) {
    let entries;
    try {
      entries = fs.readdirSync(r.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDirAbs = path.join(r.dir, entry.name);
      if (!isDir(skillDirAbs)) continue;
      if (!fs.existsSync(path.join(skillDirAbs, 'SKILL.md'))) continue;
      let real;
      try {
        real = fs.realpathSync(skillDirAbs);
      } catch {
        continue;
      }
      found.push({ real, name: entry.name, label: r.label, key: r.key ?? r.label, rootDir: r.dir, skillDirAbs, project: r.project });
    }
  }
  return found;
}

// `walkMd` is injected so server.js stays the single recursive-.md-walk
// implementation. `cwd` is machine scope for agent detection, not per-root —
// no default, an implicit one silently made tests and the server probe
// different directories.
/**
 * @param {import('../types/showmd').SkillRoot[]} roots
 * @param {import('../types/showmd').SkillsTreeOptions} opts
 */
async function buildSkillsTree(roots, { walkMd, home = os.homedir(), cwd, mode = 'all' }) {
  const lockSources = readLockSources(home);
  const projectLockCache = new Map();
  function projectLockSourcesFor(dir) {
    if (!projectLockCache.has(dir)) projectLockCache.set(dir, readLockSources(dir));
    return projectLockCache.get(dir);
  }
  const globalRoots = roots
    .filter((r) => scopeForLabel(r.label) === 'Global')
    .sort((a, b) => (a.label === 'agents' ? 0 : 1) - (b.label === 'agents' ? 0 : 1));
  const projectRoots = roots.filter((r) => scopeForLabel(r.label) === 'Project');

  const detected = detectedAgents(home, cwd);
  // an agent with no globalDir (e.g. PromptScript) is excluded from the
  // Global canonical-store short-circuit, mirroring npx's own gate; project
  // scope has no such field to be missing, so no exclusion there
  const universalKeysGlobal = new Set(detected.filter((a) => a.universal && a.globalDir).map((a) => a.name));
  const universalKeysProject = new Set(detected.filter((a) => a.universal).map((a) => a.name));
  const agentBadges = scanAgentBadges(home, cwd, detected);
  const byRealpath = new Map();
  for (const found of scanSkillDirs(globalRoots)) {
    let entry = byRealpath.get(found.real);
    if (!entry) {
      entry = {
        scope: 'Global',
        name: found.name,
        group: groupForEntry(found.label, found.name, lockSources),
        creatorLabel: found.label,
        lock: found.label === 'agents' ? lockSources.get(found.name) : undefined,
        key: found.key,
        rootDir: found.rootDir,
        skillDirAbs: found.skillDirAbs,
        real: found.real,
        pluginMarketplace: null,
      };
      byRealpath.set(found.real, entry);
    }
    if (isPluginLabel(found.label)) entry.pluginMarketplace = found.label.slice('plugin: '.length);
  }
  function projectEntry(found, extra) {
    const projectDir = found.project || cwd;
    return {
      scope: 'Project',
      name: found.name,
      group: path.basename(projectDir),
      creatorLabel: found.label,
      lock: found.label === 'project agents' ? projectLockSourcesFor(projectDir).get(found.name) : undefined,
      key: found.key,
      rootDir: found.rootDir,
      skillDirAbs: found.skillDirAbs,
      real: found.real,
      pluginMarketplace: isPluginLabel(found.label) ? found.label.slice('plugin: '.length) : null,
      ...extra,
    };
  }
  function projectDisplayPath(found) {
    return relPosix(found.project || cwd, found.skillDirAbs);
  }
  const projectFound = scanSkillDirs(projectRoots).filter((found) => !byRealpath.has(found.real));
  // group by (project, skill name) to catch a skill installed independently
  // in both .agents/skills and .claude/skills — different realpaths, so the
  // dedupe above keeps both; each project only ever contributes those two
  // candidate dirs, so a collision group is never bigger than 2
  const byProjectName = new Map(); // project dir -> skill name -> found[]
  for (const found of projectFound) {
    const projectDir = found.project || cwd;
    if (!byProjectName.has(projectDir)) byProjectName.set(projectDir, new Map());
    const byName = byProjectName.get(projectDir);
    if (!byName.has(found.name)) byName.set(found.name, []);
    byName.get(found.name).push(found);
  }
  const collisionGroups = [...byProjectName.values()].flatMap((byName) => [...byName.values()]);
  for (const group of collisionGroups) {
    const agentsCopy = group.find((f) => f.label === 'project agents');
    const claudeCopy = group.find((f) => f.label === 'claude project');
    if (group.length !== 2 || !agentsCopy || !claudeCopy) {
      for (const found of group) byRealpath.set(found.real, projectEntry(found));
      continue;
    }
    const [agentsHash, claudeHash] = await Promise.all([
      hashDir(agentsCopy.skillDirAbs),
      hashDir(claudeCopy.skillDirAbs),
    ]);
    if (agentsHash === claudeHash) {
      byRealpath.set(agentsCopy.real, projectEntry(agentsCopy, {
        copies: 2,
        copyPaths: [projectDisplayPath(agentsCopy), projectDisplayPath(claudeCopy)],
      }));
    } else {
      byRealpath.set(agentsCopy.real, projectEntry(agentsCopy, { origin: 'agents' }));
      byRealpath.set(claudeCopy.real, projectEntry(claudeCopy, { origin: 'claude' }));
    }
  }

  const entries = [...byRealpath.values()];
  const fileLists = await Promise.all(entries.map((e) => walkMd(e.skillDirAbs, e.skillDirAbs, [])));
  const scopeMap = new Map();
  for (const [i, entry] of entries.entries()) {
    const prefix = `${entry.key}/${relPosix(entry.rootDir, entry.skillDirAbs)}`;
    const files = fileLists[i]
      .filter((f) => f !== 'SKILL.md')
      .sort()
      .map((f) => ({ id: `${prefix}/${f}`, label: f }));
    // universal agents (Codex, Cursor, Gemini CLI, ...) read the canonical
    // .agents/skills store natively, no symlink needed — see AGENT_REGISTRY
    const badgeKeys = new Set(agentBadges.get(entry.real) || []);
    if (entry.scope === 'Global' && entry.creatorLabel === 'agents') {
      for (const key of universalKeysGlobal) badgeKeys.add(key);
    } else if (entry.scope === 'Project' && entry.creatorLabel === 'project agents') {
      for (const key of universalKeysProject) badgeKeys.add(key);
    }
    const badges = badgesFor(badgeKeys);
    const origin = resolveInstall(entry, home);
    const skill = { id: `${prefix}/SKILL.md`, name: entry.name, badges, files, install: origin.install };
    if (origin.source) skill.source = origin.source;
    if (origin.sourceUrl) skill.sourceUrl = origin.sourceUrl;
    if (origin.installedAt) skill.installedAt = origin.installedAt;
    if (origin.updatedAt) skill.updatedAt = origin.updatedAt;
    if (entry.copies) { skill.copies = entry.copies; skill.copyPaths = entry.copyPaths; }
    if (entry.origin) skill.origin = entry.origin;
    if (!scopeMap.has(entry.scope)) scopeMap.set(entry.scope, new Map());
    const groupMap = scopeMap.get(entry.scope);
    if (!groupMap.has(entry.group)) groupMap.set(entry.group, []);
    groupMap.get(entry.group).push(skill);
  }

  // PROJECT mode puts the given project(s) first (singular "Project", cold-start
  // target); ALL/GLOBAL mode puts Global first ("Projects" plural, all collapsed)
  const order = mode === 'project' ? ['Project', 'Global'] : ['Global', 'Project'];
  const scopes = [];
  for (const name of order) {
    const groupMap = scopeMap.get(name);
    if (!groupMap || groupMap.size === 0) continue;
    // "local" (no lock/plugin source) skills sit directly on the scope, after
    // the sourced groups — no group header/collapse level for them
    const local = (groupMap.get('local') || []).sort((a, b) => a.name.localeCompare(b.name));
    groupMap.delete('local');
    const groups = [...groupMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([source, skills]) => ({ source, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) }));
    const displayName = name === 'Project' && mode !== 'project' ? 'Projects' : name;
    scopes.push({ name: displayName, groups, skills: local });
  }
  return { scopes };
}

// shared by cli.js's dedicated skills mode and the server's Skills space,
// so the composition lives in one place
/** @param {import('../types/showmd').DiscoverRootsOptions} [opts] */
function discoverSkillRoots({ mode = 'all', projectDirs = [], home, claudeJsonPath } = {}) {
  const globalOpts = home !== undefined ? { home } : {};
  const dirsOpts = { ...globalOpts, ...(claudeJsonPath !== undefined ? { claudeJsonPath } : {}) };
  const globalRoots = discoverGlobalRoots(globalOpts);
  const discoveredProjectDirs = mode === 'project' ? projectDirs : mode === 'all' ? discoverProjectDirs(dirsOpts) : [];
  const projectRoots = discoveredProjectDirs.flatMap((d) => discoverProjectRoots(d));
  const found = [...globalRoots, ...projectRoots];
  const seen = new Map();
  return found.map(({ dir, label, project }) => {
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    return { dir, key: n === 1 ? label : `${label} (${n})`, label, project };
  });
}

// doc-mode only: skills for the folder currently open, not a fixed root — a
// root swap (or a watcher-detected skill-file change) invalidates this. Bundles
// a second multi-root doc store over the same skill dirs, since those files
// live outside the served root and the main store can never resolve them.
const treeCache = createTreeCache();

/** @param {import('../types/showmd').TreeCacheOptions} [opts] */
async function getTree(rootDir, opts = {}) {
  return treeCache.getTree(rootDir, async () => {
    const skillRoots = discoverSkillRoots({ mode: 'project', projectDirs: [rootDir] });
    const tree = await buildSkillsTree(skillRoots, { walkMd, home: os.homedir(), cwd: rootDir, mode: 'project' });
    return { tree, roots: skillRoots };
  }, opts);
}

function invalidate() {
  treeCache.invalidate();
}

module.exports = {
  discoverGlobalRoots,
  discoverProjectRoots,
  discoverProjectDirs,
  discoverSkillRoots,
  isSkillsProjectDir,
  buildSkillsTree,
  getTree,
  invalidate,
  // absolute-vs-relative key filtering isn't observable through discoverProjectDirs
  // without cwd trickery; kept here so the test can reach it directly
  __test__: { harvestClaudeJsonProjects },
};
