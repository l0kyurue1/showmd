import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import '../helpers/isolate-state.mjs';

const require = createRequire(import.meta.url);
const { createServer } = require('../../server/server.js');

function stubPickerFactory(pick) {
  return () => ({ warm() {}, pick, ensureApp: () => Promise.resolve() });
}

async function withServer(folderPickerFactory, fn) {
  const server = createServer(null, { folderPickerFactory });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    await server.whenClosed();
  }
}

function postPickFolder(base, body) {
  return fetch(`${base}/api/pick-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /api/pick-folder: a picked path is returned as {path}', async () => {
  const calls = [];
  await withServer(stubPickerFactory(async (mode, startDir) => { calls.push([mode, startDir]); return '/Users/me/picked'; }), async (base) => {
    const res = await postPickFolder(base, { mode: 'folder', startDir: '/Users/me' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { path: '/Users/me/picked' });
    assert.deepEqual(calls, [['folder', '/Users/me']]);
  });
});

test('POST /api/pick-folder: a canceled dialog (picker returns null) reports {canceled:true}', async () => {
  await withServer(stubPickerFactory(async () => null), async (base) => {
    const res = await postPickFolder(base, { mode: 'file' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { canceled: true });
  });
});

test('POST /api/pick-folder: an unsupported platform (picker returns undefined) is a 501, not a crash', async () => {
  await withServer(stubPickerFactory(async () => undefined), async (base) => {
    const res = await postPickFolder(base, { mode: 'folder' });
    assert.equal(res.status, 501);
  });
});

test('POST /api/pick-folder: a picker error is a clean 500, not a crash', async () => {
  await withServer(stubPickerFactory(async () => { throw new Error('boom'); }), async (base) => {
    const res = await postPickFolder(base, { mode: 'file' });
    assert.equal(res.status, 500);
  });
});

test('POST /api/pick-folder: an invalid mode is rejected before the picker is ever called', async () => {
  const calls = [];
  await withServer(stubPickerFactory(async (mode) => { calls.push(mode); return null; }), async (base) => {
    const res = await postPickFolder(base, { mode: 'nonsense' });
    assert.equal(res.status, 400);
    assert.deepEqual(calls, []);
  });
});

test('POST /api/pick-folder: it mutates no root state — GET /api/roots still lists none', async () => {
  await withServer(stubPickerFactory(async () => '/Users/me/picked'), async (base) => {
    await postPickFolder(base, { mode: 'folder' });
    const roots = await (await fetch(`${base}/api/roots`)).json();
    assert.deepEqual(roots.roots, []);
  });
});
