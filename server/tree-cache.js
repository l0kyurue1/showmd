'use strict';
const { createDocumentStore } = require('./documents.js');

// One-tree TTL cache for rare external edits in Skills and agent config.
function createTreeCache() {
  /** @type {{ key: string, tree: any, store: any, builtAt: number } | null} */
  let cache = null;

  /**
   * @param {string} key
   * @param {() => { tree: any, roots: any } | Promise<{ tree: any, roots: any }>} build
   * @param {import('../types/showmd').TreeCacheOptions} [opts]
   */
  async function getTree(key, build, { ttlMs = 30000, now = Date.now } = {}) {
    const ts = now();
    if (!cache || cache.key !== key || ts - cache.builtAt >= ttlMs) {
      const { tree, roots } = await build();
      cache = {
        key,
        tree,
        store: roots ? createDocumentStore(roots, { addressing: 'keyed' }) : null,
        builtAt: ts,
      };
    }
    return { tree: cache.tree, store: cache.store };
  }

  function invalidate() {
    cache = null;
  }

  return { getTree, invalidate };
}

module.exports = { createTreeCache };
