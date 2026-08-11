import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import '../helpers/isolate-state.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
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

test('GET /api/roots: single-root boot lists the boot root', async () => {
  const root = tmp('showmd-roots-boot-');
  try {
    writeFileSync(path.join(root, 'a.md'), '# a\n');
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/roots`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.roots.length, 1);
      assert.equal(body.roots[0].dir, root);
      assert.equal(body.roots[0].name, path.basename(root));
      assert.match(body.roots[0].key, /^r_[A-Za-z0-9_-]{22}$/);
      assert.equal(body.roots[0].url, `/r/${body.roots[0].key}/`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/roots: adds a second root alongside the boot root', async () => {
  const root = tmp('showmd-roots-first-');
  const second = tmp('showmd-roots-second-');
  try {
    await withServer(root, async (base) => {
      const { status, body } = await postRoot(base, second);
      assert.equal(status, 200);
      assert.equal(body.root.dir, second);
      assert.match(body.root.key, /^r_[A-Za-z0-9_-]{22}$/);

      const list = await (await fetch(`${base}/api/roots`)).json();
      assert.equal(list.roots.length, 2);
      const dirs = list.roots.map((r) => r.dir).sort();
      assert.deepEqual(dirs, [root, second].sort());
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('POST /api/roots: adding the boot root again dedupes to the same key', async () => {
  const root = tmp('showmd-roots-dedupe-');
  try {
    await withServer(root, async (base) => {
      const before = await (await fetch(`${base}/api/roots`)).json();
      const bootKey = before.roots[0].key;

      const { status, body } = await postRoot(base, root);
      assert.equal(status, 200);
      assert.equal(body.root.key, bootKey);

      const after = await (await fetch(`${base}/api/roots`)).json();
      assert.equal(after.roots.length, 1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/roots: nonexistent path is rejected with a structured error', async () => {
  const root = tmp('showmd-roots-invalid-');
  try {
    await withServer(root, async (base) => {
      const missing = path.join(root, 'does-not-exist');
      const { status, body } = await postRoot(base, missing);
      assert.equal(status, 400);
      assert.equal(typeof body.error, 'string');

      const list = await (await fetch(`${base}/api/roots`)).json();
      assert.equal(list.roots.length, 1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/roots: a markdown file target joins its parent as the root and returns a document url', async () => {
  const root = tmp('showmd-roots-file-');
  try {
    const filePath = path.join(root, 'a.md');
    writeFileSync(filePath, '# a\n');
    await withServer(null, async (base) => {
      const { status, body } = await postRoot(base, filePath);
      assert.equal(status, 200);
      assert.equal(body.root.dir, root);
      assert.equal(body.url, `/r/${body.root.key}/a.md`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/roots: a non-markdown file is rejected', async () => {
  const root = tmp('showmd-roots-nonmd-');
  try {
    const filePath = path.join(root, 'a.txt');
    writeFileSync(filePath, 'not markdown\n');
    await withServer(root, async (base) => {
      const { status, body } = await postRoot(base, filePath);
      assert.equal(status, 400);
      assert.equal(typeof body.error, 'string');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/roots: recents record the added directory; a file target also records the file, even on a duplicate add', async () => {
  const recentsHome = tmp('showmd-roots-recents-home-');
  const prevSettingsHome = process.env.SHOWMD_SETTINGS_HOME;
  process.env.SHOWMD_SETTINGS_HOME = recentsHome;
  const root = tmp('showmd-roots-recents-');
  try {
    const filePath = path.join(root, 'a.md');
    writeFileSync(filePath, '# a\n');
    await withServer(null, async (base) => {
      await postRoot(base, root);
      let recents = await (await fetch(`${base}/api/recents`)).json();
      assert.deepEqual(recents.recents.map((r) => r.path), [root]);

      // duplicate add of the same root: the root dedupes, but the file
      // target's own recent still records (conflict #10)
      const { status, body } = await postRoot(base, filePath);
      assert.equal(status, 200);
      assert.equal(body.root.dir, root);
      recents = await (await fetch(`${base}/api/recents`)).json();
      assert.deepEqual(recents.recents.map((r) => r.path).sort(), [filePath, root].sort());
    });
  } finally {
    if (prevSettingsHome === undefined) delete process.env.SHOWMD_SETTINGS_HOME;
    else process.env.SHOWMD_SETTINGS_HOME = prevSettingsHome;
    rmSync(recentsHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/roots: a file nested under an existing root scopes to its parent and keeps the full document path', async () => {
  const root = tmp('showmd-roots-nested-');
  try {
    const nestedDir = path.join(root, 'docs');
    mkdirSync(nestedDir);
    const filePath = path.join(nestedDir, 'a.md');
    writeFileSync(filePath, '# a\n');
    await withServer(root, async (base) => {
      const { status, body } = await postRoot(base, filePath);
      assert.equal(status, 200);
      assert.equal(body.root.dir, root);
      assert.equal(body.url, `/r/${body.root.key}/docs/a.md?scope=docs`);
      const scopedTree = await (await fetch(`${base}/api/roots/${body.root.key}/tree?scope=docs`)).json();
      assert.deepEqual(scopedTree, ['docs/a.md']);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function collectSSEUntil(url, matcher, ms = 8000) {
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
        if (matcher(event, events)) controller.abort();
      }
    }
  } catch { /* aborted */ }
  clearTimeout(timer);
  return events;
}

test('POST /api/roots: a parent opened over a narrower root promotes it, with a root-promoted SSE event', async () => {
  const outer = tmp('showmd-roots-promote-outer-');
  const inner = path.join(outer, 'docs');
  mkdirSync(inner);
  writeFileSync(path.join(inner, 'a.md'), '# a\n');
  await withServer(inner, async (base) => {
    const before = await (await fetch(`${base}/api/roots`)).json();
    const innerKey = before.roots[0].key;

    const eventsPromise = collectSSEUntil(`${base}/api/events`, (e) => e.event === 'root-promoted');
    await new Promise((r) => setTimeout(r, 200));
    const { status, body } = await postRoot(base, outer);
    assert.equal(status, 200);
    assert.equal(body.root.dir, outer);
    const outerKey = body.root.key;

    const events = await eventsPromise;
    const promoted = events.find((e) => e.event === 'root-promoted');
    assert.ok(promoted, 'root-promoted event arrived');
    assert.equal(promoted.rootKey, innerKey);
    assert.equal(promoted.newRoot.key, outerKey);
    assert.deepEqual(promoted.scope, { rootKey: outerKey, scopePath: 'docs' });

    const list = await (await fetch(`${base}/api/roots`)).json();
    assert.deepEqual(list.roots.map((r) => r.key), [outerKey], 'the narrower root is gone; only the parent is registered');
  });
  rmSync(outer, { recursive: true, force: true });
});

test('POST /api/roots: a parent opened over two narrower roots promotes both in one operation', async () => {
  const outer = tmp('showmd-roots-promote-two-');
  const docsDir = path.join(outer, 'docs');
  const srcDir = path.join(outer, 'src');
  mkdirSync(docsDir);
  mkdirSync(srcDir);
  await withServer(null, async (base) => {
    const { body: docsAdded } = await postRoot(base, docsDir);
    const { body: srcAdded } = await postRoot(base, srcDir);

    const eventsPromise = collectSSEUntil(`${base}/api/events`, (e, all) =>
      all.filter((ev) => ev.event === 'root-promoted').length >= 2);
    await new Promise((r) => setTimeout(r, 200));
    const { status, body } = await postRoot(base, outer);
    assert.equal(status, 200);
    const outerKey = body.root.key;

    const events = await eventsPromise;
    const promotedKeys = events.filter((e) => e.event === 'root-promoted').map((e) => e.rootKey).sort();
    assert.deepEqual(promotedKeys, [docsAdded.root.key, srcAdded.root.key].sort());

    const list = await (await fetch(`${base}/api/roots`)).json();
    assert.deepEqual(list.roots.map((r) => r.key), [outerKey]);
  });
  rmSync(outer, { recursive: true, force: true });
});

test('POST /api/roots: documents previously served under a narrower root are reachable under the parent at the scope-prefixed path', async () => {
  const outer = tmp('showmd-roots-promote-reach-');
  const inner = path.join(outer, 'docs');
  mkdirSync(inner);
  writeFileSync(path.join(inner, 'a.md'), '# a\n');
  await withServer(inner, async (base) => {
    const { status, body } = await postRoot(base, outer);
    assert.equal(status, 200);
    const outerKey = body.root.key;

    const res = await fetch(`${base}/api/roots/${outerKey}/raw?path=${encodeURIComponent('docs/a.md')}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '# a\n');
  });
  rmSync(outer, { recursive: true, force: true });
});

test('POST /api/roots: missing path in body is rejected', async () => {
  const root = tmp('showmd-roots-missing-body-');
  try {
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/roots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/roots: rootless launcher boot lists no roots until one is added', async () => {
  const added = tmp('showmd-roots-launcher-');
  try {
    await withServer(null, async (base) => {
      const before = await (await fetch(`${base}/api/roots`)).json();
      assert.deepEqual(before.roots, []);

      const { status, body } = await postRoot(base, added);
      assert.equal(status, 200);
      assert.equal(body.root.dir, added);

      const after = await (await fetch(`${base}/api/roots`)).json();
      assert.equal(after.roots.length, 1);
    });
  } finally {
    rmSync(added, { recursive: true, force: true });
  }
});

test('deleting a live root directory closes the root and drops its recents entry', async () => {
  const recentsHome = tmp('showmd-roots-vanish-home-');
  const prevSettingsHome = process.env.SHOWMD_SETTINGS_HOME;
  process.env.SHOWMD_SETTINGS_HOME = recentsHome;
  const root = tmp('showmd-roots-vanish-');
  writeFileSync(path.join(root, 'a.md'), '# a\n');
  try {
    await withServer(root, async (base) => {
      const before = await (await fetch(`${base}/api/roots`)).json();
      const key = before.roots[0].key;

      const eventsPromise = collectSSEUntil(`${base}/api/events`, (e) => e.event === 'root-removed');
      await new Promise((r) => setTimeout(r, 300));
      rmSync(root, { recursive: true, force: true });

      const events = await eventsPromise;
      const removed = events.find((e) => e.event === 'root-removed');
      assert.ok(removed, 'root-removed event arrived');
      assert.equal(removed.rootKey, key);

      const after = await (await fetch(`${base}/api/roots`)).json();
      assert.deepEqual(after.roots, []);

      const recents = await (await fetch(`${base}/api/recents`)).json();
      assert.deepEqual(recents.recents.map((r) => r.path), []);
    });
  } finally {
    if (prevSettingsHome === undefined) delete process.env.SHOWMD_SETTINGS_HOME;
    else process.env.SHOWMD_SETTINGS_HOME = prevSettingsHome;
    rmSync(recentsHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('deleting a file inside a live root does not close the root', async () => {
  const root = tmp('showmd-roots-file-unlink-');
  const filePath = path.join(root, 'a.md');
  writeFileSync(filePath, '# a\n');
  try {
    await withServer(root, async (base) => {
      const before = await (await fetch(`${base}/api/roots`)).json();
      const key = before.roots[0].key;

      const eventsPromise = collectSSEUntil(`${base}/api/events`, (e) => e.event === 'change' || e.event === 'unlink', 2000);
      await new Promise((r) => setTimeout(r, 300));
      rmSync(filePath, { force: true });
      await eventsPromise;

      const after = await (await fetch(`${base}/api/roots`)).json();
      assert.deepEqual(after.roots.map((r) => r.key), [key]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/recents: a cold entry whose path is gone is pruned from the next read', async () => {
  const recentsHome = tmp('showmd-recents-prune-home-');
  const prevSettingsHome = process.env.SHOWMD_SETTINGS_HOME;
  process.env.SHOWMD_SETTINGS_HOME = recentsHome;
  const gone = tmp('showmd-recents-prune-gone-');
  rmSync(gone, { recursive: true, force: true });
  try {
    const { settingsDir } = require('../../server/settings.js');
    mkdirSync(settingsDir(), { recursive: true });
    writeFileSync(path.join(settingsDir(), 'recents.json'), JSON.stringify([{ path: gone, ts: Date.now() }]));
    await withServer(null, async (base) => {
      const recents = await (await fetch(`${base}/api/recents`)).json();
      assert.deepEqual(recents.recents, []);
    });
  } finally {
    if (prevSettingsHome === undefined) delete process.env.SHOWMD_SETTINGS_HOME;
    else process.env.SHOWMD_SETTINGS_HOME = prevSettingsHome;
    rmSync(recentsHome, { recursive: true, force: true });
  }
});

test('GET /api/recents: a cold entry surviving a non-ENOENT stat error is kept', async () => {
  const recentsHome = tmp('showmd-recents-keep-home-');
  const prevSettingsHome = process.env.SHOWMD_SETTINGS_HOME;
  process.env.SHOWMD_SETTINGS_HOME = recentsHome;
  const notADir = tmp('showmd-recents-keep-file-');
  writeFileSync(path.join(notADir, 'leaf.md'), '# a\n');
  const impossiblePath = path.join(notADir, 'leaf.md', 'child.md');
  try {
    const { settingsDir } = require('../../server/settings.js');
    mkdirSync(settingsDir(), { recursive: true });
    writeFileSync(path.join(settingsDir(), 'recents.json'), JSON.stringify([{ path: impossiblePath, ts: Date.now() }]));
    await withServer(null, async (base) => {
      const recents = await (await fetch(`${base}/api/recents`)).json();
      assert.deepEqual(recents.recents.map((r) => r.path), [impossiblePath]);
    });
  } finally {
    if (prevSettingsHome === undefined) delete process.env.SHOWMD_SETTINGS_HOME;
    else process.env.SHOWMD_SETTINGS_HOME = prevSettingsHome;
    rmSync(recentsHome, { recursive: true, force: true });
    rmSync(notADir, { recursive: true, force: true });
  }
});
