import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');

// realpath every temp root: windows hands back 8.3 short names here, and libuv
// aborts a served process when a watch event's long filename does not match
const workDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-cli-')));
process.env.SHOWMD_APP_DIR = path.join(workDir, 'app-dir');
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


export {
  PROJECT, workDir, filePath, childEnv, spawnCli, spawnCliArgs, spawnCliFrom, copyPackageWithVersion,
  extractUrl, bootData, waitFor, waitForAsync, waitForClose, killAndWait, getFreePort,
};

test.after(() => rmSync(workDir, { recursive: true, force: true }));
