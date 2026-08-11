'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const proc = require('./proc.js');
const { identityPath } = require('./root-identity.js');

// mirrors promisify(execFile): an error's own .stdout carries whatever the
// command printed before it exited non-zero, which realGitExec relies on
async function execFileAsync(cmd, args, opts) {
  const { err, stdout } = await proc.tryRun(cmd, args, opts);
  if (err) { err.stdout = stdout; throw err; }
  return { stdout };
}

const AMEND_WINDOW_MS = 60000;

const SOURCES = {
  user: 'user',
  restore: 'restore',
  external: 'external',
  commit: 'commit',
  baseline: 'baseline',
};

// trust boundary: strip any inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE so
// every call below is scoped only by the explicit --git-dir/--work-tree args,
// never by ambient environment pointing git somewhere else
function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

async function realGitExec(prefixArgs, args, allowCodes, opts) {
  const { env, ...rest } = opts || {};
  try {
    const { stdout } = await execFileAsync('git', [...prefixArgs, ...args], { env: { ...gitEnv(), ...env }, maxBuffer: 64 * 1024 * 1024, ...rest });
    return { code: 0, stdout };
  } catch (err) {
    if (typeof err.code === 'number' && allowCodes.includes(err.code)) {
      return { code: err.code, stdout: err.stdout || '' };
    }
    throw err;
  }
}

// the history store lives outside every served directory; SHOWMD_HISTORY_HOME
// moves it, which is how tests get a real git repo without touching the
// developer's own home
function historyHome() {
  return process.env.SHOWMD_HISTORY_HOME || path.join(os.homedir(), '.local', 'share', 'showmd', 'history');
}

// legacy per-root repos (pre-rekey) live flat under historyHome() as 40-char
// sha1 hex dirs; the new store lives under a 'store' subdirectory so
// migration can tell the two apart by listing historyHome() once
function storeRoot() {
  return path.join(historyHome(), 'store');
}

const LEGACY_DIR_PATTERN = /^[0-9a-f]{40}$/;

// one repo per filesystem root (POSIX "/", or a drive letter on Windows) is
// the closest a git work-tree can get to "the whole machine": `git add`
// reads real bytes off disk relative to --work-tree, so the work-tree has to
// be a real ancestor of every file it will ever be asked to add
function driveRootOf(absPath) {
  return path.parse(absPath).root;
}

// git refuses a pathspec that walks through a symlinked ancestor (macOS's
// /var -> /private/var is exactly this), and a synthetic "/" work-tree makes
// every path walk from the real filesystem root, so the root must be
// realpath'd before anything joins onto it. relPath itself is left alone:
// resolving it would require the file to still exist, which breaks history
// lookups for a file that was since deleted.
async function identityAbs(root) {
  const real = await fsp.realpath(root).catch(() => path.resolve(root));
  return identityPath(real);
}

// canonical absolute path for a document, reusing root-identity.js's identity
// normalisation so the same file reached through two different roots (or
// through case/Unicode-equivalent spellings) always resolves to one key
async function keyPath(root, relPath) {
  return path.join(await identityAbs(root), relPath);
}

function relKeyFor(driveRoot, absPath) {
  return path.relative(driveRoot, absPath).split(path.sep).join('/');
}

function isUnderPrefix(relPath, prefixRel) {
  if (prefixRel === '') return true;
  return relPath === prefixRel || relPath.startsWith(`${prefixRel}/`);
}

function historyDirFor(anyPath) {
  const driveRoot = driveRootOf(identityPath(path.resolve(anyPath)));
  const hash = crypto.createHash('sha1').update(driveRoot).digest('hex');
  return path.join(storeRoot(), hash);
}

function parseLog(stdout) {
  return stdout.split('\x00').filter(Boolean).map((chunk) => {
    const nl = chunk.indexOf('\n');
    const header = nl === -1 ? chunk : chunk.slice(0, nl);
    const body = nl === -1 ? '' : chunk.slice(nl + 1);
    const [rev, ts, subject] = header.split('\x1f');
    const stat = body.match(/^(\d+|-)\t(\d+|-)\t/m);
    const adds = stat && stat[1] !== '-' ? Number(stat[1]) : 0;
    const dels = stat && stat[2] !== '-' ? Number(stat[2]) : 0;
    return { rev, ts: Number(ts), subject, adds, dels };
  });
}

const LOG_ARGS = ['log', '--follow', '--format=%x00%H\x1f%ct\x1f%s', '--numstat', '--'];

function pruneAllDir() {
  return historyHome();
}

async function dirSize(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += await fsp.stat(full).then((st) => st.size, () => 0);
  }
  return total;
}

// gitExec is the seam: production leaves it defaulted to the real git binary
// below, tests pass a scripted adapter instead so everything in here — the
// amend-window decision, the fromRepo branch, prune — runs against canned
// git output instead of a real repo
function createHistory(gitExec = realGitExec) {
  function run(gitDir, workTree, args, allowCodes = [], extraOpts = {}) {
    return gitExec(['--git-dir', gitDir, '--work-tree', workTree], args, allowCodes, { cwd: workTree, ...extraOpts });
  }

  /** @type {Promise<boolean> | null} */
  let gitAvailable = null;
  function checkGitAvailable() {
    if (!gitAvailable) {
      gitAvailable = gitExec([], ['--version'], []).then(() => true).catch(() => false);
    }
    return gitAvailable;
  }

  const repoCache = new Map();

  // trust boundary: every mutating git op for a repo must flow through this
  // chain, one at a time — concurrent `add`+`commit` pairs otherwise race on
  // index.lock or sweep in each other's staged changes
  const gitLocks = new Map();
  function withGitLock(gitDir, fn) {
    const tail = gitLocks.get(gitDir) || Promise.resolve();
    const run = tail.then(fn, fn);
    gitLocks.set(gitDir, run.catch(() => {}));
    return run;
  }

  // one repo now serves every open root, so every showmd process on the
  // machine can land on the same gitDir at once. The in-process chain above
  // only serializes callers inside this one process; this file lock (atomic
  // create, same pattern as writeFileAtomic) is what keeps two processes off
  // the same index.lock instead of one silently losing its commit.
  const LOCK_STALE_MS = 30000;
  const LOCK_TIMEOUT_MS = 60000;
  async function withCrossProcessLock(gitDir, fn) {
    const lockPath = `${gitDir}.lock`;
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await fsp.open(lockPath, 'wx');
        await handle.close();
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const stat = await fsp.stat(lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fsp.rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
        if (Date.now() > deadline) throw Object.assign(new Error(`history lock timeout: ${lockPath}`), { code: 'ELOCKTIMEOUT' });
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
      }
    }
    try {
      return await fn();
    } finally {
      await fsp.rm(lockPath, { force: true }).catch(() => {});
    }
  }

  async function initRepoAt(gitDir, driveRoot) {
    await fsp.mkdir(gitDir, { recursive: true });
    await run(gitDir, driveRoot, ['init', '-q']);
    await run(gitDir, driveRoot, ['config', 'user.name', 'showmd']);
    await run(gitDir, driveRoot, ['config', 'user.email', 'showmd@local']);
  }

  async function ensureRepo(driveRoot) {
    if (!(await checkGitAvailable())) return null;
    const gitDir = historyDirFor(driveRoot);
    if (repoCache.has(gitDir)) return repoCache.get(gitDir);
    // two showmd processes can both see a missing HEAD at once, so the
    // check-then-init below needs the same cross-process lock a commit takes,
    // not just the in-process repoCache guard
    const ready = withCrossProcessLock(gitDir, async () => {
      await fsp.mkdir(gitDir, { recursive: true });
      if (!fs.existsSync(path.join(gitDir, 'HEAD'))) await initRepoAt(gitDir, driveRoot);
      return gitDir;
    });
    repoCache.set(gitDir, ready);
    return ready;
  }


  // migration claims a legacy repo by renaming it out of historyHome()'s top
  // level first: the rename is atomic, so two processes racing to migrate the
  // same legacy dir leave exactly one winner, and the loser sees ENOENT and
  // moves on
  /** @type {Promise<void> | null} */
  let migrationDone = null;
  function ensureMigrated() {
    if (!migrationDone) {
      migrationDone = migrateLegacy().catch((err) => {
        console.error(`showmd: history migration failed: ${err.message}`);
      });
    }
    return migrationDone;
  }

  async function migrateLegacy() {
    const home = historyHome();
    let entries;
    try {
      entries = await fsp.readdir(home, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !LEGACY_DIR_PATTERN.test(entry.name)) continue;
      const legacyDir = path.join(home, entry.name);
      const claimDir = `${legacyDir}.migrating-${process.pid}`;
      try {
        await fsp.rename(legacyDir, claimDir);
      } catch {
        continue;
      }
      try {
        await migrateOneRepo(claimDir, entry.name);
      } catch (err) {
        console.error(`showmd: history migration of ${entry.name} failed: ${err.message}`);
      } finally {
        await rmRepo(claimDir);
      }
    }
  }

  async function migrateOneRepo(legacyGitDir, label) {
    const cfgPath = path.join(legacyGitDir, 'config');
    let cfg;
    try {
      cfg = await fsp.readFile(cfgPath, 'utf8');
    } catch {
      console.error(`showmd: history migration skipped ${label}: no config found`);
      return;
    }
    const m = cfg.match(/^\s*worktree\s*=\s*(.+?)\s*$/m);
    if (!m) {
      console.error(`showmd: history migration skipped ${label}: no core.worktree recorded`);
      return;
    }
    const legacyRoot = m[1];

    const allPaths = await listAllTrackedPaths(legacyGitDir, legacyRoot);
    if (!allPaths.length) return;

    const entries = [];
    for (const relPath of allPaths) {
      const commits = await allCommitsOldestFirst(legacyGitDir, legacyRoot, relPath);
      for (const c of commits) entries.push({ ...c, relPath });
    }
    entries.sort((a, b) => a.ts - b.ts);
    if (!entries.length) return;

    const realLegacyRoot = await identityAbs(legacyRoot);
    const driveRoot = driveRootOf(realLegacyRoot);
    const newGitDir = await ensureRepo(driveRoot);
    if (!newGitDir) return;

    await withCrossProcessLock(newGitDir, () => withGitLock(newGitDir, async () => {
      for (const entry of entries) {
        const content = await run(legacyGitDir, legacyRoot, ['show', `${entry.rev}:${entry.relPath}`], [128]);
        if (content.code !== 0) continue;
        const absPath = path.join(realLegacyRoot, entry.relPath);
        const newRelPath = relKeyFor(driveRoot, absPath);
        const sep = entry.subject.indexOf(': ');
        const source = sep === -1 ? SOURCES.external : entry.subject.slice(0, sep);
        await writeBlobInto(newGitDir, driveRoot, newRelPath, content.stdout);
        await commitAt(newGitDir, driveRoot, `${source}: ${newRelPath}`, entry.ts);
      }
    }));
  }

  async function getLastCommit(gitDir, driveRoot, storeRelPath) {
    const r = await run(gitDir, driveRoot, ['log', '-1', '--format=%H\x1f%s\x1f%ct', '--', storeRelPath], [128]);
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const [rev, subject, ts] = r.stdout.trim().split('\x1f');
    return { rev, subject, ts: Number(ts) };
  }

  async function commit(root, relPath, source) {
    await ensureMigrated();
    const absPath = await keyPath(root, relPath);
    const driveRoot = driveRootOf(absPath);
    const gitDir = await ensureRepo(driveRoot);
    if (!gitDir) return;
    const storeRelPath = relKeyFor(driveRoot, absPath);
    return withCrossProcessLock(gitDir, () => withGitLock(gitDir, async () => {
      // first save of a file: seed an invisible baseline commit with the repo's
      // HEAD content, so save deltas read against the last real commit instead
      // of showing the whole file as added
      if (!(await getLastCommit(gitDir, driveRoot, storeRelPath))) {
        const base = await repoReadAt(root, relPath, 'HEAD');
        if (base != null) {
          await writeBlobInto(gitDir, driveRoot, storeRelPath, base);
          const seeded = await run(gitDir, driveRoot, ['diff', '--cached', '--quiet', '--', storeRelPath], [1]);
          if (seeded.code !== 0) await run(gitDir, driveRoot, ['commit', '-m', `${SOURCES.baseline}: ${storeRelPath}`]);
        }
      }
      await run(gitDir, driveRoot, ['add', '-f', '--', storeRelPath]);
      const staged = await run(gitDir, driveRoot, ['diff', '--cached', '--quiet', '--', storeRelPath], [1]);
      if (staged.code === 0) return;
      const subject = `${source}: ${storeRelPath}`;
      const last = await getLastCommit(gitDir, driveRoot, storeRelPath);
      // `commit --amend` always targets HEAD, so amending is only safe when this
      // path's own last commit IS HEAD — otherwise HEAD belongs to some other
      // path's commit and amending would fold this change into it
      const head = last ? await run(gitDir, driveRoot, ['rev-parse', 'HEAD'], [128]) : null;
      const amend = !!last && last.subject === subject && head?.code === 0 && head.stdout.trim() === last.rev
        && Date.now() - last.ts * 1000 < AMEND_WINDOW_MS;
      await run(gitDir, driveRoot, amend ? ['commit', '--amend', '--no-edit'] : ['commit', '-m', subject]);
    }));
  }

  async function list(root, relPath) {
    await ensureMigrated();
    const absPath = await keyPath(root, relPath);
    const driveRoot = driveRootOf(absPath);
    const gitDir = await ensureRepo(driveRoot);
    if (!gitDir) return null;
    const storeRelPath = relKeyFor(driveRoot, absPath);
    const r = await run(gitDir, driveRoot, [...LOG_ARGS, storeRelPath], [128]);
    if (r.code !== 0 || !r.stdout) return [];
    return parseLog(r.stdout).map(({ subject, ...e }) => {
      const sep = subject.indexOf(': ');
      return { ...e, source: sep === -1 ? SOURCES.external : subject.slice(0, sep) };
    });
  }

  // trust boundary: repo-git access is strictly read-only — log/show only, with
  // --no-optional-locks so git never writes the repo's index or any lock file
  function runRepo(root, args, allowCodes = []) {
    return gitExec(['-C', root, '--no-optional-locks'], args, allowCodes, {});
  }

  async function repoList(root, relPath) {
    const r = await runRepo(root, [...LOG_ARGS, relPath], [128]);
    if (r.code !== 0 || !r.stdout) return [];
    return parseLog(r.stdout).map((e) => ({ ...e, source: SOURCES.commit, repo: true }));
  }

  async function repoClean(root, relPath) {
    const r = await runRepo(root, ['diff', '--quiet', 'HEAD', '--', relPath], [1, 128]);
    return r.code === 0;
  }

  async function repoDiff(root, relPath, rev) {
    const r = await runRepo(root, ['show', rev, '--format=', '--', relPath], [128]);
    return r.code === 0 ? r.stdout : null;
  }

  async function repoReadAt(root, relPath, rev) {
    // `rev:./path` resolves the path against cwd, so it works when root is a
    // subdirectory of the repo and relPath is root-relative
    const r = await runRepo(root, ['show', `${rev}:./${relPath}`], [128]);
    return r.code === 0 ? r.stdout : null;
  }

  // deleting a repo out from under a running git leaves half-written objects
  // behind (ENOTEMPTY) and spawns git into a directory that no longer exists,
  // so a prune waits its turn in the same chain every commit uses
  const rmRepo = (dir) => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

  async function listAllTrackedPaths(gitDir, driveRoot) {
    const r = await run(gitDir, driveRoot, ['ls-tree', '-r', '--name-only', 'HEAD'], [128]);
    if (r.code !== 0 || !r.stdout) return [];
    return r.stdout.split('\n').filter(Boolean);
  }

  async function allCommitsOldestFirst(gitDir, driveRoot, storeRelPath) {
    const r = await run(gitDir, driveRoot, ['log', '--reverse', '--format=%H\x1f%ct\x1f%s', '--', storeRelPath], [128]);
    if (r.code !== 0 || !r.stdout.trim()) return [];
    return r.stdout.trim().split('\n').map((line) => {
      const [rev, ts, subject] = line.split('\x1f');
      return { rev, ts: Number(ts), subject };
    });
  }

  async function writeBlobInto(gitDir, driveRoot, storeRelPath, content) {
    const tmp = path.join(os.tmpdir(), `showmd-blob-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(tmp, content);
    try {
      const blob = await run(gitDir, driveRoot, ['hash-object', '-w', '--', tmp]);
      await run(gitDir, driveRoot, ['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},${storeRelPath}`]);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  async function commitAt(gitDir, driveRoot, subject, ts) {
    const stamp = `${ts} +0000`;
    await run(gitDir, driveRoot, ['commit', '-m', subject], [], { env: { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } });
  }

  // "Selected folder's history" can no longer delete a directory shared by
  // every open root, so pruning one folder means: build a fresh repo holding
  // only the paths NOT under it, replaying their full timelines, then swap it
  // in. The old repo (and the pruned paths' blobs with it) is deleted outright
  // afterward, so nothing pruned stays reachable in git's object store.
  async function prune(root) {
    await ensureMigrated();
    const absRoot = await identityAbs(root);
    const driveRoot = driveRootOf(absRoot);
    const gitDir = historyDirFor(driveRoot);
    if (!fs.existsSync(gitDir)) return gitDir;
    return withCrossProcessLock(gitDir, () => withGitLock(gitDir, async () => {
      const prefixRel = relKeyFor(driveRoot, absRoot);
      const allPaths = await listAllTrackedPaths(gitDir, driveRoot);
      const keep = allPaths.filter((p) => !isUnderPrefix(p, prefixRel));
      const tmpGitDir = `${gitDir}.rebuild-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      await initRepoAt(tmpGitDir, driveRoot);
      for (const storeRelPath of keep) {
        const commits = await allCommitsOldestFirst(gitDir, driveRoot, storeRelPath);
        for (const c of commits) {
          const content = await run(gitDir, driveRoot, ['show', `${c.rev}:${storeRelPath}`], [128]);
          if (content.code !== 0) continue;
          await writeBlobInto(tmpGitDir, driveRoot, storeRelPath, content.stdout);
          await commitAt(tmpGitDir, driveRoot, c.subject, c.ts);
        }
      }
      repoCache.delete(gitDir);
      await rmRepo(gitDir);
      await fsp.rename(tmpGitDir, gitDir);
      repoCache.set(gitDir, Promise.resolve(gitDir));
      return gitDir;
    }));
  }

  function pruneAll() {
    const dir = pruneAllDir();
    const pending = [...gitLocks.values()];
    const done = Promise.allSettled(pending).then(async () => {
      await rmRepo(dir);
      repoCache.clear();
      return dir;
    });
    const settled = done.catch(() => {});
    for (const key of gitLocks.keys()) gitLocks.set(key, settled);
    return done;
  }

  // reads `cat-file --batch-check` output (one "<type> <size>" line per
  // input object) and sums the blob sizes — the only shape both historySize
  // and totalHistorySize need out of a batch-check pass
  function sumBlobSizes(batch) {
    if (batch.code !== 0 || !batch.stdout) return 0;
    let total = 0;
    for (const line of batch.stdout.split('\n')) {
      if (!line) continue;
      const [type, size] = line.trim().split(/\s+/);
      if (type === 'blob') total += Number(size) || 0;
    }
    return total;
  }

  // what prune deletes is every historical blob under a prefix, not just
  // HEAD's current tree, so the size readout has to count them all: one
  // `rev-list --objects` walks HEAD's full history and lists every reachable
  // object exactly once (blobs dedupe by content across commits and across
  // paths — verified against a real repo, not assumed), then one
  // `cat-file --batch-check` reads every listed object's size in a single
  // pass. Two spawns total, regardless of path or commit count.
  //
  // %(rest) has to be in the format even though its value is discarded:
  // without it, batch-check tries to resolve each *whole line* (hash plus
  // whatever rev-list appended — a path for blobs, a bare trailing space for
  // the anonymous root tree) as one revision expression, and anything past
  // the hash makes that fail, so every non-commit object comes back
  // "missing". %(rest) is what tells batch-check to split at the first
  // whitespace and use only the hash for the lookup (verified against a real
  // repo: every object resolved once this was added, zero still missing).
  async function treeSizeFor(gitDir, driveRoot, pathspec) {
    const args = ['rev-list', '--objects', 'HEAD'];
    if (pathspec) args.push('--', pathspec);
    const rev = await run(gitDir, driveRoot, args, [128]);
    if (rev.code !== 0 || !rev.stdout.trim()) return 0;
    const batch = await run(gitDir, driveRoot, ['cat-file', '--batch-check=%(objecttype) %(objectsize) %(rest)'], [128], { input: rev.stdout });
    return sumBlobSizes(batch);
  }

  // prefix query over the shared repo's own object sizes: with one repo
  // covering every open root, a directory size on disk no longer maps to a
  // single root, so a root's own footprint is every historical blob under
  // its own pathspec rather than a stat on a dedicated directory
  async function historySize(root) {
    await ensureMigrated();
    const absRoot = await identityAbs(root);
    const driveRoot = driveRootOf(absRoot);
    const gitDir = historyDirFor(driveRoot);
    if (!fs.existsSync(gitDir)) return 0;
    const prefixRel = relKeyFor(driveRoot, absRoot);
    return treeSizeFor(gitDir, driveRoot, prefixRel || null);
  }

  // the store's own dirSize would count every repo's fixed git overhead
  // (hook templates, packfiles) which historySize's prefix query deliberately
  // excludes, so the total has to be the same tracked-content sum across
  // every repo the store holds, not a stat on the store directory.
  // --batch-all-objects skips the rev-list walk entirely (there is no prefix
  // to filter by), one spawn per repo in the store.
  async function totalHistorySize() {
    await ensureMigrated();
    let entries;
    try {
      entries = await fsp.readdir(storeRoot(), { withFileTypes: true });
    } catch {
      return 0;
    }
    let total = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const gitDir = path.join(storeRoot(), entry.name);
      const cfg = await fsp.readFile(path.join(gitDir, 'config'), 'utf8').catch(() => null);
      const m = cfg && cfg.match(/^\s*worktree\s*=\s*(.+?)\s*$/m);
      if (!m) continue;
      const driveRoot = m[1];
      const batch = await run(gitDir, driveRoot, ['cat-file', '--batch-check=%(objecttype) %(objectsize)', '--batch-all-objects'], [128]);
      total += sumBlobSizes(batch);
    }
    return total;
  }

  async function diff(root, relPath, rev) {
    await ensureMigrated();
    const absPath = await keyPath(root, relPath);
    const driveRoot = driveRootOf(absPath);
    const gitDir = await ensureRepo(driveRoot);
    if (!gitDir) return null;
    const storeRelPath = relKeyFor(driveRoot, absPath);
    const r = await run(gitDir, driveRoot, ['show', rev, '--format=', '--', storeRelPath], [128]);
    return r.code === 0 ? r.stdout : null;
  }

  async function readAt(root, relPath, rev) {
    await ensureMigrated();
    const absPath = await keyPath(root, relPath);
    const driveRoot = driveRootOf(absPath);
    const gitDir = await ensureRepo(driveRoot);
    if (!gitDir) return null;
    const storeRelPath = relKeyFor(driveRoot, absPath);
    const r = await run(gitDir, driveRoot, ['show', `${rev}:${storeRelPath}`], [128]);
    return r.code === 0 ? r.stdout : null;
  }

  // One timeline per file: unpushed history saves on top of the served repo's own
  // commits. A history save is a working-copy checkpoint since the last commit, so
  // once a real commit absorbs it — or the file matches HEAD again (edit then
  // revert) — it drops out of the timeline, still stored, just not shown.
  async function timeline(root, relPath) {
    const [saved, commits] = await Promise.all([list(root, relPath), repoList(root, relPath)]);
    const saves = saved || [];
    const lastCommitTs = commits.length ? commits[0].ts : 0;
    let pending = saves.filter((e) => e.source !== SOURCES.baseline && e.ts > lastCommitTs);
    if (pending.length && commits.length && (await repoClean(root, relPath))) pending = [];
    return [...pending, ...commits].sort((a, b) => b.ts - a.ts);
  }

  // `fromRepo` is the entry's own `repo` marker handed back, not a choice the
  // caller has to reason about
  function contentAt(root, relPath, rev, fromRepo) {
    return fromRepo ? repoReadAt(root, relPath, rev) : readAt(root, relPath, rev);
  }

  function diffAt(root, relPath, rev, fromRepo) {
    return fromRepo ? repoDiff(root, relPath, rev) : diff(root, relPath, rev);
  }

  return {
    checkGitAvailable,
    record: commit,
    timeline,
    contentAt,
    diffAt,
    prune,
    pruneAll,
    historySize,
    totalHistorySize,
    migrateLegacyHistory: ensureMigrated,
  };
}

// module.exports must be a literal object of plain identifiers (not the
// direct call result) — Node's CJS→ESM named-export detection is purely
// syntactic and can't see through a function call
const {
  checkGitAvailable, record, timeline, contentAt, diffAt, prune, pruneAll, historySize, totalHistorySize, migrateLegacyHistory,
} = createHistory();

module.exports = {
  SOURCES,
  checkGitAvailable,
  record,
  timeline,
  contentAt,
  diffAt,
  prune,
  pruneAll,
  pruneAllDir,
  historyDirFor,
  parseLog,
  createHistory,
  dirSize,
  historySize,
  totalHistorySize,
  migrateLegacyHistory,
};
