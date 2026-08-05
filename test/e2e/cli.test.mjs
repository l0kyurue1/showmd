import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
// updateCheck off: this spawns the real CLI, and the update check is the one
// outbound call showmd can make — npm test needs no network
writeFileSync(path.join(settingsHome, 'settings.json'), JSON.stringify({ updateCheck: false }));
const childEnv = { ...process.env, SHOWMD_SETTINGS_HOME: settingsHome };

function spawnCli(extraArgs) {
  return spawnCliArgs([filePath, '--no-open', ...extraArgs]);
}

function spawnCliArgs(argv, opts = {}) {
  const child = spawn('node', [path.join(PROJECT, 'bin', 'cli.js'), ...argv], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv, ...opts });
  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => (state.stdout += d.toString()));
  child.stderr.on('data', (d) => (state.stderr += d.toString()));
  return { child, state };
}

function extractUrl(stdout) {
  const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\/\S*/);
  return m ? { url: m[0], port: Number(m[1]) } : null;
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

test('default-port collision: two instances get distinct ports, both serve 200', async () => {
  let a = null;
  let b = null;
  try {
    // default port may already be taken on this machine; assert distinct+alive ports, not an exact number
    a = spawnCli([]);
    const infoA = await waitFor(() => extractUrl(a.state.stdout));

    b = spawnCli([]);
    const infoB = await waitFor(() => extractUrl(b.state.stdout));
    assert.notEqual(infoB.port, infoA.port, 'second instance falls back to a different (ephemeral) port');

    const [resA, resB] = await Promise.all([fetch(infoA.url), fetch(infoB.url)]);
    assert.equal(resA.status, 200, 'first instance responds 200');
    assert.equal(resB.status, 200, 'second instance responds 200');
    console.log(`criterion PASS: default-port collision -> instance A on ${infoA.port}, instance B fell back to ${infoB.port}, both 200`);
  } finally {
    await Promise.all([a, b].filter(Boolean).map((p) => killAndWait(p.child)));
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

    // stands in for the real failure: an older install still holding the
    // default port, serving its outdated client to any tab pointed at it.
    // Identifies as showmd via /api/version, so takeover never hits a stranger
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

test('silent default-port fallback names the squatter first, since it is another showmd', async () => {
  let a = null;
  let b = null;
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-warn-home-')));
  try {
    // a dedicated free port pinned via settings.json, not the real 4321 — this
    // machine may already have an unrelated showmd (possibly predating
    // /api/version) squatting there, which would make the probe silently
    // come back empty and the assertion below flaky
    const pinnedPort = await getFreePort();
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: pinnedPort }));
    const env = { ...process.env, SHOWMD_SETTINGS_HOME: home };

    a = spawnCliArgs([filePath, '--no-open'], { env });
    const infoA = await waitFor(() => extractUrl(a.state.stdout));
    assert.equal(infoA.port, pinnedPort, 'first instance takes the pinned default port');

    b = spawnCliArgs([filePath, '--no-open'], { env });
    const infoB = await waitFor(() => extractUrl(b.state.stdout));
    assert.notEqual(infoB.port, pinnedPort, 'second instance falls back off the pinned port');

    assert.match(b.state.stderr, new RegExp(`showmd: port ${pinnedPort} is held by showmd \\S+`), 'the loser names the squatter (instance A) before falling back');
  } finally {
    await Promise.all([a, b].filter(Boolean).map((p) => killAndWait(p.child)));
    rmSync(home, { recursive: true, force: true });
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
    assert.match(state.stdout, /Claude Code/, 'stdout names the agent it reached');
    console.log(`criterion PASS: install-skill exit 0, SKILL.md at ${canonical}, Claude Code linked`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--launcher --no-open: boots with no root; /api/root gives dir null', async () => {
  let p = null;
  // a pinned free port + own settings home: the default port may already be
  // held by a real, same-version showmd launcher (e.g. the installed app),
  // in which case --launcher just opens that tab and never prints its banner
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-launcher-home-')));
  try {
    const pinnedPort = await getFreePort();
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateCheck: false, port: pinnedPort }));
    const env = { ...process.env, SHOWMD_SETTINGS_HOME: home };
    p = spawnCliArgs(['--launcher', '--no-open'], { env });
    const info = await waitFor(() => extractUrl(p.state.stdout));
    assert.match(p.state.stdout, /showmd launcher/);
    const res = await fetch(`http://127.0.0.1:${info.port}/api/root`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { dir: null, launchedFrom: 'terminal' });
    console.log('criterion PASS: --launcher boots with dir:null');
  } finally {
    if (p) await killAndWait(p.child);
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
    const res = await fetch(`http://127.0.0.1:${info.port}/api/raw?path=${encodeURIComponent('notes.markdown')}`);
    assert.equal(res.status, 200, '.markdown file boots and serves');
    await killAndWait(p.child);

    p = spawnCliArgs([upperMd, '--no-open'], { env: childEnv });
    const infoUpper = await waitFor(() => extractUrl(p.state.stdout));
    const resUpper = await fetch(`http://127.0.0.1:${infoUpper.port}/api/raw?path=${encodeURIComponent('README.MD')}`);
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
    p = spawnCliArgs(['--no-open'], { cwd: cwdDir });
    const info = await waitFor(() => extractUrl(p.state.stdout));
    const res = await fetch(`http://127.0.0.1:${info.port}/api/root`);
    assert.equal(res.status, 200);
    // realpath: the child's process.cwd() resolves symlinks (e.g. macOS's
    // /tmp -> /private/tmp) the same way, so compare against that, not the
    // pre-resolved tmpdir() path this test built cwdDir from
    assert.deepEqual(await res.json(), { dir: realpathSync(cwdDir), name: path.basename(cwdDir), launchedFrom: 'terminal' });
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
      JSON.stringify({ updateCheck: false, browser: 'showmd-no-such-browser' }));
    p = spawnCliArgs([filePath], { env: { ...process.env, SHOWMD_SETTINGS_HOME: home } });
    const info = await waitFor(() => extractUrl(p.state.stdout));

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(p.child.exitCode, null, `server exited: ${p.state.stderr}`);
    const res = await fetch(`http://127.0.0.1:${info.port}/api/root`);
    assert.equal(res.status, 200, 'still serving after the failed browser launch');
    console.log('criterion PASS: unspawnable browser is survivable');
  } finally {
    if (p) await killAndWait(p.child);
    rmSync(home, { recursive: true, force: true });
  }
});
