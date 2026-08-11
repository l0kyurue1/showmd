import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import '../helpers/isolate-state.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createServer } = require('../../server/server.js');

// realpath, not just mkdtemp: windows hands back an 8.3 short name here
// (C:\Users\RUNNER~1\...) and libuv aborts the process when a watch event's
// long filename does not match the short dir it was given
function tmp(prefix) {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

// isolates settings- and history-backed routes from whatever this machine has for real
process.env.SHOWMD_SETTINGS_HOME = tmp('showmd-settings-home-');
process.env.SHOWMD_HISTORY_HOME = tmp('showmd-history-home-');
const { historyDirFor } = require('../../server/history.js');

// revealFile is injected so these never spawn a real Finder/Explorer/xdg-open process
async function withServer(root, fn) {
  const revealed = [];
  const server = createServer(root, { revealFile: (p) => revealed.push(p) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const key = root === null ? null : (await (await fetch(`${base}/api/roots`)).json()).roots[0].key;
    await fn(base, revealed, key);
  } finally {
    server.close();
    await server.whenClosed();
  }
}

test('POST /api/roots/:key/reveal: valid path -> 204, injected spawner called with the resolved file, nothing actually spawned', async () => {
  const root = tmp('showmd-reveal-');
  try {
    writeFileSync(path.join(root, 'hello.md'), '# hi\n');
    await withServer(root, async (base, revealed, key) => {
      const res = await fetch(`${base}/api/roots/${key}/reveal?path=${encodeURIComponent('hello.md')}`, { method: 'POST' });
      assert.equal(res.status, 204);
      assert.deepEqual(revealed, [path.join(root, 'hello.md')]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/roots/:key/reveal: traversal outside root -> 403, spawner never called', async () => {
  const root = tmp('showmd-reveal-');
  const outside = tmp('showmd-reveal-outside-');
  try {
    writeFileSync(path.join(outside, 'secret.md'), '# secret\n');
    await withServer(root, async (base, revealed, key) => {
      const traversal = `../${path.basename(outside)}/secret.md`;
      const res = await fetch(`${base}/api/roots/${key}/reveal?path=${encodeURIComponent(traversal)}`, { method: 'POST' });
      assert.equal(res.status, 403);
      assert.deepEqual(revealed, []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('POST /api/roots/:key/reveal: missing file -> 404, spawner never called', async () => {
  const root = tmp('showmd-reveal-');
  try {
    await withServer(root, async (base, revealed, key) => {
      const res = await fetch(`${base}/api/roots/${key}/reveal?path=${encodeURIComponent('missing.md')}`, { method: 'POST' });
      assert.equal(res.status, 404);
      assert.deepEqual(revealed, []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/roots/:key/asset: serves a png from the doc directory with image/png', async () => {
  const root = tmp('showmd-asset-');
  try {
    writeFileSync(path.join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await withServer(root, async (base, revealed, key) => {
      const res = await fetch(`${base}/api/roots/${key}/asset?path=${encodeURIComponent('img.png')}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/roots/:key/asset: traversal outside root -> 403', async () => {
  const root = tmp('showmd-asset-');
  const outside = tmp('showmd-asset-outside-');
  try {
    writeFileSync(path.join(outside, 'secret.png'), Buffer.from([0x89]));
    await withServer(root, async (base, revealed, key) => {
      const traversal = `../${path.basename(outside)}/secret.png`;
      const res = await fetch(`${base}/api/roots/${key}/asset?path=${encodeURIComponent(traversal)}`);
      assert.equal(res.status, 403);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('GET /api/roots/:key/asset: non-whitelisted extension -> 404', async () => {
  const root = tmp('showmd-asset-');
  try {
    writeFileSync(path.join(root, 'notes.txt'), 'hi');
    await withServer(root, async (base, revealed, key) => {
      const res = await fetch(`${base}/api/roots/${key}/asset?path=${encodeURIComponent('notes.txt')}`);
      assert.equal(res.status, 404);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/roots/:key/raw: symlinked doc sets X-Showmd-Symlink, plain doc does not', async () => {
  const root = tmp('showmd-symlink-');
  const outside = tmp('showmd-symlink-outside-');
  try {
    writeFileSync(path.join(root, 'real.md'), '# hi\n');
    symlinkSync(path.join(root, 'real.md'), path.join(root, 'link.md'));
    writeFileSync(path.join(outside, 'external.md'), '# ext\n');
    symlinkSync(path.join(outside, 'external.md'), path.join(root, 'outlink.md'));
    await withServer(root, async (base, revealed, key) => {
      const plain = await fetch(`${base}/api/roots/${key}/raw?path=${encodeURIComponent('real.md')}`);
      assert.equal(plain.headers.get('x-showmd-symlink'), null);

      const linked = await fetch(`${base}/api/roots/${key}/raw?path=${encodeURIComponent('link.md')}`);
      assert.equal(linked.headers.get('x-showmd-symlink'), '1');
      assert.equal(decodeURIComponent(linked.headers.get('x-showmd-symlink-target')), path.join(root, 'real.md'));
      assert.equal(decodeURIComponent(linked.headers.get('x-showmd-symlink-doc')), 'real.md');

      const outlinked = await fetch(`${base}/api/roots/${key}/raw?path=${encodeURIComponent('outlink.md')}`);
      assert.equal(outlinked.headers.get('x-showmd-symlink'), '1');
      assert.equal(outlinked.headers.get('x-showmd-symlink-doc'), null);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('GET /api/version: returns the running package version', async () => {
  const root = tmp('showmd-version-');
  try {
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/version`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.version, require('../../package.json').version);
      assert.equal(body.launcher, false, 'a rooted server is never the app launcher to reuse');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/version: a rootless (launcher) server marks itself reusable', async () => {
  const server = createServer(null);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/version`);
    const body = await res.json();
    assert.equal(body.launcher, true);
  } finally {
    server.close();
    await server.whenClosed();
  }
});

test('GET /api/settings: includes a browsers list with "default" first', async () => {
  const root = tmp('showmd-settings-');
  try {
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/settings`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.browsers));
      assert.equal(body.browsers[0], 'default');
      assert.equal(body.port, 4321);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/settings: includes settingsPath, defaults, and effective (snapshot at construction)', async () => {
  const root = tmp('showmd-settings-effective-');
  try {
    await withServer(root, async (base) => {
      const settingsMod = require('../../server/settings.js');
      const before = await (await fetch(`${base}/api/settings`)).json();
      assert.equal(before.settingsPath, settingsMod.settingsFile());
      assert.deepEqual(before.defaults, settingsMod.DEFAULTS);
      assert.deepEqual(before.effective, { port: settingsMod.DEFAULTS.port, browser: settingsMod.DEFAULTS.browser });
      assert.equal(before.port, before.effective.port);

      const put = await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: 9999 }),
      });
      assert.equal(put.status, 200);

      const after = await (await fetch(`${base}/api/settings`)).json();
      assert.equal(after.port, 9999);
      assert.equal(after.effective.port, settingsMod.DEFAULTS.port);
      assert.notEqual(after.port, after.effective.port);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/reveal?settings=1: reveals settings.json regardless of ?path', async () => {
  const root = tmp('showmd-reveal-settings-');
  try {
    await withServer(root, async (base, revealed) => {
      const settingsMod = require('../../server/settings.js');
      const res = await fetch(`${base}/api/reveal?settings=1`, { method: 'POST' });
      assert.equal(res.status, 204);
      assert.deepEqual(revealed, [settingsMod.settingsFile()]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/history-size: historySizeBytes reflects a real save, POST /api/prune clears it back to 0', async () => {
  const root = tmp('showmd-prune-');
  try {
    writeFileSync(path.join(root, 'a.md'), '# a\n');
    await withServer(root, async (base, revealed, rootKey) => {
      const put = await fetch(`${base}/api/roots/${rootKey}/raw?path=${encodeURIComponent('a.md')}`, { method: 'PUT', body: '# a changed\n' });
      assert.equal(put.status, 204);
      assert.ok(existsSync(historyDirFor(root)));

      const before = await (await fetch(`${base}/api/history-size?root=${rootKey}`)).json();
      assert.ok(before.historySizeBytes > 0);

      const pruned = await fetch(`${base}/api/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'root', rootKey }),
      });
      assert.equal(pruned.status, 200);
      // scope=root now rebuilds the shared repo in place rather than deleting
      // a dedicated directory, so the repo itself survives; only this root's
      // own history is gone from it
      assert.ok(existsSync(historyDirFor(root)));

      const after = await (await fetch(`${base}/api/history-size?root=${rootKey}`)).json();
      assert.equal(after.historySizeBytes, 0);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/prune: scope=root without a rootKey is a 400, and an unopen key is a 404', async () => {
  const root = tmp('showmd-prune-key-');
  try {
    await withServer(root, async (base) => {
      const unnamed = await fetch(`${base}/api/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'root' }),
      });
      assert.equal(unnamed.status, 400);

      const unopen = await fetch(`${base}/api/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'root', rootKey: 'r_AAAAAAAAAAAAAAAAAAAAAA' }),
      });
      assert.equal(unopen.status, 404);
      assert.equal((await unopen.json()).error, 'root_not_open');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/history-size: historySizeBytes is null without a root and 404s on an unopen key', async () => {
  const root = tmp('showmd-settings-root-');
  try {
    await withServer(root, async (base) => {
      const unscoped = await (await fetch(`${base}/api/history-size`)).json();
      assert.equal(unscoped.historySizeBytes, null);

      const unopen = await fetch(`${base}/api/history-size?root=r_AAAAAAAAAAAAAAAAAAAAAA`);
      assert.equal(unopen.status, 404);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function withInstallServer(fn, opts = {}) {
  const root = tmp('showmd-install-');
  const server = createServer(root, opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    await server.whenClosed();
    rmSync(root, { recursive: true, force: true });
  }
}

test('POST /api/install-app: calls the injected installFn and reports its result', async () => {
  let calls = 0;
  const installFn = () => { calls++; return { dest: '/fake/ShowMD.app', ephemeral: false }; };
  await withInstallServer(async (base) => {
    const res = await fetch(`${base}/api/install-app`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, dest: '/fake/ShowMD.app', ephemeral: false });
    assert.equal(calls, 1);
  }, { installFn });
});

test('POST /api/install-app: installFn throwing -> 500 with the error message', async () => {
  const installFn = () => { throw new Error('boom'); };
  await withInstallServer(async (base) => {
    const res = await fetch(`${base}/api/install-app`, { method: 'POST' });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'boom' });
  }, { installFn });
});

test('POST /api/install-app: unsupported platform -> 501, no install attempted', async () => {
  await withInstallServer(async (base) => {
    const res = await fetch(`${base}/api/install-app`, { method: 'POST' });
    assert.equal(res.status, 501);
  }, { platform: 'freebsd' });
});

test('GET /api/history-size: includes historyTotalBytes summed across every shadow repo', async () => {
  // the shared repo now spans every root this test file has touched, so this
  // test needs a clean store to compare an exact total against
  await require('../../server/history.js').pruneAll();
  const rootA = tmp('showmd-total-a-');
  const rootB = tmp('showmd-total-b-');
  try {
    writeFileSync(path.join(rootA, 'a.md'), '# a\n');
    await withServer(rootA, async (base, revealed, key) => {
      await fetch(`${base}/api/roots/${key}/raw?path=${encodeURIComponent('a.md')}`, { method: 'PUT', body: '# a changed\n' });
      const before = await (await fetch(`${base}/api/history-size`)).json();
      assert.ok(before.historyTotalBytes > 0);
    });
    writeFileSync(path.join(rootB, 'b.md'), '# b\n');
    await withServer(rootB, async (base, revealed, key) => {
      await fetch(`${base}/api/roots/${key}/raw?path=${encodeURIComponent('b.md')}`, { method: 'PUT', body: '# b changed\n' });
      const after = await (await fetch(`${base}/api/history-size`)).json();
      // rootA's shadow repo is still on disk, so the total covers both roots
      const rootAOnly = await require('../../server/history.js').historySize(rootA);
      const rootBOnly = await require('../../server/history.js').historySize(rootB);
      assert.equal(after.historyTotalBytes, rootAOnly + rootBOnly);
    });
  } finally {
    await require('../../server/history.js').pruneAll();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('POST /api/prune: invalid scope -> 400', async () => {
  const root = tmp('showmd-prune-scope-');
  try {
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'bogus' }),
      });
      assert.equal(res.status, 400);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// otherDir and historyDirFor(root) are now the same shared repo (one repo per
// drive, not per root), so this only proves scope=all wipes the store itself;
// test/unit/history.test.mjs's migration/prune tests cover cross-root sharing
test('POST /api/prune: scope=all removes every shadow repo, not just the served root\'s', async () => {
  const root = tmp('showmd-prune-all-');
  const otherDir = historyDirFor(tmp('showmd-prune-all-other-'));
  try {
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(path.join(otherDir, 'marker'), 'x');
    writeFileSync(path.join(root, 'a.md'), '# a\n');
    await withServer(root, async (base, revealed, key) => {
      await fetch(`${base}/api/roots/${key}/raw?path=${encodeURIComponent('a.md')}`, { method: 'PUT', body: '# a changed\n' });
      assert.ok(existsSync(historyDirFor(root)));
      assert.ok(existsSync(otherDir));

      const res = await fetch(`${base}/api/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all' }),
      });
      assert.equal(res.status, 200);
      assert.ok(!existsSync(historyDirFor(root)));
      assert.ok(!existsSync(otherDir));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/settings: appInstalled/appPath come from the injected appStatusFn seam', async () => {
  const root = tmp('showmd-launcher-');
  try {
    const appStatusFn = () => ({ installed: true, path: '/fake/ShowMD.app' });
    const server = createServer(root, { appStatusFn });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const body = await (await fetch(`${base}/api/settings`)).json();
      assert.equal(body.appInstalled, true);
      assert.equal(body.appPath, '/fake/ShowMD.app');
    } finally {
      server.close();
      await server.whenClosed();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/settings: mdHandlerDefault comes from the injected mdHandlerDefaultFn seam', async () => {
  const root = tmp('showmd-mdhandler-');
  try {
    const mdHandlerDefaultFn = () => true;
    const server = createServer(root, { mdHandlerDefaultFn });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const body = await (await fetch(`${base}/api/settings`)).json();
      assert.equal(body.mdHandlerDefault, true);
    } finally {
      server.close();
      await server.whenClosed();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/settings: mdHandlerDefault defaults to false without the seam (non-darwin test platform has no real handler)', async () => {
  const root = tmp('showmd-mdhandler-default-');
  try {
    const server = createServer(root, { platform: 'linux' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const body = await (await fetch(`${base}/api/settings`)).json();
      assert.equal(body.mdHandlerDefault, false);
    } finally {
      server.close();
      await server.whenClosed();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/register-markdown: calls the injected registerMdFn and reports its result', async () => {
  let calls = 0;
  const registerMdFn = () => { calls++; return { dest: '/fake/ShowMD.app' }; };
  await withInstallServer(async (base) => {
    const res = await fetch(`${base}/api/register-markdown`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, dest: '/fake/ShowMD.app', opened: false });
    assert.equal(calls, 1);
  }, { registerMdFn, platform: 'darwin' });
});

test('POST /api/register-markdown: opens Get Info on the root\'s first .md file via the injected opener', async () => {
  const registerMdFn = () => ({ dest: '/fake/ShowMD.app' });
  let openedPath = null;
  const openInfoFn = (fullPath) => { openedPath = fullPath; return true; };
  const root = tmp('showmd-install-');
  writeFileSync(path.join(root, 'a.md'), '# a');
  const server = createServer(root, { registerMdFn, openInfoFn, platform: 'darwin' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/register-markdown`, { method: 'POST' });
    assert.deepEqual(await res.json(), { ok: true, dest: '/fake/ShowMD.app', opened: true });
    assert.equal(openedPath, path.join(root, 'a.md'));
  } finally {
    server.close();
    await server.whenClosed();
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/register-markdown: a failing opener still reports 200 with opened:false', async () => {
  const registerMdFn = () => ({ dest: '/fake/ShowMD.app' });
  const openInfoFn = () => { throw new Error('no display'); };
  const root = tmp('showmd-install-');
  writeFileSync(path.join(root, 'a.md'), '# a');
  const server = createServer(root, { registerMdFn, openInfoFn, platform: 'darwin' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/register-markdown`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, dest: '/fake/ShowMD.app', opened: false });
  } finally {
    server.close();
    await server.whenClosed();
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/register-markdown: non-darwin platform -> 501', async () => {
  await withInstallServer(async (base) => {
    const res = await fetch(`${base}/api/register-markdown`, { method: 'POST' });
    assert.equal(res.status, 501);
  }, { platform: 'linux' });
});

test('POST /api/restart: responds 200 and invokes the injected restartFn instead of actually restarting', async () => {
  let called = 0;
  const restartFn = () => { called++; };
  await withInstallServer(async (base) => {
    const res = await fetch(`${base}/api/restart`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    // restart is scheduled after the response is sent and after the
    // server-restarting broadcast has read settings, so it lands a few ticks out
    await waitUntil(() => called === 1);
    assert.equal(called, 1);
  }, { restartFn });
});

test('POST /api/restart: two concurrent requests only invoke restartFn once', async () => {
  let called = 0;
  const restartFn = () => { called++; };
  await withInstallServer(async (base) => {
    const [res1, res2] = await Promise.all([
      fetch(`${base}/api/restart`, { method: 'POST' }),
      fetch(`${base}/api/restart`, { method: 'POST' }),
    ]);
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
    await waitUntil(() => called === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(called, 1, 'the second concurrent call is a no-op');
  }, { restartFn });
});

async function waitUntil(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

async function waitForFile(file, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function waitForGone(file, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('POST /api/shutdown: responds 200, stops the server, and removes its registry entry (no respawn)', async () => {
  const root = tmp('showmd-shutdown-');
  const announceFile = path.join(process.env.SHOWMD_SETTINGS_HOME, 'ports', `${process.pid}.json`);
  let exitCode = null;
  const server = createServer(root, { exitFn: (code) => { exitCode = code; } });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.ok(await waitForFile(announceFile), 'registry entry written on listen');

    const closed = new Promise((resolve) => server.once('close', resolve));
    const res = await fetch(`${base}/api/shutdown`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    await closed;
    await server.whenClosed();
    assert.equal(exitCode, 0);
    await assert.rejects(() => fetch(base), 'server no longer accepts connections');
    assert.ok(await waitForGone(announceFile), 'registry entry removed after shutdown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/shutdown: two concurrent requests only close/exit once', async () => {
  const root = tmp('showmd-shutdown-concurrent-');
  let exitCalls = 0;
  const server = createServer(root, { exitFn: () => { exitCalls++; } });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const closed = new Promise((resolve) => server.once('close', resolve));

    const [res1, res2] = await Promise.all([
      fetch(`${base}/api/shutdown`, { method: 'POST' }),
      fetch(`${base}/api/shutdown`, { method: 'POST' }).catch(() => null),
    ]);
    assert.equal(res1.status, 200);
    if (res2) assert.equal(res2.status, 200);

    await closed;
    await server.whenClosed();
    assert.equal(exitCalls, 1, 'the second concurrent call is a no-op');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('per-instance ports/<pid>.json: announced on listen with {port, pid}, retracted on close', async () => {
  const { list } = require('../../server/ports.js');
  const root = tmp('showmd-ports-registry-');
  const announceFile = path.join(process.env.SHOWMD_SETTINGS_HOME, 'ports', `${process.pid}.json`);
  const server = createServer(root);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    assert.ok(await waitForFile(announceFile), 'per-instance file written on listen');
    assert.deepEqual(JSON.parse(readFileSync(announceFile, 'utf8')), { port: server.address().port, pid: process.pid });
    assert.deepEqual(await list(), [{ port: server.address().port, pid: process.pid }]);
  } finally {
    server.close();
    await server.whenClosed();
    assert.ok(await waitForGone(announceFile), 'per-instance file removed on close');
    rmSync(root, { recursive: true, force: true });
  }
});

test('createServer(root): booting with a real root records it as a recent entry', async () => {
  const root = tmp('showmd-boot-recents-');
  try {
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/recents`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.recents.some((e) => e.path === root && e.kind === 'folder'), 'boot recorded the root dir');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /assets/*: client code is served no-cache so an upgrade cannot leave a stale client', async () => {
  const root = tmp('showmd-assets-cache-');
  try {
    await withServer(root, async (base) => {
      for (const rel of ['app.js', 'settings-view.js', 'update-cta.js', 'app.css']) {
        const res = await fetch(`${base}/assets/${rel}`);
        assert.equal(res.status, 200, `${rel} served`);
        assert.equal(res.headers.get('cache-control'), 'no-cache', `${rel} is revalidated`);
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /: boot shell embeds escaped boot data as JSON before the module script', async () => {
  const root = tmp('showmd-boot-shell-');
  try {
    await withServer(root, async (base) => {
      const html = await (await fetch(`${base}/`)).text();
      const match = html.match(/<script type="application\/json" id="boot-data">(.*?)<\/script>/);
      assert.ok(match, 'boot-data script tag present');
      const boot = JSON.parse(match[1]);
      assert.ok(boot.settings, 'boot data carries settings');
      assert.ok(html.indexOf(match[0]) < html.indexOf('<script type="module"'), 'boot data precedes the module script');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /: a "<" in boot data (from the root dir name) is escaped so it cannot close the script tag early', { skip: process.platform === 'win32' && 'windows forbids < and > in a file name, so this root cannot exist' }, async () => {
  // the root's basename rides into boot.root.name verbatim; a name containing
  // "<script>" is the same shape of hazard the original renderShell unit test
  // covered, reached here through a real root instead of a hand-built object
  const root = tmp('showmd-boot-shell-<script>x-');
  try {
    await withServer(root, async (base) => {
      const html = await (await fetch(`${base}/`)).text();
      assert.ok(!html.includes('<script>x'), 'raw "<script>x" must not appear unescaped in the response');
      assert.ok(html.includes('\\u003cscript>x'), 'the "<" is escaped inside boot data');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /: colorMode stamps data-theme on <html> for light/dark, and leaves it untouched for system', async () => {
  const root = tmp('showmd-boot-theme-');
  try {
    await withServer(root, async (base) => {
      const before = await (await fetch(`${base}/`)).text();
      assert.ok(before.includes('<html lang="en">'));
      assert.ok(!before.includes('data-theme'));

      await fetch(`${base}/api/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ colorMode: 'dark' }),
      });
      const dark = await (await fetch(`${base}/`)).text();
      assert.ok(dark.includes('<html lang="en" data-theme="dark">'));

      await fetch(`${base}/api/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ colorMode: 'light' }),
      });
      const light = await (await fetch(`${base}/`)).text();
      assert.ok(light.includes('<html lang="en" data-theme="light">'));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /: rootless boot (Home) adds launcher classes to <body>; a rooted boot does not', async () => {
  const rooted = tmp('showmd-boot-launcher-rooted-');
  try {
    await withServer(null, async (base) => {
      const html = await (await fetch(`${base}/`)).text();
      assert.ok(html.includes('<body class="launcher launcher-boot">'));
    });
    await withServer(rooted, async (base) => {
      const html = await (await fetch(`${base}/`)).text();
      assert.ok(html.includes('<body>\n'));
      assert.ok(!html.includes('launcher-boot'));
    });
  } finally {
    rmSync(rooted, { recursive: true, force: true });
  }
});
