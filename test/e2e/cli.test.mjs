import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');

// realpath every temp root: windows hands back 8.3 short names here, and libuv
// aborts a served process when a watch event's long filename does not match
const workDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-cli-')));
const filePath = path.join(workDir, 'file.md');
writeFileSync(filePath, '# hi\n');
// isolates the default-port tests below from any settings.json a real user saved
// on this machine (the port setting now feeds the CLI's default, per settings.js)
const settingsHome = path.join(workDir, 'settings-home');
mkdirSync(settingsHome, { recursive: true });
// Disable network updates and pin tests away from a live default-port server.
const defaultTestPort = await getFreePort();
writeFileSync(path.join(settingsHome, 'settings.json'), JSON.stringify({ updateCheck: false, port: defaultTestPort }));
const childEnv = { ...process.env, SHOWMD_SETTINGS_HOME: settingsHome };

function spawnCli(extraArgs) {
  return spawnCliArgs([filePath, '--no-open', ...extraArgs]);
}

function spawnCliArgs(argv, opts = {}) {
  return spawnCliFrom(PROJECT, argv, { env: childEnv, ...opts });
}

function spawnCliFrom(packageDir, argv, opts = {}) {
  const child = spawn('node', [path.join(packageDir, 'bin', 'cli.js'), ...argv], { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => (state.stdout += d.toString()));
  child.stderr.on('data', (d) => (state.stderr += d.toString()));
  return { child, state };
}

function copyPackageWithVersion(version) {
  const packageDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-old-package-')));
  for (const dir of ['bin', 'client', 'server']) {
    cpSync(path.join(PROJECT, dir), path.join(packageDir, dir), { recursive: true });
  }
  const pkg = JSON.parse(readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ ...pkg, version }));
  symlinkSync(path.join(PROJECT, 'node_modules'), path.join(packageDir, 'node_modules'), 'dir');
  return packageDir;
}

function extractUrl(stdout) {
  const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\/\S*/);
  return m ? { url: m[0], port: Number(m[1]) } : null;
}

async function bootData(base) {
  const html = await (await fetch(base)).text();
  const match = html.match(/<script type="application\/json" id="boot-data">(.*?)<\/script>/s);
  return JSON.parse(match[1]);
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

async function waitForAsync(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

// a child that already exited has already emitted 'close'; a listener
// attached after that fires never sees it and awaits forever
function waitForClose(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    child.once('close', (code) => resolve(code));
  });
}

function killAndWait(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', () => resolve());
    child.kill();
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

test.after(() => rmSync(workDir, { recursive: true, force: true }));

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

test('--help exit 0, --version matches package.json, unknown flag exit 1', async () => {
  const pkg = JSON.parse(readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
  function runCli(args) {
    return new Promise((resolve) => {
      const child = spawn('node', [path.join(PROJECT, 'bin', 'cli.js'), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }
  const help = await runCli(['--help']);
  assert.equal(help.code, 0, '--help exits 0');
  assert.match(help.stdout, /Usage:/, '--help prints usage');
  const ver = await runCli(['--version']);
  assert.equal(ver.code, 0, '--version exits 0');
  assert.equal(ver.stdout.trim(), pkg.version, '--version matches package.json');
  const bad = await runCli(['--bogus']);
  assert.equal(bad.code, 1, 'unknown flag exits 1');
  assert.match(bad.stderr, /unknown option/, 'unknown flag names the problem');
  assert.doesNotMatch(help.stdout, /--launcher/, '--launcher is internal, not listed in --help');
  console.log('criterion PASS: --help exit 0, --version matches package.json, unknown flag exit 1');
});

test('install-skill: exits 0 and lands SKILL.md under a fake HOME', async () => {
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-installskill-')));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  try {
    const { child, state } = spawnCliArgs(['install-skill'], {
      env: { ...childEnv, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', XDG_CONFIG_HOME: '' },
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, `install-skill exits 0 (stderr: ${state.stderr})`);
    const canonical = path.join(home, '.agents', 'skills', 'showmd', 'SKILL.md');
    assert.match(readFileSync(canonical, 'utf8'), /^name: showmd$/m, 'canonical copy carries the frontmatter name');
    assert.match(readFileSync(path.join(home, '.claude', 'skills', 'showmd', 'SKILL.md'), 'utf8'), /^name: showmd$/m);
    const openaiMetadata = path.join(home, '.agents', 'skills', 'showmd', 'agents', 'openai.yaml');
    assert.match(readFileSync(openaiMetadata, 'utf8'), /display_name: "ShowMD"/, 'canonical skill carries Codex UI metadata');
    assert.equal(realpathSync.native(path.join(home, '.claude', 'skills', 'showmd')), path.dirname(path.dirname(openaiMetadata)),
      'Claude Code and Codex-compatible metadata share one canonical skill directory');
    assert.match(state.stdout, /Claude Code/, 'stdout names the agent it reached');
    console.log(`criterion PASS: install-skill exit 0, SKILL.md and agents/openai.yaml at ${path.dirname(canonical)}, Claude Code linked`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--launcher --no-open: boots with no root; boot data gives dir null', async () => {
  let p = null;
  // Pin an isolated port so a live installed launcher cannot absorb the test.
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-launcher-home-')));
  try {
    const pinnedPort = await getFreePort();
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: pinnedPort }));
    const env = { ...process.env, SHOWMD_SETTINGS_HOME: home };
    p = spawnCliArgs(['--launcher', '--no-open'], { env });
    const info = await waitFor(() => extractUrl(p.state.stdout));
    assert.match(p.state.stdout, /showmd launcher/);
    const boot = await bootData(`http://127.0.0.1:${info.port}/`);
    assert.deepEqual(boot.root, { dir: null, launchedFrom: 'terminal' });
    console.log('criterion PASS: --launcher boots with dir:null');
  } finally {
    if (p) await killAndWait(p.child);
    rmSync(home, { recursive: true, force: true });
  }
});

// Regression: launcher discovery must find a rooted server on another port.
test('--launcher reuses an already-running rooted shared server on a different port', async () => {
  let a = null;
  let b = null;
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-launcher-reuse-home-')));
  try {
    const pinnedPort = await getFreePort();
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: pinnedPort }));
    const env = { ...process.env, SHOWMD_SETTINGS_HOME: home };

    a = spawnCliArgs([filePath, '--no-open'], { env });
    const infoA = await waitFor(() => extractUrl(a.state.stdout));
    assert.equal(infoA.port, pinnedPort, 'first instance boots as the shared server on the pinned port');

    // an explicit --port would force a dedicated boot, so leave args.port at its
    // settings.json default (pinnedPort) instead
    b = spawnCliArgs(['--launcher', '--no-open'], { env });
    const infoB = await waitFor(() => extractUrl(b.state.stdout));
    assert.equal(infoB.port, pinnedPort, '--launcher reused the already-rooted shared server instead of booting a second one');

    const bExitCode = await waitForClose(b.child);
    assert.equal(bExitCode, 0, 'the reusing --launcher invocation exits after printing the reused URL');

    const roots = await (await fetch(`http://127.0.0.1:${pinnedPort}/api/roots`)).json();
    assert.equal(roots.roots.length, 1, '--launcher did not add a root of its own');
    console.log(`criterion PASS: --launcher reused the rooted shared server on ${pinnedPort} instead of spawning a duplicate`);
  } finally {
    await Promise.all([a, b].filter(Boolean).map((p) => killAndWait(p.child)));
    rmSync(home, { recursive: true, force: true });
  }
});

test('root classification matches the Document Store: .markdown and uppercase .MD boot, .txt and missing paths fail', async () => {
  const dotMarkdown = path.join(workDir, 'notes.markdown');
  writeFileSync(dotMarkdown, '# notes\n');
  const upperMd = path.join(workDir, 'README.MD');
  writeFileSync(upperMd, '# readme\n');
  const txtFile = path.join(workDir, 'plain.txt');
  writeFileSync(txtFile, 'not markdown\n');
  const missing = path.join(workDir, 'does-not-exist.md');

  let p = null;
  try {
    p = spawnCliArgs([dotMarkdown, '--no-open'], { env: childEnv });
    const info = await waitFor(() => extractUrl(p.state.stdout));
    const base = `http://127.0.0.1:${info.port}`;
    const key = (await (await fetch(`${base}/api/roots`)).json()).roots[0].key;
    const res = await fetch(`${base}/api/roots/${key}/raw?path=${encodeURIComponent('notes.markdown')}`);
    assert.equal(res.status, 200, '.markdown file boots and serves');
    await killAndWait(p.child);

    p = spawnCliArgs([upperMd, '--no-open'], { env: childEnv });
    const infoUpper = await waitFor(() => extractUrl(p.state.stdout));
    const baseUpper = `http://127.0.0.1:${infoUpper.port}`;
    const keyUpper = (await (await fetch(`${baseUpper}/api/roots`)).json()).roots[0].key;
    const resUpper = await fetch(`${baseUpper}/api/roots/${keyUpper}/raw?path=${encodeURIComponent('README.MD')}`);
    assert.equal(resUpper.status, 200, 'uppercase .MD file boots and serves');
    await killAndWait(p.child);

    const txt = await new Promise((resolve) => {
      const child = spawn('node', [path.join(PROJECT, 'bin', 'cli.js'), txtFile, '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(txt.code, 1, 'a .txt file exits non-zero');
    assert.match(txt.stderr, /not a directory or markdown file/, 'the .txt error names the widened acceptance set');

    const notFound = await new Promise((resolve) => {
      const child = spawn('node', [path.join(PROJECT, 'bin', 'cli.js'), missing, '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(notFound.code, 1, 'a nonexistent path exits non-zero');
    assert.match(notFound.stderr, /no such file or directory/);

    console.log('criterion PASS: .markdown and uppercase .MD boot; .txt and missing paths fail with distinct messages');
  } finally {
    if (p) await killAndWait(p.child);
  }
});

test('bare `showmd` (no args) in a tmp dir still serves that dir', async () => {
  const cwdDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-cli-bare-')));
  writeFileSync(path.join(cwdDir, 'bare.md'), '# bare\n');
  let p = null;
  try {
    p = spawnCliArgs(['--no-open'], { cwd: cwdDir, env: childEnv });
    const info = await waitFor(() => extractUrl(p.state.stdout));
    const boot = await bootData(`http://127.0.0.1:${info.port}/`);
    // Match the child's canonical cwd, including macOS /tmp symlinks.
    assert.deepEqual(boot.root, { dir: realpathSync(cwdDir), name: path.basename(cwdDir), launchedFrom: 'terminal' });
    console.log('criterion PASS: bare showmd serves cwd unchanged');
  } finally {
    if (p) await killAndWait(p.child);
    rmSync(cwdDir, { recursive: true, force: true });
  }
});

test('a browser that is not installed does not take the server down', async () => {
  // the one test that boots without --no-open: an unspawnable opener used to
  // emit an unhandled 'error' and kill the server that just started
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-cli-browser-')));
  let p = null;
  try {
    writeFileSync(path.join(home, 'settings.json'),
      JSON.stringify({ updateCheck: false, browser: 'showmd-no-such-browser', port: await getFreePort() }));
    p = spawnCliArgs([filePath], { env: { ...process.env, SHOWMD_SETTINGS_HOME: home } });
    const info = await waitFor(() => extractUrl(p.state.stdout));

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(p.child.exitCode, null, `server exited: ${p.state.stderr}`);
    const res = await fetch(`http://127.0.0.1:${info.port}/`);
    assert.equal(res.status, 200, 'still serving after the failed browser launch');
    console.log('criterion PASS: unspawnable browser is survivable');
  } finally {
    if (p) await killAndWait(p.child);
    rmSync(home, { recursive: true, force: true });
  }
});

test('POST /api/shutdown: process exits cleanly and its registry entry is written then removed', async () => {
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-cli-shutdown-')));
  let p = null;
  try {
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: await getFreePort() }));
    p = spawnCliArgs([filePath, '--no-open'], { env: { ...process.env, SHOWMD_SETTINGS_HOME: home } });
    const info = await waitFor(() => extractUrl(p.state.stdout));
    const announceFile = path.join(home, 'ports', `${p.child.pid}.json`);
    await waitFor(() => existsSync(announceFile));
    assert.deepEqual(JSON.parse(readFileSync(announceFile, 'utf8')), { port: info.port, pid: p.child.pid });

    const res = await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    await new Promise((resolve) => p.child.once('exit', resolve));
    assert.ok(!existsSync(announceFile), 'registry entry removed after shutdown');
    console.log('criterion PASS: /api/shutdown stops the process and cleans up its registry entry');
  } finally {
    if (p && p.child.exitCode === null && p.child.signalCode === null) await killAndWait(p.child);
    rmSync(home, { recursive: true, force: true });
  }
});

test('SIGTERM: process exits and removes its registry entry', {
  skip: process.platform === 'win32' && 'Windows child.kill terminates the process without delivering SIGTERM',
}, async () => {
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-cli-sigterm-')));
  let p = null;
  try {
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: await getFreePort() }));
    p = spawnCliArgs([filePath, '--no-open'], { env: { ...process.env, SHOWMD_SETTINGS_HOME: home } });
    await waitFor(() => extractUrl(p.state.stdout));
    const announceFile = path.join(home, 'ports', `${p.child.pid}.json`);
    await waitFor(() => existsSync(announceFile));

    p.child.kill('SIGTERM');
    await new Promise((resolve) => p.child.once('exit', resolve));
    assert.ok(!existsSync(announceFile), 'registry entry removed after SIGTERM');
    console.log('criterion PASS: SIGTERM cleans up its registry entry');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
