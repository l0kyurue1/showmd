'use strict';
const { isDeepStrictEqual } = require('node:util');

function validateReference(reference) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)
    || typeof reference.key !== 'string' || reference.key.length < 1 || reference.key.length > 256) {
    throw new TypeError('SkillsContext reference must have a non-empty key');
  }
}

// Identity-only registry seam: each opaque value can later carry its immutable
// source set without changing route resource lookup.
function createSkillsContextRegistry(initial = []) {
  const contexts = new Map();

  function register(reference) {
    validateReference(reference);
    const existing = contexts.get(reference.key);
    if (existing) {
      if (existing === reference || isDeepStrictEqual(existing, reference)) return existing;
      const err = new Error(`SkillsContext key collision: ${reference.key}`);
      err.code = 'SKILLS_CONTEXT_KEY_COLLISION';
      err.key = reference.key;
      throw err;
    }
    contexts.set(reference.key, reference);
    return reference;
  }

  function get(key) {
    return contexts.get(key) || null;
  }

  function remove(key) {
    return contexts.delete(key);
  }

  function list() {
    return [...contexts.values()];
  }

  for (const reference of initial) register(reference);
  return { register, get, remove, list };
}

module.exports = { createSkillsContextRegistry };
