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

async function getShell(base, route) {
  const res = await fetch(`${base}${route}`);
  const html = await res.text();
  const match = html.match(/<script type="application\/json" id="boot-data">([^]*?)<\/script>/);
  return { status: res.status, contentType: res.headers.get('content-type'), boot: match ? JSON.parse(match[1]) : null };
}

test('every valid UI route serves the shell with a parsed route and root summaries', async () => {
  const root = tmp('showmd-shell-routes-');
  try {
    writeFileSync(path.join(root, 'a.md'), '# a\n');
    await withServer(root, async (base) => {
      const rootsRes = await fetch(`${base}/api/roots`);
      const { roots } = await rootsRes.json();
      const key = roots[0].key;

      const cases = [
        ['/home/', { space: 'home' }],
        [`/r/${key}/`, { space: 'root', rootKey: key }],
        [`/r/${key}/a.md`, { space: 'root', rootKey: key, documentPath: 'a.md' }],
        [`/r/${key}/?scope=docs`, { space: 'root', rootKey: key, scopePath: 'docs' }],
        ['/skills/', { space: 'skills', selection: 'global' }],
        ['/skills/?scope=all', { space: 'skills', selection: 'all' }],
        ['/agents/claude/', { space: 'agents', agentKey: 'claude' }],
        ['/settings/', { space: 'settings' }],
        [`/settings/?root=${key}`, { space: 'settings', rootKey: key }],
      ];

      for (const [route, expectedRoute] of cases) {
        const { status, contentType, boot } = await getShell(base, route);
        assert.equal(status, 200, route);
        assert.match(contentType, /^text\/html/, route);
        assert.ok(boot, `#boot-data missing for ${route}`);
        assert.deepEqual(boot.route, expectedRoute, route);
        assert.ok(Array.isArray(boot.roots), route);
        assert.equal(boot.roots.length, 1, route);
        assert.equal(boot.roots[0].key, key, route);
        assert.equal(boot.routeError, undefined, route);
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a closed root that was open this run resolves to root_not_open, same as an unknown key', async () => {
  const root = tmp('showmd-shell-cold-known-');
  try {
    await withServer(root, async (base) => {
      const key = (await (await fetch(`${base}/api/roots`)).json()).roots[0].key;
      const del = await fetch(`${base}/api/roots/${key}`, { method: 'DELETE' });
      assert.equal(del.status, 200);

      const { status, boot } = await getShell(base, `/r/${key}/`);
      assert.equal(status, 200);
      assert.deepEqual(boot.routeError, { kind: 'root_not_open', rootKey: key });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown root key resolves to root_not_open, not another root\'s content', async () => {
  const root = tmp('showmd-shell-unknown-root-');
  try {
    await withServer(root, async (base) => {
      const unknownKey = 'r_0000000000000000000000';
      const { status, boot } = await getShell(base, `/r/${unknownKey}/`);
      assert.equal(status, 200);
      assert.deepEqual(boot.route, { space: 'root', rootKey: unknownKey });
      assert.deepEqual(boot.routeError, { kind: 'root_not_open', rootKey: unknownKey });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// history sizes are slow prefix queries, so they never rode along in the
// inlined boot payload; GET /api/history-size scopes to whichever root the
// caller asks for, same as /api/settings did before the split
test('the inlined boot settings carry no history size fields; /api/history-size scopes to the requested root', async () => {
  const root = tmp('showmd-shell-settings-root-');
  try {
    writeFileSync(path.join(root, 'a.md'), '# a\n');
    await withServer(root, async (base) => {
      const { roots } = await (await fetch(`${base}/api/roots`)).json();
      const key = roots[0].key;
      await fetch(`${base}/api/roots/${key}/raw?path=a.md`, { method: 'PUT', body: '# a changed\n' });

      const scoped = await getShell(base, `/settings/?root=${key}`);
      assert.ok(!('historySizeBytes' in scoped.boot.settings));
      assert.ok(!('historyTotalBytes' in scoped.boot.settings));

      const sizeScoped = await (await fetch(`${base}/api/history-size?root=${key}`)).json();
      assert.ok(sizeScoped.historySizeBytes > 0);

      const sizeUnscoped = await (await fetch(`${base}/api/history-size`)).json();
      assert.equal(sizeUnscoped.historySizeBytes, null);

      const unknown = await getShell(base, '/settings/?root=r_0000000000000000000000');
      assert.deepEqual(unknown.boot.routeError, { kind: 'root_not_open', rootKey: 'r_0000000000000000000000' });

      const sizeUnknown = await fetch(`${base}/api/history-size?root=r_0000000000000000000000`);
      assert.equal(sizeUnknown.status, 404);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an encoded %2F inside a document segment is not collapsed into two segments', async () => {
  const root = tmp('showmd-shell-encoded-slash-');
  try {
    await withServer(root, async (base) => {
      const rootsRes = await fetch(`${base}/api/roots`);
      const { roots } = await rootsRes.json();
      const key = roots[0].key;
      const { status, boot } = await getShell(base, `/r/${key}/a%2Fb.md`);
      assert.equal(status, 200);
      assert.deepEqual(boot.route, { space: 'home' });
      assert.deepEqual(boot.routeError, { kind: 'unroutable', requested: `/r/${key}/a%2Fb.md` });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy /<relPath> lands on Home with an explanation, no redirect', async () => {
  const root = tmp('showmd-shell-legacy-');
  try {
    writeFileSync(path.join(root, 'README.md'), '# readme\n');
    await withServer(root, async (base) => {
      const { status, boot } = await getShell(base, '/README.md');
      assert.equal(status, 200);
      assert.equal(boot.route.space, 'home');
      assert.deepEqual(boot.routeError, { kind: 'unroutable', requested: '/README.md' });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
