import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createServer } = require('../../server/server.js');

// keeps discoverGlobalRoots (used by GET /api/tree?view=skills) from picking
// up this machine's real ~/.claude/skills etc — same isolation trick as
// test/e2e/skills-cli.test.mjs, applied in-process since node:test runs each file in
// its own process
const fakeHome = mkdtempSync(path.join(tmpdir(), 'showmd-pickroot-home-'));
process.env.HOME = fakeHome;

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function withServer(root, fn, extra = {}) {
  const server = createServer(root, extra);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

async function collectSSE(url, ms) {
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
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice('data: '.length)));
      }
    }
  } catch {
    // expected: aborted once the collection window elapses
  } finally {
    clearTimeout(timer);
  }
  return events;
}

function postPickRoot(base, body) {
  return fetch(`${base}/api/pick-root`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /api/pick-root: valid dir -> 200, tree switches, SSE gets root-changed', async () => {
  const oldRoot = tmp('showmd-pickroot-old-');
  const newRoot = tmp('showmd-pickroot-new-');
  try {
    writeFileSync(path.join(oldRoot, 'old.md'), '# old\n');
    writeFileSync(path.join(newRoot, 'new.md'), '# new\n');
    await withServer(oldRoot, async (base) => {
      const ssePromise = collectSSE(`${base}/api/events`, 600);
      await new Promise((r) => setTimeout(r, 100));

      const res = await postPickRoot(base, { dir: newRoot });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, root: { dir: newRoot, name: path.basename(newRoot), launchedFrom: 'terminal' } });

      const tree = await (await fetch(`${base}/api/tree`)).json();
      assert.deepEqual(tree, ['new.md']);

      const events = await ssePromise;
      assert.ok(
        events.some((e) => e.event === 'root-changed' && e.root.dir === newRoot),
        `expected a root-changed SSE event, got ${JSON.stringify(events)}`
      );
    });
  } finally {
    rmSync(oldRoot, { recursive: true, force: true });
    rmSync(newRoot, { recursive: true, force: true });
  }
});

test('POST /api/pick-root: a .md file -> 200 with root=dirname + doc=basename, tree lists siblings, SSE carries doc', async () => {
  const oldRoot = tmp('showmd-pickroot-old2-');
  const fileParent = tmp('showmd-pickroot-filedir-');
  try {
    writeFileSync(path.join(oldRoot, 'old.md'), '# old\n');
    writeFileSync(path.join(fileParent, 'target.md'), '# target\n');
    writeFileSync(path.join(fileParent, 'sibling.md'), '# sibling\n');
    await withServer(oldRoot, async (base) => {
      const ssePromise = collectSSE(`${base}/api/events`, 600);
      await new Promise((r) => setTimeout(r, 100));

      const res = await postPickRoot(base, { dir: path.join(fileParent, 'target.md') });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        ok: true,
        root: { dir: fileParent, name: path.basename(fileParent), launchedFrom: 'terminal' },
        doc: 'target.md',
      });

      const tree = await (await fetch(`${base}/api/tree`)).json();
      assert.deepEqual(tree.slice().sort(), ['sibling.md', 'target.md']);

      const events = await ssePromise;
      assert.ok(
        events.some((e) => e.event === 'root-changed' && e.root.dir === fileParent && e.doc === 'target.md'),
        `expected a root-changed SSE event carrying doc, got ${JSON.stringify(events)}`
      );
    });
  } finally {
    rmSync(oldRoot, { recursive: true, force: true });
    rmSync(fileParent, { recursive: true, force: true });
  }
});

test('POST /api/pick-root: a .markdown file also resolves, with doc set, and actually serves end to end', async () => {
  const root = tmp('showmd-pickroot-mdext-');
  try {
    writeFileSync(path.join(root, 'page.markdown'), '# page\n');
    await withServer(root, async (base) => {
      const res = await postPickRoot(base, { dir: path.join(root, 'page.markdown') });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.doc, 'page.markdown');
      assert.equal(body.root.dir, root);

      // the old bug: pick-root's own regex accepted .markdown case-insensitively,
      // but the document store's read/tree gate was strict .md-only, so the
      // picked file became the root and then failed to resolve
      const tree = await (await fetch(`${base}/api/tree`)).json();
      assert.deepEqual(tree, ['page.markdown']);

      const raw = await fetch(`${base}/api/raw?path=${encodeURIComponent('page.markdown')}`);
      assert.equal(raw.status, 200);
      assert.equal(await raw.text(), '# page\n');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/pick-root: a non-markdown file -> 400', async () => {
  const root = tmp('showmd-pickroot-root-');
  try {
    writeFileSync(path.join(root, 'notes.txt'), 'hi');
    await withServer(root, async (base) => {
      const res = await postPickRoot(base, { dir: path.join(root, 'notes.txt') });
      assert.equal(res.status, 400);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/pick-root: nonexistent dir -> 400', async () => {
  const root = tmp('showmd-pickroot-root-');
  try {
    await withServer(root, async (base) => {
      const res = await postPickRoot(base, { dir: path.join(root, 'does-not-exist') });
      assert.equal(res.status, 400);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/pick-root: empty body on a picker-less platform -> 501, no dialog attempted', async () => {
  const root = tmp('showmd-pickroot-root-');
  try {
    await withServer(
      root,
      async (base) => {
        const res = await fetch(`${base}/api/pick-root`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '' });
        assert.equal(res.status, 501);
        assert.match((await res.json()).error, /no folder picker available/);
      },
      { platform: 'freebsd' }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/pick-root: body.mode passes straight through to folderPicker.pick(mode)', async () => {
  const root = tmp('showmd-pickroot-mode-');
  const newRoot = tmp('showmd-pickroot-mode-new-');
  try {
    writeFileSync(path.join(newRoot, 'x.md'), '# x\n');
    const seenModes = [];
    await withServer(root, async (base) => {
      const res = await postPickRoot(base, { mode: 'file' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, root: { dir: newRoot, name: path.basename(newRoot), launchedFrom: 'terminal' } });
      assert.deepEqual(seenModes, ['file']);
    }, {
      folderPickerFactory: () => ({
        warm() {},
        pick(mode) { seenModes.push(mode); return Promise.resolve(newRoot); },
      }),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(newRoot, { recursive: true, force: true });
  }
});

test('POST /api/pick-root: an explicit {dir} preset skips the picker entirely, even with a mode given', async () => {
  const root = tmp('showmd-pickroot-preset-');
  const newRoot = tmp('showmd-pickroot-preset-new-');
  try {
    writeFileSync(path.join(newRoot, 'y.md'), '# y\n');
    let pickCalled = false;
    await withServer(root, async (base) => {
      const res = await postPickRoot(base, { dir: newRoot, mode: 'folder' });
      assert.equal(res.status, 200);
      assert.equal(pickCalled, false, 'the picker was never invoked when dir was already given');
    }, {
      folderPickerFactory: () => ({
        warm() {},
        pick() { pickCalled = true; return Promise.resolve(null); },
      }),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(newRoot, { recursive: true, force: true });
  }
});

test('POST /api/pick-root: skills-mode (multi-root) server does not expose the route', async () => {
  const rootA = tmp('showmd-pickroot-multiA-');
  try {
    writeFileSync(path.join(rootA, 'a.md'), '# a\n');
    await withServer([{ key: 'agents', dir: rootA, label: 'agents' }], async (base) => {
      const res = await postPickRoot(base, { dir: rootA });
      assert.equal(res.status, 404);
    });
  } finally {
    rmSync(rootA, { recursive: true, force: true });
  }
});

test('GET /api/tree?view=skills: doc-mode server returns the same {scopes} shape as skills mode', async () => {
  const root = tmp('showmd-skillsview-root-');
  try {
    mkdirSync(path.join(root, '.agents', 'skills', 'one'), { recursive: true });
    writeFileSync(path.join(root, '.agents', 'skills', 'one', 'SKILL.md'), '# one\n');
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/tree?view=skills`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.scopes), 'response has a scopes array');
      const names = body.scopes.flatMap((s) => [
        ...s.groups.flatMap((g) => g.skills.map((sk) => sk.name)),
        ...s.skills.map((sk) => sk.name),
      ]);
      assert.ok(names.includes('one'), `expected skill "one" among ${JSON.stringify(names)}`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/root: doc-mode server returns {dir, name, launcher}', async () => {
  const root = tmp('showmd-apiroot-');
  try {
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/root`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { dir: root, name: path.basename(root), launchedFrom: 'terminal' });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/root: skills-mode (multi-root) server does not expose the route', async () => {
  const rootA = tmp('showmd-apiroot-multiA-');
  try {
    await withServer([{ key: 'agents', dir: rootA, label: 'agents' }], async (base) => {
      const res = await fetch(`${base}/api/root`);
      assert.equal(res.status, 404);
    });
  } finally {
    rmSync(rootA, { recursive: true, force: true });
  }
});

test('GET /api/raw: a global-scope skill id resolves via the skills store, even without a prior /api/tree?view=skills request', async () => {
  const root = tmp('showmd-skillfallback-root-');
  const globalSkillDir = path.join(fakeHome, '.claude', 'skills', 'globby');
  try {
    writeFileSync(path.join(root, 'hello.md'), '# hi\n');
    mkdirSync(globalSkillDir, { recursive: true });
    writeFileSync(path.join(globalSkillDir, 'SKILL.md'), '# global skill\n');
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/raw?path=${encodeURIComponent('claude user/globby/SKILL.md')}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '# global skill\n');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(globalSkillDir, { recursive: true, force: true });
  }
});

test('GET /api/raw: a real file in the root shadowing a scope-key-like path wins over the skills store', async () => {
  const root = tmp('showmd-skillshadow-root-');
  const globalSkillDir = path.join(fakeHome, '.claude', 'skills', 'foo');
  try {
    mkdirSync(path.join(root, 'claude user', 'foo'), { recursive: true });
    writeFileSync(path.join(root, 'claude user', 'foo', 'SKILL.md'), '# root version\n');
    mkdirSync(globalSkillDir, { recursive: true });
    writeFileSync(path.join(globalSkillDir, 'SKILL.md'), '# skill version\n');
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/raw?path=${encodeURIComponent('claude user/foo/SKILL.md')}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '# root version\n');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(globalSkillDir, { recursive: true, force: true });
  }
});

test('setRoot drops the skills store: a project-scope id from the old root stops resolving after a swap', async () => {
  const rootA = tmp('showmd-skillswap-rootA-');
  const rootB = tmp('showmd-skillswap-rootB-');
  try {
    mkdirSync(path.join(rootA, '.agents', 'skills', 'skillA'), { recursive: true });
    writeFileSync(path.join(rootA, '.agents', 'skills', 'skillA', 'SKILL.md'), '# from A\n');
    mkdirSync(path.join(rootB, '.agents', 'skills', 'skillB'), { recursive: true });
    writeFileSync(path.join(rootB, '.agents', 'skills', 'skillB', 'SKILL.md'), '# from B\n');

    await withServer(rootA, async (base) => {
      // force the skills cache (and its store) to build while rootA is active
      const tree = await (await fetch(`${base}/api/tree?view=skills`)).json();
      assert.ok(tree.scopes.find((s) => s.name === 'Project'), 'rootA project skill shows up in the tree before the swap');

      const pick = await postPickRoot(base, { dir: rootB });
      assert.equal(pick.status, 200);

      const staleA = await fetch(`${base}/api/raw?path=${encodeURIComponent('project agents/skillA/SKILL.md')}`);
      assert.equal(staleA.status, 404, 'old root project skill no longer resolves — the skills store was rebuilt, not left stale');

      const newB = await fetch(`${base}/api/raw?path=${encodeURIComponent('project agents/skillB/SKILL.md')}`);
      assert.equal(newB.status, 200, 'new root project skill resolves via the rebuilt skills store');
      assert.equal(await newB.text(), '# from B\n');
    });
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

// fine-grained TTL/expiry/invalidate-call assertions live in
// test/unit/skills.test.mjs's getTree tests; this is a thin HTTP-level check
// that a root swap surfaces skills added while the old root was cached
test('GET /api/tree?view=skills: cache dropped by a root swap', async () => {
  const root = tmp('showmd-skillsview-cache-');
  try {
    mkdirSync(path.join(root, '.agents', 'skills', 'one'), { recursive: true });
    writeFileSync(path.join(root, '.agents', 'skills', 'one', 'SKILL.md'), '# one\n');
    await withServer(root, async (base) => {
      const first = await (await fetch(`${base}/api/tree?view=skills`)).json();

      mkdirSync(path.join(root, '.agents', 'skills', 'two'), { recursive: true });
      writeFileSync(path.join(root, '.agents', 'skills', 'two', 'SKILL.md'), '# two\n');

      const pick = await postPickRoot(base, { dir: root });
      assert.equal(pick.status, 200);
      const third = await (await fetch(`${base}/api/tree?view=skills`)).json();
      assert.notDeepEqual(third, first, 'setRoot drops the cache; the second skill now shows up');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// the tree watcher on r.dir ignores dot-prefixed paths (docs.ignorePath), so
// server.js runs a second, dedicated watcher over .agents/skills and
// .claude/skills that only busts skills.invalidate() — this proves that path
// end to end, without a root swap
test('GET /api/tree?view=skills: a skill file added under the served root busts the cache via the watcher, no root swap needed', async () => {
  const root = tmp('showmd-skillsview-watch-');
  try {
    mkdirSync(path.join(root, '.agents', 'skills', 'one'), { recursive: true });
    writeFileSync(path.join(root, '.agents', 'skills', 'one', 'SKILL.md'), '# one\n');
    await withServer(root, async (base) => {
      const first = await (await fetch(`${base}/api/tree?view=skills`)).json();

      mkdirSync(path.join(root, '.agents', 'skills', 'two'), { recursive: true });
      writeFileSync(path.join(root, '.agents', 'skills', 'two', 'SKILL.md'), '# two\n');
      // watcher debounce/settle: give chokidar's fs event time to land
      await new Promise((r) => setTimeout(r, 300));

      const second = await (await fetch(`${base}/api/tree?view=skills`)).json();
      assert.notDeepEqual(second, first, 'the watcher busted the cache — the new skill shows up without a root swap');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// the folder a user picks can be one this process may not read (macOS grants
// folder access per app, and the picked path is not always covered). Two
// things must survive that: the server, and the truth that it failed.
test('POST /api/pick-root: an unreadable dir -> tree 500 unreadable_root, and the server stays up', { skip: process.getuid && process.getuid() === 0 ? 'chmod does not constrain root' : false }, async () => {
  const root = tmp('showmd-pickroot-ok-');
  const denied = tmp('showmd-pickroot-denied-');
  try {
    writeFileSync(path.join(root, 'ok.md'), '# ok\n');
    writeFileSync(path.join(denied, 'hidden.md'), '# hidden\n');
    await withServer(root, async (base) => {
      chmodSync(denied, 0o000);
      assert.equal((await postPickRoot(base, { dir: denied })).status, 200);
      // the skills watcher raises EACCES asynchronously; an unhandled 'error'
      // event used to take the whole process down before this assert ran
      await new Promise((r) => setTimeout(r, 400));

      const res = await fetch(`${base}/api/tree`);
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'unreadable_root', dir: denied, code: 'EACCES' });

      const alive = await fetch(`${base}/api/root`);
      assert.equal(alive.status, 200, 'the server survived the unreadable root');
    });
  } finally {
    chmodSync(denied, 0o755);
    rmSync(root, { recursive: true, force: true });
    rmSync(denied, { recursive: true, force: true });
  }
});

test('POST /api/pick-root: a readable dir with no markdown -> tree 200 and empty, not an error', async () => {
  const root = tmp('showmd-pickroot-ok2-');
  const empty = tmp('showmd-pickroot-empty-');
  try {
    writeFileSync(path.join(root, 'ok.md'), '# ok\n');
    writeFileSync(path.join(empty, 'notes.txt'), 'not markdown\n');
    await withServer(root, async (base) => {
      assert.equal((await postPickRoot(base, { dir: empty })).status, 200);
      const res = await fetch(`${base}/api/tree`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});
