import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createServer } = require('../../server/server.js');

const fakeHome = mkdtempSync(path.join(tmpdir(), 'showmd-launcher-home-'));
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

test('createServer(null): boots with no root, no crash', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/api/root`);
    assert.equal(res.status, 200);
  });
});

test('GET /api/root: launcher mode returns {dir: null, launcher}', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/api/root`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { dir: null, launchedFrom: 'terminal' });
  });
});

test('GET /: the shell still serves with no root', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});

test('GET /api/settings: still works with no root', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/api/settings`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.historySizeBytes, null);
  });
});

test('GET /api/tree?view=skills: still works with no root (global scope only)', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/api/tree?view=skills`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.scopes), 'response has a scopes array');
  });
});

test('GET /api/tree (default view): a clean JSON error with no root, not a crash', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/api/tree`);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'no root set');
  });
});

test('GET /api/raw: a clean JSON error with no root', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/api/raw?path=${encodeURIComponent('x.md')}`);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'no root set');
  });
});

test('POST /api/pick-root: works with no root, and /api/root reflects the newly picked root afterwards', async () => {
  const newRoot = tmp('showmd-launcher-newroot-');
  try {
    writeFileSync(path.join(newRoot, 'hello.md'), '# hi\n');
    await withServer(null, async (base) => {
      const pick = await fetch(`${base}/api/pick-root`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: newRoot }),
      });
      assert.equal(pick.status, 200);
      assert.deepEqual(await pick.json(), { ok: true, root: { dir: newRoot, name: path.basename(newRoot), launchedFrom: 'terminal' } });

      const rootRes = await fetch(`${base}/api/root`);
      assert.deepEqual(await rootRes.json(), { dir: newRoot, name: path.basename(newRoot), launchedFrom: 'terminal' });

      const tree = await (await fetch(`${base}/api/tree`)).json();
      assert.deepEqual(tree, ['hello.md']);
    });
  } finally {
    rmSync(newRoot, { recursive: true, force: true });
  }
});

test('GET /api/raw: a global-scope skill id resolves rootless (mirrors the ?view=skills tree)', async () => {
  const globalSkillDir = path.join(fakeHome, '.claude', 'skills', 'globby');
  mkdirSync(globalSkillDir, { recursive: true });
  writeFileSync(path.join(globalSkillDir, 'SKILL.md'), '# global skill\n');
  try {
    await withServer(null, async (base) => {
      const res = await fetch(`${base}/api/raw?path=${encodeURIComponent('claude user/globby/SKILL.md')}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '# global skill\n');
    });
  } finally {
    rmSync(globalSkillDir, { recursive: true, force: true });
  }
});

test('GET /api/raw: a doc-file id still 409s rootless (no global skill matches it)', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/api/raw?path=${encodeURIComponent('x.md')}`);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'no root set');
  });
});

test('GET /: rootless response carries the launcher body marker', async () => {
  await withServer(null, async (base) => {
    const html = await (await fetch(base)).text();
    assert.match(html, /<body class="launcher launcher-boot">/);
  });
});

test('GET /: a server with a root carries no launcher body marker', async () => {
  const root = tmp('showmd-launcher-hasroot-');
  try {
    await withServer(root, async (base) => {
      const html = await (await fetch(base)).text();
      assert.doesNotMatch(html, /class="launcher"/);
      assert.match(html, /<body>/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// server-side recents (server/recents.js): its own isolated settings home, so
// prior tests' boot-time recordings above never leak into these assertions
test('recents: pick-root records the dir; GET reflects it; delete removes it', async () => {
  const recentsHome = tmp('showmd-recents-home-');
  const prevSettingsHome = process.env.SHOWMD_SETTINGS_HOME;
  process.env.SHOWMD_SETTINGS_HOME = recentsHome;
  const pickedRoot = tmp('showmd-recents-root-');
  try {
    await withServer(null, async (base) => {
      let res = await fetch(`${base}/api/recents`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { recents: [] });

      await fetch(`${base}/api/pick-root`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: pickedRoot }),
      });

      res = await fetch(`${base}/api/recents`);
      let body = await res.json();
      assert.equal(body.recents.length, 1);
      assert.equal(body.recents[0].path, pickedRoot);
      assert.equal(body.recents[0].kind, 'folder');

      const del = await fetch(`${base}/api/recents/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: pickedRoot }),
      });
      assert.equal(del.status, 204);

      res = await fetch(`${base}/api/recents`);
      assert.deepEqual(await res.json(), { recents: [] });
    });
  } finally {
    process.env.SHOWMD_SETTINGS_HOME = prevSettingsHome;
    rmSync(recentsHome, { recursive: true, force: true });
    rmSync(pickedRoot, { recursive: true, force: true });
  }
});

test('recents: a path that no longer exists on disk is dropped from the listing and pruned', async () => {
  const recentsHome = tmp('showmd-recents-home-');
  const prevSettingsHome = process.env.SHOWMD_SETTINGS_HOME;
  process.env.SHOWMD_SETTINGS_HOME = recentsHome;
  const ghostRoot = tmp('showmd-recents-ghost-');
  try {
    await withServer(null, async (base) => {
      await fetch(`${base}/api/pick-root`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: ghostRoot }),
      });
      rmSync(ghostRoot, { recursive: true, force: true });
      const res = await fetch(`${base}/api/recents`);
      assert.deepEqual(await res.json(), { recents: [] });
    });
  } finally {
    process.env.SHOWMD_SETTINGS_HOME = prevSettingsHome;
    rmSync(recentsHome, { recursive: true, force: true });
  }
});
