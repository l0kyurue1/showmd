import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  discoverGlobalRoots,
  discoverProjectRoots,
  discoverProjectDirs,
  isSkillsProjectDir,
  buildSkillsTree,
  getTree,
  invalidate,
  __test__: { harvestClaudeJsonProjects },
} = require('../../server/skills.js');
const { resolveSkillsMode } = require('../../bin/cli.js');
const { walkMd } = require('../../server/documents.js');

function flattenIds(tree) {
  const out = [];
  for (const scope of tree.scopes) {
    for (const group of scope.groups) {
      for (const skill of group.skills) {
        out.push({ id: skill.id, name: skill.name, scope: scope.name, source: skill.source, sourceUrl: skill.sourceUrl, install: skill.install, badges: skill.badges, copies: skill.copies, copyPaths: skill.copyPaths, origin: skill.origin });
        for (const f of skill.files) out.push({ id: f.id, name: f.label, scope: scope.name, source: skill.source });
      }
    }
    for (const skill of scope.skills) {
      out.push({ id: skill.id, name: skill.name, scope: scope.name, source: skill.source, sourceUrl: skill.sourceUrl, install: skill.install, badges: skill.badges, copies: skill.copies, copyPaths: skill.copyPaths, origin: skill.origin });
      for (const f of skill.files) out.push({ id: f.id, name: f.label, scope: scope.name, source: skill.source });
    }
  }
  return out;
}

function makeSkill(dir, name, lines = '# skill\n') {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, 'SKILL.md'), lines);
}

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// the root list bin/cli.js builds for project mode — global roots then the
// project's own, in that order
function discoveredRoots(home, cwd) {
  return [...discoverGlobalRoots({ home }), ...discoverProjectRoots(cwd)];
}

test('root discovery: only existing default dirs are returned, labeled correctly', () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    mkdirSync(path.join(home, '.codex', 'skills'), { recursive: true });
    // cwd/.claude/skills and home/.agents/skills intentionally absent

    const found = discoveredRoots(home, cwd);
    const labels = found.map((r) => r.label).sort();
    assert.deepEqual(labels, ['claude user', 'codex']);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('root discovery: cwd project skills dir is included when present', () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    mkdirSync(path.join(cwd, '.claude', 'skills'), { recursive: true });
    const found = discoveredRoots(home, cwd);
    assert.deepEqual(found.map((r) => r.label), ['claude project']);
    assert.equal(found[0].dir, path.join(cwd, '.claude', 'skills'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('root discovery: cwd .agents/skills project root is included, scanned before .claude/skills', () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    mkdirSync(path.join(cwd, '.claude', 'skills'), { recursive: true });
    mkdirSync(path.join(cwd, '.agents', 'skills'), { recursive: true });
    const found = discoveredRoots(home, cwd);
    assert.deepEqual(found.map((r) => r.label), ['project agents', 'claude project']);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('root discovery: plugin skills dirs found up to 3 levels deep, excluded past that', () => {
  const home = tmp('showmd-home-');
  try {
    // 2 levels below plugins/
    mkdirSync(path.join(home, '.claude', 'plugins', 'foo', 'skills'), { recursive: true });
    // 3 levels below plugins/ (mirrors real marketplace/plugin/skills layout)
    mkdirSync(path.join(home, '.claude', 'plugins', 'marketplace', 'bar', 'skills'), { recursive: true });
    // 4 levels below plugins/ — outside the "up to 3 levels" budget
    mkdirSync(path.join(home, '.claude', 'plugins', 'marketplace', 'grp', 'baz', 'skills'), { recursive: true });

    const found = discoveredRoots(home, home);
    const plugins = found.filter((r) => r.label.startsWith('plugin: ')).map((r) => r.label).sort();
    assert.deepEqual(plugins, ['plugin: bar', 'plugin: foo']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('root discovery: nothing exists -> empty list', () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    const found = discoveredRoots(home, cwd);
    assert.deepEqual(found, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: Global scope groups by lock-file source, unlocked skills fall to "local"', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(home, '.agents', 'skills'), 'skill-one');
    makeSkill(path.join(home, '.agents', 'skills'), 'skill-two');
    makeSkill(path.join(home, '.agents', 'skills'), 'skill-three');
    writeFileSync(
      path.join(home, '.agents', '.skill-lock.json'),
      JSON.stringify({
        version: 3,
        skills: {
          'skill-one': { source: 'mattpocock/skills', sourceType: 'github' },
          'skill-three': { source: '/local/path/skills', sourceType: 'path' },
        },
      })
    );

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd: home });
    const flat = flattenIds(tree);

    const one = flat.find((e) => e.name === 'skill-one');
    const two = flat.find((e) => e.name === 'skill-two');
    const three = flat.find((e) => e.name === 'skill-three');
    assert.equal(one.scope, 'Global');
    assert.equal(one.source, 'mattpocock/skills');
    assert.equal(one.install, 'npx skills');
    assert.equal(two.scope, 'Global');
    assert.equal(two.source, 'local');
    assert.equal(two.install, 'manual', 'no lock entry, lives under ~/.agents/skills -> hand-created in the store');
    assert.equal(three.source, '/local/path/skills');
    assert.equal(three.install, 'npx skills (local path)', 'lock entry present but sourceType is not github');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: "local" skills flatten directly onto scope.skills (no local group); lock metadata threads through', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(home, '.agents', 'skills'), 'skill-one');
    makeSkill(path.join(home, '.agents', 'skills'), 'skill-two');
    writeFileSync(
      path.join(home, '.agents', '.skill-lock.json'),
      JSON.stringify({
        version: 3,
        skills: {
          'skill-one': {
            source: 'mattpocock/skills',
            sourceUrl: 'https://github.com/mattpocock/skills.git',
            installedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-02-02T00:00:00.000Z',
          },
        },
      })
    );

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd: home });
    const globalScope = tree.scopes.find((s) => s.name === 'Global');

    assert.ok(!globalScope.groups.some((g) => g.source === 'local'), 'no "local" group in groups[]');
    assert.ok(globalScope.skills.some((s) => s.name === 'skill-two'), 'unlocked skill sits directly on scope.skills');

    const locked = globalScope.groups.find((g) => g.source === 'mattpocock/skills').skills.find((s) => s.name === 'skill-one');
    assert.equal(locked.sourceUrl, 'https://github.com/mattpocock/skills.git');
    assert.equal(locked.installedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(locked.updatedAt, '2026-02-02T00:00:00.000Z');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: realpath dedupe merges ~/.agents/skills and its ~/.claude/skills symlink into one entry with a claude badge', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(home, '.agents', 'skills'), 'dup-skill');
    mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(path.join('..', '..', '.agents', 'skills', 'dup-skill'), path.join(home, '.claude', 'skills', 'dup-skill'));

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd: home });
    const flat = flattenIds(tree).filter((e) => e.name === 'dup-skill');

    assert.equal(flat.length, 1, 'skill reachable via two roots appears exactly once');
    assert.deepEqual(flat[0].badges, ['Claude Code']);
    assert.ok(flat[0].id.startsWith('agents/'), 'canonical ~/.agents/skills path wins for serving/editing');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: badges list every agent CLI dir that symlinks the skill, in candidate order', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(home, '.agents', 'skills'), 'multi-agent-skill');
    for (const dir of [['.claude', 'skills'], ['.codex', 'skills'], ['.kiro', 'skills']]) {
      const agentDir = path.join(home, ...dir);
      mkdirSync(agentDir, { recursive: true });
      symlinkSync(
        path.join(home, '.agents', 'skills', 'multi-agent-skill'),
        path.join(agentDir, 'multi-agent-skill')
      );
    }

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd: home });
    const flat = flattenIds(tree).filter((e) => e.name === 'multi-agent-skill');

    assert.equal(flat.length, 1);
    assert.deepEqual(flat[0].badges, ['Claude Code', 'Codex', 'Kiro CLI']);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: plugin skills drop the "plugin" pseudo-badge; install carries that info instead', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(home, '.claude', 'plugins', 'foo', 'skills'), 'plugin-skill');
    mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(
      path.join(home, '.claude', 'plugins', 'foo', 'skills', 'plugin-skill'),
      path.join(home, '.claude', 'skills', 'plugin-skill')
    );

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd: home });
    const flat = flattenIds(tree).filter((e) => e.name === 'plugin-skill');

    assert.equal(flat.length, 1);
    assert.deepEqual(flat[0].badges, ['Claude Code']);
    assert.equal(flat[0].install, 'Claude plugin: foo');
    assert.equal(flat[0].source, 'plugin: foo', 'no marketplace .git/config present -> plain fallback source');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: plugin skill install + source derived from marketplace .git/config', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(home, '.claude', 'plugins', 'acme', 'skills'), 'acme-skill');
    mkdirSync(path.join(home, '.claude', 'plugins', 'marketplaces', 'acme', '.git'), { recursive: true });
    writeFileSync(
      path.join(home, '.claude', 'plugins', 'marketplaces', 'acme', '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme-org/acme-skills.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
    );

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd: home });
    const flat = flattenIds(tree).filter((e) => e.name === 'acme-skill');

    assert.equal(flat.length, 1);
    assert.equal(flat[0].install, 'Claude plugin: acme');
    assert.equal(flat[0].source, 'acme-org/acme-skills');
    assert.equal(flat[0].sourceUrl, 'https://github.com/acme-org/acme-skills');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: a real (non-symlink) dir directly in ~/.claude/skills installs as "manual"', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(home, '.claude', 'skills'), 'manual-skill');

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd: home });
    const flat = flattenIds(tree).filter((e) => e.name === 'manual-skill');

    assert.equal(flat.length, 1);
    assert.equal(flat[0].install, 'manual');
    assert.deepEqual(flat[0].badges, ['Claude Code']);
    assert.equal(flat[0].source, undefined, 'no known origin for a manually placed skill');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: Projects scope nests project-only skills under a project node named for the cwd basename; skills duplicating Global are skipped', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(home, '.agents', 'skills'), 'shared-skill');
    mkdirSync(path.join(cwd, '.claude', 'skills'), { recursive: true });
    symlinkSync(path.join(home, '.agents', 'skills', 'shared-skill'), path.join(cwd, '.claude', 'skills', 'shared-skill'));
    makeSkill(path.join(cwd, '.claude', 'skills'), 'project-only');

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd });
    const flat = flattenIds(tree);

    const projectOnly = flat.find((e) => e.name === 'project-only');
    assert.ok(projectOnly, 'project-only skill appears');
    assert.equal(projectOnly.scope, 'Projects');
    assert.equal(flat.filter((e) => e.name === 'shared-skill').length, 1, 'shared-skill appears once, under Global only');
    assert.equal(flat.find((e) => e.name === 'shared-skill').scope, 'Global');

    const projectsScope = tree.scopes.find((s) => s.name === 'Projects');
    assert.equal(projectsScope.groups.length, 1, 'one project node for the single cwd project');
    assert.equal(projectsScope.groups[0].source, path.basename(cwd), 'project node is labeled with the project dir basename');
    assert.ok(projectsScope.groups[0].skills.some((s) => s.name === 'project-only'), 'project skill sits under the project node');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: universal agents badge a canonical-store skill without any symlink, once their detect marker exists', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(home, '.agents', 'skills'), 'native-skill');
    mkdirSync(path.join(home, '.codex'), { recursive: true }); // Codex detect marker; no symlink anywhere

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd });
    const flat = flattenIds(tree).filter((e) => e.name === 'native-skill');

    assert.equal(flat.length, 1);
    assert.deepEqual(flat[0].badges, ['Codex'], 'Codex reads .agents/skills natively once ~/.codex exists; other universal agents have no detect marker here');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: a universal agent with no detect marker is not badged, even though its skill sits in the canonical store', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(home, '.agents', 'skills'), 'native-skill');
    // no ~/.codex, ~/.cursor, etc. -> no universal agent is detected

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd });
    const flat = flattenIds(tree).filter((e) => e.name === 'native-skill');

    assert.equal(flat.length, 1);
    assert.deepEqual(flat[0].badges, [], 'no agent detected on this machine -> no badges');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: universal-agent badges and symlink badges merge, sorted into registry order', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(home, '.agents', 'skills'), 'mixed-skill');
    mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(
      path.join(home, '.agents', 'skills', 'mixed-skill'),
      path.join(home, '.claude', 'skills', 'mixed-skill')
    );
    mkdirSync(path.join(home, '.cursor'), { recursive: true }); // Cursor detect marker, no symlink needed

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd });
    const flat = flattenIds(tree).filter((e) => e.name === 'mixed-skill');

    assert.equal(flat.length, 1);
    assert.deepEqual(flat[0].badges, ['Claude Code', 'Cursor'], 'registry order: claude-code before cursor');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: project .agents/skills real dir wins realpath dedupe over its .claude/skills symlink', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(cwd, '.agents', 'skills'), 'apply');
    mkdirSync(path.join(cwd, '.claude', 'skills'), { recursive: true });
    symlinkSync(path.join(cwd, '.agents', 'skills', 'apply'), path.join(cwd, '.claude', 'skills', 'apply'));

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd });
    const flat = flattenIds(tree).filter((e) => e.name === 'apply');

    assert.equal(flat.length, 1, 'skill reachable via both project roots appears exactly once');
    assert.equal(flat[0].scope, 'Projects');
    assert.ok(flat[0].id.startsWith('project agents/'), 'canonical .agents/skills path wins for serving/editing');
    assert.equal(flat[0].install, 'manual', 'no project lock entry -> plain "manual" install');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: identical-content duplicate skill in one project (.agents + .claude copies) collapses to one entry with copies:2', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(cwd, '.agents', 'skills'), 'dup-skill', '# dup\nsame content\n');
    makeSkill(path.join(cwd, '.claude', 'skills'), 'dup-skill', '# dup\nsame content\n');

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd });
    const flat = flattenIds(tree).filter((e) => e.name === 'dup-skill');

    assert.equal(flat.length, 1, 'identical copies collapse to one entry');
    assert.equal(flat[0].copies, 2);
    assert.deepEqual(flat[0].copyPaths.sort(), ['.agents/skills/dup-skill', '.claude/skills/dup-skill']);
    assert.ok(flat[0].id.startsWith('project agents/'), 'canonical .agents copy wins');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: diverged-content duplicate skill in one project keeps both entries with origin fields', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(cwd, '.agents', 'skills'), 'dup-skill', '# dup\nagents version\n');
    makeSkill(path.join(cwd, '.claude', 'skills'), 'dup-skill', '# dup\nclaude version\n');

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd });
    const flat = flattenIds(tree).filter((e) => e.name === 'dup-skill');

    assert.equal(flat.length, 2, 'diverged copies both kept');
    assert.deepEqual(flat.map((e) => e.origin).sort(), ['agents', 'claude']);
    assert.equal(flat.every((e) => e.copies === undefined), true, 'no copies field on diverged entries');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: an extra file in one copy counts as diverged content, not collapsed', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(cwd, '.agents', 'skills'), 'dup-skill', '# dup\nsame\n');
    makeSkill(path.join(cwd, '.claude', 'skills'), 'dup-skill', '# dup\nsame\n');
    writeFileSync(path.join(cwd, '.claude', 'skills', 'dup-skill', 'extra.md'), 'extra');

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd });
    const flat = flattenIds(tree).filter((e) => e.name === 'dup-skill');

    assert.equal(flat.length, 2, 'an extra file breaks the digest match, so both copies are kept');
    assert.deepEqual(flat.map((e) => e.origin).sort(), ['agents', 'claude']);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: identical bytes under a different filename count as diverged content', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(cwd, '.agents', 'skills'), 'dup-skill', '# dup\nsame\n');
    makeSkill(path.join(cwd, '.claude', 'skills'), 'dup-skill', '# dup\nsame\n');
    writeFileSync(path.join(cwd, '.agents', 'skills', 'dup-skill', 'NOTES.md'), 'shared text');
    writeFileSync(path.join(cwd, '.claude', 'skills', 'dup-skill', 'notes.md'), 'shared text');

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd });
    const flat = flattenIds(tree).filter((e) => e.name === 'dup-skill');

    assert.equal(flat.length, 2, 'the filename is part of the digest, so a rename breaks the match even with the same bytes');
    assert.deepEqual(flat.map((e) => e.origin).sort(), ['agents', 'claude']);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: a symlinked file in one copy hashes as its target content, so identical copies still collapse', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(cwd, '.agents', 'skills'), 'dup-skill', '# dup\nsame\n');
    mkdirSync(path.join(cwd, '.claude', 'skills', 'dup-skill'), { recursive: true });
    symlinkSync(path.join(cwd, '.agents', 'skills', 'dup-skill', 'SKILL.md'), path.join(cwd, '.claude', 'skills', 'dup-skill', 'SKILL.md'));

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd });
    const flat = flattenIds(tree).filter((e) => e.name === 'dup-skill');

    assert.equal(flat.length, 1, 'a symlink resolving to identical content still collapses to one entry');
    assert.equal(flat[0].copies, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: a symlink cycle inside a copy does not hang the collision hash', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(cwd, '.agents', 'skills'), 'dup-skill', '# dup\nsame\n');
    makeSkill(path.join(cwd, '.claude', 'skills'), 'dup-skill', '# dup\nsame\n');
    symlinkSync(path.join(cwd, '.claude', 'skills', 'dup-skill'), path.join(cwd, '.claude', 'skills', 'dup-skill', 'self'));

    const roots = discoveredRoots(home, cwd);
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd });
    const flat = flattenIds(tree).filter((e) => e.name === 'dup-skill');

    assert.ok(flat.length === 1 || flat.length === 2, 'the cycle terminates instead of hanging, whichever way it resolves');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('harvestClaudeJsonProjects: reads the `projects` map, keeps only absolute-path keys', () => {
  const home = tmp('showmd-home-');
  try {
    const claudeJsonPath = path.join(home, '.claude.json');
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({
        projects: {
          '/Users/x/repo-a': { hasTrustDialogAccepted: true },
          '/Users/x/repo-b': {},
          'not-absolute': {},
        },
        someOtherTopLevelField: 'ignored',
      })
    );
    assert.deepEqual(harvestClaudeJsonProjects(claudeJsonPath).sort(), ['/Users/x/repo-a', '/Users/x/repo-b']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('discoverProjectDirs: missing or malformed `.claude.json` -> empty list, no throw', () => {
  const home = tmp('showmd-home-');
  try {
    assert.deepEqual(discoverProjectDirs({ home, claudeJsonPath: path.join(home, 'missing.json') }), []);
    const badPath = path.join(home, 'bad.json');
    writeFileSync(badPath, 'not json');
    assert.deepEqual(discoverProjectDirs({ home, claudeJsonPath: badPath }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('discoverProjectDirs: harvest + sibling-scan combined, deduped and filtered to existing skills projects', () => {
  const home = tmp('showmd-home-');
  const base = tmp('showmd-discover-');
  try {
    const projectA = path.join(base, 'proj-a'); // harvested directly
    const projectB = path.join(base, 'proj-b'); // found only via sibling-scan
    const gone = path.join(base, 'gone'); // harvested but no longer exists
    const notAProject = path.join(base, 'not-a-project'); // sibling dir, no skills marker
    mkdirSync(path.join(projectA, '.agents', 'skills'), { recursive: true });
    mkdirSync(path.join(projectB, '.claude', 'skills'), { recursive: true });
    mkdirSync(notAProject, { recursive: true });
    writeFileSync(path.join(base, 'stray-file.txt'), 'not a dir');

    const claudeJsonPath = path.join(home, '.claude.json');
    writeFileSync(claudeJsonPath, JSON.stringify({ projects: { [projectA]: {}, [gone]: {} } }));

    const found = discoverProjectDirs({ home, claudeJsonPath });
    assert.deepEqual(found.sort(), [realpathSync(projectA), realpathSync(projectB)].sort());
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolveSkillsMode: no args -> AUTO dispatches to project mode when cwd is a skills project', () => {
  const cwd = tmp('showmd-cwd-');
  try {
    mkdirSync(path.join(cwd, '.agents', 'skills'), { recursive: true });
    assert.ok(isSkillsProjectDir(cwd));
    assert.deepEqual(resolveSkillsMode([], cwd), { mode: 'project', projectDirs: [cwd] });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveSkillsMode: no args -> AUTO dispatches to all mode when cwd is not a skills project', () => {
  const cwd = tmp('showmd-cwd-');
  try {
    assert.ok(!isSkillsProjectDir(cwd));
    assert.deepEqual(resolveSkillsMode([], cwd), { mode: 'all', projectDirs: [] });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveSkillsMode: "all" and "global" are recognized only as the sole positional arg', () => {
  const cwd = tmp('showmd-cwd-');
  try {
    assert.deepEqual(resolveSkillsMode(['all'], cwd), { mode: 'all', projectDirs: [] });
    assert.deepEqual(resolveSkillsMode(['global'], cwd), { mode: 'global', projectDirs: [] });
    assert.deepEqual(resolveSkillsMode(['./foo'], cwd), { mode: 'project', projectDirs: [path.resolve(cwd, 'foo')] });
    assert.deepEqual(resolveSkillsMode(['all', 'global'], cwd), {
      mode: 'project',
      projectDirs: [path.resolve(cwd, 'all'), path.resolve(cwd, 'global')],
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: mode "project" orders scopes ["Project","Global"] with singular "Project" name', async () => {
  const home = tmp('showmd-home-');
  const cwd = tmp('showmd-cwd-');
  try {
    makeSkill(path.join(home, '.agents', 'skills'), 'global-skill');
    makeSkill(path.join(cwd, '.agents', 'skills'), 'project-skill');

    const roots = [...discoverGlobalRoots({ home }), ...discoverProjectRoots(cwd)];
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd, mode: 'project' });

    assert.deepEqual(tree.scopes.map((s) => s.name), ['Project', 'Global'], 'Project scope first, singular name');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildSkillsTree: default mode orders scopes ["Global","Projects"] with one group per discovered project', async () => {
  const home = tmp('showmd-home-');
  const projA = tmp('showmd-proja-');
  const projB = tmp('showmd-projb-');
  try {
    makeSkill(path.join(home, '.agents', 'skills'), 'global-skill');
    makeSkill(path.join(projA, '.agents', 'skills'), 'skill-a');
    makeSkill(path.join(projB, '.claude', 'skills'), 'skill-b');

    const roots = [
      ...discoverGlobalRoots({ home }),
      ...discoverProjectRoots(projA),
      ...discoverProjectRoots(projB),
    ];
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd: home });

    assert.deepEqual(tree.scopes.map((s) => s.name), ['Global', 'Projects'], 'Global scope first, "Projects" plural');
    const projectsScope = tree.scopes.find((s) => s.name === 'Projects');
    const sources = projectsScope.groups.map((g) => g.source).sort();
    assert.deepEqual(sources, [path.basename(projA), path.basename(projB)].sort(), 'one collapsible node per discovered project');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(projA, { recursive: true, force: true });
    rmSync(projB, { recursive: true, force: true });
  }
});

test('buildSkillsTree: global-only roots (no project roots given) -> scopes is just ["Global"]', async () => {
  const home = tmp('showmd-home-');
  try {
    makeSkill(path.join(home, '.agents', 'skills'), 'global-skill');
    const roots = discoverGlobalRoots({ home });
    const tree = await buildSkillsTree(roots, { walkMd, home, cwd: home });
    assert.deepEqual(tree.scopes.map((s) => s.name), ['Global']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('getTree: caches per rootDir within the TTL — a skill added after the first call is not yet visible', async () => {
  invalidate();
  const root = tmp('showmd-gettree-ttl-reuse-');
  try {
    makeSkill(path.join(root, '.agents', 'skills'), 'one');
    let now = 1_000_000;
    const first = await getTree(root, { now: () => now });
    makeSkill(path.join(root, '.agents', 'skills'), 'two');
    now += 1000;
    const second = await getTree(root, { now: () => now });
    assert.equal(second.tree, first.tree, 'same cached tree object, still inside the TTL');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getTree: rebuilds once the TTL has elapsed', async () => {
  invalidate();
  const root = tmp('showmd-gettree-ttl-expiry-');
  try {
    makeSkill(path.join(root, '.agents', 'skills'), 'one');
    let now = 2_000_000;
    const first = await getTree(root, { ttlMs: 100, now: () => now });
    makeSkill(path.join(root, '.agents', 'skills'), 'two');
    now += 101;
    const second = await getTree(root, { ttlMs: 100, now: () => now });
    assert.notEqual(second.tree, first.tree);
    assert.ok(flattenIds(second.tree).some((e) => e.name === 'two'), 'new skill shows up once the TTL has elapsed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getTree: invalidate() forces a rebuild even inside the TTL', async () => {
  const root = tmp('showmd-gettree-invalidate-');
  try {
    makeSkill(path.join(root, '.agents', 'skills'), 'one');
    const first = await getTree(root, { now: () => 3_000_000 });
    makeSkill(path.join(root, '.agents', 'skills'), 'two');
    invalidate();
    const second = await getTree(root, { now: () => 3_000_000 });
    assert.notEqual(second.tree, first.tree);
    assert.ok(flattenIds(second.tree).some((e) => e.name === 'two'), 'invalidate() busts the cache regardless of TTL');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
