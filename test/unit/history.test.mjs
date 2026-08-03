import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workDir = mkdtempSync(path.join(tmpdir(), 'showmd-history-'));
process.env.SHOWMD_HISTORY_HOME = path.join(workDir, 'history');
test.after(() => rmSync(workDir, { recursive: true, force: true }));

const { createHistory, parseLog, historyDirFor, prune, pruneAll, pruneAllDir, dirSize, historySize } = await import('../../server/history.js');

function fakeExec(handlers) {
  const calls = [];
  async function exec(prefixArgs, args, allowCodes) {
    calls.push({ prefixArgs, args, allowCodes });
    for (const handler of handlers) {
      const result = handler(prefixArgs, args);
      if (result) return result;
    }
    throw Object.assign(new Error(`unscripted git call: ${JSON.stringify(args)}`), { code: 1 });
  }
  exec.calls = calls;
  return exec;
}

async function withFrozenNow(now, fn) {
  const orig = Date.now;
  Date.now = () => now;
  try {
    return await fn();
  } finally {
    Date.now = orig;
  }
}

function ensureRepoHandlers() {
  return [
    (p, a) => a[0] === '--version' && { code: 0, stdout: '' },
    (p, a) => a[0] === 'init' && { code: 0, stdout: '' },
    (p, a) => a[0] === 'config' && { code: 0, stdout: '' },
  ];
}

// git commit timestamps are second-granular (%ct), so the boundary is tested
// at whole seconds either side of AMEND_WINDOW_MS rather than at 1ms offsets
test('amend window: a save 59s after the last commit amends it', async () => {
  const now = 1750000000000;
  const lastTs = Math.floor(now / 1000) - 59;
  const rev = 'a'.repeat(40);
  const subject = 'user: doc.md';
  const exec = fakeExec([
    ...ensureRepoHandlers(),
    (p, a) => a[0] === 'log' && { code: 0, stdout: `${rev}\x1f${subject}\x1f${lastTs}` },
    (p, a) => a[0] === 'add' && { code: 0, stdout: '' },
    (p, a) => a[0] === 'diff' && { code: 1, stdout: '' },
    (p, a) => a[0] === 'rev-parse' && { code: 0, stdout: `${rev}\n` },
    (p, a) => a[0] === 'commit' && { code: 0, stdout: '' },
  ]);
  const history = createHistory(exec);
  await withFrozenNow(now, () => history.record(path.join(workDir, 'root-inside'), 'doc.md', 'user'));
  const commitCall = exec.calls.filter((c) => c.args[0] === 'commit').pop();
  assert.deepEqual(commitCall.args, ['commit', '--amend', '--no-edit']);
});

test('amend window: a save exactly 60s after the last commit starts a new one', async () => {
  const now = 1750000000000;
  const lastTs = Math.floor(now / 1000) - 60;
  const rev = 'b'.repeat(40);
  const subject = 'user: doc.md';
  const exec = fakeExec([
    ...ensureRepoHandlers(),
    (p, a) => a[0] === 'log' && { code: 0, stdout: `${rev}\x1f${subject}\x1f${lastTs}` },
    (p, a) => a[0] === 'add' && { code: 0, stdout: '' },
    (p, a) => a[0] === 'diff' && { code: 1, stdout: '' },
    (p, a) => a[0] === 'rev-parse' && { code: 0, stdout: `${rev}\n` },
    (p, a) => a[0] === 'commit' && { code: 0, stdout: '' },
  ]);
  const history = createHistory(exec);
  await withFrozenNow(now, () => history.record(path.join(workDir, 'root-outside'), 'doc.md', 'user'));
  const commitCall = exec.calls.filter((c) => c.args[0] === 'commit').pop();
  assert.deepEqual(commitCall.args, ['commit', '-m', 'user: doc.md']);
});

test('parseLog parses a well-formed record with numstat', () => {
  const stdout = '\x00abcdef1234567890\x1f1700000000\x1fuser: doc.md\n3\t1\tdoc.md\n';
  assert.deepEqual(parseLog(stdout), [
    { rev: 'abcdef1234567890', ts: 1700000000, subject: 'user: doc.md', adds: 3, dels: 1 },
  ]);
});

test('parseLog treats a binary numstat line ("-\\t-") as zero adds/dels', () => {
  const stdout = '\x00rev1\x1f1700000000\x1fuser: img.png\n-\t-\timg.png\n';
  assert.deepEqual(parseLog(stdout)[0], { rev: 'rev1', ts: 1700000000, subject: 'user: img.png', adds: 0, dels: 0 });
});

test('parseLog defaults adds/dels to 0 when the numstat line is missing', () => {
  const stdout = '\x00rev2\x1f1700000000\x1fuser: doc.md\n';
  assert.deepEqual(parseLog(stdout)[0], { rev: 'rev2', ts: 1700000000, subject: 'user: doc.md', adds: 0, dels: 0 });
});

test('parseLog parses multiple records and ignores stray empty chunks', () => {
  const stdout = '\x00\x00rev-a\x1f100\x1fone\n1\t0\tdoc.md\n\x00rev-b\x1f200\x1ftwo\n0\t2\tdoc.md\n';
  const parsed = parseLog(stdout);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].rev, 'rev-a');
  assert.equal(parsed[1].rev, 'rev-b');
});

test('parseLog returns an empty array for empty input', () => {
  assert.deepEqual(parseLog(''), []);
});

test('contentAt with fromRepo reads via repoReadAt (git show rev:./path)', async () => {
  const exec = fakeExec([(p, a) => p[0] === '-C' && a[0] === 'show' && { code: 0, stdout: '# content at rev\n' }]);
  const history = createHistory(exec);
  const text = await history.contentAt('/served/root', 'doc.md', 'deadbeef', true);
  assert.equal(text, '# content at rev\n');
  assert.deepEqual(exec.calls[0].prefixArgs, ['-C', '/served/root', '--no-optional-locks']);
  assert.deepEqual(exec.calls[0].args, ['show', 'deadbeef:./doc.md']);
});

test('diffAt with fromRepo reads via repoDiff (git show --format=)', async () => {
  const exec = fakeExec([(p, a) => p[0] === '-C' && a[0] === 'show' && { code: 0, stdout: '+added line\n' }]);
  const history = createHistory(exec);
  const text = await history.diffAt('/served/root', 'doc.md', 'deadbeef', true);
  assert.equal(text, '+added line\n');
  assert.deepEqual(exec.calls[0].args, ['show', 'deadbeef', '--format=', '--', 'doc.md']);
});

test('contentAt/diffAt with fromRepo return null when git show fails', async () => {
  const exec = fakeExec([(p, a) => a[0] === 'show' && { code: 128, stdout: '' }]);
  const history = createHistory(exec);
  assert.equal(await history.contentAt('/served/root', 'doc.md', 'deadbeef', true), null);
  assert.equal(await history.diffAt('/served/root', 'doc.md', 'deadbeef', true), null);
});

test('timeline: a working tree that matches HEAD drops the pending shadow save (repoClean true)', async () => {
  const root = path.join(workDir, 'root-timeline-clean');
  const rev = 'c'.repeat(40);
  const exec = fakeExec([
    ...ensureRepoHandlers(),
    (p, a) => p[0] === '--git-dir' && a[0] === 'log' && { code: 0, stdout: '\x00shadow1\x1f500\x1fuser: doc.md\n1\t0\tdoc.md\n' },
    (p, a) => p[0] === '-C' && a[0] === 'log' && { code: 0, stdout: `\x00${rev}\x1f100\x1fcommit: doc.md\n2\t0\tdoc.md\n` },
    (p, a) => p[0] === '-C' && a[0] === 'diff' && { code: 0, stdout: '' },
  ]);
  const history = createHistory(exec);
  const entries = await history.timeline(root, 'doc.md');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rev, rev);
  assert.equal(entries[0].source, 'commit');
  assert.equal(entries[0].repo, true);
});

test('timeline: a dirty working tree keeps the pending shadow save (repoClean false)', async () => {
  const root = path.join(workDir, 'root-timeline-dirty');
  const rev = 'd'.repeat(40);
  const exec = fakeExec([
    ...ensureRepoHandlers(),
    (p, a) => p[0] === '--git-dir' && a[0] === 'log' && { code: 0, stdout: '\x00shadow2\x1f500\x1fuser: doc.md\n1\t0\tdoc.md\n' },
    (p, a) => p[0] === '-C' && a[0] === 'log' && { code: 0, stdout: `\x00${rev}\x1f100\x1fcommit: doc.md\n2\t0\tdoc.md\n` },
    (p, a) => p[0] === '-C' && a[0] === 'diff' && { code: 1, stdout: '' },
  ]);
  const history = createHistory(exec);
  const entries = await history.timeline(root, 'doc.md');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].rev, 'shadow2');
  assert.equal(entries[0].source, 'user');
  assert.equal(entries[1].rev, rev);
});

test('pruneAllDir returns the configured history home', () => {
  assert.equal(pruneAllDir(), process.env.SHOWMD_HISTORY_HOME);
});

test('the shadow repo stays out of the served directory', () => {
  const root = path.join(workDir, 'shadow-root');
  assert.ok(historyDirFor(root).startsWith(process.env.SHOWMD_HISTORY_HOME));
  assert.ok(!historyDirFor(root).startsWith(root));
});

test('prune removes a document\'s shadow directory and returns its path', async () => {
  const root = path.join(workDir, 'root-prune');
  const dir = historyDirFor(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'marker'), 'x');
  assert.ok(existsSync(dir));
  const returned = await prune(root);
  assert.equal(returned, dir);
  assert.ok(!existsSync(dir));
});

test('prune on a document with no shadow directory is a harmless no-op', async () => {
  const root = path.join(workDir, 'root-prune-missing');
  const dir = historyDirFor(root);
  assert.ok(!existsSync(dir));
  const returned = await prune(root);
  assert.equal(returned, dir);
});

test('dirSize sums file bytes recursively across nested directories', async () => {
  const dir = path.join(workDir, 'dirsize-known');
  mkdirSync(path.join(dir, 'nested'), { recursive: true });
  writeFileSync(path.join(dir, 'a'), 'x'.repeat(10));
  writeFileSync(path.join(dir, 'nested', 'b'), 'x'.repeat(25));
  assert.equal(await dirSize(dir), 35);
});

test('dirSize on a missing directory returns 0 instead of throwing', async () => {
  assert.equal(await dirSize(path.join(workDir, 'does-not-exist')), 0);
});

test('historySize reads the size of the given root\'s own shadow directory', async () => {
  const root = path.join(workDir, 'root-historysize');
  const dir = historyDirFor(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'marker'), 'x'.repeat(42));
  assert.equal(await historySize(root), 42);
});

test('pruneAll removes every shadow repo under the history home', async () => {
  const dirA = historyDirFor(path.join(workDir, 'root-pruneall-a'));
  const dirB = historyDirFor(path.join(workDir, 'root-pruneall-b'));
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(path.join(dirA, 'marker'), 'x');
  writeFileSync(path.join(dirB, 'marker'), 'x');
  assert.ok(existsSync(dirA));
  assert.ok(existsSync(dirB));
  const returned = await pruneAll();
  assert.equal(returned, pruneAllDir());
  assert.ok(!existsSync(dirA));
  assert.ok(!existsSync(dirB));
  assert.ok(!existsSync(pruneAllDir()));
});
