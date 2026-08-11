'use strict';
const { AGENTS } = require('./agent-config.js');

/**
 * Bind the pure route-resolution contract to live, read-only registry views.
 * The closures intentionally perform lookup per resolution so Root and
 * SkillsContext lifecycle changes are visible without rebuilding the router.
 * @param {object} options
 * @returns {import('../types/showmd').RouteResolutionDependencies}
 */
function createRouteResolutionDependencies({
  rootManager,
  skillsContextRegistry,
  agents = AGENTS,
  canonicalLocation,
}) {
  if (!rootManager || typeof rootManager.getRoot !== 'function') {
    throw new TypeError('rootManager.getRoot is required');
  }
  if (!skillsContextRegistry || typeof skillsContextRegistry.get !== 'function') {
    throw new TypeError('skillsContextRegistry.get is required');
  }
  if (!Array.isArray(agents)) throw new TypeError('agents must be an array');

  const agentReferences = new Map();
  for (const agent of agents) {
    if (!agent || typeof agent.key !== 'string' || !agent.key || agentReferences.has(agent.key)) {
      throw new TypeError('agents must have unique non-empty keys');
    }
    agentReferences.set(agent.key, Object.freeze({ key: agent.key }));
  }

  const dependencies = {
    getRoot: (key) => rootManager.getRoot(key),
    getSkillsContext: (key) => skillsContextRegistry.get(key),
    getAgent: (key) => agentReferences.get(key) || null,
  };
  if (canonicalLocation !== undefined) {
    if (typeof canonicalLocation !== 'function') throw new TypeError('canonicalLocation must be a function');
    dependencies.canonicalLocation = canonicalLocation;
  }
  return dependencies;
}

module.exports = { createRouteResolutionDependencies };
