import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleRows, keyIntent, toggleNode, initialCollapsed, expandAncestors, INITIAL_NAV, nextNav } from '../../../client/navigation.js';
import { adaptAgentTree, adaptFilesTree, adaptSkillsTree } from '../../../client/navigation-adapters.js';

const flat = { tree: ['a.md', 'notes/one.md', 'notes/two.md', 'z.md'] };
const filesModel = adaptFilesTree(flat);

const skillsTree = {
  scopes: [{
    name: 'Project',
    groups: [{
      source: 'repo',
      skills: [
        { id: 'repo/alpha/SKILL.md', name: 'alpha', files: [{ id: 'repo/alpha/a.md', label: 'a' }] },
        { id: 'repo/beta/SKILL.md', name: 'beta', files: [] },
      ],
    }],
    skills: [{ id: 'local/solo/SKILL.md', name: 'solo', files: [] }],
  }],
};

const skillsModel = adaptSkillsTree(skillsTree);

const ids = (rows) => rows.map((r) => r.id);

test('adaptFilesTree normalizes flat files into recursive navigation nodes', () => {
  assert.deepEqual(adaptFilesTree(flat), {
    roots: [
      { key: 'a.md', role: 'file', label: 'a.md', documentId: 'a.md', children: [], initiallyCollapsed: false },
      { key: 'z.md', role: 'file', label: 'z.md', documentId: 'z.md', children: [], initiallyCollapsed: false },
      {
        key: 'dir:notes/',
        role: 'dir',
        label: 'notes',
        labelParts: { prefix: '', name: 'notes' },
        children: [
          { key: 'notes/one.md', role: 'file', label: 'one.md', documentId: 'notes/one.md', children: [], initiallyCollapsed: false },
          { key: 'notes/two.md', role: 'file', label: 'two.md', documentId: 'notes/two.md', children: [], initiallyCollapsed: false },
        ],
        initiallyCollapsed: false,
      },
    ],
  });
});

test('adaptFilesTree splits a multi-segment directory label into prefix and name', () => {
  const { roots } = adaptFilesTree({ tree: ['docs/superpowers/plans/one.md'] });
  const header = roots.find((r) => r.role === 'dir');
  assert.deepEqual(header.labelParts, { prefix: 'docs/superpowers/', name: 'plans' });
  assert.equal(header.label, 'docs/superpowers/plans');
});

test('adaptSkillsTree preserves hierarchy, metadata, and first-chain expansion', () => {
  const { roots } = adaptSkillsTree(skillsTree);
  const scope = roots[0];
  const group = scope.children[0];
  const [alpha, beta] = group.children;
  const solo = scope.children[1];

  assert.deepEqual(
    [scope.key, group.key, alpha.key, alpha.children[0].key, beta.key, solo.key],
    ['scope:Project', 'group:Project:repo', 'skill:repo/alpha/SKILL.md', 'repo/alpha/a.md', 'skill:repo/beta/SKILL.md', 'skill:local/solo/SKILL.md'],
  );
  assert.deepEqual(
    [scope.initiallyCollapsed, group.initiallyCollapsed, alpha.initiallyCollapsed, beta.initiallyCollapsed, solo.initiallyCollapsed],
    [false, false, false, true, true],
  );
  assert.equal(alpha.documentId, 'repo/alpha/SKILL.md');
  assert.equal(alpha.metadata.skill, skillsTree.scopes[0].groups[0].skills[0]);
  assert.deepEqual(alpha.children[0], {
    key: 'repo/alpha/a.md', role: 'file', label: 'a', documentId: 'repo/alpha/a.md', children: [], initiallyCollapsed: false,
  });
});

test('flat tree groups by directory with a collapsible header', () => {
  const rows = visibleRows(filesModel);
  assert.deepEqual(ids(rows), ['a.md', 'z.md', 'dir:notes/', 'notes/one.md', 'notes/two.md']);
  const header = rows.find((r) => r.kind === 'dir');
  assert.equal(header.collapsible, true);
  assert.equal(header.depth, 0);
  assert.equal(rows.find((r) => r.id === 'notes/one.md').depth, 1);
});

test('a collapsed directory hides its files but keeps its header', () => {
  const rows = visibleRows(filesModel, { collapsed: new Set(['dir:notes/']) });
  assert.deepEqual(ids(rows), ['a.md', 'z.md', 'dir:notes/']);
});

test('a query overrides collapse state', () => {
  const rows = visibleRows(filesModel, { query: 'one', collapsed: new Set(['dir:notes/']) });
  assert.deepEqual(ids(rows), ['notes/one.md']);
});

test('a query that matches nothing yields no rows', () => {
  assert.deepEqual(visibleRows(filesModel, { query: 'zzzznope' }), []);
});

test('a search row for a file in a directory splits its label into dir and base', () => {
  const rows = visibleRows(filesModel, { query: 'one' });
  const row = rows.find((r) => r.id === 'notes/one.md');
  assert.equal(row.label, 'notes/one.md');
  assert.deepEqual(row.labelParts, { dir: 'notes/', base: 'one.md' });
});

test('a search row for a root-level file has no labelParts', () => {
  const rows = visibleRows(filesModel, { query: 'a.md' });
  const row = rows.find((r) => r.id === 'a.md');
  assert.equal(row.label, 'a.md');
  assert.equal(row.labelParts, null);
});

test('the current file is marked, and only it', () => {
  const rows = visibleRows(filesModel, { file: 'z.md' });
  assert.deepEqual(rows.filter((r) => r.current).map((r) => r.id), ['z.md']);
});

test('skills tree walks scope, group, skill, file', () => {
  const rows = visibleRows(skillsModel);
  assert.deepEqual(ids(rows), [
    'scope:Project',
    'group:Project:repo',
    'repo/alpha/SKILL.md',
    'repo/alpha/a.md',
    'repo/beta/SKILL.md',
    'local/solo/SKILL.md',
  ]);
  assert.deepEqual(rows.map((r) => r.depth), [0, 1, 2, 3, 2, 1]);
});

test('a skill with no files is not collapsible', () => {
  const rows = visibleRows(skillsModel);
  assert.equal(rows.find((r) => r.id === 'repo/alpha/SKILL.md').collapsible, true);
  assert.equal(rows.find((r) => r.id === 'repo/beta/SKILL.md').collapsible, false);
});

test('collapsing a scope hides everything under it', () => {
  const rows = visibleRows(skillsModel, { collapsed: new Set(['scope:Project']) });
  assert.deepEqual(ids(rows), ['scope:Project']);
});

test('rows carry a list key so glide lists stay per group', () => {
  const rows = visibleRows(skillsModel);
  assert.equal(rows.find((r) => r.id === 'repo/alpha/SKILL.md').listKey, 'group:Project:repo');
  assert.equal(rows.find((r) => r.id === 'local/solo/SKILL.md').listKey, 'local:Project');
});

test('ArrowDown and ArrowUp walk the visible order and clamp at the ends', () => {
  const rows = visibleRows(filesModel);
  assert.equal(keyIntent(rows, 'ArrowDown', { selected: 'a.md' }).row.id, 'z.md');
  assert.equal(keyIntent(rows, 'ArrowUp', { selected: 'z.md' }).row.id, 'a.md');
  assert.equal(keyIntent(rows, 'ArrowUp', { selected: 'a.md' }).row.id, 'a.md');
  const last = rows[rows.length - 1].id;
  assert.equal(keyIntent(rows, 'ArrowDown', { selected: last }).row.id, last);
});

test('ArrowDown with nothing selected starts from the current file', () => {
  const rows = visibleRows(filesModel, { file: 'a.md' });
  assert.equal(keyIntent(rows, 'ArrowDown', { selected: null, file: 'a.md' }).row.id, 'z.md');
});

test('arrowing onto a file asks for an auto-open, onto a header does not', () => {
  const rows = visibleRows(filesModel);
  assert.equal(keyIntent(rows, 'ArrowDown', { selected: 'a.md' }).autoOpen, true);
  assert.equal(keyIntent(rows, 'ArrowDown', { selected: 'z.md' }).autoOpen, false);
});

test('ArrowRight opens a shut node, then descends into it', () => {
  const shut = new Set(['dir:notes/']);
  const closed = visibleRows(filesModel, { collapsed: shut });
  const open = keyIntent(closed, 'ArrowRight', { selected: 'dir:notes/' });
  assert.deepEqual([open.type, open.row.nodeId], ['toggle', 'dir:notes/']);

  const rows = visibleRows(filesModel);
  const descend = keyIntent(rows, 'ArrowRight', { selected: 'dir:notes/' });
  assert.deepEqual([descend.type, descend.row.id], ['select', 'notes/one.md']);
});

test('ArrowLeft shuts an open node, then climbs to the parent', () => {
  const rows = visibleRows(filesModel);
  const shut = keyIntent(rows, 'ArrowLeft', { selected: 'dir:notes/' });
  assert.deepEqual([shut.type, shut.row.nodeId], ['toggle', 'dir:notes/']);

  const climb = keyIntent(rows, 'ArrowLeft', { selected: 'notes/two.md' });
  assert.deepEqual([climb.type, climb.row.id], ['select', 'dir:notes/']);
});

test('ArrowRight on a leaf with no deeper row does nothing', () => {
  const rows = visibleRows(filesModel);
  assert.equal(keyIntent(rows, 'ArrowRight', { selected: 'notes/two.md' }), null);
});

test('Enter toggles a collapsible row and opens a leaf', () => {
  const rows = visibleRows(filesModel);
  assert.equal(keyIntent(rows, 'Enter', { selected: 'dir:notes/' }).type, 'toggle');
  assert.equal(keyIntent(rows, 'Enter', { selected: 'a.md' }).type, 'open');
});

test('Enter on a skill with files toggles rather than opening', () => {
  const rows = visibleRows(skillsModel);
  assert.equal(keyIntent(rows, 'Enter', { selected: 'repo/alpha/SKILL.md' }).type, 'toggle');
  assert.equal(keyIntent(rows, 'Enter', { selected: 'repo/beta/SKILL.md' }).type, 'open');
});

test('keys on an empty or unselected tree are inert', () => {
  assert.equal(keyIntent([], 'ArrowDown', {}), null);
  const rows = visibleRows(filesModel);
  assert.equal(keyIntent(rows, 'Enter', { selected: 'gone.md' }), null);
});

test('toggleNode flips membership', () => {
  const set = new Set();
  toggleNode(set, 'x');
  assert.equal(set.has('x'), true);
  toggleNode(set, 'x');
  assert.equal(set.has('x'), false);
});

test('initial collapse shuts everything but the first group chain', () => {
  const collapsed = initialCollapsed(skillsModel);
  assert.equal(collapsed.has('scope:Project'), false);
  assert.equal(collapsed.has('group:Project:repo'), false);
  assert.equal(collapsed.has('skill:repo/alpha/SKILL.md'), false);
  assert.equal(collapsed.has('skill:repo/beta/SKILL.md'), true);
});

test('expandAncestors opens the chain down to a file', () => {
  const collapsed = new Set(['scope:Project', 'group:Project:repo', 'skill:repo/alpha/SKILL.md']);
  expandAncestors(collapsed, skillsModel, 'repo/alpha/a.md');
  assert.equal(collapsed.size, 0);
  assert.deepEqual(ids(visibleRows(skillsModel, { collapsed })).slice(0, 4), [
    'scope:Project', 'group:Project:repo', 'repo/alpha/SKILL.md', 'repo/alpha/a.md',
  ]);
});

test('files under a skill are marked so the row can be styled without depth math', () => {
  const rows = visibleRows(skillsModel);
  assert.equal(rows.find((r) => r.id === 'repo/alpha/a.md').underSkill, true);
  assert.equal(visibleRows(filesModel).find((r) => r.id === 'notes/one.md').underSkill, undefined);
});

const agentTree = {
  agent: 'claude',
  groups: [
    { name: 'Instructions', files: [{ id: 'claude-home/CLAUDE.md', label: 'CLAUDE.md' }, { id: 'claude-rules/10-a.md', label: '10-a.md' }] },
    { name: 'Memories', projects: [
      { label: 'showmd', current: true, path: '/Users/x/showmd', memoryDoc: { id: 'claude-memory-x/MEMORY.md', label: 'MEMORY.md' }, files: [{ id: 'claude-memory-x/notes.md', label: 'notes.md' }] },
      { label: 'other-repo', current: false, path: '/Users/x/other-repo', memoryDoc: { id: 'claude-memory-y/MEMORY.md', label: 'MEMORY.md' }, files: [{ id: 'claude-memory-y/notes.md', label: 'notes.md' }] },
    ] },
  ],
};
const agentModel = adaptAgentTree(agentTree);

test('adaptAgentTree preserves project documents, metadata, and initial collapse', () => {
  const { roots } = adaptAgentTree(agentTree);
  const [instructions, memories] = roots;
  const [showmd, other] = memories.children;

  assert.deepEqual([instructions.key, memories.key], ['agentgroup:Instructions', 'agentgroup:Memories']);
  assert.deepEqual([instructions.initiallyCollapsed, memories.initiallyCollapsed], [false, true]);
  assert.deepEqual(instructions.children[0], {
    key: 'claude-home/CLAUDE.md', role: 'file', label: 'CLAUDE.md', documentId: 'claude-home/CLAUDE.md', children: [], initiallyCollapsed: false,
  });
  assert.deepEqual(
    [showmd.key, showmd.label, showmd.documentId, showmd.initiallyCollapsed, other.initiallyCollapsed],
    ['agentproject:showmd', 'showmd (current)', 'claude-memory-x/MEMORY.md', true, true],
  );
  assert.equal(showmd.metadata.project, agentTree.groups[1].projects[0]);
  assert.equal(showmd.children[0].documentId, 'claude-memory-x/notes.md');
});

test('agent tree: two scope-style group headers, Instructions files flat, Memories folds MEMORY.md into the project row', () => {
  const rows = visibleRows(agentModel);
  assert.deepEqual(ids(rows), [
    'agentgroup:Instructions', 'claude-home/CLAUDE.md', 'claude-rules/10-a.md',
    'agentgroup:Memories', 'claude-memory-x/MEMORY.md', 'claude-memory-x/notes.md',
    'claude-memory-y/MEMORY.md', 'claude-memory-y/notes.md',
  ]);
  assert.equal(rows.find((r) => r.id === 'agentgroup:Instructions').kind, 'scope');
  assert.equal(rows.find((r) => r.id === 'claude-memory-x/MEMORY.md').label, 'showmd (current)');
  assert.equal(rows.find((r) => r.id === 'claude-memory-x/MEMORY.md').title, '/Users/x/showmd');
  assert.equal(rows.find((r) => r.id === 'claude-home/CLAUDE.md').depth, 1);
  assert.equal(rows.find((r) => r.id === 'claude-memory-x/MEMORY.md').depth, 1);
  assert.equal(rows.find((r) => r.id === 'claude-memory-x/notes.md').depth, 2);
});

test('agent tree: collapsing a group hides its files; collapsing a project hides only its nested files', () => {
  const rows = visibleRows(agentModel, { collapsed: new Set(['agentgroup:Instructions', 'agentproject:other-repo']) });
  assert.deepEqual(ids(rows), ['agentgroup:Instructions', 'agentgroup:Memories', 'claude-memory-x/MEMORY.md', 'claude-memory-x/notes.md', 'claude-memory-y/MEMORY.md']);
});

test('nested file rows are marked so all three views can share one indent rule', () => {
  assert.equal(visibleRows(filesModel).find((r) => r.id === 'notes/one.md').nested, true);
  assert.equal(visibleRows(filesModel).find((r) => r.id === 'a.md').nested, false);
  assert.equal(visibleRows(skillsModel).find((r) => r.id === 'repo/alpha/a.md').nested, true);
  const rows = visibleRows(agentModel);
  assert.equal(rows.find((r) => r.id === 'claude-home/CLAUDE.md').nested, true);
  assert.equal(rows.find((r) => r.id === 'claude-memory-x/notes.md').nested, true);
});

test('initial collapse shuts Memories by default but leaves Instructions open', () => {
  const collapsed = initialCollapsed(agentModel);
  assert.equal(collapsed.has('agentgroup:Memories'), true);
  assert.equal(collapsed.has('agentgroup:Instructions'), false);
});

test('initial collapse also shuts each project inside Memories, so a first expand shows only project rows', () => {
  const collapsed = initialCollapsed(agentModel);
  assert.equal(collapsed.has('agentproject:showmd'), true);
  assert.equal(collapsed.has('agentproject:other-repo'), true);
  // simulate expanding the Memories group itself: its projects stay shut
  collapsed.delete('agentgroup:Memories');
  const rows = visibleRows(agentModel, { collapsed });
  assert.deepEqual(ids(rows).filter((id) => id.startsWith('claude-memory')), [
    'claude-memory-x/MEMORY.md', 'claude-memory-y/MEMORY.md',
  ]);
});

test('agent tree: a query drops the grouping and returns a flat filtered list, same as doc-mode search', () => {
  const rows = visibleRows(agentModel, { query: 'CLAUDE.md' });
  assert.deepEqual(ids(rows), ['claude-home/CLAUDE.md']);
});

test('agent tree search matches the trimmed project label, not the slugified doc id', () => {
  const rows = visibleRows(agentModel, { query: 'showmd' });
  assert.deepEqual(ids(rows), ['claude-memory-x/MEMORY.md', 'claude-memory-x/notes.md']);
});

test('agent tree search matches a file label directly, unrelated to its project', () => {
  const rows = visibleRows(agentModel, { query: 'notes' });
  assert.deepEqual(ids(rows), ['claude-memory-x/notes.md', 'claude-memory-y/notes.md']);
});

test('nextNav initializes collapse once, expands files, and preserves manual toggles', () => {
  let nav = INITIAL_NAV;
  nav = nextNav(nav, { type: 'sync-rows' }, { model: skillsModel, file: 'repo/alpha/a.md' });
  assert.equal(nav.initialized, true);
  assert.equal(nav.expandedFor, 'repo/alpha/a.md');
  assert.equal(nav.collapsed.has('scope:Project'), false);
  assert.equal(nav.collapsed.has('skill:repo/beta/SKILL.md'), true);

  nav = nextNav(nav, { type: 'toggle', nodeId: 'skill:repo/beta/SKILL.md' });
  nav = nextNav(nav, { type: 'sync-rows' }, { model: skillsModel, file: 'repo/alpha/a.md' });
  assert.equal(nav.collapsed.has('skill:repo/beta/SKILL.md'), false, 'sync must not reinitialize and clobber a manual toggle');

  nav = nextNav(nav, { type: 'sync-rows' }, { model: skillsModel, file: 'local/solo/SKILL.md' });
  assert.equal(nav.expandedFor, 'local/solo/SKILL.md');
  assert.equal(nav.collapsed.has('skill:local/solo/SKILL.md'), false);
});

test('nextNav reset initializes the next model from its own collapse flags', () => {
  let nav = nextNav(INITIAL_NAV, { type: 'sync-rows' }, { model: agentModel });
  assert.equal(nav.collapsed.has('agentgroup:Memories'), true);
  nav = nextNav(nav, { type: 'toggle', nodeId: 'agentgroup:Memories' });
  nav = nextNav(nav, { type: 'sync-rows' }, { model: agentModel });
  assert.equal(nav.collapsed.has('agentgroup:Memories'), false);
  nav = nextNav(nav, { type: 'reset' });
  nav = nextNav(nav, { type: 'sync-rows' }, { model: agentModel });
  assert.equal(nav.collapsed.has('agentgroup:Memories'), true);
});

test('nextNav toggle flips a node without touching selection; toggle can also carry a new selection in one step', () => {
  let nav = { ...INITIAL_NAV, selected: 'a.md' };
  nav = nextNav(nav, { type: 'toggle', nodeId: 'dir:notes/' });
  assert.equal(nav.collapsed.has('dir:notes/'), true);
  assert.equal(nav.selected, 'a.md');

  nav = nextNav(nav, { type: 'toggle', nodeId: 'dir:notes/', selected: 'notes/one.md' });
  assert.equal(nav.collapsed.has('dir:notes/'), false);
  assert.equal(nav.selected, 'notes/one.md');
});

test('nextNav select is a no-op record when the id is unchanged, and a plain replace otherwise', () => {
  const nav = { ...INITIAL_NAV, selected: 'a.md' };
  assert.equal(nextNav(nav, { type: 'select', id: 'a.md' }), nav);
  assert.equal(nextNav(nav, { type: 'select', id: 'z.md' }).selected, 'z.md');
});

test('nextNav query replaces query and leaves rows for the next sync-rows to recompute', () => {
  const nav = nextNav(INITIAL_NAV, { type: 'query', query: 'note' });
  assert.equal(nav.query, 'note');
  const synced = nextNav(nav, { type: 'sync-rows' }, { model: filesModel });
  assert.deepEqual(ids(synced.rows), ['notes/one.md', 'notes/two.md']);
  const cleared = nextNav(synced, { type: 'query', query: '' });
  const resynced = nextNav(cleared, { type: 'sync-rows' }, { model: filesModel });
  assert.deepEqual(ids(resynced.rows), ['a.md', 'z.md', 'dir:notes/', 'notes/one.md', 'notes/two.md']);
});
