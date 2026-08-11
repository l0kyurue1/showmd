import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../../client/api.js';

const KEY = 'r_AAAAAAAAAAAAAAAAAAAAAA';

function stubFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    calls.push([url, opts]);
    return Promise.resolve(response);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('root space: the document verbs build root-scoped URLs under /api/roots/<key>/...', async () => {
  const f = stubFetch();
  const root = api.documentApi({ space: 'root', rootKey: KEY });
  try {
    await root.raw('a b.md');
    await root.history('a b.md');
    await root.diff('a b.md', '3', false);
    await root.diff('a b.md', '3', true);
    await root.restore('a b.md', '3', true);
    await root.reveal('a b.md');
    assert.deepEqual(f.calls.map((c) => c[0]), [
      `/api/roots/${KEY}/raw?path=a%20b.md`,
      `/api/roots/${KEY}/history?path=a%20b.md`,
      `/api/roots/${KEY}/diff?path=a%20b.md&rev=3`,
      `/api/roots/${KEY}/diff?path=a%20b.md&rev=3&repo=1`,
      `/api/roots/${KEY}/restore?path=a%20b.md&rev=3&repo=1`,
      `/api/roots/${KEY}/reveal?path=a%20b.md`,
    ]);
    assert.equal(f.calls.at(-1)[1].method, 'POST');
  } finally {
    f.restore();
  }
});

test('tree sends a scope query only when a scopePath is given', async () => {
  const f = stubFetch();
  const root = api.documentApi({ space: 'root', rootKey: KEY });
  try {
    await root.tree();
    await root.tree({ scope: 'docs/sub' });
    assert.deepEqual(f.calls.map((c) => c[0]), [
      `/api/roots/${KEY}/tree`,
      `/api/roots/${KEY}/tree?scope=docs%2Fsub`,
    ]);
  } finally {
    f.restore();
  }
});

test('assetUrl builds the same shape as raw, without fetching', () => {
  const root = api.documentApi({ space: 'root', rootKey: KEY });
  assert.equal(root.assetUrl('docs/logo.png'), `/api/roots/${KEY}/asset?path=docs%2Flogo.png`);
});

test('skills space: every request carries its own selection', async () => {
  const f = stubFetch();
  try {
    await api.documentApi({ space: 'skills', selection: 'global' }).tree();
    await api.documentApi({ space: 'skills', selection: 'all' }).tree();
    await api.documentApi({ space: 'skills', selection: 'root', rootKey: KEY }).raw('agents/demo/SKILL.md');
    await api.documentApi({ space: 'skills', selection: 'context', contextKey: 'sc_x' }).diff('agents/demo/SKILL.md', '3', true);
    assert.deepEqual(f.calls.map((c) => c[0]), [
      '/api/skills/tree',
      '/api/skills/tree?scope=all',
      `/api/skills/raw?root=${KEY}&id=agents%2Fdemo%2FSKILL.md`,
      '/api/skills/diff?context=sc_x&id=agents%2Fdemo%2FSKILL.md&rev=3&repo=1',
    ]);
  } finally {
    f.restore();
  }
});

test('agents space: the agent key is in the path and the project root stays explicit', async () => {
  const f = stubFetch();
  try {
    await api.documentApi({ space: 'agents', agentKey: 'claude' }).tree();
    await api.documentApi({ space: 'agents', agentKey: 'codex', rootKey: KEY }).raw('codex-home/AGENTS.md');
    assert.deepEqual(f.calls.map((c) => c[0]), [
      '/api/agents/claude/tree',
      `/api/agents/codex/raw?root=${KEY}&id=codex-home%2FAGENTS.md`,
    ]);
  } finally {
    f.restore();
  }
});

test('putSettings sends a JSON body with the right headers', async () => {
  const f = stubFetch();
  try {
    await api.putSettings({ fontSize: 16 });
    const [url1, opts1] = f.calls[0];
    assert.equal(url1, '/api/settings');
    assert.equal(opts1.method, 'PUT');
    assert.equal(opts1.headers['Content-Type'], 'application/json');
    assert.equal(opts1.body, JSON.stringify({ fontSize: 16 }));
  } finally {
    f.restore();
  }
});

test('putRaw normalizes a failed save into a thrown error, matching the old inline put', async () => {
  const f = stubFetch({ ok: false, status: 500 });
  try {
    await assert.rejects(() => api.documentApi({ space: 'root', rootKey: KEY }).putRaw('doc.md', 'text'), /save failed: 500/);
  } finally {
    f.restore();
  }
});

test('putRaw resolves quietly on a successful save', async () => {
  const f = stubFetch({ ok: true, status: 200 });
  try {
    await assert.doesNotReject(() => api.documentApi({ space: 'root', rootKey: KEY }).putRaw('doc.md', 'text'));
  } finally {
    f.restore();
  }
});

test('revealSettings targets the settings file, not a document', async () => {
  const f = stubFetch();
  try {
    await api.revealSettings();
    assert.equal(f.calls[0][0], '/api/reveal?settings=1');
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

test('addRoot POSTs {path} to /api/roots', async () => {
  const f = stubFetch();
  try {
    await api.addRoot('/Users/me/proj');
    assert.equal(f.calls[0][0], '/api/roots');
    assert.equal(f.calls[0][1].method, 'POST');
    assert.deepEqual(JSON.parse(f.calls[0][1].body), { path: '/Users/me/proj' });
  } finally {
    f.restore();
  }
});

test('pickFolder POSTs the given mode/startDir to /api/pick-folder', async () => {
  const f = stubFetch();
  try {
    await api.pickFolder({ mode: 'folder', startDir: '/Users/me' });
    assert.equal(f.calls[0][0], '/api/pick-folder');
    assert.equal(f.calls[0][1].method, 'POST');
    assert.deepEqual(JSON.parse(f.calls[0][1].body), { mode: 'folder', startDir: '/Users/me' });
  } finally {
    f.restore();
  }
});

test('listRoots GETs /api/roots', async () => {
  const f = stubFetch();
  try {
    await api.listRoots();
    assert.deepEqual(f.calls[0], ['/api/roots', undefined]);
  } finally {
    f.restore();
  }
});
