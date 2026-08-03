'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
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

async function writeFileAtomic(full, buffer) {
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, full);
}

const FORBIDDEN = { ok: false, code: 'forbidden' };
const NOT_FOUND = { ok: false, code: 'not_found' };

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

// Every operation takes a document id — `relPath`, or `key/relPath` in
// multi-root mode. Resolving one refuses to leave its root; callers never see
// a filesystem path.
function createDocumentStore(initialRoots, multi, historyImpl = history) {
  let roots = initialRoots;
  const selfWrites = new Set();

  /**
   * @param {string} id
   * @param {import('../types/showmd').LocateOptions} [opts]
   */
  function locate(id, { anyExt } = {}) {
    if (!anyExt && !isMarkdownFile(id)) return null;
    let dir, rel;
    if (!multi) {
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

  async function commitQuietly(loc, source) {
    try {
      await historyImpl.record(loc.dir, loc.rel, source);
    } catch (err) {
      console.error(`showmd: history commit failed: ${err.message}`);
    }
  }

  async function writeAt(id, loc, buffer, source) {
    try {
      selfWrites.add(id);
      await writeFileAtomic(loc.full, buffer);
    } catch {
      selfWrites.delete(id);
      return { ok: false, code: 'write_failed' };
    }
    await commitQuietly(loc, source);
    return { ok: true };
  }

  async function withHistory(id, fn) {
    const loc = locate(id);
    if (!loc) return FORBIDDEN;
    if (!(await historyImpl.checkGitAvailable())) return { ok: false, code: 'unavailable' };
    return fn(loc);
  }

  return {
    walkMd,

    // the whole tree decision: which view, rooted or not, one root or many.
    // Outcomes are `{ ok, code }` like every other store operation, so the route
    // only picks a status for them.
    /**
     * @param {string} view
     * @param {import('../types/showmd').StoreTreeOptions} [opts]
     */
    async tree(view, { agent = 'claude', skillsMode, home = os.homedir(), cwd = process.cwd() } = {}) {
      // required here, not at module scope: skills.js and agent-config.js both
      // require this module, and a top-level cycle would hand them an empty one
      const skills = require('./skills.js');
      const agentConfig = require('./agent-config.js');
      const rootDir = roots.length ? roots[0].dir : null;

      if (view === 'agents') {
        const { tree } = await agentConfig.getAgentTree(agent, { cwd: rootDir || cwd });
        return tree ? { ok: true, tree } : { ok: false, code: 'unknown_agent' };
      }
      if (multi) {
        return { ok: true, tree: await skills.buildSkillsTree(roots, { walkMd, home, cwd, mode: skillsMode }) };
      }
      if (view === 'skills') {
        if (!rootDir) {
          const skillRoots = skills.discoverSkillRoots({ mode: 'global' });
          return { ok: true, tree: await skills.buildSkillsTree(skillRoots, { walkMd, home, cwd }) };
        }
        return { ok: true, tree: (await skills.getTree(rootDir)).tree };
      }
      if (!rootDir) return { ok: false, code: 'no_root' };
      try {
        return { ok: true, tree: await walkFiles(rootDir, rootDir, [], { filter: isMarkdownFile, strictRoot: true }) };
      } catch (err) {
        return { ok: false, code: 'unreadable_root', dir: rootDir, errno: err.code };
      }
    },

    ignorePath(dir, filePath) {
      const rel = path.relative(dir, filePath);
      if (rel === '') return false;
      return rel.split(path.sep).some((seg) => seg.startsWith('.') || seg === 'node_modules');
    },

    idFor(root, filePath) {
      const rel = relPosix(root.dir, filePath);
      return multi ? `${root.key}/${rel}` : rel;
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

    // resolution counterpart to tree(): raw/asset/history/diff/restore routes
    // go through this to find which store actually owns an id, trying the
    // main store first, then a skills/agent-config store built lazily, same
    // as tree() builds them for those views
    async storeFor(id, { cwd = process.cwd() } = {}) {
      const skills = require('./skills.js');
      const agentConfig = require('./agent-config.js');
      async function agentStoreFor() {
        const agentKey = agentConfig.agentKeyForId(id);
        if (!agentKey) return null;
        const { store } = await agentConfig.getAgentTree(agentKey, { cwd });
        return store;
      }
      if (multi) return this;
      if (!roots.length) {
        const skillsStore = createDocumentStore(skills.discoverSkillRoots({ mode: 'global' }), true);
        if (await skillsStore.assetExists(id)) return skillsStore;
        const agentStore = await agentStoreFor();
        if (agentStore && (await agentStore.assetExists(id))) return agentStore;
        return null;
      }
      if (await this.assetExists(id)) return this;
      const { store: skillsStore } = await skills.getTree(roots[0].dir);
      if (skillsStore && (await skillsStore.assetExists(id))) return skillsStore;
      const agentStore = await agentStoreFor();
      if (agentStore && (await agentStore.assetExists(id))) return agentStore;
      return this;
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
        return multi ? `${root.key}/${rel}` : rel;
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

    async write(id, buffer) {
      const loc = locate(id);
      if (!loc) return FORBIDDEN;
      return writeAt(id, loc, buffer, history.SOURCES.user);
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
      if (!isValidRev(rev)) return Promise.resolve({ ok: false, code: 'invalid_rev' });
      return withHistory(id, async (loc) => {
        const content = await historyImpl.contentAt(loc.dir, loc.rel, rev, fromRepo);
        if (content == null) return NOT_FOUND;
        return writeAt(id, loc, Buffer.from(content, 'utf8'), history.SOURCES.restore);
      });
    },

    // the watcher fires for our own writes too; a claimed id is ours, anything
    // else came from outside and earns a History entry
    consumeSelfWrite(id) {
      return selfWrites.delete(id);
    },

    recordExternalChange(id) {
      const loc = locate(id);
      return loc ? commitQuietly(loc, history.SOURCES.external) : Promise.resolve();
    },

    setRoots(newRoots) {
      roots = newRoots;
    },
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
