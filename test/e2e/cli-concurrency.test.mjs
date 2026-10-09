import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnCliArgs, spawnCli, extractUrl, waitFor, killAndWait, getFreePort } from '../helpers/cli-e2e.mjs';

// Concurrent cold starts race the bind; the loser hands its target to the winner.
test('two concurrent cold starts: exactly one primary survives, both targets are served', async () => {
  let a = null;
  let b = null;
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-concurrent-home-')));
  const dirA = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-concurrent-a-')));
  const dirB = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-concurrent-b-')));
  try {
    const pinnedPort = await getFreePort();
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: pinnedPort }));
    const env = { ...process.env, SHOWMD_SETTINGS_HOME: home };
    const fileA = path.join(dirA, 'a.md');
    const fileB = path.join(dirB, 'b.md');
    writeFileSync(fileA, '# a\n');
    writeFileSync(fileB, '# b\n');

    a = spawnCliArgs([fileA, '--no-open'], { env });
    b = spawnCliArgs([fileB, '--no-open'], { env });
    const [infoA, infoB] = await Promise.all([
      waitFor(() => extractUrl(a.state.stdout), 10000),
      waitFor(() => extractUrl(b.state.stdout), 10000),
    ]);

    assert.equal(infoA.port, infoB.port, 'both invocations converge on one compatible primary port');

    const [resA, resB] = await Promise.all([fetch(infoA.url), fetch(infoB.url)]);
    assert.equal(resA.status, 200, 'target A serves 200');
    assert.equal(resB.status, 200, 'target B serves 200');
    const roots = await (await fetch(`http://127.0.0.1:${infoA.port}/api/roots`)).json();
    assert.equal(roots.roots.length, 2, 'both targets are live roots on the surviving primary');
    console.log(`criterion PASS: concurrent cold start -> one primary on ${infoA.port}, both targets served`);
  } finally {
    await Promise.all([a, b].filter(Boolean).map((p) => killAndWait(p.child)));
    rmSync(home, { recursive: true, force: true });
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('explicit --port collision: second instance exits 1 with a port-conflict message', async () => {
  let a = null;
  let b = null;
  try {
    // pick a free port ourselves so the explicit-port collision below is
    // guaranteed to be with our own first instance, not an unrelated process
    const explicitPort = await getFreePort();
    a = spawnCli(['--port', String(explicitPort)]);
    await waitFor(() => extractUrl(a.state.stdout));

    b = spawnCli(['--port', String(explicitPort)]);
    const bExitCode = await new Promise((resolve) => b.child.on('close', (code) => resolve(code)));
    assert.equal(bExitCode, 1, 'explicit --port collision exits 1');
    assert.match(b.state.stderr, /port/i, 'stderr explains the port conflict');
    console.log(`criterion PASS: explicit --port ${explicitPort} collision -> second instance exited ${bExitCode}, stderr: ${b.state.stderr.trim()}`);
  } finally {
    await Promise.all([a, b].filter(Boolean).map((p) => killAndWait(p.child)));
  }
});

