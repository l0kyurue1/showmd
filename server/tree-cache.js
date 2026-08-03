'use strict';
const { createDocumentStore } = require('./documents.js');

// single-slot TTL cache for a tree built over a Document Store: skills.js and
// agent-config.js each show one tree (for one root/agent) at a time, so a TTL
// beats real invalidation logic for the rare case of an external edit mid-session.
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
      cache = { key, tree, store: roots ? createDocumentStore(roots, true) : null, builtAt: ts };
    }
    return { tree: cache.tree, store: cache.store };
  }

  function invalidate() {
    cache = null;
  }

  return { getTree, invalidate };
}

module.exports = { createTreeCache };
