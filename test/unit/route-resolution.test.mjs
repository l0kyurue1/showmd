import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mapRouteResolutionToHttp, resolveRouteResources } = require('../../server/route-resolution.js');

const rootKey = 'r_0123456789abcdefghij_A';
const otherRootKey = 'r_ABCDEFGHIJ-klmnopqrstu';

function dependencies({ roots = [], contexts = [], agents = [], canonicalLocation } = {}) {
  return {
    getRoot: (key) => roots.find((root) => root.key === key) || null,
    getSkillsContext: (key) => contexts.find((context) => context.key === key) || null,
    getAgent: (key) => agents.find((agent) => agent.key === key) || null,
    canonicalLocation,
  };
}

test('resource-free spaces resolve without consulting registries', () => {
  const fail = () => { throw new Error('registry should not be consulted'); };
  const result = resolveRouteResources(
    { space: 'skills', selection: 'global' },
    { getRoot: fail, getSkillsContext: fail, getAgent: fail },
  );

  assert.deepEqual(result, {
    kind: 'resolved',
    context: { space: 'skills', selection: 'global' },
    resources: {},
  });
});

test('root-bearing spaces resolve the exact registered root', () => {
  const root = { key: rootKey, dir: '/tmp/project', name: 'project' };
  const deps = dependencies({ roots: [root] });
  const contexts = [
    { space: 'root', rootKey, scopePath: 'docs' },
    { space: 'skills', selection: 'root', rootKey },
    { space: 'settings', rootKey },
  ];

  for (const context of contexts) {
    assert.deepEqual(resolveRouteResources(context, deps), {
      kind: 'resolved', context, resources: { root },
    });
  }

  assert.deepEqual(resolveRouteResources({ space: 'root', rootKey: otherRootKey }, deps), {
    kind: 'root_not_open', rootKey: otherRootKey,
  });
});

test('expired SkillsContext and unknown Agent have distinct outcomes', () => {
  const context = { key: 'ctx_live' };
  const agent = { key: 'claude' };
  const deps = dependencies({ contexts: [context], agents: [agent] });

  assert.deepEqual(
    resolveRouteResources({ space: 'skills', selection: 'context', contextKey: 'ctx_live' }, deps),
    {
      kind: 'resolved',
      context: { space: 'skills', selection: 'context', contextKey: 'ctx_live' },
      resources: { skillsContext: context },
    },
  );
  assert.deepEqual(
    resolveRouteResources({ space: 'skills', selection: 'context', contextKey: 'ctx_gone' }, deps),
    { kind: 'context_expired', contextKey: 'ctx_gone' },
  );
  assert.deepEqual(
    resolveRouteResources({ space: 'agents', agentKey: 'unknown' }, deps),
    { kind: 'unknown_agent', agentKey: 'unknown' },
  );
});

test('Agents resolve their agent and optional root independently', () => {
  const root = { key: rootKey, dir: '/tmp/project', name: 'project' };
  const agent = { key: 'claude' };
  const deps = dependencies({ roots: [root], agents: [agent] });
  const context = { space: 'agents', agentKey: 'claude', rootKey };

  assert.deepEqual(resolveRouteResources(context, deps), {
    kind: 'resolved', context, resources: { agent, root },
  });
  assert.deepEqual(
    resolveRouteResources({ space: 'agents', agentKey: 'claude', rootKey: otherRootKey }, deps),
    { kind: 'root_not_open', rootKey: otherRootKey },
  );
});

test('resource-aware canonicalization is a typed redirect outcome', () => {
  const context = { space: 'home' };
  const deps = dependencies({ canonicalLocation: () => '/home/' });
  assert.deepEqual(resolveRouteResources(context, deps), {
    kind: 'canonical_redirect', location: '/home/', context,
  });
});

test('HTTP mapping keeps status and public error payloads explicit', () => {
  const vectors = [
    [{ kind: 'resolved', context: { space: 'home' }, resources: {} }, { status: 200 }],
    [{ kind: 'root_not_open', rootKey }, { status: 404, body: { error: 'root_not_open', rootKey } }],
    [{ kind: 'context_expired', contextKey: 'ctx_old' }, { status: 410, body: { error: 'context_expired', contextKey: 'ctx_old' } }],
    [{ kind: 'unknown_agent', agentKey: 'nope' }, { status: 404, body: { error: 'unknown_agent', agentKey: 'nope' } }],
    [{ kind: 'canonical_redirect', location: '/home/', context: { space: 'home' } }, { status: 308, headers: { location: '/home/' } }],
  ];

  for (const [outcome, expected] of vectors) {
    assert.deepEqual(mapRouteResolutionToHttp(outcome), expected);
  }
  assert.throws(() => mapRouteResolutionToHttp({ kind: 'future' }), /unknown route resolution/);
});
