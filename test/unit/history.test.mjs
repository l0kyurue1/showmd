import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { identityPath } = require('../../server/root-identity.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'showmd-history-'));
process.env.SHOWMD_HISTORY_HOME = path.join(workDir, 'history');
test.after(() => rmSync(workDir, { recursive: true, force: true }));

const {
  createHistory, parseLog, historyDirFor, prune, pruneAll, pruneAllDir, dirSize, historySize, timeline, record,
  checkGitAvailable, contentAt,
} = await import('../../server/history.js');

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

function permissiveHistoryExec(onCommit = async () => ({ code: 0, stdout: '' })) {
  return fakeExec([
    (p, a) => a[0] === '--version' && { code: 0, stdout: '' },
    (p, a) => (a[0] === 'init' || a[0] === 'config' || a[0] === 'add') && { code: 0, stdout: '' },
    (p, a) => a[0] === 'log' && { code: 128, stdout: '' },
    (p, a) => a[0] === 'show' && { code: 128, stdout: '' },
    (p, a) => a[0] === 'diff' && { code: 1, stdout: '' },
    (p, a) => a[0] === 'commit' && onCommit(),
  ]);
}

// The mocked roots below never exist on disk, so history.js's realpath step
// falls back to path.resolve(root), then applies the shared platform identity
// rules (notably case folding on Windows).
function storeRelPathFor(root, relPath) {
  const canonicalRoot = identityPath(path.resolve(root));
  const driveRoot = path.parse(canonicalRoot).root;
  return path.relative(driveRoot, path.join(canonicalRoot, relPath)).split(path.sep).join('/');
}

async function waitFor(condition, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// git commit timestamps are second-granular (%ct), so the boundary is tested
// at whole seconds either side of AMEND_WINDOW_MS rather than at 1ms offsets
test('amend window: a save 59s after the last commit amends it', async () => {
  const now = 1750000000000;
  const lastTs = Math.floor(now / 1000) - 59;
  const rev = 'a'.repeat(40);
  const root = path.join(workDir, 'root-inside');
  const subject = `user: ${storeRelPathFor(root, 'doc.md')}`;
  const exec = fakeExec([
    ...ensureRepoHandlers(),
    (p, a) => a[0] === 'log' && { code: 0, stdout: `${rev}\x1f${subject}\x1f${lastTs}` },
    (p, a) => a[0] === 'add' && { code: 0, stdout: '' },
    (p, a) => a[0] === 'diff' && { code: 1, stdout: '' },
    (p, a) => a[0] === 'rev-parse' && { code: 0, stdout: `${rev}\n` },
    (p, a) => a[0] === 'commit' && { code: 0, stdout: '' },
  ]);
  const history = createHistory(exec);
  await withFrozenNow(now, () => history.record(root, 'doc.md', 'user'));
  const commitCall = exec.calls.filter((c) => c.args[0] === 'commit').pop();
  assert.deepEqual(commitCall.args, ['commit', '--amend', '--no-edit']);
});

test('amend window: a save exactly 60s after the last commit starts a new one', async () => {
  const now = 1750000000000;
  const lastTs = Math.floor(now / 1000) - 60;
  const rev = 'b'.repeat(40);
  const root = path.join(workDir, 'root-outside');
  const subject = `user: ${storeRelPathFor(root, 'doc.md')}`;
  const exec = fakeExec([
    ...ensureRepoHandlers(),
    (p, a) => a[0] === 'log' && { code: 0, stdout: `${rev}\x1f${subject}\x1f${lastTs}` },
    (p, a) => a[0] === 'add' && { code: 0, stdout: '' },
    (p, a) => a[0] === 'diff' && { code: 1, stdout: '' },
    (p, a) => a[0] === 'rev-parse' && { code: 0, stdout: `${rev}\n` },
    (p, a) => a[0] === 'commit' && { code: 0, stdout: '' },
  ]);
  const history = createHistory(exec);
  await withFrozenNow(now, () => history.record(root, 'doc.md', 'user'));
  const commitCall = exec.calls.filter((c) => c.args[0] === 'commit').pop();
  assert.deepEqual(commitCall.args, ['commit', '-m', subject]);
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

// historyDirFor is keyed by filesystem root (POSIX "/", or a drive letter on
// Windows), not by the served root passed in — that is the whole point of the
// rekey: every root on the same drive shares one repo
test('historyDirFor returns the same shadow directory for two unrelated roots on one drive', () => {
  const a = historyDirFor(path.join(workDir, 'unrelated-a'));
  const b = historyDirFor(path.join(workDir, 'unrelated-b'));
  assert.equal(a, b);
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

test('pruneAll removes every shadow repo under the history home', async () => {
  const dirA = historyDirFor(path.join(workDir, 'root-pruneall-a'));
  mkdirSync(dirA, { recursive: true });
  writeFileSync(path.join(dirA, 'marker'), 'x');
  assert.ok(existsSync(dirA));
  const returned = await pruneAll();
  assert.equal(returned, pruneAllDir());
  assert.ok(!existsSync(dirA));
  assert.ok(!existsSync(pruneAllDir()));
});

// --- real-git coverage below: the mocked exec above proves the argv shape,
// these prove the actual on-disk behaviour the rekey is about ---

const git = await checkGitAvailable();

function realGitTmp(prefix) {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

test('the same file reached through two different roots shares one history timeline', { skip: !git && 'git unavailable' }, async () => {
  const base = realGitTmp('showmd-history-shared-');
  const parent = path.join(base, 'project');
  const child = path.join(base, 'project', 'docs');
  mkdirSync(child, { recursive: true });
  const file = path.join(child, 'guide.md');
  writeFileSync(file, '# v1\n');
  await record(parent, 'docs/guide.md', 'user');
  writeFileSync(file, '# v2\n');
  await record(child, 'guide.md', 'user');

  const viaParent = await timeline(parent, 'docs/guide.md');
  const viaChild = await timeline(child, 'guide.md');
  assert.equal(viaParent.length, viaChild.length);
  assert.deepEqual(viaParent.map((e) => e.rev), viaChild.map((e) => e.rev));
  assert.ok(viaParent.length >= 1);
});

test('two concurrent writers on the shared repo lose no history to lock contention', { skip: !git && 'git unavailable' }, async () => {
  const root = realGitTmp('showmd-history-concurrent-');
  const file = path.join(root, 'race.md');
  writeFileSync(file, 'start');
  // two independent createHistory() instances share nothing in-process (no
  // shared gitLocks map), so the only thing serializing them is the
  // cross-process file lock — this stands in for two real showmd processes
  const h1 = createHistory();
  const h2 = createHistory();

  const rounds = 10;
  const attempts = [];
  for (let round = 0; round < rounds; round++) {
    writeFileSync(file, `round-${round}-${Math.random()}`);
    attempts.push(h1.record(root, 'race.md', 'user'));
    writeFileSync(file, `round-${round}-${Math.random()}`);
    attempts.push(h2.record(root, 'race.md', 'external'));
  }
  // the assertion that matters: none of the 2*rounds concurrent commits
  // rejects. A lost write from lock contention surfaces here as a thrown git
  // error (e.g. a stale index.lock), not as a quietly-missing entry.
  await assert.doesNotReject(Promise.all(attempts));

  const entries = await h1.timeline(root, 'race.md');
  assert.ok(entries.length >= 1 && entries.length <= rounds * 2, `expected a plausible commit count, got ${entries.length}`);
  // the repo (shared with every other test in this file) must still be a
  // coherent, readable git object store afterward — a corrupted index or a
  // stray leftover lock file would break this
  const gitDir = historyDirFor(root);
  execFileSync('git', ['--git-dir', gitDir, 'log', '--oneline'], { encoding: 'utf8' });
  assert.equal(existsSync(`${gitDir}.lock`), false);
});

test('a stale-looking lock owned by a live process is never stolen', { skip: !git && 'git unavailable' }, async () => {
  const root = realGitTmp('showmd-history-live-lock-');
  const file = path.join(root, 'locked.md');
  writeFileSync(file, '# locked\n');
  const lockPath = `${historyDirFor(root)}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ token: 'live-owner', pid: process.pid }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);

  const history = createHistory(undefined, { lockStaleMs: 10, lockTimeoutMs: 50, lockPollMs: 5 });
  await assert.rejects(
    history.record(root, 'locked.md', 'user'),
    (err) => err && err.code === 'ELOCKTIMEOUT',
  );
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'live-owner');
  rmSync(lockPath, { force: true });
});

test('heartbeat keeps a long history operation exclusive beyond the stale threshold', async () => {
  const root = path.join(workDir, 'heartbeat-root');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'doc.md'), '# one\n');
  let releaseCommit;
  let enteredCommit;
  const commitEntered = new Promise((resolve) => { enteredCommit = resolve; });
  const holdCommit = new Promise((resolve) => { releaseCommit = resolve; });
  const firstExec = permissiveHistoryExec(async () => {
    enteredCommit();
    await holdCommit;
    return { code: 0, stdout: '' };
  });
  const secondExec = permissiveHistoryExec();
  const lockOptions = {
    lockStaleMs: 120, lockHeartbeatMs: 30, lockTimeoutMs: 1000, lockPollMs: 10,
    lockPidAlive: () => false,
  };
  const first = createHistory(firstExec, lockOptions);
  const second = createHistory(secondExec, lockOptions);

  const firstRecord = first.record(root, 'doc.md', 'user');
  let secondRecord;
  let released = false;
  try {
    await commitEntered;
    const lockPath = `${historyDirFor(root)}.lock`;
    const initialMtime = statSync(lockPath).mtimeMs;
    const contestedAt = Date.now();
    secondRecord = second.record(root, 'doc.md', 'external');
    await waitFor(() => (
      Date.now() - contestedAt > lockOptions.lockStaleMs * 2
      && statSync(lockPath).mtimeMs > initialMtime
    ));
    assert.equal(secondExec.calls.some((call) => ['init', 'add', 'commit'].includes(call.args[0])), false,
      'the contender has not entered a mutating git operation');

    releaseCommit();
    released = true;
    await Promise.all([firstRecord, secondRecord]);
    assert.equal(secondExec.calls.some((call) => call.args[0] === 'commit'), true);
  } finally {
    if (!released) releaseCommit();
    await Promise.allSettled([firstRecord, secondRecord].filter(Boolean));
  }
});

test('lock release preserves a replacement file owned by another token', async () => {
  const root = path.join(workDir, 'replacement-lock-root');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'doc.md'), '# one\n');
  const lockPath = `${historyDirFor(root)}.lock`;
  const exec = permissiveHistoryExec(async () => {
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, JSON.stringify({ token: 'replacement-owner', pid: process.pid }));
    return { code: 0, stdout: '' };
  });

  try {
    await createHistory(exec, { lockHeartbeatMs: 1000 }).record(root, 'doc.md', 'user');
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'replacement-owner');
  } finally {
    rmSync(lockPath, { force: true });
  }
});

test('migration recovers a legacy per-root repo via its recorded core.worktree', { skip: !git && 'git unavailable' }, async () => {
  const home = process.env.SHOWMD_HISTORY_HOME;
  mkdirSync(home, { recursive: true });
  const legacyRoot = realGitTmp('showmd-history-legacy-');
  writeFileSync(path.join(legacyRoot, 'notes.md'), 'v1');
  const legacyGitDir = path.join(home, '1'.repeat(40));
  const gitArgs = (...args) => execFileSync('git', ['--git-dir', legacyGitDir, '--work-tree', legacyRoot, ...args], { encoding: 'utf8' });
  gitArgs('init', '-q');
  gitArgs('config', 'user.name', 'showmd');
  gitArgs('config', 'user.email', 'showmd@local');
  gitArgs('add', '-f', '--', 'notes.md');
  gitArgs('commit', '-m', 'user: notes.md');
  writeFileSync(path.join(legacyRoot, 'notes.md'), 'v2');
  gitArgs('add', '-f', '--', 'notes.md');
  gitArgs('commit', '-m', 'user: notes.md');

  const history = createHistory();
  await history.migrateLegacyHistory();

  assert.ok(!existsSync(legacyGitDir));
  const entries = await history.timeline(legacyRoot, 'notes.md');
  assert.equal(entries.length, 2);
  const oldest = entries[entries.length - 1];
  assert.equal(await history.contentAt(legacyRoot, 'notes.md', oldest.rev, false), 'v1');
});

test('migration preserves history reachable only from a non-current branch', { skip: !git && 'git unavailable' }, async () => {
  const home = process.env.SHOWMD_HISTORY_HOME;
  mkdirSync(home, { recursive: true });
  const legacyRoot = realGitTmp('showmd-history-legacy-branch-');
  writeFileSync(path.join(legacyRoot, 'current.md'), 'current');
  const legacyGitDir = path.join(home, '4'.repeat(40));
  const gitArgs = (...args) => execFileSync('git', ['--git-dir', legacyGitDir, '--work-tree', legacyRoot, ...args], { encoding: 'utf8' });
  gitArgs('init', '-q');
  gitArgs('config', 'user.name', 'showmd');
  gitArgs('config', 'user.email', 'showmd@local');
  gitArgs('add', '-f', '--', 'current.md');
  gitArgs('commit', '-m', 'user: current.md');
  const currentBranch = gitArgs('branch', '--show-current').trim();
  gitArgs('switch', '-q', '-c', 'archive');
  writeFileSync(path.join(legacyRoot, 'archived.md'), 'archived');
  gitArgs('add', '-f', '--', 'archived.md');
  gitArgs('commit', '-m', 'user: archived.md');
  gitArgs('switch', '-q', currentBranch);

  const history = createHistory();
  await history.migrateLegacyHistory();

  assert.ok(!existsSync(legacyGitDir));
  const entries = await history.timeline(legacyRoot, 'archived.md');
  assert.equal(entries.length, 1);
  assert.equal(await history.contentAt(legacyRoot, 'archived.md', entries[0].rev, false), 'archived');
});

test('a legacy repo is preserved when commit enumeration fails for any historical path', { skip: !git && 'git unavailable' }, async () => {
  const home = process.env.SHOWMD_HISTORY_HOME;
  mkdirSync(home, { recursive: true });
  const legacyRoot = realGitTmp('showmd-history-enumeration-failure-');
  writeFileSync(path.join(legacyRoot, 'good.md'), 'recoverable');
  writeFileSync(path.join(legacyRoot, 'bad.md'), 'must not be dropped');
  const label = '5'.repeat(40);
  const legacyGitDir = path.join(home, label);
  const gitArgs = (...args) => execFileSync('git', ['--git-dir', legacyGitDir, '--work-tree', legacyRoot, ...args], { encoding: 'utf8' });
  gitArgs('init', '-q');
  gitArgs('config', 'user.name', 'showmd');
  gitArgs('config', 'user.email', 'showmd@local');
  gitArgs('add', '-f', '--', 'good.md', 'bad.md');
  gitArgs('commit', '-m', 'user: two paths');

  const failOnePath = async (prefixArgs, args, allowCodes, opts) => {
    if (prefixArgs.some((arg) => arg.includes(label)) && args[0] === 'log' && args.at(-1) === 'bad.md') {
      return { code: 128, stdout: '' };
    }
    const result = spawnSync('git', [...prefixArgs, ...args], { ...opts, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status === 0 || allowCodes.includes(result.status)) {
      return { code: result.status, stdout: result.stdout || '' };
    }
    throw Object.assign(new Error(result.stderr || `git exited ${result.status}`), { code: result.status });
  };

  const history = createHistory(failOnePath);
  await history.migrateLegacyHistory();

  assert.ok(existsSync(legacyGitDir), 'the complete source remains recoverable after any enumeration failure');
  rmSync(legacyGitDir, { recursive: true, force: true });
});

test('a legacy repo with no core.worktree is preserved and logged, not guessed or deleted', { skip: !git && 'git unavailable' }, async () => {
  const home = process.env.SHOWMD_HISTORY_HOME;
  mkdirSync(home, { recursive: true });
  const badGitDir = path.join(home, '2'.repeat(40));
  mkdirSync(path.join(badGitDir, 'objects'), { recursive: true });
  writeFileSync(path.join(badGitDir, 'config'), '[core]\n\tbare = false\n');

  const originalError = console.error;
  const logged = [];
  console.error = (msg) => logged.push(msg);
  try {
    const history = createHistory();
    await history.migrateLegacyHistory();
  } finally {
    console.error = originalError;
  }

  assert.ok(existsSync(badGitDir), 'an unreadable legacy repo remains available for recovery');
  assert.ok(logged.some((m) => m.includes('no core.worktree recorded')), 'the skip is logged, not silent');
  rmSync(badGitDir, { recursive: true, force: true });
});

test('a legacy repo is preserved when any historical blob cannot be copied', { skip: !git && 'git unavailable' }, async () => {
  const home = process.env.SHOWMD_HISTORY_HOME;
  mkdirSync(home, { recursive: true });
  const legacyRoot = realGitTmp('showmd-history-corrupt-legacy-');
  writeFileSync(path.join(legacyRoot, 'notes.md'), 'recover me');
  const legacyGitDir = path.join(home, '3'.repeat(40));
  const gitArgs = (...args) => execFileSync('git', ['--git-dir', legacyGitDir, '--work-tree', legacyRoot, ...args], { encoding: 'utf8' });
  gitArgs('init', '-q');
  gitArgs('config', 'user.name', 'showmd');
  gitArgs('config', 'user.email', 'showmd@local');
  gitArgs('add', '-f', '--', 'notes.md');
  gitArgs('commit', '-m', 'user: notes.md');
  const blob = gitArgs('rev-parse', 'HEAD:notes.md').trim();
  rmSync(path.join(legacyGitDir, 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });

  const history = createHistory();
  await history.migrateLegacyHistory();

  assert.ok(existsSync(legacyGitDir), 'the only copy is retained when migration cannot read a blob');
  rmSync(legacyGitDir, { recursive: true, force: true });
});

test('historySize is a prefix query: it only counts a root\'s own tracked paths', { skip: !git && 'git unavailable' }, async () => {
  const rootA = realGitTmp('showmd-history-size-a-');
  const rootB = realGitTmp('showmd-history-size-b-');
  writeFileSync(path.join(rootA, 'a.md'), '# a content\n');
  writeFileSync(path.join(rootB, 'b.md'), '# b content, a bit longer\n');
  await record(rootA, 'a.md', 'user');
  await record(rootB, 'b.md', 'user');

  const sizeA = await historySize(rootA);
  const sizeB = await historySize(rootB);
  assert.ok(sizeA > 0);
  assert.ok(sizeB > 0);
  assert.notEqual(sizeA, sizeB);

  const total = await historySize(path.parse(rootA).root);
  assert.ok(total >= sizeA + sizeB);
});

test('totalHistorySize sums tracked content across the store, not the store\'s physical footprint', { skip: !git && 'git unavailable' }, async () => {
  await pruneAll();
  const rootA = realGitTmp('showmd-history-total-a-');
  const rootB = realGitTmp('showmd-history-total-b-');
  writeFileSync(path.join(rootA, 'a.md'), '# a\n');
  writeFileSync(path.join(rootB, 'b.md'), '# b changed\n');
  await record(rootA, 'a.md', 'user');
  await record(rootB, 'b.md', 'user');

  const sizeA = await historySize(rootA);
  const sizeB = await historySize(rootB);
  const { totalHistorySize } = await import('../../server/history.js');
  const total = await totalHistorySize();
  assert.equal(total, sizeA + sizeB);
  // a fresh git init writes several KB of hook templates; the tracked-content
  // total must not include that fixed per-repo overhead
  const gitDir = historyDirFor(rootA);
  assert.ok(await dirSize(gitDir) > total, 'physical footprint includes overhead the logical total excludes');
});

// historySize/totalHistorySize count every historical blob reachable from
// HEAD, not just the current tree — that's what makes the number match what
// prune() actually reclaims, since prune's own rebuild (below) also only
// replays reachable commit history. Saves alternate sources so each one
// lands its own commit instead of amending the previous save away (the
// amend window only fires when source AND path both repeat).
test('historySize grows with each distinct saved version and shrinks back after prune', { skip: !git && 'git unavailable' }, async () => {
  const root = realGitTmp('showmd-history-growth-');
  const file = path.join(root, 'growth.md');

  writeFileSync(file, 'v1 '.repeat(200));
  await record(root, 'growth.md', 'user');
  const afterFirst = await historySize(root);
  assert.ok(afterFirst > 0);

  writeFileSync(file, 'v2 grew a lot more than v1 '.repeat(400));
  await record(root, 'growth.md', 'external');
  const afterSecond = await historySize(root);
  assert.ok(afterSecond > afterFirst, `expected growth: ${afterFirst} -> ${afterSecond}`);

  writeFileSync(file, 'v3 grew even more than v2 did '.repeat(600));
  await record(root, 'growth.md', 'restore');
  const afterThird = await historySize(root);
  assert.ok(afterThird > afterSecond, `expected growth: ${afterSecond} -> ${afterThird}`);

  await prune(root);
  assert.equal(await historySize(root), 0);
});

test('prune rebuilds the shared repo: the pruned folder\'s history is gone and its blobs are unreachable, kept paths survive', { skip: !git && 'git unavailable' }, async () => {
  const keepRoot = realGitTmp('showmd-history-keep-');
  const pruneRoot = realGitTmp('showmd-history-drop-');
  writeFileSync(path.join(keepRoot, 'keep.md'), '# keep v1\n');
  writeFileSync(path.join(pruneRoot, 'drop.md'), '# secret content to be pruned\n');
  await record(keepRoot, 'keep.md', 'user');
  await record(pruneRoot, 'drop.md', 'user');
  writeFileSync(path.join(keepRoot, 'keep.md'), '# keep v2\n');
  await record(keepRoot, 'keep.md', 'user');

  const before = await timeline(keepRoot, 'keep.md');
  assert.ok(before.length >= 1);
  const droppedBefore = await timeline(pruneRoot, 'drop.md');
  assert.ok(droppedBefore.length >= 1);

  const gitDir = historyDirFor(pruneRoot);
  const returned = await prune(pruneRoot);
  assert.equal(returned, gitDir);

  const droppedAfter = await timeline(pruneRoot, 'drop.md');
  assert.deepEqual(droppedAfter, []);

  // the rebuild replays into a fresh repo, so commit hashes are new even
  // though the timeline's shape (count, timestamps, content) is preserved
  const after = await timeline(keepRoot, 'keep.md');
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map((e) => e.ts).sort(), before.map((e) => e.ts).sort());
  assert.equal(await contentAt(keepRoot, 'keep.md', after[0].rev, false), '# keep v2\n');

  // the rebuild swapped in a fresh repo, so the pruned blob's content must not
  // be reachable from any object in the new repo's object store at all
  const grep = execFileSync('git', ['--git-dir', gitDir, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  const found = grep.some((sha) => {
    try {
      const content = execFileSync('git', ['--git-dir', gitDir, 'cat-file', 'blob', sha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return content.includes('secret content to be pruned');
    } catch {
      return false;
    }
  });
  assert.equal(found, false, 'pruned blob content must be unreachable in the rebuilt repo\'s object store');
});

test('prune on a root with no shared repo yet is a harmless no-op', { skip: !git && 'git unavailable' }, async () => {
  const root = realGitTmp('showmd-history-prune-missing-root-');
  await pruneAll();
  const dir = historyDirFor(root);
  assert.ok(!existsSync(dir));
  const returned = await prune(root);
  assert.equal(returned, dir);
  assert.ok(!existsSync(dir));
});
