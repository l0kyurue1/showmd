import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import '../helpers/isolate-state.mjs';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createServer } = require('../../server/server.js');
const { CAPABILITIES } = require('../../server/protocol.js');

function tmp(prefix) {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

async function withServer(root, fn, extra = {}) {
  const server = createServer(root, extra);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    await server.whenClosed();
  }
}

test('GET /api/version: single-root server reports core shape fields', async () => {
  const root = tmp('showmd-version-single-');
  try {
    writeFileSync(path.join(root, 'a.md'), '# a\n');
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/version`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.launcher, false);
      assert.equal(body.protocol, 1);
      assert.match(body.instanceId, /^[0-9a-f-]{36}$/);
      assert.equal(new Date(body.startedAt).toISOString(), body.startedAt);
      assert.equal(body.actualPort, Number(new URL(base).port));
      assert.equal(body.mode, 'shared');
      assert.deepEqual(body.capabilities, [CAPABILITIES.ROOTS_V1, CAPABILITIES.SPACES_V1]);

      const repeated = await (await fetch(`${base}/api/version`)).json();
      assert.equal(repeated.instanceId, body.instanceId);
      assert.equal(repeated.startedAt, body.startedAt);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/version: createServer accepts an explicit dedicated mode', async () => {
  await withServer(null, async (base) => {
    const body = await (await fetch(`${base}/api/version`)).json();
    assert.equal(body.mode, 'dedicated');
    assert.deepEqual(body.capabilities, [CAPABILITIES.ROOTS_V1, CAPABILITIES.SPACES_V1]);
  }, { mode: 'dedicated' });
});

test('GET /api/version: launcher stays true after POST /api/roots on a rootless boot', async () => {
  const newRoot = tmp('showmd-version-addroot-new-');
  try {
    writeFileSync(path.join(newRoot, 'x.md'), '# x\n');
    await withServer(null, async (base) => {
      const before = await (await fetch(`${base}/api/version`)).json();
      assert.equal(before.launcher, true);

      const add = await fetch(`${base}/api/roots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newRoot }),
      });
      assert.equal(add.status, 200);

      const after = await (await fetch(`${base}/api/version`)).json();
      assert.equal(after.launcher, true);
    });
  } finally {
    rmSync(newRoot, { recursive: true, force: true });
  }
});
