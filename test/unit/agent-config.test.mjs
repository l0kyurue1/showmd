import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AGENTS, buildAgentTree, getAgentTree, invalidate, agentKeyForId, projectSlug } = require('../../server/agent-config.js');

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('buildAgentTree: unknown agent key returns null', () => {
  const home = tmp('showmd-agent-home-');
  try {
    assert.equal(buildAgentTree('nope', { home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildAgentTree: no ~/.claude at all -> not detected, no groups', () => {
  const home = tmp('showmd-agent-home-');
  try {
    const tree = buildAgentTree('claude', { home });
    assert.equal(tree.detected, false);
    assert.deepEqual(tree.groups, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildAgentTree: CLAUDE.md + rules/*.md become one Instructions group, ids route through key/relpath', () => {
  const home = tmp('showmd-agent-home-');
  try {
    mkdirSync(path.join(home, '.claude', 'rules'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# global\n');
    writeFileSync(path.join(home, '.claude', 'rules', '10-a.md'), '# a\n');
    writeFileSync(path.join(home, '.claude', 'rules', '20-b.md'), '# b\n');
    writeFileSync(path.join(home, '.claude', 'rules', 'notes.txt'), 'skip me\n');

    const tree = buildAgentTree('claude', { home });
    assert.equal(tree.detected, true);
    assert.equal(tree.groups.length, 1);
    assert.equal(tree.groups[0].name, 'Instructions');
    const ids = tree.groups[0].files.map((f) => f.id);
    assert.deepEqual(ids, ['claude-home/CLAUDE.md', 'claude-rules/10-a.md', 'claude-rules/20-b.md']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Claude Code's own encoding, recovered from the shipped binary. Spelled out
// rather than computed so a regression in projectSlug cannot pass silently.
test('projectSlug: every non-alphanumeric becomes one dash, case preserved', () => {
  assert.equal(projectSlug('/Users/a/my.project'), '-Users-a-my-project');
  assert.equal(projectSlug('C:\\Users\\foo\\my.project'), 'C--Users-foo-my-project');
  assert.equal(projectSlug('/Users/a/Application Support'), '-Users-a-Application-Support');
  assert.equal(projectSlug('/Users/a/iCloud~md~obsidian'), '-Users-a-iCloud-md-obsidian');
  assert.equal(projectSlug('/Users/a/Moon@Cloud/snake_case'), '-Users-a-Moon-Cloud-snake-case');
});

test('buildAgentTree: memory groups by project, current cwd project sorts first', () => {
  const home = tmp('showmd-agent-home-');
  const project = tmp('showmd-agent-project-');
  try {
    const resolvedProject = path.resolve(project);
    const slug = projectSlug(resolvedProject);
    const otherSlug = '-Users-someone-other-repo';
    mkdirSync(path.join(home, '.claude', 'projects', slug, 'memory'), { recursive: true });
    mkdirSync(path.join(home, '.claude', 'projects', otherSlug, 'memory'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'projects', slug, 'memory', 'notes.md'), '# mine\n');
    writeFileSync(path.join(home, '.claude', 'projects', otherSlug, 'memory', 'notes.md'), '# other\n');
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [resolvedProject]: {} } }));

    const tree = buildAgentTree('claude', { home, cwd: project });
    const memGroup = tree.groups.find((g) => g.name === 'Memories');
    assert.ok(memGroup);
    assert.equal(memGroup.projects.length, 2);
    assert.equal(memGroup.projects[0].current, true);
    assert.equal(memGroup.projects[0].label, path.basename(resolvedProject));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('buildAgentTree: memory project label falls back to the slug\'s basename, not the full decoded path', () => {
  const home = tmp('showmd-agent-home-');
  try {
    const slug = '-Users-someone-Documents-Repository-showmd';
    mkdirSync(path.join(home, '.claude', 'projects', slug, 'memory'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'projects', slug, 'memory', 'notes.md'), '# notes\n');

    const tree = buildAgentTree('claude', { home });
    const memGroup = tree.groups.find((g) => g.name === 'Memories');
    assert.equal(memGroup.projects[0].label, 'showmd');
    assert.equal(memGroup.projects[0].path, 'Users/someone/Documents/Repository/showmd');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildAgentTree: two projects with the same basename disambiguate with their parent segment', () => {
  const home = tmp('showmd-agent-home-');
  try {
    const slugA = '-Users-a-work-showmd';
    const slugB = '-Users-b-side-showmd';
    for (const slug of [slugA, slugB]) {
      mkdirSync(path.join(home, '.claude', 'projects', slug, 'memory'), { recursive: true });
      writeFileSync(path.join(home, '.claude', 'projects', slug, 'memory', 'notes.md'), '# notes\n');
    }

    const tree = buildAgentTree('claude', { home });
    const labels = tree.groups.find((g) => g.name === 'Memories').projects.map((p) => p.label).sort();
    assert.deepEqual(labels, ['side/showmd', 'work/showmd']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildAgentTree: a project\'s MEMORY.md folds out of files into its own memoryDoc', () => {
  const home = tmp('showmd-agent-home-');
  try {
    mkdirSync(path.join(home, '.claude', 'projects', '-p', 'memory'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'projects', '-p', 'memory', 'MEMORY.md'), '# memory\n');
    writeFileSync(path.join(home, '.claude', 'projects', '-p', 'memory', 'notes.md'), '# notes\n');

    const tree = buildAgentTree('claude', { home });
    const proj = tree.groups.find((g) => g.name === 'Memories').projects[0];
    assert.deepEqual(proj.memoryDoc, { id: 'claude-memory--p/MEMORY.md', label: 'MEMORY.md' });
    assert.deepEqual(proj.files.map((f) => f.id), ['claude-memory--p/notes.md']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildAgentTree: a project with no MEMORY.md leaves memoryDoc null', () => {
  const home = tmp('showmd-agent-home-');
  try {
    mkdirSync(path.join(home, '.claude', 'projects', '-p', 'memory'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'projects', '-p', 'memory', 'notes.md'), '# notes\n');

    const tree = buildAgentTree('claude', { home });
    const proj = tree.groups.find((g) => g.name === 'Memories').projects[0];
    assert.equal(proj.memoryDoc, null);
    assert.deepEqual(proj.files.map((f) => f.id), ['claude-memory--p/notes.md']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildAgentTree: project dirs with an empty memory/ (or none) are skipped', () => {
  const home = tmp('showmd-agent-home-');
  try {
    mkdirSync(path.join(home, '.claude', 'projects', '-empty', 'memory'), { recursive: true });
    mkdirSync(path.join(home, '.claude', 'projects', '-nomemory'), { recursive: true });
    const tree = buildAgentTree('claude', { home });
    assert.equal(tree.groups.find((g) => g.name === 'Memories'), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildAgentTree: codex has no rules dir and no memory group', () => {
  const home = tmp('showmd-agent-home-');
  try {
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    writeFileSync(path.join(home, '.codex', 'AGENTS.md'), '# codex\n');
    const tree = buildAgentTree('codex', { home });
    assert.equal(tree.detected, true);
    assert.deepEqual(tree.groups, [{ name: 'Instructions', files: [{ id: 'codex-home/AGENTS.md', label: 'AGENTS.md' }] }]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildAgentTree: agents list reports detected status for every registered agent', () => {
  const home = tmp('showmd-agent-home-');
  try {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const tree = buildAgentTree('claude', { home });
    assert.deepEqual(tree.agents.map((a) => a.key).sort(), AGENTS.map((a) => a.key).sort());
    assert.equal(tree.agents.find((a) => a.key === 'claude').detected, true);
    assert.equal(tree.agents.find((a) => a.key === 'codex').detected, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('agentKeyForId: routes every id shape to its agent, rejects unrelated ids', () => {
  assert.equal(agentKeyForId('claude-home/CLAUDE.md'), 'claude');
  assert.equal(agentKeyForId('claude-rules/10-a.md'), 'claude');
  assert.equal(agentKeyForId('claude-memory--Users-a-b/notes.md'), 'claude');
  assert.equal(agentKeyForId('codex-home/AGENTS.md'), 'codex');
  assert.equal(agentKeyForId('some-project/README.md'), null);
  assert.equal(agentKeyForId('no-slash-at-all'), null);
});

test('getAgentTree: caches per (agent, cwd) within the TTL, rebuilds after it or on invalidate()', async () => {
  const home = tmp('showmd-agent-home-');
  try {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# v1\n');
    let now = 1000;
    const { tree: t1, store } = await getAgentTree('claude', { cwd: '/a', home, now: () => now });
    assert.equal(t1.groups[0].files[0].label, 'CLAUDE.md');
    assert.ok(store);

    // still within TTL: same object back even though disk changed underneath
    mkdirSync(path.join(home, '.claude', 'rules'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'rules', 'a.md'), '# a\n');
    const { tree: t2 } = await getAgentTree('claude', { cwd: '/a', home, now: () => now + 1 });
    assert.equal(t2.groups.length, 1);

    now += 30001;
    const { tree: t3 } = await getAgentTree('claude', { cwd: '/a', home, now: () => now });
    assert.equal(t3.groups.length, 1);
    assert.equal(t3.groups[0].files.length, 2);
  } finally {
    invalidate();
    rmSync(home, { recursive: true, force: true });
  }
});
