import test from 'node:test';
import assert from 'node:assert/strict';
import { pollUntilUp, followRestart } from '../../../client/restart-follow.js';

function stubFetch(handler) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = realFetch; };
}

function stubWindow(loc) {
  const realWindow = globalThis.window;
  globalThis.window = { location: { protocol: 'http:', hostname: '127.0.0.1', pathname: '/', search: '', hash: '', ...loc } };
  return () => { globalThis.window = realWindow; };
}

test('pollUntilUp same-origin: resolves true on the first ok response', async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return { ok: true, status: 200 }; });
  try {
    const ok = await pollUntilUp('/api/settings', true, 5);
    assert.equal(ok, true);
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test('pollUntilUp cross-origin: a resolved no-cors fetch counts as up even though its body is opaque', async () => {
  // cross-origin path never inspects the response — a fetch that merely
  // resolves (not rejects) is success, regardless of shape
  const restore = stubFetch(async () => ({}));
  try {
    const ok = await pollUntilUp('http://127.0.0.1:9/api/settings', false, 5);
    assert.equal(ok, true);
  } finally {
    restore();
  }
});

test('pollUntilUp: gives up after the attempt budget when the port never answers', async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls++; throw new Error('ECONNREFUSED'); });
  try {
    const ok = await pollUntilUp('/api/settings', true, 3);
    assert.equal(ok, false);
    assert.equal(calls, 3);
  } finally {
    restore();
  }
});

test('followRestart: same port polls the current origin and never navigates', async () => {
  const restoreWindow = stubWindow({ port: '4321' });
  const restoreFetch = stubFetch(async () => ({ ok: true, status: 200 }));
  try {
    const result = await followRestart(4321, { pathname: '/a', search: '', hash: '' }, 5);
    assert.deepEqual(result, { ok: true, samePort: true });
    assert.equal(globalThis.window.location.href, undefined, 'same-port success must not navigate');
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test('followRestart: a port change polls the new origin, then navigates preserving pathname, search and hash', async () => {
  const restoreWindow = stubWindow({ port: '4321' });
  const restoreFetch = stubFetch(async () => ({}));
  try {
    const result = await followRestart(4322, { pathname: '/r/abc/doc.md', search: '?x=1', hash: '#L10' }, 5);
    assert.deepEqual(result, { ok: true, samePort: false });
    assert.equal(globalThis.window.location.href, 'http://127.0.0.1:4322/r/abc/doc.md?x=1#L10');
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test('followRestart: give-up path — the replacement never answers, so it resolves ok:false without navigating', async () => {
  const restoreWindow = stubWindow({ port: '4321' });
  const restoreFetch = stubFetch(async () => { throw new Error('ECONNREFUSED'); });
  try {
    const result = await followRestart(4322, { pathname: '/', search: '', hash: '' }, 2);
    assert.deepEqual(result, { ok: false, samePort: false });
    assert.equal(globalThis.window.location.href, undefined);
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test('followRestart: concurrent calls for the same restart share one in-flight poll', async () => {
  const restoreWindow = stubWindow({ port: '4321' });
  let calls = 0;
  const restoreFetch = stubFetch(async () => { calls++; return { ok: true, status: 200 }; });
  try {
    const [a, b] = await Promise.all([
      followRestart(4321, { pathname: '/', search: '', hash: '' }, 5),
      followRestart(4321, { pathname: '/', search: '', hash: '' }, 5),
    ]);
    assert.deepEqual(a, { ok: true, samePort: true });
    assert.deepEqual(b, { ok: true, samePort: true });
    assert.equal(calls, 1, 'only one poll loop actually ran');
  } finally {
    restoreFetch();
    restoreWindow();
  }
});
