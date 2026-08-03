import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workDir = mkdtempSync(path.join(tmpdir(), 'showmd-docs-'));
process.env.SHOWMD_HISTORY_HOME = path.join(workDir, 'history');

const { createDocumentStore, isMarkdownFile, classifyRootTarget, readDirSafe, isDirEntry, walkFiles } = await import('../../server/documents.js');
const history = await import('../../server/history.js');

function makeRoot(name) {
  const dir = path.join(workDir, name);
  mkdirSync(path.join(dir, 'notes'), { recursive: true });
  writeFileSync(path.join(dir, 'hello.md'), '# Hello\n');
  writeFileSync(path.join(dir, 'notes', 'deep.md'), '# Deep\n');
  return dir;
}

const soloDir = makeRoot('solo');
const solo = createDocumentStore([{ key: null, dir: soloDir }], false);

const groupA = makeRoot('groupA');
const groupB = makeRoot('groupB');
const multi = createDocumentStore([{ key: 'a', dir: groupA }, { key: 'b', dir: groupB }], true);

test.after(() => rmSync(workDir, { recursive: true, force: true }));

test('read returns the document', async () => {
  assert.deepEqual(await solo.read('hello.md'), { ok: true, text: '# Hello\n', full: path.join(soloDir, 'hello.md') });
  assert.equal((await solo.read('notes/deep.md')).text, '# Deep\n');
});

test('read refuses anything that is not a .md inside the root', async () => {
  for (const id of ['../escape.md', 'notes/../../escape.md', '/etc/passwd.md', 'hello.txt', '']) {
    assert.deepEqual(await solo.read(id), { ok: false, code: 'forbidden' }, id);
  }
});

test('read reports a missing document separately from a refused one', async () => {
  assert.deepEqual(await solo.read('nope.md'), { ok: false, code: 'not_found' });
});

test('write lands on disk and is readable back', async () => {
  const result = await solo.write('hello.md', Buffer.from('# Changed\n'));
  assert.deepEqual(result, { ok: true });
  assert.equal(readFileSync(path.join(soloDir, 'hello.md'), 'utf8'), '# Changed\n');
  assert.equal((await solo.read('hello.md')).text, '# Changed\n');
});

test('write refuses to escape the root', async () => {
  assert.deepEqual(await solo.write('../escape.md', Buffer.from('x')), { ok: false, code: 'forbidden' });
});

// a save can raise more than one watcher event, so the echo is claimed for as
// long as the file still holds what we wrote, not for one event only
test('a write claims every watcher echo while the file still holds what we wrote', async () => {
  await solo.write('hello.md', Buffer.from('# Again\n'));
  assert.equal(await solo.consumeSelfWrite('hello.md'), true);
  assert.equal(await solo.consumeSelfWrite('hello.md'), true);
});

test('an echo for an earlier save is still ours after a later save stamped its own', async () => {
  await solo.write('hello.md', Buffer.from('# One\n'));
  const later = solo.write('hello.md', Buffer.from('# Two\n'));
  assert.equal(await solo.consumeSelfWrite('hello.md'), true);
  await later;
  assert.equal(await solo.consumeSelfWrite('hello.md'), true);
});

test('an outside edit landing on top of our write is not claimed as the echo', async () => {
  await solo.write('hello.md', Buffer.from('# Ours\n'));
  writeFileSync(path.join(soloDir, 'hello.md'), '# Ours\ntheirs\n');
  assert.equal(await solo.consumeSelfWrite('hello.md'), false);
});

test('concurrent writes to one document both succeed and the last one wins', async () => {
  const [first, second] = await Promise.all([
    solo.write('hello.md', Buffer.from('# One\n')),
    solo.write('hello.md', Buffer.from('# Two\n')),
  ]);
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  assert.equal(readFileSync(path.join(soloDir, 'hello.md'), 'utf8'), '# Two\n');
});

test('multi-root ids resolve inside their own group only', async () => {
  writeFileSync(path.join(groupA, 'hello.md'), '# A\n');
  writeFileSync(path.join(groupB, 'hello.md'), '# B\n');
  assert.equal((await multi.read('a/hello.md')).text, '# A\n');
  assert.equal((await multi.read('b/hello.md')).text, '# B\n');
  assert.deepEqual(await multi.read('hello.md'), { ok: false, code: 'forbidden' });
  assert.deepEqual(await multi.read('c/hello.md'), { ok: false, code: 'forbidden' });
  assert.deepEqual(await multi.read('a/../../groupB/hello.md'), { ok: false, code: 'forbidden' });
});

test('resolveAsset resolves a non-.md id the same way locate resolves a doc id', async () => {
  writeFileSync(path.join(soloDir, 'img.png'), Buffer.from([0x89, 0x50]));
  const loc = solo.resolveAsset('img.png');
  assert.equal(loc.full, path.join(soloDir, 'img.png'));
  assert.equal(solo.resolveAsset('../escape.png'), null);
  assert.equal(multi.resolveAsset('a/img.png').full, path.join(groupA, 'img.png'));
  assert.equal(multi.resolveAsset('a/../../groupB/img.png'), null);
});

test('diff and restore reject a rev that is not a bare object id', async () => {
  for (const rev of ['../x', '$(id)', 'HEAD', 'refs/heads/main', 'abc', '']) {
    assert.deepEqual(await solo.diff('hello.md', rev, false), { ok: false, code: 'invalid_rev' }, rev);
    assert.deepEqual(await solo.restore('hello.md', rev, false), { ok: false, code: 'invalid_rev' }, rev);
  }
});

const git = await history.checkGitAvailable();

// fakeGitExec is a scripted stand-in for the real git binary, wired through
// history.js's own createHistory(gitExec) seam. It tracks just enough state
// (a per-path commit chain plus a rev->content object map, mirroring how
// `git commit --amend` leaves the pre-amend object reachable by hash even
// once it drops out of `git log`) to drive commit/amend/log/show the way
// server/history.js calls them — it does not hash or diff for real.
function fakeGitExec() {
  const repos = new Map();
  let counter = 0;
  const nextRev = () => (++counter).toString(16).padStart(40, '0');
  const repoFor = (gitDir) => {
    if (!repos.has(gitDir)) repos.set(gitDir, { head: null, objects: new Map(), history: new Map(), staged: new Map(), lastStaged: null });
    return repos.get(gitDir);
  };

  return async function gitExec(prefixArgs, args, allowCodes = [], opts = {}) {
    if (prefixArgs.length === 0 && args[0] === '--version') return { code: 0, stdout: 'git version 2.40.0 (fake)\n' };
    if (prefixArgs[0] === '-C') return { code: 128, stdout: '' };
    if (prefixArgs[0] !== '--git-dir') return { code: 0, stdout: '' };

    const gitDir = prefixArgs[1];
    const workTree = prefixArgs[3];
    const repo = repoFor(gitDir);
    const [cmd] = args;

    if (cmd === 'init' || cmd === 'config' || cmd === 'hash-object' || cmd === 'update-index') return { code: 0, stdout: '' };

    if (cmd === 'add') {
      const relPath = args[args.length - 1];
      const content = readFileSync(path.join(workTree, relPath), 'utf8');
      repo.staged.set(relPath, content);
      repo.lastStaged = relPath;
      return { code: 0, stdout: '' };
    }

    if (cmd === 'diff' && args.includes('--cached')) {
      const relPath = args[args.length - 1];
      const chain = repo.history.get(relPath) || [];
      const lastContent = chain.length ? repo.objects.get(chain[chain.length - 1].rev) : '';
      const staged = repo.staged.get(relPath);
      return { code: staged === lastContent ? 0 : 1, stdout: '' };
    }

    if (cmd === 'commit') {
      const relPath = repo.lastStaged;
      const chain = repo.history.get(relPath) || [];
      const content = repo.staged.get(relPath);
      const rev = nextRev();
      const ts = Math.floor(Date.now() / 1000);
      repo.objects.set(rev, content);
      if (args[1] === '--amend') {
        const subject = chain.length ? chain[chain.length - 1].subject : '';
        if (chain.length) chain[chain.length - 1] = { rev, subject, ts };
        else chain.push({ rev, subject, ts });
      } else {
        chain.push({ rev, subject: args[2], ts });
      }
      repo.history.set(relPath, chain);
      repo.head = rev;
      return { code: 0, stdout: '' };
    }

    if (cmd === 'rev-parse') return repo.head ? { code: 0, stdout: `${repo.head}\n` } : { code: 128, stdout: '' };

    if (cmd === 'log' && args[1] === '-1') {
      const relPath = args[args.length - 1];
      const chain = repo.history.get(relPath) || [];
      if (!chain.length) return { code: 0, stdout: '' };
      const last = chain[chain.length - 1];
      return { code: 0, stdout: `${last.rev}\x1f${last.subject}\x1f${last.ts}` };
    }

    if (cmd === 'log' && args.includes('--numstat')) {
      const relPath = args[args.length - 1];
      const chain = repo.history.get(relPath) || [];
      const stdout = [...chain].reverse().map((e) => `\x00${e.rev}\x1f${e.ts}\x1f${e.subject}\n1\t0\t${relPath}\n`).join('');
      return { code: 0, stdout };
    }

    if (cmd === 'show' && args.length === 2) {
      const idx = args[1].indexOf(':');
      const rev = args[1].slice(0, idx);
      const content = repo.objects.get(rev);
      return content === undefined ? { code: 128, stdout: '' } : { code: 0, stdout: content };
    }

    return { code: 128, stdout: '' };
  };
}

function makeFakeHistoryStore(name) {
  const dir = makeRoot(name);
  return createDocumentStore([{ key: null, dir }], false, history.createHistory(fakeGitExec()));
}

test('a save becomes a timeline entry', async () => {
  const store = makeFakeHistoryStore('fake-history-1');
  await store.write('notes/deep.md', Buffer.from('# Deep\n\nfirst\n'));
  const result = await store.timeline('notes/deep.md');
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].source, 'user');
  assert.ok(result.entries[0].adds > 0);
});

test('restore puts an earlier version back on disk', async () => {
  const store = makeFakeHistoryStore('fake-history-2');
  const file = 'notes/deep.md';
  await store.write(file, Buffer.from('# Deep\n\nfirst\n'));
  const { entries } = await store.timeline(file);
  const rev = entries[0].rev;
  await store.write(file, Buffer.from('# Deep\n\nsecond\n'));
  assert.equal((await store.read(file)).text, '# Deep\n\nsecond\n');

  const result = await store.restore(file, rev, false);
  assert.deepEqual(result, { ok: true });
  assert.equal((await store.read(file)).text, '# Deep\n\nfirst\n');
});

test('timeline reports a document with no history as empty', async () => {
  const store = makeFakeHistoryStore('fake-history-3');
  const result = await store.timeline('hello.md');
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.entries));
});

test('a save becomes a timeline entry (real git)', { skip: !git && 'git unavailable' }, async () => {
  await solo.write('notes/deep.md', Buffer.from('# Deep\n\nfirst\n'));
  const result = await solo.timeline('notes/deep.md');
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].source, 'user');
  assert.ok(result.entries[0].adds > 0);
});

test('restore puts an earlier version back on disk (real git)', { skip: !git && 'git unavailable' }, async () => {
  const file = 'notes/deep.md';
  await solo.write(file, Buffer.from('# Deep\n\nfirst\n'));
  const { entries } = await solo.timeline(file);
  const rev = entries[0].rev;
  await solo.write(file, Buffer.from('# Deep\n\nsecond\n'));
  assert.equal((await solo.read(file)).text, '# Deep\n\nsecond\n');

  const result = await solo.restore(file, rev, false);
  assert.deepEqual(result, { ok: true });
  assert.equal((await solo.read(file)).text, '# Deep\n\nfirst\n');
});

// real git exits 128 on an unborn HEAD; the fake exec always returns 0, so this
// path is only reachable against the real binary
test('timeline reports a document with no history as empty (real git)', { skip: !git && 'git unavailable' }, async () => {
  const result = await solo.timeline('never-saved.md');
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries, []);
});

test('isMarkdownFile accepts .md and .markdown, case-insensitively, and rejects everything else', () => {
  for (const id of ['a.md', 'a.MD', 'a.markdown', 'a.MARKDOWN', 'notes/deep.Md', 'a/b.MarkDown']) {
    assert.equal(isMarkdownFile(id), true, id);
  }
  for (const id of ['a.txt', 'a.mdx', 'a.mdown', 'markdown', 'a', '']) {
    assert.equal(isMarkdownFile(id), false, id);
  }
});

test('a .markdown file resolves and reads through the store, the same as .md', async () => {
  writeFileSync(path.join(soloDir, 'page.markdown'), '# Page\n');
  assert.equal((await solo.read('page.markdown')).text, '# Page\n');
  assert.equal((await solo.read('page.mdx')).code, 'forbidden');
});

test('symlinkInfo returns null for a plain file and metadata for a real symlink', async () => {
  const realFile = path.join(soloDir, 'hello.md');
  const linkFile = path.join(soloDir, 'link-to-hello.md');
  symlinkSync(realFile, linkFile);
  try {
    assert.equal(await solo.symlinkInfo(realFile), null);
    const info = await solo.symlinkInfo(linkFile);
    assert.equal(info.isSymlink, true);
    assert.equal(info.target, realFile);
    assert.equal(info.docId, 'hello.md');
  } finally {
    rmSync(linkFile, { force: true });
  }
});

test('assetExists reflects a real file on disk and rejects an id that escapes the root', async () => {
  writeFileSync(path.join(soloDir, 'pic.png'), Buffer.from([0x89, 0x50]));
  assert.equal(await solo.assetExists('pic.png'), true);
  assert.equal(await solo.assetExists('missing.png'), false);
  assert.equal(await solo.assetExists('../escape.png'), false);
});

test('classifyRootTarget: a markdown file target -> {dir: parent, doc: basename}', async () => {
  const target = await classifyRootTarget(path.join(soloDir, 'hello.md'));
  assert.deepEqual(target, { dir: soloDir, doc: 'hello.md' });
});

test('classifyRootTarget: a .MARKDOWN file target also resolves (case-insensitive)', async () => {
  writeFileSync(path.join(soloDir, 'other.MARKDOWN'), '# Other\n');
  const target = await classifyRootTarget(path.join(soloDir, 'other.MARKDOWN'));
  assert.deepEqual(target, { dir: soloDir, doc: 'other.MARKDOWN' });
});

test('classifyRootTarget: a directory target -> {dir, doc: null}', async () => {
  const target = await classifyRootTarget(path.join(soloDir, 'notes'));
  assert.deepEqual(target, { dir: path.join(soloDir, 'notes'), doc: null });
});

test('classifyRootTarget: a non-markdown file or a missing path -> null', async () => {
  writeFileSync(path.join(soloDir, 'notes.txt'), 'hi');
  assert.equal(await classifyRootTarget(path.join(soloDir, 'notes.txt')), null);
  assert.equal(await classifyRootTarget(path.join(soloDir, 'does-not-exist')), null);
});

test('isDirEntry: a symlink pointing at a directory reports true even though its own Dirent says otherwise', async () => {
  const targetDir = path.join(soloDir, 'realdir');
  mkdirSync(targetDir, { recursive: true });
  const linkPath = path.join(soloDir, 'dirlink');
  symlinkSync(targetDir, linkPath);
  try {
    const entries = await readDirSafe(soloDir);
    const entry = entries.find((e) => e.name === 'dirlink');
    assert.equal(entry.isDirectory(), false, 'Dirent reports the symlink itself, not its target');
    assert.equal(await isDirEntry(linkPath, entry), true);
  } finally {
    rmSync(linkPath, { force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('readDirSafe: a missing directory returns [] instead of throwing', async () => {
  assert.deepEqual(await readDirSafe(path.join(soloDir, 'does-not-exist')), []);
});

test('walkFiles strictRoot: an unreadable root throws with its errno, an unreadable subdir stays swallowed', { skip: process.platform === 'win32' ? 'chmod does not restrict access on windows' : process.getuid && process.getuid() === 0 ? 'chmod does not constrain root' : false }, async () => {
  const denied = path.join(workDir, 'denied-root');
  mkdirSync(denied, { recursive: true });
  chmodSync(denied, 0o000);
  try {
    await assert.rejects(
      () => walkFiles(denied, denied, [], { strictRoot: true }),
      (err) => err.code === 'EACCES' || err.code === 'EPERM',
    );
    assert.deepEqual(await walkFiles(denied, denied, []), []);
  } finally {
    chmodSync(denied, 0o755);
  }

  const outer = path.join(workDir, 'outer');
  const inner = path.join(outer, 'blocked');
  mkdirSync(inner, { recursive: true });
  writeFileSync(path.join(outer, 'top.md'), '# Top\n');
  chmodSync(inner, 0o000);
  try {
    assert.deepEqual(await walkFiles(outer, outer, [], { strictRoot: true }), ['top.md']);
  } finally {
    chmodSync(inner, 0o755);
  }
});

test('tree: rooted single root lists its markdown', async () => {
  const outcome = await solo.tree(null, {});
  assert.equal(outcome.ok, true);
  assert.ok(outcome.tree.includes('hello.md') && outcome.tree.includes('notes/deep.md'));
  assert.ok(outcome.tree.every((id) => isMarkdownFile(id)));
});

test('tree: rootless with no view -> no_root', async () => {
  const rootless = createDocumentStore([], false);
  assert.deepEqual(await rootless.tree(null, {}), { ok: false, code: 'no_root' });
});

test('tree: an unreadable root -> unreadable_root carrying dir and errno', { skip: process.platform === 'win32' ? 'chmod does not restrict access on windows' : process.getuid && process.getuid() === 0 ? 'chmod does not constrain root' : false }, async () => {
  const denied = path.join(workDir, 'denied-store');
  mkdirSync(denied, { recursive: true });
  chmodSync(denied, 0o000);
  try {
    const store = createDocumentStore([{ key: null, dir: denied }], false);
    const outcome = await store.tree(null, {});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'unreadable_root');
    assert.equal(outcome.dir, denied);
    assert.ok(outcome.errno === 'EACCES' || outcome.errno === 'EPERM');
  } finally {
    chmodSync(denied, 0o755);
  }
});

test('tree: view=agents with an unknown agent -> unknown_agent', async () => {
  assert.deepEqual(await solo.tree('agents', { agent: 'nope-not-an-agent' }), { ok: false, code: 'unknown_agent' });
});

test('tree: view=agents with a known agent returns that agent tree', async () => {
  const outcome = await solo.tree('agents', { agent: 'claude', home: workDir, cwd: soloDir });
  assert.equal(outcome.ok, true);
  assert.ok(Array.isArray(outcome.tree.roots));
});

test('tree: multi-root ignores view and builds the skills tree', async () => {
  const outcome = await multi.tree(null, { skillsMode: 'all', home: workDir, cwd: workDir });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.tree && typeof outcome.tree === 'object');
});

test('tree: view=skills while rootless builds the global-scope skills tree', async () => {
  const rootless = createDocumentStore([], false);
  const outcome = await rootless.tree('skills', { home: workDir, cwd: workDir });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.tree && typeof outcome.tree === 'object');
});

test('storeFor: multi-root store always resolves to itself', async () => {
  assert.equal(await multi.storeFor('a/hello.md'), multi);
  assert.equal(await multi.storeFor('nonsense'), multi);
});

test('storeFor: an id the main store already owns resolves to that store', async () => {
  assert.equal(await solo.storeFor('hello.md'), solo);
});

test('storeFor: rootless with no matching skill or agent id resolves to null', async () => {
  const rootless = createDocumentStore([], false);
  assert.equal(await rootless.storeFor('nope.md'), null);
});
