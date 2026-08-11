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

// Trust boundary: strip ambient git paths and use only explicit repositories.
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

// SHOWMD_HISTORY_HOME isolates the external history store in tests.
function historyHome() {
  return process.env.SHOWMD_HISTORY_HOME || path.join(os.homedir(), '.local', 'share', 'showmd', 'history');
}

// Legacy SHA-named repos are flat; the new store subdirectory distinguishes them.
function storeRoot() {
  return path.join(historyHome(), 'store');
}

const LEGACY_DIR_PATTERN = /^[0-9a-f]{40}$/;

// Each repo uses a filesystem root so its work-tree contains every tracked file.
function driveRootOf(absPath) {
  return path.parse(absPath).root;
}

// Resolve symlinked roots before building git pathspecs. Keep relPath unresolved
// so deleted files remain addressable in history.
async function identityAbs(root) {
  const real = await fsp.realpath(root).catch(() => path.resolve(root));
  return identityPath(real);
}

// Normalize document identity across roots, case, and Unicode spellings.
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

// Tests replace gitExec with scripted output; production uses git.
function createHistory(gitExec = realGitExec, options = {}) {
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

  // Serialize mutations per repo to protect index.lock and staged changes.
  const gitLocks = new Map();
  function withGitLock(gitDir, fn) {
    const tail = gitLocks.get(gitDir) || Promise.resolve();
    const run = tail.then(fn, fn);
    gitLocks.set(gitDir, run.catch(() => {}));
    return run;
  }

  // Atomic file locks serialize separate showmd processes sharing one repo.
  const lockStaleMs = options.lockStaleMs ?? 30000;
  const lockTimeoutMs = options.lockTimeoutMs ?? 60000;
  const lockPollMs = options.lockPollMs ?? 20;
  const lockHeartbeatMs = options.lockHeartbeatMs ?? Math.max(10, Math.floor(lockStaleMs / 3));
  const lockToken = options.lockToken || (() => crypto.randomUUID());
  const lockPidAlive = options.lockPidAlive || ((pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  });

  async function readLockOwner(file) {
    try {
      const owner = JSON.parse(await fsp.readFile(file, 'utf8'));
      return owner && typeof owner.token === 'string' ? owner : null;
    } catch {
      return null;
    }
  }

  async function claimLockFile(lockPath, claimPath) {
    try {
      await fsp.rename(lockPath, claimPath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async function withCrossProcessLock(gitDir, fn) {
    const lockPath = `${gitDir}.lock`;
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const owner = { token: lockToken(), pid: process.pid };
    let deadline = Date.now() + lockTimeoutMs;
    let observedMtime = /** @type {number | null} */ (null);
    for (;;) {
      try {
        const handle = await fsp.open(lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify(owner));
          await handle.sync();
        } finally {
          await handle.close();
        }
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const stat = await fsp.stat(lockPath).catch(() => null);
        if (stat && stat.mtimeMs !== observedMtime) {
          observedMtime = stat.mtimeMs;
          deadline = Date.now() + lockTimeoutMs;
        }
        if (stat && Date.now() - stat.mtimeMs > lockStaleMs) {
          const existingOwner = await readLockOwner(lockPath);
          if (!existingOwner || !lockPidAlive(existingOwner.pid)) {
            const staleClaim = `${lockPath}.stale-${lockToken()}`;
            if (await claimLockFile(lockPath, staleClaim)) {
              await fsp.rm(staleClaim, { force: true }).catch(() => {});
              observedMtime = null;
              deadline = Date.now() + lockTimeoutMs;
            }
            continue;
          }
        }
        if (Date.now() > deadline) throw Object.assign(new Error(`history lock timeout: ${lockPath}`), { code: 'ELOCKTIMEOUT' });
        await new Promise((r) => setTimeout(r, lockPollMs + Math.random() * lockPollMs));
      }
    }
    const heartbeat = setInterval(async () => {
      const current = await readLockOwner(lockPath);
      if (!current || current.token !== owner.token) return;
      const now = new Date();
      await fsp.utimes(lockPath, now, now).catch(() => {});
    }, lockHeartbeatMs);
    heartbeat.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      const releaseClaim = `${lockPath}.release-${owner.token}`;
      if (await claimLockFile(lockPath, releaseClaim).catch(() => false)) {
        const releasedOwner = await readLockOwner(releaseClaim);
        if (releasedOwner && releasedOwner.token === owner.token) {
          await fsp.rm(releaseClaim, { force: true }).catch(() => {});
        } else {
          await fsp.rename(releaseClaim, lockPath).catch(() => {});
        }
      }
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
    // Lock check-and-init across processes that may both observe a missing HEAD.
    const ready = withCrossProcessLock(gitDir, async () => {
      await fsp.mkdir(gitDir, { recursive: true });
      if (!fs.existsSync(path.join(gitDir, 'HEAD'))) await initRepoAt(gitDir, driveRoot);
      return gitDir;
    });
    repoCache.set(gitDir, ready);
    return ready;
  }


  // Atomically rename a legacy repo so only one process can migrate it.
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
      let migrated = false;
      try {
        migrated = await migrateOneRepo(claimDir, entry.name);
      } catch (err) {
        console.error(`showmd: history migration of ${entry.name} failed: ${err.message}`);
      }
      if (migrated) {
        await rmRepo(claimDir);
        continue;
      }
      try {
        await fsp.rename(claimDir, legacyDir);
      } catch (err) {
        const quarantine = `${legacyDir}.unmigrated-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        let preservedAt = claimDir;
        let quarantineError = '';
        try {
          await fsp.rename(claimDir, quarantine);
          preservedAt = quarantine;
        } catch (claimErr) {
          quarantineError = `; quarantine failed: ${claimErr.message}`;
        }
        console.error(`showmd: legacy history preserved at ${preservedAt}: ${err.message}${quarantineError}`);
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
      return false;
    }
    const m = cfg.match(/^\s*worktree\s*=\s*(.+?)\s*$/m);
    if (!m) {
      console.error(`showmd: history migration skipped ${label}: no core.worktree recorded`);
      return false;
    }
    const legacyRoot = m[1];

    const allPaths = await listAllHistoricalPaths(legacyGitDir, legacyRoot);
    if (!allPaths.length) return false;

    const entries = [];
    for (const relPath of allPaths) {
      const commits = await allCommitsOldestFirst(legacyGitDir, legacyRoot, relPath);
      for (const c of commits) {
        const present = await run(legacyGitDir, legacyRoot, ['ls-tree', '-r', '--name-only', c.rev, '--', relPath], [128]);
        if (present.code !== 0) throw new Error(`cannot inspect ${c.rev}:${relPath}`);
        if (!present.stdout.split('\n').includes(relPath)) continue;
        const content = await run(legacyGitDir, legacyRoot, ['show', `${c.rev}:${relPath}`], [128]);
        if (content.code !== 0) throw new Error(`cannot read ${c.rev}:${relPath}`);
        entries.push({ ...c, relPath, content: content.stdout });
      }
    }
    entries.sort((a, b) => a.ts - b.ts);
    if (!entries.length) return false;

    const realLegacyRoot = await identityAbs(legacyRoot);
    const driveRoot = driveRootOf(realLegacyRoot);
    const newGitDir = await ensureRepo(driveRoot);
    if (!newGitDir) return false;

    await withCrossProcessLock(newGitDir, () => withGitLock(newGitDir, async () => {
      for (const entry of entries) {
        const absPath = path.join(realLegacyRoot, entry.relPath);
        const newRelPath = relKeyFor(driveRoot, absPath);
        const sep = entry.subject.indexOf(': ');
        const source = sep === -1 ? SOURCES.external : entry.subject.slice(0, sep);
        const importId = crypto.createHash('sha256').update(`${label}\0${entry.rev}\0${entry.relPath}`).digest('hex');
        const marker = `showmd-legacy-id: ${importId}`;
        const imported = await run(newGitDir, driveRoot, ['log', '--all', `--grep=${marker}`, '--format=%H', '-1'], [128]);
        if (imported.code === 0 && imported.stdout.trim()) {
          const existing = await run(newGitDir, driveRoot, ['show', `${imported.stdout.trim()}:${newRelPath}`], [128]);
          if (existing.code !== 0 || existing.stdout !== entry.content) throw new Error(`legacy verification failed for ${entry.relPath}`);
          continue;
        }
        await writeBlobInto(newGitDir, driveRoot, newRelPath, entry.content);
        await commitAt(newGitDir, driveRoot, `${source}: ${newRelPath}`, entry.ts, marker);
        const copied = await run(newGitDir, driveRoot, ['show', `HEAD:${newRelPath}`], [128]);
        if (copied.code !== 0 || copied.stdout !== entry.content) throw new Error(`legacy verification failed for ${entry.relPath}`);
      }
    }));
    return true;
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
      // Seed a baseline so the first save diffs against repository content.
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
      // Amend only when this path owns HEAD; otherwise another file's commit would fold in.
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

  // Serialize prune with commits so git never runs against a removed repo.
  const rmRepo = (dir) => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

  async function listAllTrackedPaths(gitDir, driveRoot) {
    const r = await run(gitDir, driveRoot, ['ls-tree', '-r', '--name-only', 'HEAD'], [128]);
    if (r.code !== 0 || !r.stdout) return [];
    return r.stdout.split('\n').filter(Boolean);
  }

  async function listAllHistoricalPaths(gitDir, driveRoot) {
    const r = await run(gitDir, driveRoot, ['log', '--all', '--format=', '--name-only'], [128]);
    if (r.code !== 0 || !r.stdout) return [];
    return [...new Set(r.stdout.split('\n').filter(Boolean))];
  }

  async function allCommitsOldestFirst(gitDir, driveRoot, storeRelPath) {
    const r = await run(gitDir, driveRoot, ['log', '--all', '--reverse', '--format=%H\x1f%ct\x1f%s', '--', storeRelPath], [128]);
    if (r.code !== 0) throw new Error(`cannot enumerate commits for ${storeRelPath}`);
    if (!r.stdout.trim()) return [];
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

  async function commitAt(gitDir, driveRoot, subject, ts, marker) {
    const stamp = `${ts} +0000`;
    const args = ['commit', ...(marker ? ['--allow-empty'] : []), '-m', subject, ...(marker ? ['-m', marker] : [])];
    await run(gitDir, driveRoot, args, [], { env: { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } });
  }

  // Prune a folder by rebuilding the shared repo without its full timeline,
  // then swap repositories so removed blobs are unreachable.
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

  // Sum blob sizes from `cat-file --batch-check` output.
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

  // Count unique reachable blobs under pathspec. %(rest) makes batch-check
  // ignore paths appended by rev-list instead of reporting objects missing.
  async function treeSizeFor(gitDir, driveRoot, pathspec) {
    const args = ['rev-list', '--objects', 'HEAD'];
    if (pathspec) args.push('--', pathspec);
    const rev = await run(gitDir, driveRoot, args, [128]);
    if (rev.code !== 0 || !rev.stdout.trim()) return 0;
    const batch = await run(gitDir, driveRoot, ['cat-file', '--batch-check=%(objecttype) %(objectsize) %(rest)'], [128], { input: rev.stdout });
    return sumBlobSizes(batch);
  }

  // A root's footprint is the historical blobs reachable under its pathspec.
  async function historySize(root) {
    await ensureMigrated();
    const absRoot = await identityAbs(root);
    const driveRoot = driveRootOf(absRoot);
    const gitDir = historyDirFor(driveRoot);
    if (!fs.existsSync(gitDir)) return 0;
    const prefixRel = relKeyFor(driveRoot, absRoot);
    return treeSizeFor(gitDir, driveRoot, prefixRel || null);
  }

  // Sum tracked content, not fixed git overhead. Without a path prefix,
  // --batch-all-objects avoids the rev-list pass.
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

  // Show uncommitted checkpoints above repository commits; hide checkpoints
  // absorbed by a commit or a clean revert.
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

// Keep literal exports so Node can detect CJS named exports syntactically.
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
