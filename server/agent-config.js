'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const AGENT_REGISTRY = require('./agent-registry.js');
const { createTreeCache } = require('./tree-cache.js');

function isMd(name) {
  return /\.md$/i.test(name);
}

function listMdFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && isMd(e.name)).map((e) => e.name).sort();
}

// v1 scope: Claude Code and Codex only, the AGENT_REGISTRY entries carrying a
// `key`. Codex's config.toml (and any other non-md file) is intentionally
// skipped — only markdown instructions/memory are browsable here.
const AGENTS = AGENT_REGISTRY.filter((a) => a.key).map((a) => ({
  key: a.key,
  displayName: a.configLabel || a.displayName,
  detect: a.detect,
  instructionsFile: a.instructionsFile,
  rulesDir: a.rulesDir,
  projectsDir: a.projectsDir,
}));

// Claude Code slugs a project by replacing every non-alphanumeric character
// with '-' — one for one, no collapsing, no case folding — then truncating to
// SLUG_MAX with a hash suffix. The hash is not reproducible from outside, so an
// over-long slug is matched on its truncated prefix instead.
const SLUG_MAX = 200;

function projectSlug(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

// Windows preserves the case Claude Code recorded, but the same directory can
// resolve as 'c:\...' or 'C:\...' depending on who asked.
function slugKey(slug) {
  return process.platform === 'win32' ? slug.toLowerCase() : slug;
}

function slugMatchesPath(slug, absPath) {
  const want = slugKey(slug);
  const computed = slugKey(projectSlug(absPath));
  if (computed === want) return true;
  return computed.length > SLUG_MAX && want.startsWith(`${computed.slice(0, SLUG_MAX)}-`);
}

// The slug is lossy, so it is matched against ~/.claude.json's own project list
// (the same harvest skills.js does) to recover the real path where possible,
// falling back to a best-effort slash-split of the slug itself. The visible
// label is always just the directory basename, disambiguated with its parent
// segment on collision (e.g. two checkouts both named "showmd").
function projectLabelsFromSlugs(home, slugs) {
  let claudeJson;
  try {
    claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  } catch {
    claudeJson = null;
  }
  const known = claudeJson && typeof claudeJson.projects === 'object' ? Object.keys(claudeJson.projects) : [];
  const realPaths = new Map(slugs.map((slug) => [
    slug,
    known.find((p) => slugMatchesPath(slug, p)) || slug.replace(/^-/, '').replace(/-/g, '/'),
  ]));
  const basenameCount = new Map();
  for (const real of realPaths.values()) {
    const base = path.basename(real);
    basenameCount.set(base, (basenameCount.get(base) || 0) + 1);
  }
  const labels = new Map();
  for (const [slug, real] of realPaths) {
    const base = path.basename(real);
    const label = basenameCount.get(base) > 1 ? `${path.basename(path.dirname(real))}/${base}` : base;
    labels.set(slug, { label, path: real });
  }
  return labels;
}

function memoryProjects(agent, home, cwd) {
  if (!agent.projectsDir) return [];
  const projectsDir = agent.projectsDir(home);
  let slugs;
  try {
    slugs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const withFiles = slugs
    .map((slug) => ({ slug, dir: path.join(projectsDir, slug, 'memory') }))
    .map((p) => ({ ...p, files: listMdFiles(p.dir) }))
    .filter((p) => p.files.length > 0);
  if (withFiles.length === 0) return [];
  const labels = projectLabelsFromSlugs(home, withFiles.map((p) => p.slug));
  const cwdPath = cwd ? path.resolve(cwd) : null;
  return withFiles
    .map((p) => ({ ...p, ...labels.get(p.slug), current: cwdPath ? slugMatchesPath(p.slug, cwdPath) : false }))
    .sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || a.label.localeCompare(b.label));
}

// `roots` feeds createDocumentStore directly, same composition skills.js uses
// for its own out-of-project files.
/**
 * @param {string} agentKey
 * @param {import('../types/showmd').AgentTreeOptions} [opts]
 */
function buildAgentTree(agentKey, { home = os.homedir(), cwd } = {}) {
  const agent = AGENTS.find((a) => a.key === agentKey);
  // a registry entry carrying `key` is expected to carry `instructionsFile` too;
  // nothing enforces that, so an entry missing it reads as an unknown agent
  if (!agent || !agent.instructionsFile) return null;
  const roots = [];
  const groups = [];

  const instructionsFiles = [];
  const instructionsFile = agent.instructionsFile(home);
  if (fs.existsSync(instructionsFile)) {
    const key = `${agent.key}-home`;
    roots.push({ key, dir: path.dirname(instructionsFile) });
    instructionsFiles.push({ id: `${key}/${path.basename(instructionsFile)}`, label: path.basename(instructionsFile) });
  }
  if (agent.rulesDir) {
    const rulesDir = agent.rulesDir(home);
    const names = listMdFiles(rulesDir);
    if (names.length) {
      const key = `${agent.key}-rules`;
      roots.push({ key, dir: rulesDir });
      for (const name of names) instructionsFiles.push({ id: `${key}/${name}`, label: name });
    }
  }
  if (instructionsFiles.length) groups.push({ name: 'Instructions', files: instructionsFiles });

  const projects = memoryProjects(agent, home, cwd);
  if (projects.length) {
    const memProjects = [];
    for (const proj of projects) {
      const key = `${agent.key}-memory-${proj.slug}`;
      roots.push({ key, dir: proj.dir });
      const hasMemoryDoc = proj.files.includes('MEMORY.md');
      memProjects.push({
        label: proj.label,
        current: proj.current,
        path: proj.path,
        memoryDoc: hasMemoryDoc ? { id: `${key}/MEMORY.md`, label: 'MEMORY.md' } : null,
        files: proj.files.filter((name) => name !== 'MEMORY.md').map((name) => ({ id: `${key}/${name}`, label: name })),
      });
    }
    groups.push({ name: 'Memories', projects: memProjects });
  }

  return {
    agent: agent.key,
    displayName: agent.displayName,
    detected: agent.detect(home),
    agents: AGENTS.map((a) => ({ key: a.key, displayName: a.displayName, detected: a.detect(home) })),
    groups,
    roots,
  };
}

// this view is only ever showing one agent for one cwd at a time.
const treeCache = createTreeCache();

/**
 * @param {string} agentKey
 * @param {import('../types/showmd').AgentTreeOptions} [opts]
 */
async function getAgentTree(agentKey, { cwd, ttlMs, now, home = os.homedir() } = {}) {
  return treeCache.getTree(`${agentKey}::${cwd}`, () => {
    const tree = buildAgentTree(agentKey, { home, cwd });
    return { tree, roots: tree ? tree.roots : null };
  }, { ttlMs, now });
}

function invalidate() {
  treeCache.invalidate();
}

// a doc id's leading `key/` segment identifies which agent built it (e.g.
// `claude-rules/foo.md`, `codex-home/AGENTS.md`) so pickStore can route a
// raw/history/diff request without knowing the agent in advance
function agentKeyForId(id) {
  const slash = id.indexOf('/');
  if (slash === -1) return null;
  const prefix = id.slice(0, slash);
  const agent = AGENTS.find((a) => prefix === `${a.key}-home` || prefix === `${a.key}-rules` || prefix.startsWith(`${a.key}-memory-`));
  return agent ? agent.key : null;
}

module.exports = { AGENTS, buildAgentTree, getAgentTree, invalidate, agentKeyForId, projectSlug };
