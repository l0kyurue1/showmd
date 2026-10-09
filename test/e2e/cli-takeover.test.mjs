import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROJECT, filePath, spawnCliArgs, extractUrl, waitFor, killAndWait, getFreePort } from '../helpers/cli-e2e.mjs';

// --new skips registry reuse and advertises a dedicated process.
test('--new and --dedicated boot their own process instead of reusing the shared one', async () => {
  const spawned = [];
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-dedicated-home-')));
  const targetDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-dedicated-target-')));
  try {
    const pinnedPort = await getFreePort();
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: pinnedPort }));
    const env = { ...process.env, SHOWMD_SETTINGS_HOME: home };
    const targetFile = path.join(targetDir, 'target.md');
    writeFileSync(targetFile, '# target\n');

    const shared = spawnCliArgs([filePath, '--no-open'], { env });
    spawned.push(shared);
    const infoShared = await waitFor(() => extractUrl(shared.state.stdout));
    assert.equal(infoShared.port, pinnedPort, 'the first instance holds the pinned port');
    const versionShared = await (await fetch(`http://127.0.0.1:${pinnedPort}/api/version`)).json();
    assert.equal(versionShared.mode, 'shared', 'a plain invocation announces itself as shared');

    for (const flag of ['--new', '--dedicated']) {
      const own = spawnCliArgs([targetFile, '--no-open', flag], { env });
      spawned.push(own);
      const info = await waitFor(() => extractUrl(own.state.stdout));
      assert.notEqual(info.port, pinnedPort, `${flag} does not land on the shared process's port`);
      const version = await (await fetch(`http://127.0.0.1:${info.port}/api/version`)).json();
      assert.equal(version.mode, 'dedicated', `${flag} announces mode dedicated`);
      assert.equal((await fetch(info.url)).status, 200, `${flag} serves its own target`);
    }

    const roots = await (await fetch(`http://127.0.0.1:${pinnedPort}/api/roots`)).json();
    assert.equal(roots.roots.length, 1, 'no dedicated instance handed its root to the shared process');
    console.log('criterion PASS: --new and --dedicated each boot a dedicated process; shared process keeps its one root');
  } finally {
    await Promise.all(spawned.map((p) => killAndWait(p.child)));
    rmSync(home, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('a stale showmd on the default port is replaced, not yielded to', async () => {
  let squatter = null;
  let b = null;
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-takeover-home-')));
  try {
    const pinnedPort = await getFreePort();
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: pinnedPort }));
    const env = { ...process.env, SHOWMD_SETTINGS_HOME: home };

    // Model an outdated showmd on the default port; /api/version makes takeover safe.
    const stale = `require('node:http').createServer((q, s) => { s.writeHead(200, {'content-type':'application/json'}); s.end(JSON.stringify({version:'0.0.0-old', launcher:true})); }).listen(${pinnedPort}, '127.0.0.1', () => console.log('up'));`;
    squatter = spawn('node', ['-e', stale], { stdio: ['ignore', 'pipe', 'pipe'] });
    let squatterOut = '';
    squatter.stdout.on('data', (d) => (squatterOut += d.toString()));
    await waitFor(() => squatterOut.includes('up'));

    b = spawnCliArgs([filePath, '--no-open'], { env });
    const info = await waitFor(() => extractUrl(b.state.stdout));

    assert.equal(info.port, pinnedPort, 'the fresh instance takes the default port over');
    assert.match(b.state.stderr, new RegExp(`replacing stale showmd 0\\.0\\.0-old on port ${pinnedPort}`));
    await waitFor(() => squatter.exitCode !== null || squatter.signalCode !== null);
    const res = await fetch(`http://127.0.0.1:${info.port}/api/version`);
    assert.equal((await res.json()).version, JSON.parse(readFileSync(path.join(PROJECT, 'package.json'), 'utf8')).version);
    console.log(`criterion PASS: stale showmd 0.0.0-old on ${pinnedPort} killed, fresh instance now serves that port`);
  } finally {
    await Promise.all([squatter && { child: squatter }, b].filter(Boolean).map((p) => killAndWait(p.child)));
    rmSync(home, { recursive: true, force: true });
  }
});

// Reopening a target returns the existing root URL, not a new Scope.
test('a second invocation of the same target dedupes to the already-open root', async () => {
  let a = null;
  let b = null;
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-dedupe-home-')));
  try {
    const pinnedPort = await getFreePort();
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: pinnedPort }));
    const env = { ...process.env, SHOWMD_SETTINGS_HOME: home };

    a = spawnCliArgs([filePath, '--no-open'], { env });
    const infoA = await waitFor(() => extractUrl(a.state.stdout));
    assert.equal(infoA.port, pinnedPort, 'first instance takes the pinned default port');

    b = spawnCliArgs([filePath, '--no-open'], { env });
    const infoB = await waitFor(() => extractUrl(b.state.stdout));
    assert.equal(infoB.url, infoA.url, 'the dedupe returns the identical root URL, not a new one');

    const roots = await (await fetch(`http://127.0.0.1:${pinnedPort}/api/roots`)).json();
    assert.equal(roots.roots.length, 1, 'the duplicate target did not open a second root');
    console.log(`criterion PASS: duplicate target on ${pinnedPort} deduped to ${infoA.url}`);
  } finally {
    await Promise.all([a, b].filter(Boolean).map((p) => killAndWait(p.child)));
    rmSync(home, { recursive: true, force: true });
  }
});

// Concurrent cold starts race the bind; the loser hands its target to the winner.
