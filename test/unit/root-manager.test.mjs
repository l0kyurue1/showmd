import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { createRootManager } = await import('../../server/root-manager.js');
const { identifyRoot } = await import('../../server/root-identity.js');

function runtimeFactory(closed = []) {
  return (root) => ({
    root,
    store: { rootKey: root.key },
    async close() { closed.push(root.key); },
  });
}

test('RootManager adds, lists, gets, and removes roots while retaining visibility until close completes', async () => {
  const roots = new Map([
    ['/one', { key: 'r_one', dir: '/one', name: 'one' }],
    ['/two', { key: 'r_two', dir: '/two', name: 'two' }],
  ]);
  let releaseClose;
  const manager = createRootManager({
    identifyRoot: async (dir) => roots.get(dir),
    createRuntime: (root) => ({
      root,
      store: {},
      close: root.key === 'r_one'
        ? () => new Promise((resolve) => { releaseClose = resolve; })
        : async () => {},
    }),
  });

  assert.equal((await manager.add('/one')).kind, 'added');
  assert.equal((await manager.add('/two')).kind, 'added');
  assert.deepEqual(manager.list().map((root) => root.key), ['r_one', 'r_two']);
  assert.equal(manager.get('r_one').dir, '/one');
  assert.equal(manager.getRuntime('r_one').store.rootKey, undefined);

  const removing = manager.remove('r_one');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.get('r_one').key, 'r_one', 'runtime remains visible until shutdown succeeds');
  releaseClose();
  assert.deepEqual(await removing, { removed: true, root: roots.get('/one') });
  assert.equal(manager.get('r_one'), null);
  assert.deepEqual(await manager.remove('r_one'), { removed: false });
});

test('RootManager exact-dedupes aliases and reuses an ancestor root with a concise Scope', async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'showmd-root-manager-'));
  const rootDir = path.join(work, 'project');
  const childDir = path.join(rootDir, 'notes', 'deep');
  const alias = path.join(work, 'alias');
  mkdirSync(childDir, { recursive: true });
  symlinkSync(rootDir, alias);
  const created = [];
  const manager = createRootManager({
    identifyRoot,
    createRuntime(root) {
      created.push(root);
      return { root, store: {}, async close() {} };
    },
  });

  try {
    const added = await manager.add(rootDir);
    const duplicate = await manager.add(alias);
    const descendant = await manager.add(childDir);

    assert.equal(added.kind, 'added');
    assert.equal(duplicate.kind, 'existing');
    assert.equal(duplicate.root, added.root);
    assert.deepEqual(duplicate.scope, { rootKey: added.root.key, scopePath: '' });
    assert.equal(descendant.kind, 'existing');
    assert.deepEqual(descendant.scope, { rootKey: added.root.key, scopePath: 'notes/deep' });
    assert.equal(created.length, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('RootManager keeps same-basename disjoint roots and promotes on an ancestor conflict', async () => {
  const identities = new Map([
    ['/a/project', { key: 'r_a', dir: '/a/project', name: 'project' }],
    ['/b/project', { key: 'r_b', dir: '/b/project', name: 'project' }],
    ['/a', { key: 'r_parent', dir: '/a', name: 'a' }],
  ]);
  const closed = [];
  const manager = createRootManager({
    identifyRoot: async (dir) => identities.get(dir),
    createRuntime: runtimeFactory(closed),
  });

  await manager.add('/a/project');
  await manager.add('/b/project');
  assert.equal(manager.list().length, 2);

  const result = await manager.add('/a');
  assert.equal(result.kind, 'promoted');
  assert.deepEqual(result.root, identities.get('/a'));
  assert.deepEqual(result.scope, { rootKey: 'r_parent', scopePath: '' });
  assert.equal(result.promoted.length, 1);
  assert.deepEqual(result.promoted[0].oldRoot, identities.get('/a/project'));
  assert.deepEqual(result.promoted[0].scope, { rootKey: 'r_parent', scopePath: 'project' });
  assert.deepEqual(closed, ['r_a']);

  const keys = manager.list().map((root) => root.key).sort();
  assert.deepEqual(keys, ['r_b', 'r_parent'], 'the narrower root is gone; the disjoint one and the new parent remain');
});

test('RootManager promotes every narrower root under one new parent in a single operation', async () => {
  const identities = new Map([
    ['/repo/docs', { key: 'r_docs', dir: '/repo/docs', name: 'docs' }],
    ['/repo/src', { key: 'r_src', dir: '/repo/src', name: 'src' }],
    ['/repo', { key: 'r_repo', dir: '/repo', name: 'repo' }],
  ]);
  const closed = [];
  const manager = createRootManager({
    identifyRoot: async (dir) => identities.get(dir),
    createRuntime: runtimeFactory(closed),
  });

  await manager.add('/repo/docs');
  await manager.add('/repo/src');
  const result = await manager.add('/repo');

  assert.equal(result.kind, 'promoted');
  assert.equal(result.promoted.length, 2);
  const promotedKeys = result.promoted.map((p) => p.oldRoot.key).sort();
  assert.deepEqual(promotedKeys, ['r_docs', 'r_src']);
  assert.deepEqual(closed.sort(), ['r_docs', 'r_src']);
  assert.deepEqual(manager.list().map((root) => root.key), ['r_repo']);
});

test('RootManager rejects a key collision after comparing canonical directories', async () => {
  const identities = new Map([
    ['/one', { key: 'r_collision', dir: '/one', name: 'one' }],
    ['/two', { key: 'r_collision', dir: '/two', name: 'two' }],
  ]);
  const manager = createRootManager({
    identifyRoot: async (dir) => identities.get(dir),
    createRuntime: runtimeFactory(),
  });

  await manager.add('/one');
  await assert.rejects(
    () => manager.add('/two'),
    (err) => err.code === 'ROOT_KEY_COLLISION' && err.key === 'r_collision',
  );
  assert.equal(manager.list().length, 1);
});

test('RootManager serializes concurrent mutations so one canonical root creates one runtime', async () => {
  const root = { key: 'r_one', dir: '/one', name: 'one' };
  let releaseIdentity;
  const blocked = new Promise((resolve) => { releaseIdentity = resolve; });
  let identifies = 0;
  let runtimes = 0;
  const manager = createRootManager({
    async identifyRoot() {
      identifies += 1;
      if (identifies === 1) await blocked;
      return root;
    },
    createRuntime(value) {
      runtimes += 1;
      return { root: value, store: {}, async close() {} };
    },
  });

  const first = manager.add('/one');
  const second = manager.add('/one');
  releaseIdentity();
  const outcomes = await Promise.all([first, second]);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['added', 'existing']);
  assert.equal(runtimes, 1);
});
