import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync , realpathSync} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');
const PORT = 4401;
const BASE = `http://127.0.0.1:${PORT}`;

// fake HOME: keeps this machine's real ~/.claude/skills etc. out of the
// discovery result, and isolates the shadow-history repos this run creates
// realpath every temp root: windows hands back 8.3 short names here, and libuv
// aborts a served process when a watch event's long filename does not match
const fakeHome = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-skills-home-')));
const rootA = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-skills-rootA-')));
const rootB = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-skills-rootB-')));
const outsideA = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-skills-outsideA-')));

// `showmd skills <dir> <dir>` is PROJECT mode for both dirs: each needs its
// own .agents/skills or .claude/skills marker to be picked up
mkdirSync(path.join(rootA, '.agents', 'skills', 'skillA', 'evals'), { recursive: true });
writeFileSync(path.join(rootA, '.agents', 'skills', 'skillA', 'SKILL.md'), '# from root A\n');
writeFileSync(path.join(rootA, '.agents', 'skills', 'skillA', 'evals', 'eval1.md'), '# eval one\n');
mkdirSync(path.join(rootB, '.claude', 'skills', 'skillB'), { recursive: true });
writeFileSync(path.join(rootB, '.claude', 'skills', 'skillB', 'SKILL.md'), '# from root B\n');
writeFileSync(path.join(outsideA, 'secret.md'), '# secret\n');

const labelA = path.basename(rootA);
const labelB = path.basename(rootB);

function flattenIds(tree) {
  const out = [];
  for (const scope of tree.scopes) {
    for (const group of scope.groups) {
      for (const skill of group.skills) {
        out.push(skill.id);
        for (const f of skill.files) out.push(f.id);
      }
    }
    for (const skill of scope.skills) {
      out.push(skill.id);
      for (const f of skill.files) out.push(f.id);
    }
  }
  return out;
}

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

// updateCheck off: this spawns the real CLI, and the update check is the one
// outbound call showmd can make — npm test needs no network
const settingsHome = path.join(fakeHome, 'settings-home');
mkdirSync(settingsHome, { recursive: true });
writeFileSync(path.join(settingsHome, 'settings.json'), JSON.stringify({ updateCheck: false }));

let child;
let stdout = '';
let stderr = '';

test.before(async () => {
  child = spawn(
    'node',
    [path.join(PROJECT, 'bin', 'cli.js'), 'skills', rootA, rootB, '--no-open', '--port', String(PORT)],
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
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
  rmSync(outsideA, { recursive: true, force: true });
});

test('cli started, announced both project roots', () => {
  assert.ok(stdout.includes('project agents') && stdout.includes('claude project'), 'cli announces both project roots');
  console.log('criterion 0 PASS: cli started, announced both project roots\n' + stdout.trim());
});

test('/api/tree returns structured Project scopes for both roots', async () => {
  const tree = await (await fetch(`${BASE}/api/tree`)).json();
  assert.ok(!Array.isArray(tree), 'skills mode returns a structured Scope>Group>Skill object, not a flat array');
  assert.deepEqual(tree.scopes.map((s) => s.name), ['Project'], 'explicit project-dir args -> PROJECT mode, no Global scope (fake empty HOME)');
  const ids = flattenIds(tree);
  assert.ok(ids.includes('project agents/skillA/SKILL.md'), 'tree includes skill A SKILL.md under its root prefix');
  assert.ok(ids.includes('claude project/skillB/SKILL.md'), 'tree includes skill B SKILL.md under its root prefix');
  assert.ok(ids.includes('project agents/skillA/evals/eval1.md'), 'nested skill file is included with a full id');
  const projectScope = tree.scopes.find((s) => s.name === 'Project');
  const sources = projectScope.groups.map((g) => g.source).sort();
  assert.deepEqual(sources, [labelA, labelB].sort(), 'one project node per given dir, named by dir basename');
  console.log(`criterion 1 PASS: /api/tree returns structured Project>{${sources.join(',')}} skills: ${JSON.stringify(ids)}`);
});

test('/api/raw serves distinct real content from two different project roots', async () => {
  const rawA = await fetch(`${BASE}/api/raw?path=${encodeURIComponent('project agents/skillA/SKILL.md')}`);
  assert.equal(rawA.status, 200);
  assert.ok((await rawA.text()).includes('from root A'));
  const rawB = await fetch(`${BASE}/api/raw?path=${encodeURIComponent('claude project/skillB/SKILL.md')}`);
  assert.equal(rawB.status, 200);
  assert.ok((await rawB.text()).includes('from root B'));
  console.log('criterion 2 PASS: /api/raw serves distinct real content from two different project roots');
});

test('a file only resolves under its own group prefix', async () => {
  const crossRaw = await fetch(`${BASE}/api/raw?path=${encodeURIComponent('claude project/skillA/SKILL.md')}`);
  assert.equal(crossRaw.status, 404, 'root A skill is not reachable under root B\'s prefix');
  console.log('criterion 3 PASS: a file only resolves under its own group prefix');
});

test('traversal attempt escaping a root is rejected 403', async () => {
  const traversalPath = `project agents/../${path.basename(outsideA)}/secret.md`;
  const traversalRes = await fetch(`${BASE}/api/raw?path=${encodeURIComponent(traversalPath)}`);
  assert.equal(traversalRes.status, 403, 'traversal out of root A is rejected');
  console.log('criterion 4 PASS: traversal attempt escaping a root is rejected 403');
});

test('save history recorded for a file under a multi-root group', async () => {
  const putRes = await fetch(`${BASE}/api/raw?path=${encodeURIComponent('project agents/skillA/SKILL.md')}`, {
    method: 'PUT',
    body: '# from root A\n\nedited\n',
  });
  assert.equal(putRes.status, 204);
  await new Promise((r) => setTimeout(r, 200));
  const histA = await (await fetch(`${BASE}/api/history?path=${encodeURIComponent('project agents/skillA/SKILL.md')}`)).json();
  assert.equal(histA[0].source, 'user', 'save history works per-root under the multi-root server');
  console.log(`criterion 5 PASS: save history recorded for a file under a multi-root group: ${JSON.stringify(histA[0])}`);
});
