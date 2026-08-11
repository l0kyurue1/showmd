import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import '../helpers/isolate-state.mjs';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createServer } = require('../../server/server.js');

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

async function postRoot(base, dir) {
  const res = await fetch(`${base}/api/roots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dir }),
  });
  return { status: res.status, body: await res.json() };
}

async function deleteRoot(base, key, headers = {}) {
  const res = await fetch(`${base}/api/roots/${key}`, { method: 'DELETE', headers });
  const body = await res.json();
  return { status: res.status, body };
}

// graceMs keeps the stream open after the expected event so an assertion about
// an event that must NOT arrive is time-bounded rather than merely ordered
async function collectSSEUntil(url, matcher, ms = 8000, graceMs = 0) {
  const controller = new AbortController();
  const events = [];
  let graceTimer = null;
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice('data: '.length));
        events.push(event);
        if (!matcher(event, events)) continue;
        if (!graceMs) controller.abort();
        else if (!graceTimer) graceTimer = setTimeout(() => controller.abort(), graceMs);
      }
    }
  } catch { /* aborted */ }
  clearTimeout(timer);
  clearTimeout(graceTimer);
  return events;
}

test('DELETE /api/roots/:key: removes the root; a following GET no longer lists it, the other root stays', async () => {
  const rootA = tmp('showmd-remove-a-');
  const rootB = tmp('showmd-remove-b-');
  try {
    await withServer(rootA, async (base) => {
      const { body: added } = await postRoot(base, rootB);
      const keyA = (await (await fetch(`${base}/api/roots`)).json()).roots.find((r) => r.dir === rootA).key;
      const keyB = added.root.key;

      const { status, body } = await deleteRoot(base, keyA);
      assert.equal(status, 200);
      assert.equal(body.root.dir, rootA);

      const list = await (await fetch(`${base}/api/roots`)).json();
      assert.deepEqual(list.roots.map((r) => r.key), [keyB]);
    });
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('DELETE /api/roots/:key: unknown key is rejected 404 with the root-scoped error shape', async () => {
  const root = tmp('showmd-remove-unknown-');
  try {
    await withServer(root, async (base) => {
      const { status, body } = await deleteRoot(base, 'r_doesnotexist0000000000');
      assert.equal(status, 404);
      assert.equal(body.error, 'root_not_open');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DELETE /api/roots/:key: an already-removed key 404s on a second delete', async () => {
  const root = tmp('showmd-remove-twice-');
  try {
    await withServer(root, async (base) => {
      const key = (await (await fetch(`${base}/api/roots`)).json()).roots[0].key;
      const first = await deleteRoot(base, key);
      assert.equal(first.status, 200);
      const second = await deleteRoot(base, key);
      assert.equal(second.status, 404);
      assert.equal(second.body.error, 'root_not_open');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DELETE /api/roots/:key: cross-origin request is rejected 403 (Origin guard)', async () => {
  const root = tmp('showmd-remove-cors-');
  try {
    await withServer(root, async (base) => {
      const key = (await (await fetch(`${base}/api/roots`)).json()).roots[0].key;
      const res = await fetch(`${base}/api/roots/${key}`, {
        method: 'DELETE', headers: { Origin: 'http://evil.example' },
      });
      assert.equal(res.status, 403);

      const list = await (await fetch(`${base}/api/roots`)).json();
      assert.equal(list.roots.length, 1, 'the cross-origin request must not have removed the root');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DELETE /api/roots/:key: the watcher is actually closed — changes under the removed root produce no SSE, the surviving root still fires', async () => {
  const rootA = tmp('showmd-remove-watch-a-');
  const rootB = tmp('showmd-remove-watch-b-');
  try {
    await withServer(rootA, async (base) => {
      const { body: added } = await postRoot(base, rootB);
      const keyA = (await (await fetch(`${base}/api/roots`)).json()).roots.find((r) => r.dir === rootA).key;
      const keyB = added.root.key;

      await deleteRoot(base, keyA);

      const eventsPromise = collectSSEUntil(`${base}/api/events`, (e) => e.path === 'sb.md', 8000, 500);
      await new Promise((r) => setTimeout(r, 200));
      writeFileSync(path.join(rootA, 'sa.md'), '# sa\n');
      writeFileSync(path.join(rootB, 'sb.md'), '# sb\n');
      const events = await eventsPromise;

      assert.ok(events.find((e) => e.path === 'sb.md' && e.rootKey === keyB), 'surviving root still fires SSE');
      assert.ok(!events.find((e) => e.path === 'sa.md'), 'removed root produced no SSE for its own file change');
    });
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('DELETE /api/roots/:key: broadcasts a root-removed SSE event with the removed rootKey', async () => {
  const root = tmp('showmd-remove-sse-');
  try {
    await withServer(root, async (base) => {
      const key = (await (await fetch(`${base}/api/roots`)).json()).roots[0].key;

      const eventsPromise = collectSSEUntil(`${base}/api/events`, (e) => e.event === 'root-removed');
      await new Promise((r) => setTimeout(r, 200));
      const { status } = await deleteRoot(base, key);
      assert.equal(status, 200);
      const events = await eventsPromise;

      const removed = events.find((e) => e.event === 'root-removed');
      assert.ok(removed, 'root-removed event arrived');
      assert.equal(removed.rootKey, key);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
