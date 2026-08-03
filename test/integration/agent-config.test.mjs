import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// isolates settings- and history-backed routes from whatever this machine has for real
process.env.SHOWMD_SETTINGS_HOME = tmp('showmd-settings-home-');
process.env.SHOWMD_HISTORY_HOME = tmp('showmd-history-home-');

const fakeHome = tmp('showmd-agentcfg-home-');
process.env.HOME = fakeHome;
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

test('GET /api/tree?view=agents&agent=claude: Instructions group lists CLAUDE.md and rules/*.md', async () => {
  const root = tmp('showmd-agentcfg-root-');
  try {
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/tree?view=agents&agent=claude`);
      assert.equal(res.status, 200);
      const tree = await res.json();
      assert.equal(tree.detected, true);
      const instr = tree.groups.find((g) => g.name === 'Instructions');
      assert.deepEqual(instr.files.map((f) => f.id), ['claude-home/CLAUDE.md', 'claude-rules/10-a.md']);
      const codex = tree.agents.find((a) => a.key === 'codex');
      assert.equal(codex.detected, true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/tree?view=agents&agent=nope: 400 unknown agent', async () => {
  const root = tmp('showmd-agentcfg-root-');
  try {
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/tree?view=agents&agent=nope`);
      assert.equal(res.status, 400);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/tree?view=agents works with no project root at all (launcher mode)', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/api/tree?view=agents&agent=codex`);
    assert.equal(res.status, 200);
    const tree = await res.json();
    assert.equal(tree.agent, 'codex');
    assert.deepEqual(tree.groups, [{ name: 'Instructions', files: [{ id: 'codex-home/AGENTS.md', label: 'AGENTS.md' }] }]);
  });
});

test('PUT /api/raw + GET /api/history: an agent-config file outside the project saves and gets a history entry', async (t) => {
  if (!(await checkGitAvailable())) {
    t.skip('git not available in this environment');
    return;
  }
  const root = tmp('showmd-agentcfg-root-');
  try {
    await withServer(root, async (base) => {
      const id = 'claude-rules/10-a.md';
      const putRes = await fetch(`${base}/api/raw?path=${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: '# rule a, edited\n',
      });
      assert.equal(putRes.status, 204);

      const rawRes = await fetch(`${base}/api/raw?path=${encodeURIComponent(id)}`);
      assert.equal(await rawRes.text(), '# rule a, edited\n');

      const histRes = await fetch(`${base}/api/history?path=${encodeURIComponent(id)}`);
      assert.equal(histRes.status, 200);
      const entries = await histRes.json();
      assert.ok(entries.length >= 1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
