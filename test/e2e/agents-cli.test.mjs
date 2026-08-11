import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync , realpathSync} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');
const PORT = 4402;
const BASE = `http://127.0.0.1:${PORT}`;

// Isolate user state and canonicalize Windows temp paths before watching them.
const fakeHome = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-agents-home-')));
mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
writeFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), '# fake claude instructions\n');

const settingsHome = path.join(fakeHome, 'settings-home');
mkdirSync(settingsHome, { recursive: true });
// updateCheck off: this spawns the real CLI, and the update check is the one
// outbound call showmd can make — npm test needs no network
writeFileSync(path.join(settingsHome, 'settings.json'), JSON.stringify({ updateCheck: false }));

async function waitForServer(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start in time');
}

let child;
let stdout = '';
let stderr = '';

test.before(async () => {
  child = spawn(
    'node',
    [path.join(PROJECT, 'bin', 'cli.js'), 'agents', '--no-open', '--port', String(PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, SHOWMD_SETTINGS_HOME: settingsHome } }
  );
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));
  await waitForServer(`${BASE}/`);
});

test.after(async () => {
  child.kill();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(fakeHome, { recursive: true, force: true });
});

test('cli started, announced agent config', () => {
  assert.ok(stdout.includes('showmd serving agent config'), 'cli announces agent config mode');
  console.log('criterion 0 PASS: cli started, announced agent config\n' + stdout.trim());
});

test('the printed URL is the Agents space, and its boot data carries that route', async () => {
  assert.ok(stdout.includes(`${BASE}/agents/claude/`), `cli prints the agents URL: ${stdout}`);
  const html = await (await fetch(`${BASE}/agents/claude/`)).text();
  assert.ok(html.includes('"space":"agents"'), 'boot data carries the agents route');
  assert.ok(html.includes('"agentKey":"claude"'), 'boot data names the agent');
  console.log('criterion 1 PASS: /agents/claude/ boots into the Agents space');
});

test('GET /api/agents/claude/tree returns the claude agent groups', async () => {
  const tree = await (await fetch(`${BASE}/api/agents/claude/tree`)).json();
  assert.equal(tree.agent, 'claude');
  assert.ok(tree.detected, 'fake HOME/.claude is detected');
  const instructions = tree.groups.find((g) => g.name === 'Instructions');
  assert.ok(instructions, 'tree includes an Instructions group');
  const claudeMd = instructions.files.find((f) => f.id === 'claude-home/CLAUDE.md');
  assert.ok(claudeMd, 'tree includes the fake CLAUDE.md');
  assert.equal(claudeMd.href, '/agents/claude/claude-home/CLAUDE.md');
  console.log(`criterion 2 PASS: agent tree groups: ${JSON.stringify(tree.groups.map((g) => g.name))}`);
});

test('cli exits cleanly on kill', async () => {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
  assert.equal(stderr, '', 'no stderr output during a normal run');
  console.log('criterion 3 PASS: cli exits cleanly on kill');
});
