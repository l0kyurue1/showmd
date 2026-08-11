'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const history = require('./history.js');

// trust boundary: every filesystem path built from a request must resolve
// inside `base` before we touch disk. Exported because asset serving needs the
// same guard against a different base.
function safeResolve(base, requested) {
  const resolved = path.resolve(base, requested);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

// trust boundary: rev flows straight into a git argv slot; only a bare hex
// object id may pass, closing off flag/shell injection via rev
function isValidRev(rev) {
  return /^[0-9a-f]{4,40}$/.test(rev);
}

// windows refuses the rename while anything else holds the target open — the
// watcher, an indexer, a virus scanner — and the holder is gone within a tick
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function writeFileAtomic(full, buffer) {
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, buffer);
  try {
    await fsp.rename(tmp, full);
  } catch (err) {
    if (!RENAME_RETRY_CODES.has(err.code)) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    await new Promise((r) => setTimeout(r, 50));
    try {
      await fsp.rename(tmp, full);
    } catch (retryErr) {
      await fsp.rm(tmp, { force: true });
      throw retryErr;
    }
  }
}

// a self-write mark whose watcher event never arrived must not swallow an
// unrelated edit minutes later
const SELF_WRITE_TTL_MS = 5000;
const SELF_WRITE_KEEP = 8;

const digest = (buffer) => createHash('sha1').update(buffer).digest('hex');

const FORBIDDEN = { ok: false, code: 'forbidden' };
const NOT_FOUND = { ok: false, code: 'not_found' };
const CLOSED = { ok: false, code: 'closed' };

const MAX_WALK_DEPTH = 40;

// document ids are always slash-separated, whatever the platform's separator is
function relPosix(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function isMarkdownFile(nameOrId) {
  return /\.(?:md|markdown)$/i.test(nameOrId);
}

// a dir deleted mid-walk (or unreadable) yields fewer files rather than
// failing the whole traversal — the tree is rebuilt on the next watch event
async function readDirSafe(dir) {
  return fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
}

// skill directories are frequently symlinks (e.g. `~/.claude/skills/*` links
// into a shared store); fs.Dirent reports a symlink's own type, not its
// target's, so isDirectory() would silently skip them without this extra stat
async function isDirEntry(full, entry) {
  if (!entry.isSymbolicLink()) return entry.isDirectory();
  const st = await fsp.stat(full).catch(() => null);
  return !!st && st.isDirectory();
}

// sync counterpart for callers outside the async walk (skills.js's project/
// global root discovery runs synchronously)
function isDirSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function walkFiles(dir, root, out, opts = {}, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return out; // depth cap guards against symlink cycles; real cycle detection if this ever bites
  // strictRoot lets the root's own readdir error escape while subdirectories stay
  // swallowed: one bad subfolder must not sink a tree, but a denied root reaching
  // the caller as "empty" is indistinguishable from a bug
  const entries = depth === 0 && opts.strictRoot
    ? await fsp.readdir(dir, { withFileTypes: true })
    : await readDirSafe(dir);
  for (const entry of entries) {
    if (!opts.includeHidden && (entry.name.startsWith('.') || entry.name === 'node_modules')) continue;
    const full = path.join(dir, entry.name);
    if (await isDirEntry(full, entry)) {
      await walkFiles(full, root, out, opts, depth + 1);
      continue;
    }
    const isFileEntry = entry.isSymbolicLink()
      ? !!(await fsp.stat(full).catch(() => null))?.isFile()
      : entry.isFile();
    if (isFileEntry && (!opts.filter || opts.filter(entry.name))) out.push(relPosix(root, full));
  }
  return out;
}

const walkMd = (dir, root, out) => walkFiles(dir, root, out, { filter: isMarkdownFile });

// Every operation takes a document id. Addressing determines whether that id
// is `relPath` or `key/relPath`. Resolution never leaves a construction-time
// root snapshot, and callers never see a filesystem path.
/**
 * @param {import('../types/showmd').DocumentRoot[]} initialRoots
 * @param {import('../types/showmd').DocumentStoreConfig} config
 */
function createDocumentStore(initialRoots, { addressing }, historyImpl = history) {
  const roots = initialRoots.map((root) => ({ ...root }));
  const keyed = addressing === 'keyed';
  // one hash per document is not enough: back-to-back saves each stamp their
  // own, and a watcher event for the earlier one can arrive after the later one
  // stamped, which would read our own content as somebody else's
  const selfWrites = new Map();
  function freshMarks(id) {
    const marks = (selfWrites.get(id) || []).filter((m) => Date.now() - m.at <= SELF_WRITE_TTL_MS);
    if (marks.length) selfWrites.set(id, marks);
    else selfWrites.delete(id);
    return marks;
  }

  // two PUTs to one document otherwise rename onto the same target at the same
  // moment, which windows fails outright
  const writeLocks = new Map();
  function withWriteLock(id, fn) {
    const tail = writeLocks.get(id) || Promise.resolve();
    const run = tail.then(fn, fn);
    const settled = run.catch(() => {});
    writeLocks.set(id, settled);
    settled.then(() => {
      if (writeLocks.get(id) === settled) writeLocks.delete(id);
    });
    return run;
  }

  // Runtime shutdown closes admission before stopping its watcher, then waits
  // here without reaching into the per-document lock implementation. Tracking
  // the public operation (rather than only its lock tail) also covers restore's
  // history lookup before it reaches writeAt().
  let acceptingWrites = true;
  const acceptedWrites = new Set();
  function admitWrite(fn) {
    if (!acceptingWrites) return Promise.resolve(CLOSED);
    const run = Promise.resolve().then(fn);
    const settled = run.catch(() => {});
    acceptedWrites.add(settled);
    settled.then(() => acceptedWrites.delete(settled));
    return run;
  }

  function beginClose() {
    acceptingWrites = false;
  }

  async function drain() {
    while (acceptedWrites.size) await Promise.all(acceptedWrites);
  }

  /**
   * @param {string} id
   * @param {import('../types/showmd').LocateOptions} [opts]
   */
  function locate(id, { anyExt } = {}) {
    if (!anyExt && !isMarkdownFile(id)) return null;
    let dir, rel;
    if (!keyed) {
      if (!roots.length) return null;
      dir = roots[0].dir;
      rel = id;
    } else {
      const slash = id.indexOf('/');
      if (slash === -1) return null;
      const group = roots.find((entry) => entry.key === id.slice(0, slash));
      if (!group) return null;
      dir = group.dir;
      rel = id.slice(slash + 1);
    }
    const full = safeResolve(dir, rel);
    return full && { dir, rel, full };
  }

  // the watcher fires for our own writes too. Event counting cannot tell the
  // two apart: macOS coalesces our write and an outside edit that lands right
  // after it into one event, and a lone save can raise two. What holds is the
  // content — if the file still reads back something we wrote, the event was
  // ours; anything else came from outside and earns a History entry.
  async function isSelfWrite(id) {
    const marks = freshMarks(id);
    if (!marks.length) return false;
    const loc = locate(id);
    if (!loc) return false;
    const current = await fsp.readFile(loc.full).catch(() => null);
    if (current == null) return false;
    const hash = digest(current);
    return marks.some((m) => m.hash === hash);
  }

  async function commitQuietly(loc, source) {
    try {
      await historyImpl.record(loc.dir, loc.rel, source);
    } catch (err) {
      console.error(`showmd: history commit failed: ${err.message}`);
    }
  }

  function writeAt(id, loc, buffer, source) {
    return withWriteLock(id, async () => {
      const mark = { hash: digest(buffer), at: Date.now() };
      selfWrites.set(id, [...freshMarks(id), mark].slice(-SELF_WRITE_KEEP));
      try {
        await writeFileAtomic(loc.full, buffer);
      } catch {
        return { ok: false, code: 'write_failed' };
      }
      await commitQuietly(loc, source);
      return { ok: true };
    });
  }

  async function withHistory(id, fn) {
    const loc = locate(id);
    if (!loc) return FORBIDDEN;
    if (!(await historyImpl.checkGitAvailable())) return { ok: false, code: 'unavailable' };
    return fn(loc);
  }

  return {
    walkMd,

    /** @param {{ scope?: string }} [opts] */
    async tree({ scope } = {}) {
      const rootDir = roots.length ? roots[0].dir : null;
      if (!rootDir) return { ok: false, code: 'no_root' };
      if (scope) {
        const full = safeResolve(rootDir, scope);
        if (!full) return FORBIDDEN;
        const st = await fsp.stat(full).catch(() => null);
        if (!st || !st.isDirectory()) return NOT_FOUND;
        try {
          return { ok: true, tree: await walkFiles(full, rootDir, [], { filter: isMarkdownFile, strictRoot: true }) };
        } catch (err) {
          return { ok: false, code: 'unreadable_root', dir: full, errno: err.code };
        }
      }
      const files = [];
      for (const root of roots) {
        try {
          const rootFiles = await walkFiles(root.dir, root.dir, [], { filter: isMarkdownFile, strictRoot: true });
          files.push(...rootFiles.map((rel) => keyed ? `${root.key}/${rel}` : rel));
        } catch (err) {
          return { ok: false, code: 'unreadable_root', dir: root.dir, errno: err.code };
        }
      }
      return { ok: true, tree: files };
    },

    ignorePath(dir, filePath) {
      const rel = path.relative(dir, filePath);
      if (rel === '') return false;
      return rel.split(path.sep).some((seg) => seg.startsWith('.') || seg === 'node_modules');
    },

    idFor(root, filePath) {
      const rel = relPosix(root.dir, filePath);
      return keyed ? `${root.key}/${rel}` : rel;
    },

    async read(id) {
      const loc = locate(id);
      if (!loc) return FORBIDDEN;
      try {
        return { ok: true, text: await fsp.readFile(loc.full, 'utf8'), full: loc.full };
      } catch {
        return NOT_FOUND;
      }
    },

    // asset ids share the doc id's root/group resolution but skip the .md gate
    resolveAsset(id) {
      return locate(id, { anyExt: true });
    },

    async assetExists(id) {
      const loc = locate(id, { anyExt: true });
      if (!loc) return false;
      return fsp.access(loc.full).then(() => true, () => false);
    },

    // reverse of locate(): a real fs path -> its doc id, if a served root contains it.
    // root.dir itself may sit behind a symlink (e.g. macOS /var -> /private/var), so
    // it's realpath'd too before the containment check.
    async docIdForPath(full) {
      if (!isMarkdownFile(full)) return null;
      for (const root of roots) {
        const realRoot = await fsp.realpath(root.dir).catch(() => root.dir);
        const rel = relPosix(realRoot, full);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        return keyed ? `${root.key}/${rel}` : rel;
      }
      return null;
    },

    async symlinkInfo(full) {
      const st = await fsp.lstat(full).catch(() => null);
      if (!st || !st.isSymbolicLink()) return null;
      const target = await fsp.readlink(full).catch(() => full);
      const real = await fsp.realpath(full).catch(() => null);
      const docId = real ? await this.docIdForPath(real) : null;
      return { isSymlink: true, target, real, docId };
    },

    write(id, buffer) {
      return admitWrite(() => {
        const loc = locate(id);
        if (!loc) return FORBIDDEN;
        return writeAt(id, loc, buffer, history.SOURCES.user);
      });
    },

    async reveal(id) {
      const loc = locate(id);
      if (!loc) return FORBIDDEN;
      try {
        await fsp.access(loc.full);
      } catch {
        return NOT_FOUND;
      }
      return { ok: true, full: loc.full };
    },

    timeline(id) {
      return withHistory(id, async (loc) => ({ ok: true, entries: await historyImpl.timeline(loc.dir, loc.rel) }));
    },

    diff(id, rev, fromRepo) {
      if (!isValidRev(rev)) return Promise.resolve({ ok: false, code: 'invalid_rev' });
      return withHistory(id, async (loc) => {
        const text = await historyImpl.diffAt(loc.dir, loc.rel, rev, fromRepo);
        return text == null ? NOT_FOUND : { ok: true, text };
      });
    },

    restore(id, rev, fromRepo) {
      return admitWrite(() => {
        if (!isValidRev(rev)) return { ok: false, code: 'invalid_rev' };
        return withHistory(id, async (loc) => {
          const content = await historyImpl.contentAt(loc.dir, loc.rel, rev, fromRepo);
          if (content == null) return NOT_FOUND;
          return writeAt(id, loc, Buffer.from(content, 'utf8'), history.SOURCES.restore);
        });
      });
    },

    consumeSelfWrite: isSelfWrite,

    // classifying and committing must happen as one step, under the same lock a
    // write takes: otherwise a save landing in between is committed here as
    // somebody else's edit, and the save's own commit then finds nothing staged
    recordIfExternal(id) {
      return admitWrite(() => {
        const loc = locate(id);
        if (!loc) return;
        return withWriteLock(id, async () => {
          if (await isSelfWrite(id)) return;
          await commitQuietly(loc, history.SOURCES.external);
        });
      });
    },

    beginClose,
    drain,
  };
}

async function classifyRootTarget(pickedPath) {
  const resolved = path.resolve(pickedPath);
  const st = await fsp.stat(resolved).catch(() => null);
  if (st && st.isFile()) {
    if (!isMarkdownFile(resolved)) return null;
    return { dir: path.dirname(resolved), doc: path.basename(resolved) };
  }
  if (st && st.isDirectory()) return { dir: resolved, doc: null };
  return null;
}

module.exports = {
  createDocumentStore, safeResolve, walkMd, walkFiles, relPosix, isMarkdownFile, classifyRootTarget,
  readDirSafe, isDirEntry, isDirSync,
};
