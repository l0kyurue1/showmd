'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isRootKey } = require('./root-identity.js');
const settings = require('./settings.js');

const HANDOFF_SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 5 * 60_000;
const MAX_ROOTS = 128;
const MAX_CONTEXTS = 128;
const MAX_PATH_LENGTH = 4096;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

function restartDir() {
  return path.join(settings.settingsDir(), 'restart');
}

function handoffError(message, code = 'INVALID_HANDOFF') {
  return Object.assign(new TypeError(message), { code });
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw handoffError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw handoffError(`${label} has unexpected fields`);
  }
}

function validateInstance(value, label) {
  const required = ['instanceId', 'pid', 'startedAt'];
  const keys = value && value.actualPort === undefined ? required : [...required, 'actualPort'];
  exactKeys(value, keys, label);
  if (typeof value.instanceId !== 'string' || value.instanceId.length < 1 || value.instanceId.length > 128) {
    throw handoffError(`${label}.instanceId is invalid`);
  }
  if (!Number.isInteger(value.pid) || value.pid < 1 || value.pid > 0x7fffffff) {
    throw handoffError(`${label}.pid is invalid`);
  }
  if (typeof value.startedAt !== 'string' || value.startedAt.length > 64 || Number.isNaN(Date.parse(value.startedAt))) {
    throw handoffError(`${label}.startedAt is invalid`);
  }
  if (value.actualPort !== undefined
    && (!Number.isInteger(value.actualPort) || value.actualPort < 1 || value.actualPort > 65535)) {
    throw handoffError(`${label}.actualPort is invalid`);
  }
}

function validateRoots(roots) {
  if (!Array.isArray(roots) || roots.length > MAX_ROOTS) throw handoffError('roots are invalid');
  const keys = new Set();
  const dirs = new Set();
  for (const root of roots) {
    exactKeys(root, ['key', 'dir', 'name'], 'root');
    if (!isRootKey(root.key) || keys.has(root.key)) throw handoffError('root key is invalid or duplicated');
    if (typeof root.dir !== 'string' || !path.isAbsolute(root.dir)
      || root.dir.length < 1 || root.dir.length > MAX_PATH_LENGTH || dirs.has(root.dir)) {
      throw handoffError('root dir is invalid or duplicated');
    }
    if (typeof root.name !== 'string' || root.name.length > 255) throw handoffError('root name is invalid');
    keys.add(root.key);
    dirs.add(root.dir);
  }
}

function validateContexts(contexts) {
  if (!Array.isArray(contexts) || contexts.length > MAX_CONTEXTS) throw handoffError('skillsContexts are invalid');
  const keys = new Set();
  for (const context of contexts) {
    exactKeys(context, ['key', 'projectDirs'], 'skills context reference');
    if (typeof context.key !== 'string' || context.key.length < 1 || context.key.length > 256 || keys.has(context.key)) {
      throw handoffError('skills context key is invalid or duplicated');
    }
    if (!Array.isArray(context.projectDirs) || !context.projectDirs.length
      || context.projectDirs.length > MAX_CONTEXTS
      || context.projectDirs.some((dir) => typeof dir !== 'string' || !path.isAbsolute(dir)
        || dir.length > MAX_PATH_LENGTH)) {
      throw handoffError('skills context projectDirs are invalid');
    }
    keys.add(context.key);
  }
}

function validateRestartSnapshot(value, { now = Date.now, allowExpired = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw handoffError('snapshot must be an object');
  if (value.schemaVersion !== HANDOFF_SCHEMA_VERSION) {
    throw handoffError('unsupported restart handoff schema', 'UNSUPPORTED_HANDOFF');
  }
  exactKeys(value, [
    'schemaVersion', 'createdAt', 'expiresAt', 'oldInstance', 'newInstance', 'roots', 'skillsContexts',
  ], 'snapshot');
  if (!Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > MAX_TTL_MS) {
    throw handoffError('snapshot lifetime is invalid');
  }
  if (!allowExpired && now() >= value.expiresAt) throw handoffError('restart handoff expired', 'EXPIRED_HANDOFF');
  validateInstance(value.oldInstance, 'oldInstance');
  validateInstance(value.newInstance, 'newInstance');
  validateRoots(value.roots);
  validateContexts(value.skillsContexts);
  return value;
}

function createRestartSnapshot(state, { now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw handoffError('ttlMs is invalid');
  }
  const createdAt = now();
  const value = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    createdAt,
    expiresAt: createdAt + ttlMs,
    oldInstance: { ...state.oldInstance },
    newInstance: { ...state.newInstance },
    roots: Array.isArray(state.roots) ? state.roots.map((root) => ({ ...root })) : state.roots,
    skillsContexts: Array.isArray(state.skillsContexts)
      ? state.skillsContexts.map((context) => ({ ...context }))
      : state.skillsContexts,
  };
  return validateRestartSnapshot(value, { now });
}

async function writeRestartHandoff(filePath, state, options = {}) {
  const fsImpl = options.fs || fsp;
  const random = options.random || randomUUID;
  const value = createRestartSnapshot(state, options);
  const tempPath = `${filePath}.tmp-${random()}`;
  await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fsImpl.writeFile(tempPath, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    await fsImpl.rename(tempPath, filePath);
  } catch (err) {
    await fsImpl.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  return value;
}

async function adoptRestartHandoff(filePath, { newInstance, adopt }, options = {}) {
  const fsImpl = options.fs || fsp;
  const now = options.now || Date.now;
  const random = options.random || randomUUID;
  const claimPath = `${filePath}.claim-${random()}`;
  try {
    await fsImpl.rename(filePath, claimPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: 'missing', fallback: 'cold_start' };
    throw err;
  }

  try {
    let value;
    try {
      const text = await fsImpl.readFile(claimPath, 'utf8');
      if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) throw handoffError('snapshot is too large');
      value = validateRestartSnapshot(JSON.parse(text), { now });
    } catch (err) {
      const kind = err.code === 'EXPIRED_HANDOFF' ? 'expired' : 'invalid';
      return { kind, fallback: 'cold_start' };
    }

    if (!newInstance || value.newInstance.instanceId !== newInstance.instanceId) {
      return { kind: 'wrong_target', fallback: 'cold_start' };
    }

    try {
      await adopt(value);
      return { kind: 'adopted', snapshot: value };
    } catch (error) {
      return { kind: 'adoption_failed', fallback: 'cold_start', error };
    }
  } finally {
    await fsImpl.rm(claimPath, { force: true }).catch(() => {});
  }
}

async function cleanupRestartHandoffs(directory, options = {}) {
  const fsImpl = options.fs || fsp;
  const now = options.now || Date.now;
  const entries = await fsImpl.readdir(directory, { withFileTypes: true }).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('restart-')) continue;
    const full = path.join(directory, entry.name);
    const transient = entry.name.includes('.tmp-') || entry.name.includes('.claim-');
    let remove = false;
    if (transient) {
      // Do not race a parent publishing or a child consuming a live handoff.
      // Transient files outliving the maximum valid TTL cannot still be useful.
      const stat = await fsImpl.stat(full).catch(() => null);
      remove = !stat || now() - stat.mtimeMs > MAX_TTL_MS;
    } else {
      try {
        const text = await fsImpl.readFile(full, 'utf8');
        if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) throw handoffError('snapshot is too large');
        validateRestartSnapshot(JSON.parse(text), { now });
      } catch {
        remove = true;
      }
    }
    if (remove) {
      await fsImpl.rm(full, { force: true });
      removed += 1;
    } else {
      kept += 1;
    }
  }
  return { removed, kept };
}

module.exports = {
  HANDOFF_SCHEMA_VERSION,
  restartDir,
  createRestartSnapshot,
  validateRestartSnapshot,
  writeRestartHandoff,
  adoptRestartHandoff,
  cleanupRestartHandoffs,
};
