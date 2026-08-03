import { filterFiles, filterSkillsTree, matchesQuery } from './search.js';

// a query forces every matching node open, so collapse state stays untouched
// underneath and reapplies once the query is cleared
function opened(collapsed, query) {
  return (nodeId) => !query && collapsed.has(nodeId);
}

function skillRows(skills, { depth, listKey, isCollapsed, file, out }) {
  for (const skill of skills) {
    const nodeId = `skill:${skill.id}`;
    const hasFiles = skill.files.length > 0;
    const isShut = hasFiles && isCollapsed(nodeId);
    out.push({
      kind: 'skill',
      id: skill.id,
      nodeId,
      depth,
      listKey,
      label: skill.name,
      skill,
      collapsible: hasFiles,
      collapsed: isShut,
      opensFile: true,
      current: skill.id === file,
    });
    if (!hasFiles || isShut) continue;
    for (const f of skill.files) {
      out.push({
        kind: 'file',
        id: f.id,
        depth: depth + 1,
        listKey,
        label: f.label,
        nested: true,
        underSkill: true,
        collapsible: false,
        collapsed: false,
        opensFile: true,
        current: f.id === file,
      });
    }
  }
}

function header(kind, nodeId, depth, label, isCollapsed) {
  return {
    kind,
    id: nodeId,
    nodeId,
    depth,
    label,
    collapsible: true,
    collapsed: isCollapsed(nodeId),
    opensFile: false,
    current: false,
  };
}

// a project's MEMORY.md folds into its own row, same as a skill's SKILL.md
// folds into the skill row below; other memory files nest under it. A project
// with no MEMORY.md (unusual) falls back to a plain header, matching how a
// skill-less directory would render.
function agentProjectRows(projects, { depth, listKey, isCollapsed, file, out }) {
  for (const proj of projects) {
    const label = proj.current ? `${proj.label} (current)` : proj.label;
    const nodeId = `agentproject:${proj.label}`;
    if (!proj.memoryDoc) {
      out.push(header('dir', nodeId, depth, label, isCollapsed));
      if (isCollapsed(nodeId)) continue;
      for (const f of proj.files) {
        out.push({ kind: 'file', id: f.id, depth: depth + 1, listKey, label: f.label, nested: true, collapsible: false, collapsed: false, opensFile: true, current: f.id === file });
      }
      continue;
    }
    const hasFiles = proj.files.length > 0;
    const isShut = hasFiles && isCollapsed(nodeId);
    out.push({
      kind: 'project',
      id: proj.memoryDoc.id,
      nodeId,
      depth,
      listKey,
      label,
      title: proj.path,
      collapsible: hasFiles,
      collapsed: isShut,
      opensFile: true,
      current: proj.memoryDoc.id === file,
    });
    if (!hasFiles || isShut) continue;
    for (const f of proj.files) {
      out.push({ kind: 'file', id: f.id, depth: depth + 1, listKey, label: f.label, nested: true, underSkill: true, collapsible: false, collapsed: false, opensFile: true, current: f.id === file });
    }
  }
}

export function visibleRows({ skillsTree, agentTree, tree }, { query = '', collapsed = new Set(), file = null } = {}) {
  const isCollapsed = opened(collapsed, query);
  const out = [];

  // a query drops the grouping and lists flat matches, same shortcut doc-mode
  // search takes below. The category headers reuse the 'scope' row kind (and
  // its CSS) so they read exactly like Skills' own Global/Projects headers.
  if (agentTree) {
    if (query) {
      // matches the trimmed display label (file name, project name), never the
      // slugified doc id — same reason filterSkillsTree matches skill.name/label
      const push = (f) => out.push({ kind: 'file', id: f.id, depth: 0, listKey: 'search', label: f.label, collapsible: false, collapsed: false, opensFile: true, current: f.id === file });
      for (const group of agentTree.groups) {
        for (const f of group.files || []) {
          if (matchesQuery(f.label, query)) push(f);
        }
        for (const proj of group.projects || []) {
          const projLabel = proj.current ? `${proj.label} (current)` : proj.label;
          const projMatches = matchesQuery(projLabel, query);
          if (proj.memoryDoc && (projMatches || matchesQuery(proj.memoryDoc.label, query))) push(proj.memoryDoc);
          for (const f of proj.files) {
            if (projMatches || matchesQuery(f.label, query)) push(f);
          }
        }
      }
      return out;
    }
    for (const group of agentTree.groups) {
      const groupId = `agentgroup:${group.name}`;
      out.push(header('scope', groupId, 0, group.name, isCollapsed));
      if (isCollapsed(groupId)) continue;
      if (group.files) {
        for (const f of group.files) {
          out.push({ kind: 'file', id: f.id, depth: 1, listKey: groupId, label: f.label, nested: true, collapsible: false, collapsed: false, opensFile: true, current: f.id === file });
        }
      }
      if (group.projects) {
        agentProjectRows(group.projects, { depth: 1, listKey: groupId, isCollapsed, file, out });
      }
    }
    return out;
  }

  if (skillsTree) {
    const data = query ? filterSkillsTree(skillsTree, query) : skillsTree;
    for (const scope of data.scopes) {
      const scopeId = `scope:${scope.name}`;
      out.push(header('scope', scopeId, 0, scope.name, isCollapsed));
      if (isCollapsed(scopeId)) continue;
      for (const group of scope.groups) {
        const groupId = `group:${scope.name}:${group.source}`;
        out.push(header('group', groupId, 1, group.source, isCollapsed));
        if (isCollapsed(groupId)) continue;
        skillRows(group.skills, { depth: 2, listKey: groupId, isCollapsed, file, out });
      }
      // "local" skills: direct children of the scope, no group header/collapse level
      if (scope.skills.length) {
        skillRows(scope.skills, { depth: 1, listKey: `local:${scope.name}`, isCollapsed, file, out });
      }
    }
    return out;
  }

  const files = query ? filterFiles(tree, query) : tree;
  // search results drop the directory grouping so filterFiles' basename-first
  // ranking survives to the row order, and ArrowDown lands on the best match
  if (query) {
    for (const f of files) {
      out.push({ kind: 'file', id: f, depth: 0, listKey: 'search', label: f, collapsible: false, collapsed: false, opensFile: true, current: f === file });
    }
    return out;
  }

  const byDir = new Map();
  for (const f of files) {
    const slash = f.lastIndexOf('/');
    const dir = slash === -1 ? '' : f.slice(0, slash + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }
  for (const dir of [...byDir.keys()].sort()) {
    const listKey = `dir:${dir}`;
    let depth = 0;
    if (dir) {
      out.push(header('dir', listKey, 0, dir, isCollapsed));
      if (isCollapsed(listKey)) continue;
      depth = 1;
    }
    for (const f of byDir.get(dir).sort()) {
      out.push({ kind: 'file', id: f, depth, listKey, label: f.slice(dir.length), nested: !!dir, collapsible: false, collapsed: false, opensFile: true, current: f === file });
    }
  }
  return out;
}

// keeps the keyboard off the synthetic-click path: `toggle` and `open` are the
// same operations the mouse handlers call
export function keyIntent(rows, key, { selected = null, file = null } = {}) {
  if (rows.length === 0) return null;
  let idx = rows.findIndex((r) => r.id === selected);
  if (idx === -1 && selected == null && file) idx = rows.findIndex((r) => r.id === file);

  if (key === 'ArrowDown') {
    const row = rows[Math.min(rows.length - 1, idx + 1)];
    return { type: 'select', row, autoOpen: row.opensFile };
  }
  if (key === 'ArrowUp') {
    const row = rows[Math.max(0, (idx === -1 ? rows.length : idx) - 1)];
    return { type: 'select', row, autoOpen: row.opensFile };
  }
  if (idx === -1) return null;

  const row = rows[idx];
  if (key === 'Enter' || key === ' ') {
    return row.collapsible ? { type: 'toggle', row } : { type: 'open', row };
  }
  if (key === 'ArrowRight') {
    if (row.collapsed) return { type: 'toggle', row };
    const child = rows[idx + 1];
    return child && child.depth > row.depth ? { type: 'select', row: child } : null;
  }
  if (key === 'ArrowLeft') {
    if (row.collapsible && !row.collapsed) return { type: 'toggle', row };
    for (let i = idx - 1; i >= 0; i--) {
      if (rows[i].depth < row.depth) return { type: 'select', row: rows[i] };
    }
  }
  return null;
}

export function toggleNode(collapsed, nodeId) {
  if (collapsed.has(nodeId)) collapsed.delete(nodeId);
  else collapsed.add(nodeId);
  return collapsed;
}

// first run only: everything shut, then the first group chain reopened so the
// tree does not greet you as a wall of closed rows
export function seedSkillsCollapse(collapsed, data) {
  for (const scope of data.scopes) {
    collapsed.add(`scope:${scope.name}`);
    for (const group of scope.groups) {
      collapsed.add(`group:${scope.name}:${group.source}`);
      for (const skill of group.skills) collapsed.add(`skill:${skill.id}`);
    }
    for (const skill of scope.skills) collapsed.add(`skill:${skill.id}`);
  }
  for (const scope of data.scopes) {
    const group = scope.groups[0];
    if (group) {
      collapsed.delete(`scope:${scope.name}`);
      collapsed.delete(`group:${scope.name}:${group.source}`);
      collapsed.delete(`skill:${group.skills[0].id}`);
      return collapsed;
    }
    if (scope.skills.length) {
      collapsed.delete(`scope:${scope.name}`);
      collapsed.delete(`skill:${scope.skills[0].id}`);
      return collapsed;
    }
  }
  return collapsed;
}

// Memory projects default shut (they can run long) so a fresh agent-config
// view doesn't greet you with a wall of per-project rows; Instructions stays
// open since enterAgentConfigView() auto-opens its first file.
export function seedAgentCollapse(collapsed, agentTree) {
  for (const group of agentTree.groups) {
    if (group.projects) {
      collapsed.add(`agentgroup:${group.name}`);
      for (const proj of group.projects) collapsed.add(`agentproject:${proj.label}`);
    }
  }
  return collapsed;
}

// the sidebar's whole state. `collapsed` is session-only: it resets on page
// reload and survives SSE-triggered re-renders. `rows` is whatever the last
// render painted — the keyboard walks that, never the DOM.
export const INITIAL_NAV = { collapsed: new Set(), query: '', selected: null, seeded: false, agentSeeded: false, expandedFor: null, rows: [] };

// mirrors nextView: every nav event in, next record out, one commit per caller.
// collapsed is copy-on-write here so old records stay untouched — the seed/toggle
// helpers below still mutate their Set argument in place, so each branch passes
// them a fresh copy.
export function nextNav(nav, event, ctx) {
  switch (event.type) {
    case 'query':
      return nav.query === event.query ? nav : { ...nav, query: event.query };
    case 'select':
      return nav.selected === event.id ? nav : { ...nav, selected: event.id };
    case 'toggle': {
      const collapsed = toggleNode(new Set(nav.collapsed), event.nodeId);
      const selected = event.selected !== undefined ? event.selected : nav.selected;
      return { ...nav, collapsed, selected };
    }
    case 'reset-agent-seed':
      return nav.agentSeeded ? { ...nav, agentSeeded: false } : nav;
    case 'sync-rows': {
      const { state, hideFile } = ctx;
      let collapsed = nav.collapsed;
      let seeded = nav.seeded;
      let expandedFor = nav.expandedFor;
      let agentSeeded = nav.agentSeeded;
      if (state.skillsTree) {
        if (!seeded) {
          collapsed = seedSkillsCollapse(new Set(collapsed), state.skillsTree);
          seeded = true;
        }
        if (state.file && state.file !== expandedFor) {
          collapsed = expandAncestors(new Set(collapsed), state.skillsTree, state.file);
          expandedFor = state.file;
        }
      }
      if (state.agentTree && !agentSeeded) {
        collapsed = seedAgentCollapse(new Set(collapsed), state.agentTree);
        agentSeeded = true;
      }
      const rows = visibleRows(state, { query: nav.query, collapsed, file: hideFile ? null : state.file });
      return { ...nav, collapsed, seeded, expandedFor, agentSeeded, rows };
    }
    default:
      return nav;
  }
}

export function expandAncestors(collapsed, data, file) {
  if (!file) return collapsed;
  for (const scope of data.scopes) {
    for (const group of scope.groups) {
      for (const skill of group.skills) {
        if (skill.id !== file && !skill.files.some((f) => f.id === file)) continue;
        collapsed.delete(`scope:${scope.name}`);
        collapsed.delete(`group:${scope.name}:${group.source}`);
        collapsed.delete(`skill:${skill.id}`);
        return collapsed;
      }
    }
    // group-less local skills: collapse chain is scope > skill, no group level
    for (const skill of scope.skills) {
      if (skill.id !== file && !skill.files.some((f) => f.id === file)) continue;
      collapsed.delete(`scope:${scope.name}`);
      collapsed.delete(`skill:${skill.id}`);
      return collapsed;
    }
  }
  return collapsed;
}
