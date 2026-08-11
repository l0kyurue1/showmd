import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import '../helpers/isolate-state.mjs';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { createServer } = require('../../server/server.js');

// isolates the boot-time recents write (server.js's createServer) from
// whatever this machine has for real
process.env.HOME = mkdtempSync(path.join(tmpdir(), 'showmd-sec-home-'));
// os.homedir() reads USERPROFILE on windows and ignores HOME
process.env.USERPROFILE = process.env.HOME;

async function withServer(fn) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-sec-')));
  writeFileSync(path.join(root, 'a.md'), '# a\n');
  const server = createServer(root, {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const roots = await (await fetch(`${base}/api/roots`)).json();
    await fn(base, roots.roots[0].key);
  } finally {
    server.close();
    await server.whenClosed();
    rmSync(root, { recursive: true, force: true });
  }
}

test('cross-origin write is rejected 403', async () => {
  await withServer(async (base, key) => {
    const res = await fetch(`${base}/api/roots/${key}/raw?path=a.md`, {
      method: 'PUT', body: 'evil', headers: { Origin: 'http://evil.example' },
    });
    assert.equal(res.status, 403);
  });
});

test('loopback-origin write is allowed', async () => {
  await withServer(async (base, key) => {
    const res = await fetch(`${base}/api/roots/${key}/raw?path=a.md`, {
      method: 'PUT', body: '# ok\n', headers: { Origin: base },
    });
    assert.equal(res.status, 204);
  });
});

test('origin-less write (curl, non-browser) is allowed', async () => {
  await withServer(async (base, key) => {
    const res = await fetch(`${base}/api/roots/${key}/raw?path=a.md`, { method: 'PUT', body: '# ok2\n' });
    assert.equal(res.status, 204);
  });
});

// fetch strips Host (forbidden header), so speak raw http for the rebinding case
test('non-loopback Host is rejected 403 even on GET (DNS rebinding)', async () => {
  await withServer(async (base, key) => {
    const { port } = new URL(base);
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/api/roots/${key}/tree`, headers: { Host: 'evil.example' } },
        (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  });
});

test('cross-origin GET is not blocked', async () => {
  await withServer(async (base, key) => {
    const res = await fetch(`${base}/api/roots/${key}/tree`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(res.status, 200);
  });
});

test('cross-origin requests are rejected across privileged write routes without mutating roots', async () => {
  await withServer(async (base, key) => {
    const requests = [
      ['POST /api/prune', '/api/prune', 'POST'],
      ['POST /api/install-app', '/api/install-app', 'POST'],
      ['POST /api/restart', '/api/restart', 'POST'],
      ['POST /api/shutdown', '/api/shutdown', 'POST'],
      ['DELETE /api/roots/:key', `/api/roots/${key}`, 'DELETE'],
    ];

    for (const [name, route, method] of requests) {
      const res = await fetch(`${base}${route}`, {
        method,
        headers: { Origin: 'http://evil.example' },
      });
      assert.equal(res.status, 403, name);
    }

    const list = await (await fetch(`${base}/api/roots`)).json();
    assert.deepEqual(list.roots.map((root) => root.key), [key], 'rejected DELETE must not remove the root');
  });
});
