import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import '../helpers/isolate-state.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync, symlinkSync } from 'node:fs';
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

async function collectSSEUntil(url, wantPaths, ms = 8000) {
  const remaining = new Set(wantPaths);
  const controller = new AbortController();
  const events = [];
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
        remaining.delete(event.path);
        if (remaining.size === 0) controller.abort();
      }
    }
  } catch { /* aborted */ }
  clearTimeout(timer);
  return events;
}

test('root-scoped: two roots served simultaneously, tree and raw per key', async () => {
  const rootA = tmp('showmd-scoped-a-');
  const rootB = tmp('showmd-scoped-b-');
  try {
    writeFileSync(path.join(rootA, 'a.md'), '# from A\n');
    writeFileSync(path.join(rootB, 'b.md'), '# from B\n');
    await withServer(rootA, async (base) => {
      const { body: added } = await postRoot(base, rootB);
      const keyA = (await (await fetch(`${base}/api/roots`)).json()).roots.find((r) => r.dir === rootA).key;
      const keyB = added.root.key;

      const treeA = await (await fetch(`${base}/api/roots/${keyA}/tree`)).json();
      const treeB = await (await fetch(`${base}/api/roots/${keyB}/tree`)).json();
      assert.deepEqual(treeA, ['a.md']);
      assert.deepEqual(treeB, ['b.md']);

      const rawA = await (await fetch(`${base}/api/roots/${keyA}/raw?path=a.md`)).text();
      const rawB = await (await fetch(`${base}/api/roots/${keyB}/raw?path=b.md`)).text();
      assert.equal(rawA, '# from A\n');
      assert.equal(rawB, '# from B\n');

      // cross-key lookups do not leak into the wrong root
      assert.equal((await fetch(`${base}/api/roots/${keyA}/raw?path=b.md`)).status, 404);
      assert.equal((await fetch(`${base}/api/roots/${keyB}/raw?path=a.md`)).status, 404);
    });
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('root-scoped: PUT raw writes, GET raw round-trips, per key', async () => {
  const rootA = tmp('showmd-scoped-put-');
  try {
    await withServer(rootA, async (base) => {
      const keyA = (await (await fetch(`${base}/api/roots`)).json()).roots[0].key;
      const putRes = await fetch(`${base}/api/roots/${keyA}/raw?path=note.md`, { method: 'PUT', body: '# hi\n' });
      assert.equal(putRes.status, 204);
      const getRes = await fetch(`${base}/api/roots/${keyA}/raw?path=note.md`);
      assert.equal(await getRes.text(), '# hi\n');
    });
  } finally {
    rmSync(rootA, { recursive: true, force: true });
  }
});

test('root-scoped: unknown root key on any resource route is 404 root_not_open', async () => {
  const root = tmp('showmd-scoped-404-');
  try {
    await withServer(root, async (base) => {
      const bogus = 'r_AAAAAAAAAAAAAAAAAAAAAA';
      for (const tail of ['tree', 'raw?path=a.md', 'asset?path=a.png', 'history?path=a.md', 'diff?path=a.md&rev=abcd', 'restore?path=a.md&rev=abcd', 'reveal?path=a.md']) {
        const method = tail.startsWith('restore') || tail.startsWith('reveal') ? 'POST' : 'GET';
        const res = await fetch(`${base}/api/roots/${bogus}/${tail}`, { method });
        assert.equal(res.status, 404, `${tail} -> ${res.status}`);
        const body = await res.json();
        assert.equal(body.error, 'root_not_open');
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('root-scoped: traversal outside the root is rejected on raw and asset', async () => {
  const root = tmp('showmd-scoped-traversal-');
  try {
    await withServer(root, async (base) => {
      const key = (await (await fetch(`${base}/api/roots`)).json()).roots[0].key;
      const rawRes = await fetch(`${base}/api/roots/${key}/raw?path=${encodeURIComponent('../../etc/passwd')}`);
      assert.equal(rawRes.status, 403);
      const assetRes = await fetch(`${base}/api/roots/${key}/asset?path=${encodeURIComponent('../../etc/passwd')}`);
      assert.equal(assetRes.status, 403);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('root-scoped: an encoded slash inside the key segment cannot smuggle a route separator', async () => {
  const root = tmp('showmd-scoped-encoded-slash-');
  try {
    await withServer(root, async (base) => {
      const key = (await (await fetch(`${base}/api/roots`)).json()).roots[0].key;
      const res = await fetch(`${base}/api/roots/${key}%2Fraw/tree?path=x`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/, 'falls through to the app shell, not a matched API route');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('root-scoped: same-basename roots are distinguishable by key', async () => {
  const parentA = tmp('showmd-scoped-parentA-');
  const parentB = tmp('showmd-scoped-parentB-');
  try {
    const rootA = path.join(parentA, 'docs');
    const rootB = path.join(parentB, 'docs');
    mkdirSync(rootA);
    mkdirSync(rootB);
    writeFileSync(path.join(rootA, 'x.md'), '# A docs\n');
    writeFileSync(path.join(rootB, 'x.md'), '# B docs\n');
    await withServer(rootA, async (base) => {
      const { body: added } = await postRoot(base, rootB);
      const keyA = (await (await fetch(`${base}/api/roots`)).json()).roots.find((r) => r.dir === rootA).key;
      const keyB = added.root.key;
      assert.notEqual(keyA, keyB);
      const contentA = await (await fetch(`${base}/api/roots/${keyA}/raw?path=x.md`)).text();
      const contentB = await (await fetch(`${base}/api/roots/${keyB}/raw?path=x.md`)).text();
      assert.equal(contentA, '# A docs\n');
      assert.equal(contentB, '# B docs\n');
    });
  } finally {
    rmSync(parentA, { recursive: true, force: true });
    rmSync(parentB, { recursive: true, force: true });
  }
});

test('root-scoped: SSE document-changed events for two roots each carry their own rootKey', async () => {
  const rootA = tmp('showmd-scoped-sse-a-');
  const rootB = tmp('showmd-scoped-sse-b-');
  try {
    await withServer(rootA, async (base) => {
      const { body: added } = await postRoot(base, rootB);
      const keyA = (await (await fetch(`${base}/api/roots`)).json()).roots.find((r) => r.dir === rootA).key;
      const keyB = added.root.key;

      const eventsPromise = collectSSEUntil(`${base}/api/events`, ['sa.md', 'sb.md']);
      await new Promise((r) => setTimeout(r, 200));
      writeFileSync(path.join(rootA, 'sa.md'), '# sa\n');
      writeFileSync(path.join(rootB, 'sb.md'), '# sb\n');
      const events = await eventsPromise;

      const evA = events.find((e) => e.path === 'sa.md');
      const evB = events.find((e) => e.path === 'sb.md');
      assert.ok(evA, 'event for sa.md arrived');
      assert.ok(evB, 'event for sb.md arrived');
      assert.equal(evA.rootKey, keyA);
      assert.equal(evB.rootKey, keyB);
    });
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('root-scoped: tree honors a scope query param scoped to a subdirectory', async () => {
  const root = tmp('showmd-scoped-scope-');
  try {
    mkdirSync(path.join(root, 'sub'));
    writeFileSync(path.join(root, 'top.md'), '# top\n');
    writeFileSync(path.join(root, 'sub', 'nested.md'), '# nested\n');
    await withServer(root, async (base) => {
      const key = (await (await fetch(`${base}/api/roots`)).json()).roots[0].key;
      const scoped = await (await fetch(`${base}/api/roots/${key}/tree?scope=sub`)).json();
      assert.deepEqual(scoped, ['sub/nested.md']);
      const full = await (await fetch(`${base}/api/roots/${key}/tree`)).json();
      assert.deepEqual(full.sort(), ['sub/nested.md', 'top.md']);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Scope queries decode exactly once, matching the client route contract.
test('root-scoped: scope query survives spaces, Unicode, #, and a literal %2F segment unchanged', async () => {
  const root = tmp('showmd-scoped-scope-encoding-');
  try {
    mkdirSync(path.join(root, 'a dir'));
    writeFileSync(path.join(root, 'a dir', 'x.md'), '# x\n');
    mkdirSync(path.join(root, 'Ünïcode #'));
    writeFileSync(path.join(root, 'Ünïcode #', 'y.md'), '# y\n');
    mkdirSync(path.join(root, '%2F'));
    writeFileSync(path.join(root, '%2F', 'z.md'), '# z\n');
    await withServer(root, async (base) => {
      const key = (await (await fetch(`${base}/api/roots`)).json()).roots[0].key;
      const space = await (await fetch(`${base}/api/roots/${key}/tree?scope=${encodeURIComponent('a dir')}`)).json();
      assert.deepEqual(space, ['a dir/x.md']);
      const unicode = await (await fetch(`${base}/api/roots/${key}/tree?scope=${encodeURIComponent('Ünïcode #')}`)).json();
      assert.deepEqual(unicode, ['Ünïcode #/y.md']);
      // %2F stays a literal directory name; a second decode would smuggle a slash.
      const literalPercent = await (await fetch(`${base}/api/roots/${key}/tree?scope=${encodeURIComponent('%2F')}`)).json();
      assert.deepEqual(literalPercent, ['%2F/z.md']);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// An unreadable added folder must report failure without taking down the server.
test('root-scoped: an unreadable root added via POST /api/roots -> tree 500 unreadable_root, server stays up', {
  skip: process.platform === 'win32' ? 'chmod does not restrict access on windows' : process.getuid && process.getuid() === 0 ? 'chmod does not constrain root' : false,
}, async () => {
  const root = tmp('showmd-scoped-unreadable-ok-');
  const denied = tmp('showmd-scoped-unreadable-denied-');
  try {
    writeFileSync(path.join(denied, 'hidden.md'), '# hidden\n');
    await withServer(root, async (base) => {
      chmodSync(denied, 0o000);
      const { status, body: added } = await postRoot(base, denied);
      assert.equal(status, 200);

      const res = await fetch(`${base}/api/roots/${added.root.key}/tree`);
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'unreadable_root', dir: denied, code: 'EACCES' });

      const alive = await fetch(`${base}/api/roots`);
      assert.equal(alive.status, 200, 'the server survived the unreadable root');
    });
  } finally {
    chmodSync(denied, 0o755);
    rmSync(root, { recursive: true, force: true });
    rmSync(denied, { recursive: true, force: true });
  }
});

test('root-scoped: a symlink alias of an already-open root dedupes to the same key over HTTP', async () => {
  const work = tmp('showmd-scoped-symlink-');
  const rootDir = path.join(work, 'project');
  const alias = path.join(work, 'alias');
  try {
    mkdirSync(rootDir);
    writeFileSync(path.join(rootDir, 'x.md'), '# x\n');
    symlinkSync(rootDir, alias);
    await withServer(rootDir, async (base) => {
      const bootKey = (await (await fetch(`${base}/api/roots`)).json()).roots[0].key;
      const { status, body } = await postRoot(base, alias);
      assert.equal(status, 200);
      assert.equal(body.root.key, bootKey);

      const list = await (await fetch(`${base}/api/roots`)).json();
      assert.equal(list.roots.length, 1, 'the alias did not create a second root');

      const tree = await (await fetch(`${base}/api/roots/${bootKey}/tree`)).json();
      assert.deepEqual(tree, ['x.md']);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
