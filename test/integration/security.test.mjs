import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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

test('POST /api/prune: cross-origin request is rejected 403 (Origin guard)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/prune`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });
});

test('POST /api/install-app: cross-origin request is rejected 403 (Origin guard)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/install-app`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });
});

test('POST /api/restart: cross-origin request is rejected 403 (Origin guard)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/restart`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });
});

test('POST /api/shutdown: cross-origin request is rejected 403 (Origin guard)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });
});
