import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import '../helpers/isolate-state.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createServer } = require('../../server/server.js');

function tmp(prefix) {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

async function withIsolatedServer(fn, extra = {}) {
  const server = createServer(null, extra);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    await server.whenClosed();
  }
}

function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      const result = predicate();
      if (result) return resolve(result);
      if (Date.now() - start > timeoutMs) return reject(new Error('condition not met in time'));
      setTimeout(poll, 20);
    })();
  });
}

// a real, separately-pidded process answering /api/version: entries in
// ports.js's registry are named by pid, and ports.js sweeps any pid that
// isn't alive, so a synthetic in-process fake would race the requesting
// server's own self-announce sweep and vanish under the test
function spawnFakeCandidate(body) {
  const script = `require('node:http').createServer((q, s) => {
    s.writeHead(200, {'content-type':'application/json'});
    s.end(JSON.stringify(${JSON.stringify(body)}));
  }).listen(0, '127.0.0.1', function () { console.log('port:' + this.address().port); });`;
  const child = spawn('node', ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  return waitFor(() => {
    const m = out.match(/port:(\d+)/);
    return m ? { pid: child.pid, port: Number(m[1]), kill: () => child.kill() } : null;
  });
}

function writeRegistryEntry(dir, pid, port) {
  writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ port, pid }));
}

test('GET /api/registry: orders entries by the canonical rule regardless of directory write order', async () => {
  const home = tmp('showmd-registry-home-');
  const previous = process.env.SHOWMD_SETTINGS_HOME;
  process.env.SHOWMD_SETTINGS_HOME = home;
  const dir = path.join(home, 'ports');
  mkdirSync(dir, { recursive: true });

  const earlier = await spawnFakeCandidate({
    version: '1.0.0', protocol: 1, mode: 'shared', instanceId: 'earlier', startedAt: '2026-01-01T00:00:00.000Z',
  });
  const later = await spawnFakeCandidate({
    version: '1.0.0', protocol: 1, mode: 'shared', instanceId: 'later', startedAt: '2026-02-01T00:00:00.000Z',
  });
  const dedicated = await spawnFakeCandidate({
    version: '1.0.0', protocol: 1, mode: 'dedicated', instanceId: 'dedicated', startedAt: '2026-01-01T00:00:00.000Z',
  });

  try {
    // mode: dedicated keeps the requesting server itself out of the
    // shared-only comparison below
    await withIsolatedServer(async (base) => {
      // write descending, then ascending pid order: directory enumeration
      // order must not influence the answer
      writeRegistryEntry(dir, later.pid, later.port);
      writeRegistryEntry(dir, dedicated.pid, dedicated.port);
      writeRegistryEntry(dir, earlier.pid, earlier.port);
      const descending = await (await fetch(`${base}/api/registry`)).json();

      for (const c of [earlier, later, dedicated]) rmSync(path.join(dir, `${c.pid}.json`));
      writeRegistryEntry(dir, earlier.pid, earlier.port);
      writeRegistryEntry(dir, dedicated.pid, dedicated.port);
      writeRegistryEntry(dir, later.pid, later.port);
      const ascending = await (await fetch(`${base}/api/registry`)).json();

      // both orderings surface only the two shared, protocol-matching
      // candidates, earliest startedAt first, and agree with each other
      assert.deepEqual(descending.map((e) => e.instanceId), ['earlier', 'later']);
      assert.deepEqual(ascending.map((e) => e.instanceId), ['earlier', 'later']);
    }, { mode: 'dedicated' });
  } finally {
    for (const c of [earlier, later, dedicated]) c.kill();
    process.env.SHOWMD_SETTINGS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('GET /api/registry: a dedicated-only registry answers with an empty ordered list', async () => {
  const home = tmp('showmd-registry-home-');
  const previous = process.env.SHOWMD_SETTINGS_HOME;
  process.env.SHOWMD_SETTINGS_HOME = home;
  try {
    // the requesting server announces itself on 'listening', but mode:
    // 'dedicated' means orderRegistry filters it back out
    await withIsolatedServer(async (base) => {
      const body = await (await fetch(`${base}/api/registry`)).json();
      assert.deepEqual(body, []);
    }, { mode: 'dedicated' });
  } finally {
    process.env.SHOWMD_SETTINGS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
