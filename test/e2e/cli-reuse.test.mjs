import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROJECT, filePath, spawnCliArgs, spawnCliFrom, copyPackageWithVersion, extractUrl, waitFor, waitForAsync, waitForClose, killAndWait, getFreePort } from '../helpers/cli-e2e.mjs';

// A second shared invocation adds its target to the registry primary and exits.
test('two sequential invocations reuse one process: second reuses the first, both roots live', async () => {
  let a = null;
  let b = null;
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-reuse-home-')));
  const secondDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-reuse-second-')));
  try {
    const pinnedPort = await getFreePort();
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: pinnedPort }));
    const env = { ...process.env, SHOWMD_SETTINGS_HOME: home };
    const secondFile = path.join(secondDir, 'second.md');
    writeFileSync(secondFile, '# second\n');

    a = spawnCliArgs([filePath, '--no-open'], { env });
    const infoA = await waitFor(() => extractUrl(a.state.stdout));
    assert.equal(infoA.port, pinnedPort, 'first instance takes the pinned default port as primary');

    b = spawnCliArgs([secondFile, '--no-open'], { env });
    const infoB = await waitFor(() => extractUrl(b.state.stdout));
    assert.equal(infoB.port, pinnedPort, 'second instance reuses the first process instead of booting its own');

    const bExitCode = await waitForClose(b.child);
    assert.equal(bExitCode, 0, 'the reusing invocation exits after handing its target to the primary');

    const roots = await (await fetch(`http://127.0.0.1:${pinnedPort}/api/roots`)).json();
    assert.equal(roots.roots.length, 2, 'both roots are live on the one process');

    const [resA, resB] = await Promise.all([fetch(infoA.url), fetch(infoB.url)]);
    assert.equal(resA.status, 200, 'first root serves 200');
    assert.equal(resB.status, 200, 'second root serves 200 on the same process');
    console.log(`criterion PASS: two sequential invocations -> one process on ${pinnedPort}, two roots, both 200`);
  } finally {
    await Promise.all([a, b].filter(Boolean).map((p) => killAndWait(p.child)));
    rmSync(home, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
});

test('a target invocation replaces a mismatched shared runtime and preserves both roots', async () => {
  const oldVersion = '0.0.0-old-runtime';
  const currentVersion = JSON.parse(readFileSync(path.join(PROJECT, 'package.json'), 'utf8')).version;
  const oldPackage = copyPackageWithVersion(oldVersion);
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-version-replace-home-')));
  const secondDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-version-replace-target-')));
  let old = null;
  let fresh = null;
  try {
    const pinnedPort = await getFreePort();
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: pinnedPort }));
    const env = { ...process.env, SHOWMD_SETTINGS_HOME: home };
    const secondFile = path.join(secondDir, 'second.md');
    writeFileSync(secondFile, '# second\n');

    old = spawnCliFrom(oldPackage, [filePath, '--no-open'], { env });
    await waitFor(() => extractUrl(old.state.stdout));
    assert.equal((await (await fetch(`http://127.0.0.1:${pinnedPort}/api/version`)).json()).version, oldVersion);

    fresh = spawnCliArgs([secondFile, '--no-open'], { env });
    const version = await waitForAsync(async () => {
      try {
        const body = await (await fetch(`http://127.0.0.1:${pinnedPort}/api/version`)).json();
        return body.version === currentVersion ? body : null;
      } catch {
        return null;
      }
    });
    assert.equal(version.version, currentVersion, 'the discovered runtime must exactly match the invoking package');
    await waitFor(() => old.child.exitCode !== null || old.child.signalCode !== null);

    const info = await waitFor(() => extractUrl(fresh.state.stdout));
    assert.equal(info.port, pinnedPort, 'replacement keeps the shared port');
    const roots = await (await fetch(`http://127.0.0.1:${pinnedPort}/api/roots`)).json();
    assert.equal(roots.roots.length, 2, 'replacement preserves the old root and adds the requested root');
  } finally {
    await Promise.all([old, fresh].filter(Boolean).map((p) => killAndWait(p.child)));
    rmSync(oldPackage, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
});

test('launcher discovery replaces a mismatched shared runtime without losing its roots', async () => {
  const oldVersion = '0.0.0-old-launcher';
  const currentVersion = JSON.parse(readFileSync(path.join(PROJECT, 'package.json'), 'utf8')).version;
  const oldPackage = copyPackageWithVersion(oldVersion);
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-launcher-replace-home-')));
  let old = null;
  let fresh = null;
  try {
    const pinnedPort = await getFreePort();
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: pinnedPort }));
    const env = { ...process.env, SHOWMD_SETTINGS_HOME: home };

    old = spawnCliFrom(oldPackage, [filePath, '--no-open'], { env });
    const oldInfo = await waitFor(() => extractUrl(old.state.stdout));

    fresh = spawnCliArgs(['--launcher', '--no-open'], { env });
    const version = await waitForAsync(async () => {
      try {
        const body = await (await fetch(`http://127.0.0.1:${pinnedPort}/api/version`)).json();
        return body.version === currentVersion ? body : null;
      } catch {
        return null;
      }
    });
    assert.equal(version.version, currentVersion, 'launcher must run the exact invoking package');
    await waitFor(() => old.child.exitCode !== null || old.child.signalCode !== null);

    const launcherInfo = await waitFor(() => extractUrl(fresh.state.stdout));
    assert.equal(launcherInfo.port, pinnedPort, 'replacement keeps the shared port');
    assert.equal((await fetch(oldInfo.url)).status, 200, 'the replacement preserves the already-open root');
  } finally {
    await Promise.all([old, fresh].filter(Boolean).map((p) => killAndWait(p.child)));
    rmSync(oldPackage, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
