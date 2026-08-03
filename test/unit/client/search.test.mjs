import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterFiles, filterSkillsTree } from '../../../client/search.js';

test('filterFiles: multi-term query requires every term to match', () => {
  const paths = ['guides/auth-setup.md', 'guides/auth.md', 'guides/billing.md'];
  assert.deepEqual(filterFiles(paths, 'auth setup'), ['guides/auth-setup.md']);
});

test('filterFiles: basename matches rank above path-only matches', () => {
  const paths = ['auth/README.md', 'billing/auth-notes.md'];
  const result = filterFiles(paths, 'auth');
  assert.deepEqual(result, ['billing/auth-notes.md', 'auth/README.md']);
});

test('filterFiles: zero matches returns an empty array', () => {
  assert.deepEqual(filterFiles(['a.md', 'b.md'], 'nope'), []);
});

test('filterFiles: empty query returns the full tree', () => {
  const paths = ['a.md', 'b.md', 'c.md'];
  assert.deepEqual(filterFiles(paths, ''), paths);
  assert.deepEqual(filterFiles(paths, '   '), paths);
});

function makeSkill(id, name, files) {
  return { id, name, files: files.map((label) => ({ id: `${id}/${label}`, label })) };
}

function sampleTree() {
  return {
    scopes: [
      {
        name: 'Global',
        groups: [
          { source: 'plugin-a', skills: [makeSkill('a/SKILL.md', 'auth-helper', ['SKILL.md', 'setup.md'])] },
        ],
        skills: [makeSkill('local/SKILL.md', 'billing', ['SKILL.md', 'notes.md'])],
      },
    ],
  };
}

test('filterSkillsTree: empty query returns the original tree unchanged', () => {
  const tree = sampleTree();
  assert.equal(filterSkillsTree(tree, ''), tree);
});

test('filterSkillsTree: skill name match keeps all its files, file match keeps only matching files', () => {
  const tree = sampleTree();
  const filtered = filterSkillsTree(tree, 'auth');
  assert.equal(filtered.scopes.length, 1);
  assert.equal(filtered.scopes[0].groups[0].skills[0].files.length, 2);
  assert.equal(filtered.scopes[0].skills.length, 0);

  const byFile = filterSkillsTree(tree, 'notes');
  assert.equal(byFile.scopes[0].groups.length, 0);
  assert.deepEqual(byFile.scopes[0].skills[0].files.map((f) => f.label), ['notes.md']);
});

test('filterSkillsTree: zero matches drops empty groups and scopes without mutating the source', () => {
  const tree = sampleTree();
  const filtered = filterSkillsTree(tree, 'does-not-exist');
  assert.deepEqual(filtered.scopes, []);
  assert.equal(tree.scopes[0].groups[0].skills.length, 1);
  assert.equal(tree.scopes[0].skills.length, 1);
});
