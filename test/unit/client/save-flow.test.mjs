import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaveFlow, SAVE_DEBOUNCE_MS } from '../../../client/save-flow.js';

// one pending timer at a time is all the flow ever schedules, so a single slot
// is enough to stand in for setTimeout/clearTimeout
function harness({ buffer = 'a', put } = {}) {
  const puts = [];
  const chip = [];
  let pending = null;
  let delay = null;
  const flow = createSaveFlow({
    put: put || (async (text) => { puts.push(text); }),
    read: () => buffer,
    onState: (kind, text, title) => chip.push([kind, text, title]),
    timers: {
      set: (fn, ms) => { pending = fn; delay = ms; return 1; },
      clear: () => { pending = null; },
    },
  });
  return {
    flow,
    puts,
    chip,
    get scheduled() { return pending !== null; },
    get delay() { return delay; },
    type(text) { buffer = text; },
    fire: () => pending(),
  };
}

test('typing marks the document dirty right away', () => {
  const h = harness();
  h.flow.schedule();
  assert.equal(h.flow.dirty, true);
  assert.deepEqual(h.chip.at(-1), ['saving', 'Saving…', '']);
  assert.equal(h.delay, SAVE_DEBOUNCE_MS);
});

test('a burst of keystrokes collapses into one write', async () => {
  const h = harness({ buffer: '' });
  h.type('a');
  h.flow.schedule();
  h.type('ab');
  h.flow.schedule();
  h.type('abc');
  h.flow.schedule();
  await h.fire();
  assert.deepEqual(h.puts, ['abc']);
  assert.equal(h.flow.dirty, false);
  assert.deepEqual(h.chip.at(-1), ['saved', 'Saved', '']);
});

test('the debounced save is cancelled once it has run', async () => {
  const h = harness({ buffer: 'x' });
  h.flow.schedule();
  await h.fire();
  assert.equal(h.scheduled, false);
});

test('a buffer that matches disk settles the chip without a request', async () => {
  const h = harness({ buffer: 'same' });
  h.flow.adopt('same');
  h.flow.setDirty(true);
  await h.flow.flush();
  assert.deepEqual(h.puts, []);
  assert.equal(h.flow.dirty, false);
  assert.deepEqual(h.chip.at(-1), ['saved', 'Saved', '']);
});

test('nothing to save from is a no-op, not an empty write', async () => {
  const h = harness({ buffer: null });
  await h.flow.flush();
  assert.deepEqual(h.puts, []);
  assert.deepEqual(h.chip, []);
});

test('a failed write keeps the document dirty and says why', async () => {
  const h = harness({ buffer: 'new', put: async () => { throw new Error('save failed: 500'); } });
  h.flow.schedule();
  await h.fire();
  assert.equal(h.flow.dirty, true);
  assert.deepEqual(h.chip.at(-1), ['error', 'Save failed', 'save failed — save failed: 500']);
  assert.equal(h.flow.savedContent, '');
});

test('a failed write leaves the next attempt free to retry the same text', async () => {
  let fail = true;
  const h = harness({ buffer: 'new', put: async (text) => { if (fail) throw new Error('boom'); h.puts.push(text); } });
  await h.flow.flush();
  fail = false;
  await h.flow.flush();
  assert.deepEqual(h.puts, ['new']);
  assert.equal(h.flow.savedContent, 'new');
});

test('only a written text becomes the saved copy', async () => {
  const h = harness({ buffer: 'typed' });
  await h.flow.write('typed');
  assert.equal(h.flow.savedContent, 'typed');
});

test('adopting content the server already has moves the copy, not the chip', () => {
  const h = harness();
  h.flow.adopt('from disk');
  assert.equal(h.flow.savedContent, 'from disk');
  assert.equal(h.flow.dirty, false);
  assert.deepEqual(h.chip, []);
});

test('staging an external edit then resolving as reload adopts it as saved', () => {
  const h = harness();
  h.flow.stageExternal('from disk v2');
  const text = h.flow.resolveExternal('reload');
  assert.equal(text, 'from disk v2');
  assert.equal(h.flow.savedContent, 'from disk v2');
  assert.equal(h.flow.pendingExternal, null);
});

test('resolving a staged external edit as keep discards it without adopting', () => {
  const h = harness();
  h.flow.adopt('original');
  h.flow.stageExternal('from disk v2');
  const text = h.flow.resolveExternal('keep');
  assert.equal(text, 'from disk v2');
  assert.equal(h.flow.savedContent, 'original');
  assert.equal(h.flow.pendingExternal, null);
});

test('switching files clears a staged external edit', () => {
  const h = harness();
  h.flow.stageExternal('stale text for the file being left');
  h.flow.resolveExternal('keep');
  assert.equal(h.flow.pendingExternal, null);
});

test('isDirty and matchesSaved mirror the internal fields', () => {
  const h = harness();
  h.flow.adopt('on disk');
  assert.equal(h.flow.isDirty(), false);
  assert.equal(h.flow.matchesSaved('on disk'), true);
  assert.equal(h.flow.matchesSaved('typed'), false);
  h.flow.schedule();
  assert.equal(h.flow.isDirty(), true);
});

test('saved returns the current saved copy', () => {
  const h = harness();
  assert.equal(h.flow.saved(), '');
  h.flow.adopt('from disk');
  assert.equal(h.flow.saved(), 'from disk');
});

test('decideExternalUpdate: a clean buffer adopts a successful refetch', () => {
  const h = harness();
  const outcome = h.flow.decideExternalUpdate({ ok: true, text: 'from disk', dirty: false });
  assert.deepEqual(outcome, { action: 'adopt', text: 'from disk' });
});

test('decideExternalUpdate: a dirty buffer stages a successful refetch', () => {
  const h = harness();
  const outcome = h.flow.decideExternalUpdate({ ok: true, text: 'from disk', dirty: true });
  assert.deepEqual(outcome, { action: 'stage', text: 'from disk' });
});

test('decideExternalUpdate: text identical to the saved copy is a no-op', () => {
  const h = harness();
  h.flow.adopt('same');
  const clean = h.flow.decideExternalUpdate({ ok: true, text: 'same', dirty: false });
  assert.deepEqual(clean, { action: 'ignore', text: null });
  const dirty = h.flow.decideExternalUpdate({ ok: true, text: 'same', dirty: true });
  assert.deepEqual(dirty, { action: 'ignore', text: null });
});

for (const label of ['404', '500', '403']) {
  test(`decideExternalUpdate: a ${label} response never adopts or stages`, () => {
    const h = harness();
    const clean = h.flow.decideExternalUpdate({ ok: false, text: null, dirty: false });
    assert.deepEqual(clean, { action: 'error', text: null });
    const dirty = h.flow.decideExternalUpdate({ ok: false, text: null, dirty: true });
    assert.deepEqual(dirty, { action: 'error', text: null });
  });
}

test('decideExternalUpdate: a network failure (no response) is also an error, not empty content', () => {
  const h = harness();
  const outcome = h.flow.decideExternalUpdate({ ok: false, text: null, dirty: false });
  assert.deepEqual(outcome, { action: 'error', text: null });
});

test('decideExternalUpdate: a non-ok response never surfaces "" as text to adopt or stage', () => {
  const h = harness();
  h.flow.adopt('real content still on disk');
  const outcome = h.flow.decideExternalUpdate({ ok: false, text: '', dirty: false });
  assert.equal(outcome.action, 'error');
  assert.notEqual(outcome.text, '');
});

test('bindUnloadFlush: hiding a dirty document flushes it', async () => {
  const h = harness({ buffer: 'unsaved edit' });
  h.flow.schedule();
  const docHandlers = {};
  const winHandlers = {};
  const doc = {
    visibilityState: 'hidden',
    addEventListener: (name, fn) => { docHandlers[name] = fn; },
  };
  const win = {
    addEventListener: (name, fn) => { winHandlers[name] = fn; },
  };
  h.flow.bindUnloadFlush(doc, win);
  await docHandlers.visibilitychange();
  assert.deepEqual(h.puts, ['unsaved edit']);
});

test('bindUnloadFlush: a visible document does not flush', async () => {
  const h = harness({ buffer: 'unsaved edit' });
  h.flow.schedule();
  const doc = { visibilityState: 'visible', addEventListener: (name, fn) => { doc[name] = fn; } };
  const win = { addEventListener: () => {} };
  h.flow.bindUnloadFlush(doc, win);
  await doc.visibilitychange();
  assert.deepEqual(h.puts, []);
});

test('bindUnloadFlush: pagehide flushes only when dirty', async () => {
  const h = harness({ buffer: 'unsaved edit' });
  const winHandlers = {};
  const doc = { visibilityState: 'visible', addEventListener: () => {} };
  const win = { addEventListener: (name, fn) => { winHandlers[name] = fn; } };
  h.flow.bindUnloadFlush(doc, win);
  await winHandlers.pagehide();
  assert.deepEqual(h.puts, []);
  h.flow.schedule();
  await winHandlers.pagehide();
  assert.deepEqual(h.puts, ['unsaved edit']);
});

test('detach: schedule cannot start a write', async () => {
  const h = harness({ buffer: '# forbidden' });
  h.flow.detach();
  h.flow.schedule();
  assert.equal(h.scheduled, false);
  assert.equal(h.flow.dirty, false);
});

test('detach: a flush already pending performs no write', async () => {
  const h = harness({ buffer: 'real content' });
  h.flow.schedule();
  h.flow.detach();
  await h.flow.flush();
  assert.deepEqual(h.puts, []);
});

test('detach: an explicit flush() call performs no write', async () => {
  const h = harness({ buffer: '# forbidden' });
  h.flow.detach();
  await h.flow.flush();
  assert.deepEqual(h.puts, []);
});

test('detach then adopt re-attaches and saving works again', async () => {
  const h = harness({ buffer: 'typed after reload' });
  h.flow.detach();
  h.flow.adopt('real content from server');
  h.flow.schedule();
  await h.fire();
  assert.deepEqual(h.puts, ['typed after reload']);
  assert.equal(h.flow.dirty, false);
});

test('a successfully loaded empty document is still saveable', async () => {
  const h = harness({ buffer: 'typed into empty doc' });
  h.flow.adopt('');
  h.flow.schedule();
  await h.fire();
  assert.deepEqual(h.puts, ['typed into empty doc']);
});

test('detach sets a truthful, non-saved chip state', () => {
  const h = harness();
  h.flow.detach();
  const [kind, text] = h.chip.at(-1);
  assert.notEqual(kind, 'saved');
  assert.notEqual(text, 'Saved');
});

// browsers throw "Illegal invocation" when the native timers run with any
// `this` other than window; Node doesn't care, so emulate the browser check
test('default timers survive a this-sensitive setTimeout', async () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = function (fn) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    fn();
    return 1;
  };
  globalThis.clearTimeout = function () {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
  };
  try {
    const puts = [];
    const flow = createSaveFlow({
      put: async (text) => { puts.push(text); },
      read: () => 'typed',
      onState: () => {},
      delay: 0,
    });
    flow.schedule();
    await Promise.resolve();
    assert.deepEqual(puts, ['typed']);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});
