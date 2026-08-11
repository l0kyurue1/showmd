'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT_KEY_PATTERN = /^r_[A-Za-z0-9_-]{22}$/;

function isRootKey(value) {
  return typeof value === 'string' && ROOT_KEY_PATTERN.test(value);
}

// Keep byte-distinct Linux names distinct. Darwin filesystems normalize Unicode
// spellings, while Windows identity is additionally case-insensitive.
function identityPath(dir) {
  if (process.platform === 'linux') return dir;
  const normalized = dir.normalize('NFC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// 128 bits keeps URLs short while leaving collisions impractical. A future
// Root Manager must still compare canonical dirs and reject a key collision.
function keyFor(dir) {
  const digest = createHash('sha256').update(identityPath(dir)).digest().subarray(0, 16);
  return `r_${digest.toString('base64url')}`;
}

/**
 * @param {string} dir
 * @returns {Promise<import('../types/showmd').Root>}
 */
async function identifyRoot(dir) {
  const canonicalDir = await fsp.realpath(path.resolve(dir));
  const stat = await fsp.stat(canonicalDir);
  if (!stat.isDirectory()) {
    throw Object.assign(new Error(`not a directory: ${dir}`), { code: 'ENOTDIR' });
  }
  return {
    key: keyFor(canonicalDir),
    dir: canonicalDir,
    name: path.basename(canonicalDir),
  };
}

/**
 * @param {import('../types/showmd').Root} a
 * @param {import('../types/showmd').Root} b
 * @returns {import('../types/showmd').RootRelation}
 */
function rootRelation(a, b) {
  const aDir = identityPath(a.dir);
  const bDir = identityPath(b.dir);
  const fromA = path.relative(aDir, bDir);
  if (fromA === '') return 'same';
  if (!fromA.startsWith('..') && !path.isAbsolute(fromA)) return 'ancestor';
  const fromB = path.relative(bDir, aDir);
  if (!fromB.startsWith('..') && !path.isAbsolute(fromB)) return 'descendant';
  return 'disjoint';
}

module.exports = { identifyRoot, isRootKey, rootRelation, identityPath };
