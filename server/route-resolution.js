'use strict';

function rootNotOpen(rootKey) {
  return { kind: 'root_not_open', rootKey };
}

function resolveRoot(rootKey, dependencies, resources) {
  const root = dependencies.getRoot(rootKey);
  if (!root) return rootNotOpen(rootKey);
  resources.root = root;
  return null;
}

/**
 * Resolve a syntactically valid RouteContext against read-only registry seams.
 * This contract does not own, create, or mutate any runtime registry.
 * @param {import('../types/showmd').RouteContext} context
 * @param {import('../types/showmd').RouteResolutionDependencies} dependencies
 * @returns {import('../types/showmd').RouteResolution}
 */
function resolveRouteResources(context, dependencies) {
  if (!context || typeof context !== 'object') throw new TypeError('invalid route context');
  const resources = {};
  let failure = null;

  if (context.space === 'root') {
    failure = resolveRoot(context.rootKey, dependencies, resources);
  } else if (context.space === 'skills') {
    if (context.selection === 'root') {
      failure = resolveRoot(context.rootKey, dependencies, resources);
    } else if (context.selection === 'context') {
      const skillsContext = dependencies.getSkillsContext(context.contextKey);
      if (!skillsContext) return { kind: 'context_expired', contextKey: context.contextKey };
      resources.skillsContext = skillsContext;
    } else if (context.selection !== 'global' && context.selection !== 'all') {
      throw new TypeError('unknown skills selection');
    }
  } else if (context.space === 'agents') {
    const agent = dependencies.getAgent(context.agentKey);
    if (!agent) return { kind: 'unknown_agent', agentKey: context.agentKey };
    resources.agent = agent;
    if (context.rootKey !== undefined) {
      failure = resolveRoot(context.rootKey, dependencies, resources);
    }
  } else if (context.space === 'settings' && context.rootKey !== undefined) {
    failure = resolveRoot(context.rootKey, dependencies, resources);
  } else if (context.space !== 'home' && context.space !== 'settings') {
    throw new TypeError('unknown route space');
  }

  if (failure) return failure;
  if (typeof dependencies.canonicalLocation === 'function') {
    const location = dependencies.canonicalLocation(context, resources);
    if (location !== null && location !== undefined) {
      if (typeof location !== 'string' || !location.startsWith('/')) {
        throw new TypeError('canonical location must be an absolute-path reference');
      }
      return { kind: 'canonical_redirect', location, context };
    }
  }
  return { kind: 'resolved', context, resources };
}

/**
 * Map a RouteResolution onto the transport contract without writing a response.
 * @param {import('../types/showmd').RouteResolution} outcome
 * @returns {import('../types/showmd').RouteResolutionHttp}
 */
function mapRouteResolutionToHttp(outcome) {
  if (outcome.kind === 'resolved') return { status: 200 };
  if (outcome.kind === 'root_not_open') {
    return { status: 404, body: { error: outcome.kind, rootKey: outcome.rootKey } };
  }
  if (outcome.kind === 'context_expired') {
    return { status: 410, body: { error: outcome.kind, contextKey: outcome.contextKey } };
  }
  if (outcome.kind === 'unknown_agent') {
    return { status: 404, body: { error: outcome.kind, agentKey: outcome.agentKey } };
  }
  if (outcome.kind === 'canonical_redirect') {
    return { status: 308, headers: { location: outcome.location } };
  }
  throw new TypeError('unknown route resolution outcome');
}

module.exports = { mapRouteResolutionToHttp, resolveRouteResources };
