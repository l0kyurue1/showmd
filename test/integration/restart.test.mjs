import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import '../helpers/isolate-state.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

function tmp(prefix) {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

// Isolate settings and fix instanceId so adoption tests target this server.
process.env.SHOWMD_SETTINGS_HOME = tmp('showmd-settings-home-restart-');
process.env.SHOWMD_INSTANCE_ID = 'restart-test-old-instance';

const { createServer } = require('../../server/server.js');
const { getInstanceMetadata } = require('../../server/protocol.js');
const { writeRestartHandoff, restartDir } = require('../../server/restart-handoff.js');

function fakeKey(seed) {
  return `r_${seed.repeat(22).slice(0, 22)}`;
}

// Let the server end the SSE stream; aborting on match would hide that contract.
async function collectSSEUntilClosed(url, ms = 4000) {
  const controller = new AbortController();
  const events = [];
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let closed = false;
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { closed = true; break; }
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (line) events.push(JSON.parse(line.slice('data: '.length)));
      }
    }
  } catch { /* aborted by the timeout above */ }
  clearTimeout(timer);
  return { events, closed };
}

test('POST /api/restart: broadcasts server-restarting with the saved port to every SSE client, then ends their stream', async () => {
  const root = tmp('showmd-restart-sse-');
  const prevHome = process.env.SHOWMD_SETTINGS_HOME;
  process.env.SHOWMD_SETTINGS_HOME = tmp('showmd-restart-sse-settings-');
  const server = createServer(root, { restartFn: () => {} });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 5555 }),
    });

    const eventsPromise = collectSSEUntilClosed(`${base}/api/events`);
    await new Promise((r) => setTimeout(r, 200));
    const res = await fetch(`${base}/api/restart`, { method: 'POST' });
    assert.equal(res.status, 200);

    const { events, closed } = await eventsPromise;
    assert.equal(closed, true, 'the server ended the stream itself, not the test timeout');
    assert.equal(events.length, 1);
    const [restarting] = events;
    assert.equal(restarting.event, 'server-restarting');
    assert.equal(restarting.port, 5555);
    assert.equal(restarting.rootKey, undefined, 'no rootKey field — an un-updated client must not filter this out');
  } finally {
    server.close();
    await server.whenClosed();
    process.env.SHOWMD_SETTINGS_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/restart: snapshot carries every RootManager root (including one added over HTTP) and the child is spawned with handoff env', async () => {
  const root = tmp('showmd-restart-boot-');
  const added = tmp('showmd-restart-added-');
  writeFileSync(path.join(root, 'a.md'), '# a\n');
  const launches = [];
  const launchDetachedFn = (cmd, args, opts) => {
    launches.push({ cmd, args, opts });
    return { unref() {} };
  };
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const server = createServer(root, { launchDetachedFn, exitFn });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    await fetch(`${base}/api/roots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: added }),
    });

    const closed = new Promise((resolve) => server.once('close', resolve));
    const res = await fetch(`${base}/api/restart`, { method: 'POST' });
    assert.equal(res.status, 200);
    await closed;
    await server.whenClosed();

    assert.equal(exitCode, 0);
    assert.equal(launches.length, 1);
    const { cmd, args, opts } = launches[0];
    assert.equal(cmd, process.execPath);
    assert.ok(!args.includes('--port'));
    assert.ok(opts.env.SHOWMD_INSTANCE_ID);
    assert.ok(opts.env.SHOWMD_RESTART_HANDOFF);
    assert.equal(path.dirname(opts.env.SHOWMD_RESTART_HANDOFF), restartDir());

    const snapshot = JSON.parse(readFileSync(opts.env.SHOWMD_RESTART_HANDOFF, 'utf8'));
    assert.equal(snapshot.newInstance.instanceId, opts.env.SHOWMD_INSTANCE_ID);
    assert.equal(snapshot.oldInstance.instanceId, getInstanceMetadata().instanceId);
    const dirs = snapshot.roots.map((r) => r.dir);
    assert.ok(dirs.includes(root), 'boot root is in the snapshot');
    assert.ok(dirs.includes(added), 'root added over HTTP after boot is in the snapshot');
    assert.deepEqual(snapshot.skillsContexts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(added, { recursive: true, force: true });
  }
});

test('boot with a valid, matching restart handoff adopts its roots and consumes the snapshot file', async () => {
  const rootA = tmp('showmd-restart-adopt-a-');
  const rootB = tmp('showmd-restart-adopt-b-');
  const snapshotPath = path.join(restartDir(), 'restart-adopt-test.json');
  const newInstanceId = getInstanceMetadata().instanceId;
  await writeRestartHandoff(snapshotPath, {
    oldInstance: { instanceId: 'restart-test-prev-instance', pid: 1, startedAt: new Date(Date.now() - 1000).toISOString() },
    newInstance: { instanceId: newInstanceId, pid: 1, startedAt: new Date().toISOString() },
    roots: [
      { key: fakeKey('a'), dir: rootA, name: path.basename(rootA) },
      { key: fakeKey('b'), dir: rootB, name: path.basename(rootB) },
    ],
    skillsContexts: [],
  });

  process.env.SHOWMD_RESTART_HANDOFF = snapshotPath;
  const server = createServer(null);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/roots`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const dirs = body.roots.map((r) => r.dir);
    assert.ok(dirs.includes(rootA), 'first snapshot root adopted');
    assert.ok(dirs.includes(rootB), 'second snapshot root adopted');
    assert.equal(existsSync(snapshotPath), false, 'snapshot file is consumed');
  } finally {
    delete process.env.SHOWMD_RESTART_HANDOFF;
    server.close();
    await server.whenClosed();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('boot with a wrong-target restart handoff boots cleanly with zero roots and consumes the snapshot', async () => {
  const snapshotPath = path.join(restartDir(), 'restart-wrong-target-test.json');
  await writeRestartHandoff(snapshotPath, {
    oldInstance: { instanceId: 'restart-test-prev-instance', pid: 1, startedAt: new Date(Date.now() - 1000).toISOString() },
    newInstance: { instanceId: 'some-other-instance-not-this-process', pid: 1, startedAt: new Date().toISOString() },
    roots: [],
    skillsContexts: [],
  });

  process.env.SHOWMD_RESTART_HANDOFF = snapshotPath;
  const server = createServer(null);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/roots`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).roots, []);
    assert.equal(existsSync(snapshotPath), false);
  } finally {
    delete process.env.SHOWMD_RESTART_HANDOFF;
    server.close();
    await server.whenClosed();
    rmSync(snapshotPath, { force: true });
  }
});

test('boot with an expired restart handoff boots cleanly with zero roots, no crash', async () => {
  const snapshotPath = path.join(restartDir(), 'restart-expired-test.json');
  const newInstanceId = getInstanceMetadata().instanceId;
  await writeRestartHandoff(snapshotPath, {
    oldInstance: { instanceId: 'restart-test-prev-instance', pid: 1, startedAt: new Date(Date.now() - 60_000).toISOString() },
    newInstance: { instanceId: newInstanceId, pid: 1, startedAt: new Date().toISOString() },
    roots: [],
    skillsContexts: [],
  }, { now: () => Date.now() - 60_000, ttlMs: 1_000 });

  process.env.SHOWMD_RESTART_HANDOFF = snapshotPath;
  const server = createServer(null);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/roots`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).roots, []);
  } finally {
    delete process.env.SHOWMD_RESTART_HANDOFF;
    server.close();
    await server.whenClosed();
    rmSync(snapshotPath, { force: true });
  }
});

test('boot with a missing restart handoff boots cleanly with zero roots, no crash', async () => {
  process.env.SHOWMD_RESTART_HANDOFF = path.join(restartDir(), 'restart-does-not-exist.json');
  const server = createServer(null);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/roots`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).roots, []);
  } finally {
    delete process.env.SHOWMD_RESTART_HANDOFF;
    server.close();
    await server.whenClosed();
  }
});
