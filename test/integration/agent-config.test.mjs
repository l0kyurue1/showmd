import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// realpath, not just mkdtemp: windows hands back an 8.3 short name here
// (C:\Users\RUNNER~1\...) and libuv aborts the process when a watch event's
// long filename does not match the short dir it was given
function tmp(prefix) {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

// isolates settings- and history-backed routes from whatever this machine has for real
process.env.SHOWMD_SETTINGS_HOME = tmp('showmd-settings-home-');
process.env.SHOWMD_HISTORY_HOME = tmp('showmd-history-home-');

const fakeHome = tmp('showmd-agentcfg-home-');
process.env.HOME = fakeHome;
// os.homedir() reads USERPROFILE on windows and ignores HOME
process.env.USERPROFILE = fakeHome;
mkdirSync(path.join(fakeHome, '.claude', 'rules'), { recursive: true });
writeFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), '# global rules\n');
writeFileSync(path.join(fakeHome, '.claude', 'rules', '10-a.md'), '# rule a\n');
mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
writeFileSync(path.join(fakeHome, '.codex', 'AGENTS.md'), '# codex agents\n');

const { createServer } = require('../../server/server.js');
const { checkGitAvailable } = require('../../server/history.js');

async function withServer(root, fn, extra = {}) {
  const server = createServer(root, { revealFile: () => {}, ...extra });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('GET /api/agents/claude/tree: Instructions group lists CLAUDE.md and rules/*.md; codex cross-detected', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/api/agents/claude/tree`);
    assert.equal(res.status, 200);
    const tree = await res.json();
    assert.equal(tree.detected, true);
    const instr = tree.groups.find((g) => g.name === 'Instructions');
    assert.deepEqual(instr.files.map((f) => f.id), ['claude-home/CLAUDE.md', 'claude-rules/10-a.md']);
    const codex = tree.agents.find((a) => a.key === 'codex');
    assert.equal(codex.detected, true);
  });
});

test('GET /api/agents/codex/tree works with no project root at all (launcher mode)', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/api/agents/codex/tree`);
    assert.equal(res.status, 200);
    const tree = await res.json();
    assert.equal(tree.agent, 'codex');
    assert.deepEqual(
      tree.groups.map((g) => ({ name: g.name, files: g.files.map((f) => ({ id: f.id, label: f.label })) })),
      [{ name: 'Instructions', files: [{ id: 'codex-home/AGENTS.md', label: 'AGENTS.md' }] }],
    );
  });
});

test('PUT /api/agents/claude/raw + GET /api/agents/claude/history: an agent-config file outside the project saves and gets a history entry', async (t) => {
  if (!(await checkGitAvailable())) {
    t.skip('git not available in this environment');
    return;
  }
  await withServer(null, async (base) => {
    const id = 'claude-rules/10-a.md';
    const putRes = await fetch(`${base}/api/agents/claude/raw?id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: '# rule a, edited\n',
    });
    assert.equal(putRes.status, 204);

    const rawRes = await fetch(`${base}/api/agents/claude/raw?id=${encodeURIComponent(id)}`);
    assert.equal(await rawRes.text(), '# rule a, edited\n');

    const histRes = await fetch(`${base}/api/agents/claude/history?id=${encodeURIComponent(id)}`);
    assert.equal(histRes.status, 200);
    const entries = await histRes.json();
    assert.ok(entries.length >= 1);
  });
});

test('GET /api/agents/<key>/tree: files carry agent-space hrefs, and ?root= sets the project context', async () => {
  const project = tmp('showmd-agentcfg-project-');
  try {
    await withServer(null, async (base) => {
      const res = await fetch(`${base}/api/agents/claude/tree`);
      assert.equal(res.status, 200);
      const tree = await res.json();
      const instr = tree.groups.find((g) => g.name === 'Instructions');
      assert.deepEqual(
        instr.files.map((f) => f.href),
        ['/agents/claude/claude-home/CLAUDE.md', '/agents/claude/claude-rules/10-a.md'],
      );

      const added = await fetch(`${base}/api/roots`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: project }),
      });
      const { root } = await added.json();
      const scoped = await fetch(`${base}/api/agents/claude/tree?root=${root.key}`);
      assert.equal(scoped.status, 200);
      const scopedTree = await scoped.json();
      const scopedInstr = scopedTree.groups.find((g) => g.name === 'Instructions');
      assert.ok(scopedInstr.files.every((f) => f.href.endsWith(`?root=${root.key}`)), 'hrefs keep the root context');
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('GET/PUT /api/agents/<key>/raw: read and write one agent-config document', async () => {
  await withServer(null, async (base) => {
    const id = 'claude-home/CLAUDE.md';
    const put = await fetch(`${base}/api/agents/claude/raw?id=${encodeURIComponent(id)}`, {
      method: 'PUT', body: '# global rules, edited\n',
    });
    assert.equal(put.status, 204);
    const res = await fetch(`${base}/api/agents/claude/raw?id=${encodeURIComponent(id)}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '# global rules, edited\n');
  });
});

test('agent space rejects an unknown agent, an unknown root, and an unsupported selector', async () => {
  await withServer(null, async (base) => {
    const unknown = await fetch(`${base}/api/agents/nope/tree`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'unknown_agent');

    const noRoot = await fetch(`${base}/api/agents/claude/tree?root=r_AAAAAAAAAAAAAAAAAAAAAA`);
    assert.equal(noRoot.status, 404);
    assert.equal((await noRoot.json()).error, 'root_not_open');

    const bad = await fetch(`${base}/api/agents/claude/tree?scope=all`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'invalid_agents_selection');
  });
});
