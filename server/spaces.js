'use strict';
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const skills = require('./skills.js');
const agentConfig = require('./agent-config.js');
const { createDocumentStore, walkMd } = require('./documents.js');
const { formatRouteContext } = require('./route-context.js');

const SKILLS_STORE_CONFIG = { addressing: 'keyed' };

function newContextKey() {
  return `sc_${randomBytes(16).toString('base64url')}`;
}

function selectorOf(context) {
  if (context.selection === 'root') return { selection: 'root', rootKey: context.rootKey };
  if (context.selection === 'context') return { selection: 'context', contextKey: context.contextKey };
  return { selection: context.selection };
}

function skillHref(id, selector) {
  return formatRouteContext({ space: 'skills', ...selector, documentRoute: id });
}

function decorateSkillsTree(tree, selector) {
  for (const scope of tree.scopes || []) {
    const all = [...(scope.skills || []), ...(scope.groups || []).flatMap((g) => g.skills || [])];
    for (const skill of all) {
      skill.href = skillHref(skill.id, selector);
      for (const file of skill.files || []) file.href = skillHref(file.id, selector);
    }
  }
  return tree;
}

// Selection decides which skill directories exist at all, so tree and store are
// built from one root list and never fall back to another selection's roots.
/**
 * @param {import('../types/showmd').RouteContext} context
 * @param {{ rootDir?: string, projectDirs?: string[], home?: string, cwd?: string }} [opts]
 */
async function skillsSpace(context, { rootDir, projectDirs = [], home = os.homedir(), cwd = process.cwd() } = {}) {
  const selector = selectorOf(context);
  if (context.selection === 'root') {
    const { tree, store } = await skills.getTree(rootDir);
    return { tree: decorateSkillsTree(tree, selector), store };
  }
  const roots = context.selection === 'context'
    ? skills.discoverSkillRoots({ mode: 'project', projectDirs, home })
    : skills.discoverSkillRoots({ mode: context.selection, home });
  const mode = context.selection === 'context' ? 'project' : context.selection;
  const tree = await skills.buildSkillsTree(roots, { walkMd, home, cwd, mode });
  return { tree: decorateSkillsTree(tree, selector), store: createDocumentStore(roots, SKILLS_STORE_CONFIG) };
}

function decorateAgentTree(tree, { agentKey, rootKey }) {
  const href = (id) => formatRouteContext({ space: 'agents', agentKey, rootKey, documentRoute: id });
  for (const group of tree.groups || []) {
    for (const file of group.files || []) file.href = href(file.id);
    for (const project of group.projects || []) {
      if (project.memoryDoc) project.memoryDoc.href = href(project.memoryDoc.id);
      for (const file of project.files || []) file.href = href(file.id);
    }
  }
  return tree;
}

// Project context is whatever the route named; nothing here falls back to the
// first open root or the server's cwd.
/**
 * @param {import('../types/showmd').RouteContext} context
 * @param {{ rootDir?: string }} [opts]
 */
async function agentsSpace(context, { rootDir } = {}) {
  const { tree, store } = await agentConfig.getAgentTree(context.agentKey, { cwd: rootDir });
  if (!tree) return null;
  return { tree: decorateAgentTree(tree, { agentKey: context.agentKey, rootKey: context.rootKey }), store };
}

module.exports = { newContextKey, skillsSpace, agentsSpace, decorateSkillsTree, decorateAgentTree };
