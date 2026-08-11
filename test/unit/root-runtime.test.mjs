import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { createRootRuntime } = await import('../../server/root-runtime.js');

function fakeScheduler() {
  let nextId = 1;
  const pending = new Map();
  return {
    pending,
    setTimer(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimer(id) { pending.delete(id); },
    async run(id) {
      const fn = pending.get(id);
      pending.delete(id);
      await fn();
    },
  };
}

function fakeStore(overrides = {}) {
  return {
    ignorePath: () => false,
    idFor: (_root, full) => full.split('/').at(-1),
    recordIfExternal: async () => {},
    beginClose() {},
    async drain() {},
    ...overrides,
  };
}

test('RootRuntime owns one relative files store and debounces watcher work by document', async () => {
  const root = { key: 'r_example', dir: '/root', name: 'root' };
  const scheduler = fakeScheduler();
  const watcher = new EventEmitter();
  watcher.close = async () => {};
  const created = [];
  const records = [];
  const changes = [];

  const runtime = createRootRuntime(root, {
    createStore(roots, config) {
      created.push({ roots, config });
      return fakeStore({
        recordIfExternal: async (id) => { records.push(id); },
      });
    },
    createWatchers({ onDocument }) {
      watcher.on('all', onDocument);
      return [watcher];
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    onChange: (change) => changes.push(change),
  });

  assert.equal(runtime.root, root);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    roots: [{ key: null, dir: '/root', label: null }],
    config: { addressing: 'relative' },
  });

  watcher.emit('all', 'change', '/root/note.md');
  const firstTimer = [...scheduler.pending.keys()][0];
  watcher.emit('all', 'add', '/root/note.md');
  assert.equal(scheduler.pending.has(firstTimer), false, 'the later event replaces the earlier debounce');
  assert.equal(scheduler.pending.size, 1);

  await scheduler.run([...scheduler.pending.keys()][0]);
  assert.deepEqual(changes, [{ root, path: 'note.md', event: 'add' }]);
  assert.deepEqual(records, ['note.md']);
});

test('RootRuntime close is idempotent, cancels debounce, suppresses late events, and awaits owned work', async () => {
  const root = { key: 'r_example', dir: '/root', name: 'root' };
  const scheduler = fakeScheduler();
  const watcher = new EventEmitter();
  const calls = [];
  let skillInvalidations = 0;
  let emitSkillsChange;
  let releaseWatcher;
  let releaseDrain;
  watcher.close = () => new Promise((resolve) => { releaseWatcher = () => { calls.push('watcher closed'); resolve(); }; });
  const store = fakeStore({
    beginClose() { calls.push('admission closed'); },
    drain: () => new Promise((resolve) => { releaseDrain = () => { calls.push('store drained'); resolve(); }; }),
  });

  const runtime = createRootRuntime(root, {
    createStore: () => store,
    createWatchers({ onDocument, onSkillsChange }) {
      watcher.on('all', onDocument);
      emitSkillsChange = onSkillsChange;
      return [watcher];
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    onSkillsChange: () => { skillInvalidations += 1; },
  });

  watcher.emit('all', 'change', '/root/note.md');
  assert.equal(scheduler.pending.size, 1);

  const closing = runtime.close();
  assert.equal(runtime.close(), closing);
  assert.deepEqual(calls, ['admission closed']);
  assert.equal(scheduler.pending.size, 0);

  watcher.emit('all', 'change', '/root/late.md');
  emitSkillsChange();
  assert.equal(scheduler.pending.size, 0, 'late watcher callbacks are suppressed');
  assert.equal(skillInvalidations, 0);

  let closed = false;
  closing.then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);

  releaseWatcher();
  releaseDrain();
  await closing;
  assert.equal(closed, true);
  assert.deepEqual(calls, ['admission closed', 'watcher closed', 'store drained']);
});
