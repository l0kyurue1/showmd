'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const proc = require('./proc.js');

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
  try {
    const { stdout } = await execFileAsync('git', [...prefixArgs, ...args], { env: gitEnv(), maxBuffer: 64 * 1024 * 1024, ...opts });
    return { code: 0, stdout };
  } catch (err) {
    if (typeof err.code === 'number' && allowCodes.includes(err.code)) {
      return { code: err.code, stdout: err.stdout || '' };
    }
    throw err;
  }
}

// the history repos live outside every served directory; SHOWMD_HISTORY_HOME
// moves them, which is how tests get a real git repo without touching the
// developer's own home
function historyHome() {
  return process.env.SHOWMD_HISTORY_HOME || path.join(os.homedir(), '.local', 'share', 'showmd', 'history');
}

function historyDirFor(root) {
  const hash = crypto.createHash('sha1').update(root).digest('hex');
  return path.join(historyHome(), hash);
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

function historySize(root) {
  return dirSize(historyDirFor(root));
}

// gitExec is the seam: production leaves it defaulted to the real git binary
// below, tests pass a scripted adapter instead so everything in here — the
// amend-window decision, the fromRepo branch, prune — runs against canned
// git output instead of a real repo
function createHistory(gitExec = realGitExec) {
  function run(gitDir, workTree, args, allowCodes = []) {
    return gitExec(['--git-dir', gitDir, '--work-tree', workTree], args, allowCodes, { cwd: workTree });
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

  async function ensureRepo(root) {
    if (!(await checkGitAvailable())) return null;
    const gitDir = historyDirFor(root);
    if (repoCache.has(gitDir)) return repoCache.get(gitDir);
    const ready = (async () => {
      await fsp.mkdir(gitDir, { recursive: true });
      if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
        await run(gitDir, root, ['init', '-q']);
        await run(gitDir, root, ['config', 'user.name', 'showmd']);
        await run(gitDir, root, ['config', 'user.email', 'showmd@local']);
      }
      return gitDir;
    })();
    repoCache.set(gitDir, ready);
    return ready;
  }

  async function getLastCommit(gitDir, root, relPath) {
    const r = await run(gitDir, root, ['log', '-1', '--format=%H\x1f%s\x1f%ct', '--', relPath], [128]);
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const [rev, subject, ts] = r.stdout.trim().split('\x1f');
    return { rev, subject, ts: Number(ts) };
  }

  async function commit(root, relPath, source) {
    const gitDir = await ensureRepo(root);
    if (!gitDir) return;
    return withGitLock(gitDir, async () => {
      // first save of a file: seed an invisible baseline commit with the repo's
      // HEAD content, so save deltas read against the last real commit instead
      // of showing the whole file as added
      if (!(await getLastCommit(gitDir, root, relPath))) {
        const base = await repoReadAt(root, relPath, 'HEAD');
        if (base != null) {
          const tmp = path.join(os.tmpdir(), `showmd-baseline-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
          await fsp.writeFile(tmp, base);
          const blob = await run(gitDir, root, ['hash-object', '-w', '--', tmp]).finally(() => fsp.rm(tmp, { force: true }));
          await run(gitDir, root, ['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},${relPath}`]);
          const seeded = await run(gitDir, root, ['diff', '--cached', '--quiet', '--', relPath], [1]);
          if (seeded.code !== 0) await run(gitDir, root, ['commit', '-m', `${SOURCES.baseline}: ${relPath}`]);
        }
      }
      await run(gitDir, root, ['add', '-f', '--', relPath]);
      const staged = await run(gitDir, root, ['diff', '--cached', '--quiet', '--', relPath], [1]);
      if (staged.code === 0) return;
      const subject = `${source}: ${relPath}`;
      const last = await getLastCommit(gitDir, root, relPath);
      // `commit --amend` always targets HEAD, so amending is only safe when this
      // path's own last commit IS HEAD — otherwise HEAD belongs to some other
      // path's commit and amending would fold this change into it
      const head = last ? await run(gitDir, root, ['rev-parse', 'HEAD'], [128]) : null;
      const amend = !!last && last.subject === subject && head?.code === 0 && head.stdout.trim() === last.rev
        && Date.now() - last.ts * 1000 < AMEND_WINDOW_MS;
      await run(gitDir, root, amend ? ['commit', '--amend', '--no-edit'] : ['commit', '-m', subject]);
    });
  }

  async function list(root, relPath) {
    const gitDir = await ensureRepo(root);
    if (!gitDir) return null;
    const r = await run(gitDir, root, [...LOG_ARGS, relPath], [128]);
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

  function prune(root) {
    const dir = historyDirFor(root);
    return withGitLock(dir, async () => {
      await rmRepo(dir);
      repoCache.delete(dir);
      return dir;
    });
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

  async function diff(root, relPath, rev) {
    const gitDir = await ensureRepo(root);
    if (!gitDir) return null;
    const r = await run(gitDir, root, ['show', rev, '--format=', '--', relPath], [128]);
    return r.code === 0 ? r.stdout : null;
  }

  async function readAt(root, relPath, rev) {
    const gitDir = await ensureRepo(root);
    if (!gitDir) return null;
    const r = await run(gitDir, root, ['show', `${rev}:${relPath}`], [128]);
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
  };
}

// module.exports must be a literal object of plain identifiers (not the
// direct call result) — Node's CJS→ESM named-export detection is purely
// syntactic and can't see through a function call
const { checkGitAvailable, record, timeline, contentAt, diffAt, prune, pruneAll } = createHistory();

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
};
