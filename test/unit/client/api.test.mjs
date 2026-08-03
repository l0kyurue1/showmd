import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../../client/api.js';

function stubFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    calls.push([url, opts]);
    return Promise.resolve(response);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('raw/history/diff/restore build the same query strings the call sites used to hand-roll', async () => {
  const f = stubFetch();
  try {
    await api.raw('a b.md');
    await api.history('a b.md');
    await api.diff('a b.md', '3', false);
    await api.diff('a b.md', '3', true);
    await api.restore('a b.md', '3', true);
    assert.deepEqual(f.calls.map((c) => c[0]), [
      '/api/raw?path=a%20b.md',
      '/api/history?path=a%20b.md',
      '/api/diff?path=a%20b.md&rev=3',
      '/api/diff?path=a%20b.md&rev=3&repo=1',
      '/api/restore?path=a%20b.md&rev=3&repo=1',
    ]);
    assert.equal(f.calls.at(-1)[1].method, 'POST');
  } finally {
    f.restore();
  }
});

test('treeAgents and treeSkills hit the view-scoped tree endpoint', async () => {
  const f = stubFetch();
  try {
    await api.treeAgents('claude');
    await api.treeSkills();
    assert.deepEqual(f.calls.map((c) => c[0]), [
      '/api/tree?view=agents&agent=claude',
      '/api/tree?view=skills',
    ]);
  } finally {
    f.restore();
  }
});

test('putSettings and pickRoot send JSON bodies with the right headers', async () => {
  const f = stubFetch();
  try {
    await api.putSettings({ fontSize: 16 });
    await api.pickRoot({ dir: '/tmp' });
    const [url1, opts1] = f.calls[0];
    assert.equal(url1, '/api/settings');
    assert.equal(opts1.method, 'PUT');
    assert.equal(opts1.headers['Content-Type'], 'application/json');
    assert.equal(opts1.body, JSON.stringify({ fontSize: 16 }));
    const [url2, opts2] = f.calls[1];
    assert.equal(url2, '/api/pick-root');
    assert.equal(opts2.body, JSON.stringify({ dir: '/tmp' }));
  } finally {
    f.restore();
  }
});

test('putRaw normalizes a failed save into a thrown error, matching the old inline put', async () => {
  const f = stubFetch({ ok: false, status: 500 });
  try {
    await assert.rejects(() => api.putRaw('doc.md', 'text'), /save failed: 500/);
  } finally {
    f.restore();
  }
});

test('putRaw resolves quietly on a successful save', async () => {
  const f = stubFetch({ ok: true, status: 200 });
  try {
    await assert.doesNotReject(() => api.putRaw('doc.md', 'text'));
  } finally {
    f.restore();
  }
});

test('reveal builds settings vs path targets, and skips the request when neither is given', async () => {
  const f = stubFetch();
  try {
    await api.reveal({ settings: true });
    await api.reveal({ path: 'a b.md' });
    assert.equal(api.reveal({}), null);
    assert.deepEqual(f.calls.map((c) => c[0]), [
      '/api/reveal?settings=1',
      '/api/reveal?path=a%20b.md',
    ]);
    assert.equal(f.calls[0][1].method, 'POST');
  } finally {
    f.restore();
  }
});

test('ping is a thin passthrough used for liveness polling of arbitrary URLs', async () => {
  const f = stubFetch();
  try {
    await api.ping('http://127.0.0.1:4000/api/settings', { mode: 'no-cors', cache: 'no-store' });
    assert.deepEqual(f.calls[0], [
      'http://127.0.0.1:4000/api/settings',
      { mode: 'no-cors', cache: 'no-store' },
    ]);
  } finally {
    f.restore();
  }
});
