import test from 'node:test';
import assert from 'node:assert/strict';

const { createRootManager } = await import('../../server/root-manager.js');
const { createSkillsContextRegistry } = await import('../../server/skills-context-registry.js');
const { createRouteResolutionDependencies } = await import('../../server/route-resources.js');
const { resolveRouteResources } = await import('../../server/route-resolution.js');

const root = { key: `r_${'a'.repeat(22)}`, dir: '/canonical/project', name: 'project' };

function rootManager() {
  return createRootManager({
    identifyRoot: async () => root,
    createRuntime: (value) => ({ value, root: value, store: {}, async close() {} }),
  });
}

test('live route dependencies follow Root Manager add and remove lifecycle', async () => {
  const roots = rootManager();
  const contexts = createSkillsContextRegistry();
  const deps = createRouteResolutionDependencies({ rootManager: roots, skillsContextRegistry: contexts });
  const route = { space: 'root', rootKey: root.key };

  assert.deepEqual(resolveRouteResources(route, deps), { kind: 'root_not_open', rootKey: root.key });
  await roots.add(root.dir);
  assert.deepEqual(resolveRouteResources(route, deps), {
    kind: 'resolved', context: route, resources: { root: roots.get(root.key) },
  });
  await roots.remove(root.key);
  assert.deepEqual(resolveRouteResources(route, deps), { kind: 'root_not_open', rootKey: root.key });
});

test('live route dependencies distinguish registered and expired SkillsContexts', () => {
  const contexts = createSkillsContextRegistry();
  const deps = createRouteResolutionDependencies({ rootManager: rootManager(), skillsContextRegistry: contexts });
  const reference = Object.freeze({ key: 'ctx_live' });
  const route = { space: 'skills', selection: 'context', contextKey: reference.key };

  contexts.register(reference);
  assert.deepEqual(resolveRouteResources(route, deps), {
    kind: 'resolved', context: route, resources: { skillsContext: reference },
  });
  assert.equal(contexts.register(reference), reference, 'exact registration is idempotent');
  assert.equal(contexts.remove(reference.key), true);
  assert.deepEqual(resolveRouteResources(route, deps), {
    kind: 'context_expired', contextKey: reference.key,
  });
});

test('live route dependencies use the supported Agent registry and forward canonicalization', () => {
  const canonicalCalls = [];
  const deps = createRouteResolutionDependencies({
    rootManager: rootManager(),
    skillsContextRegistry: createSkillsContextRegistry(),
    canonicalLocation(context, resources) {
      canonicalCalls.push({ context, resources });
      return '/agents/claude/';
    },
  });
  const route = { space: 'agents', agentKey: 'claude' };

  assert.deepEqual(resolveRouteResources(route, deps), {
    kind: 'canonical_redirect', location: '/agents/claude/', context: route,
  });
  assert.deepEqual(canonicalCalls, [{ context: route, resources: { agent: { key: 'claude' } } }]);
  assert.deepEqual(
    resolveRouteResources({ space: 'agents', agentKey: 'not-supported' }, deps),
    { kind: 'unknown_agent', agentKey: 'not-supported' },
  );
});

test('SkillsContext registry rejects key collisions instead of replacing a live identity', () => {
  const contexts = createSkillsContextRegistry([{ key: 'ctx_same', source: 'first' }]);
  assert.throws(
    () => contexts.register({ key: 'ctx_same', source: 'second' }),
    (err) => err.code === 'SKILLS_CONTEXT_KEY_COLLISION',
  );
  assert.deepEqual(contexts.list(), [{ key: 'ctx_same', source: 'first' }]);
});
