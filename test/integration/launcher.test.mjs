import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createServer } = require('../../server/server.js');

const fakeHome = mkdtempSync(path.join(tmpdir(), 'showmd-launcher-home-'));
process.env.HOME = fakeHome;
// os.homedir() reads USERPROFILE on windows and ignores HOME
process.env.USERPROFILE = fakeHome;

// realpath, not just mkdtemp: windows hands back an 8.3 short name here
// (C:\Users\RUNNER~1\...) and libuv aborts the process when a watch event's
// long filename does not match the short dir it was given
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
  }
}

async function bootData(base) {
  const html = await (await fetch(base)).text();
  const match = html.match(/<script type="application\/json" id="boot-data">(.*?)<\/script>/s);
  return JSON.parse(match[1]);
}

test('createServer(null): boots with no root, no crash', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/api/roots`);
    assert.equal(res.status, 200);
  });
});

test('boot data: launcher mode reports {dir: null, launcher}', async () => {
  await withServer(null, async (base) => {
    const boot = await bootData(base);
    assert.deepEqual(boot.root, { dir: null, launchedFrom: 'terminal' });
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
    assert.ok(!('historySizeBytes' in body));
  });
});

test('GET /api/skills/tree: still works with no root (global scope only)', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/api/skills/tree`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.scopes), 'response has a scopes array');
  });
});

// pick-root/setRoot are gone; adding a root to a rootless launcher now only
// goes through RootManager (POST /api/roots) and is visible via root-scoped
// routes
test('POST /api/roots: adds a root to a rootless launcher; visible at its own key', async () => {
  const newRoot = tmp('showmd-launcher-newroot-');
  try {
    writeFileSync(path.join(newRoot, 'hello.md'), '# hi\n');
    await withServer(null, async (base) => {
      const add = await fetch(`${base}/api/roots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newRoot }),
      });
      assert.equal(add.status, 200);
      const added = await add.json();
      assert.equal(added.root.dir, newRoot);

      const tree = await (await fetch(`${base}/api/roots/${added.root.key}/tree`)).json();
      assert.deepEqual(tree, ['hello.md']);

      const shell = await (await fetch(`${base}${added.url}`)).text();
      assert.doesNotMatch(shell, /<body class="launcher launcher-boot">/,
        'a launcher with a live root must boot that root tree');
    });
  } finally {
    rmSync(newRoot, { recursive: true, force: true });
  }
});

test('GET /api/skills/raw: a global-scope skill id resolves rootless (mirrors the skills tree)', async () => {
  const globalSkillDir = path.join(fakeHome, '.claude', 'skills', 'globby');
  mkdirSync(globalSkillDir, { recursive: true });
  writeFileSync(path.join(globalSkillDir, 'SKILL.md'), '# global skill\n');
  try {
    await withServer(null, async (base) => {
      const res = await fetch(`${base}/api/skills/raw?id=${encodeURIComponent('claude user/globby/SKILL.md')}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '# global skill\n');
    });
  } finally {
    rmSync(globalSkillDir, { recursive: true, force: true });
  }
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
// prior tests' boot-time recordings above never leak into these assertions.
// POST /api/roots records its target too (see test/integration/roots.test.mjs);
// this file's coverage stays on the boot-time recording path.
test('recents: a single-root boot records the dir; GET reflects it; delete removes it', async () => {
  const recentsHome = tmp('showmd-recents-home-');
  const prevSettingsHome = process.env.SHOWMD_SETTINGS_HOME;
  process.env.SHOWMD_SETTINGS_HOME = recentsHome;
  const bootRoot = tmp('showmd-recents-root-');
  try {
    await withServer(bootRoot, async (base) => {
      let res = await fetch(`${base}/api/recents`);
      assert.equal(res.status, 200);
      let body = await res.json();
      assert.equal(body.recents.length, 1);
      assert.equal(body.recents[0].path, bootRoot);
      assert.equal(body.recents[0].kind, 'folder');

      const del = await fetch(`${base}/api/recents/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: bootRoot }),
      });
      assert.equal(del.status, 204);

      res = await fetch(`${base}/api/recents`);
      assert.deepEqual(await res.json(), { recents: [] });
    });
  } finally {
    if (prevSettingsHome === undefined) delete process.env.SHOWMD_SETTINGS_HOME;
    else process.env.SHOWMD_SETTINGS_HOME = prevSettingsHome;
    rmSync(recentsHome, { recursive: true, force: true });
    rmSync(bootRoot, { recursive: true, force: true });
  }
});

test('recents: a path that no longer exists on disk is dropped from the listing and pruned', async () => {
  const recentsHome = tmp('showmd-recents-home-');
  const prevSettingsHome = process.env.SHOWMD_SETTINGS_HOME;
  process.env.SHOWMD_SETTINGS_HOME = recentsHome;
  const ghostRoot = tmp('showmd-recents-ghost-');
  try {
    await withServer(ghostRoot, async (base) => {
      rmSync(ghostRoot, { recursive: true, force: true });
      const res = await fetch(`${base}/api/recents`);
      assert.deepEqual(await res.json(), { recents: [] });
    });
  } finally {
    if (prevSettingsHome === undefined) delete process.env.SHOWMD_SETTINGS_HOME;
    else process.env.SHOWMD_SETTINGS_HOME = prevSettingsHome;
    rmSync(recentsHome, { recursive: true, force: true });
  }
});
