import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROJECT, workDir, filePath, childEnv, spawnCliArgs, extractUrl, bootData, waitFor, waitForClose, killAndWait, getFreePort } from '../helpers/cli-e2e.mjs';

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
