'use strict';
const path = require('node:path');
const { identifyRoot, rootRelation } = require('./root-identity.js');
const { createRootRuntime } = require('./root-runtime.js');

function scopeFor(root, target) {
  const relative = path.relative(root.dir, target.dir);
  return {
    rootKey: root.key,
    scopePath: relative === '' ? '' : relative.split(path.sep).join('/'),
  };
}

function collisionError(existing, target) {
  const err = new Error(`root key collision for ${target.key}: ${existing.dir} and ${target.dir}`);
  err.code = 'ROOT_KEY_COLLISION';
  err.key = target.key;
  err.existingDir = existing.dir;
  err.targetDir = target.dir;
  return err;
}

/**
 * Own canonical Root registration and serialize lifecycle mutations. Reads stay
 * synchronous; a closing runtime remains visible until its shutdown resolves.
 */
function createRootManager(options = {}) {
  const identify = options.identifyRoot || identifyRoot;
  const makeRuntime = options.createRuntime || createRootRuntime;
  const runtimes = new Map();
  let mutation = Promise.resolve();

  function serialize(fn) {
    const run = mutation.then(fn, fn);
    mutation = run.catch(() => {});
    return run;
  }

  function list() {
    return [...runtimes.values()].map((runtime) => runtime.root);
  }

  function get(key) {
    return runtimes.get(key)?.root || null;
  }

  function getRuntime(key) {
    return runtimes.get(key) || null;
  }

  function add(dir) {
    return serialize(async () => {
      const identified = await identify(dir);
      const target = Object.freeze({ ...identified });
      const existingRuntimes = [...runtimes.values()];

      // Canonical-directory equality is authoritative. The key comparison is a
      // separate guard rather than an assumption that hashes cannot collide.
      const exact = existingRuntimes.find((runtime) => rootRelation(runtime.root, target) === 'same');
      if (exact) {
        return { kind: 'existing', root: exact.root, scope: scopeFor(exact.root, target) };
      }

      const sameKey = runtimes.get(target.key);
      if (sameKey) throw collisionError(sameKey.root, target);

      const ancestor = existingRuntimes.find((runtime) => rootRelation(runtime.root, target) === 'ancestor');
      if (ancestor) {
        return { kind: 'existing', root: ancestor.root, scope: scopeFor(ancestor.root, target) };
      }

      const conflicting = existingRuntimes
        .filter((runtime) => rootRelation(runtime.root, target) === 'descendant');
      if (conflicting.length) {
        const promoted = conflicting.map((runtime) => ({
          oldRoot: runtime.root,
          scope: scopeFor(target, runtime.root),
        }));
        await Promise.all(conflicting.map((runtime) => runtime.close()));
        for (const runtime of conflicting) {
          if (runtimes.get(runtime.root.key) === runtime) runtimes.delete(runtime.root.key);
        }
        const runtime = makeRuntime(target);
        runtimes.set(target.key, runtime);
        return { kind: 'promoted', root: target, scope: scopeFor(target, target), promoted };
      }

      const runtime = makeRuntime(target);
      runtimes.set(target.key, runtime);
      return { kind: 'added', root: target, scope: scopeFor(target, target) };
    });
  }

  function remove(key) {
    return serialize(async () => {
      const runtime = runtimes.get(key);
      if (!runtime) return { removed: false };
      await runtime.close();
      if (runtimes.get(key) === runtime) runtimes.delete(key);
      return { removed: true, root: runtime.root };
    });
  }

  return { add, list, get, getRoot: get, getRuntime, remove };
}

module.exports = { createRootManager };
