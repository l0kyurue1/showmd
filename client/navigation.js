import { matchesQuery } from './search.js';

function walkNodes(nodes, visit, ancestors = []) {
  for (const node of nodes) {
    if (visit(node, ancestors) === false) return false;
    if (walkNodes(node.children, visit, [...ancestors, node]) === false) return false;
  }
  return true;
}

export function documentIds(model) {
  const ids = [];
  walkNodes(model.roots, (node) => {
    if (node.documentId) ids.push(node.documentId);
  });
  return ids;
}

export function findDocument(model, documentId) {
  let found = null;
  walkNodes(model.roots, (node, ancestors) => {
    if (node.documentId !== documentId) return;
    found = { node, ancestors, metadata: [...ancestors, node].map((item) => item.metadata).filter(Boolean) };
    return false;
  });
  return found;
}

export function metadataForDocument(model, documentId, name) {
  const found = findDocument(model, documentId);
  if (!found) return null;
  for (let i = found.metadata.length - 1; i >= 0; i--) {
    if (name in found.metadata[i]) return found.metadata[i][name];
  }
  return null;
}

export function breadcrumbForDocument(model, documentId) {
  const found = findDocument(model, documentId);
  if (!found) return documentId;
  const prefix = metadataForDocument(model, documentId, 'breadcrumbPrefix');
  const label = found.node.metadata?.documentLabel || found.node.label;
  return prefix ? `${prefix} / ${label}` : (found.node.metadata?.fullLabel || documentId);
}

export function initialCollapsed(model) {
  const collapsed = new Set();
  walkNodes(model.roots, (node) => {
    if (node.initiallyCollapsed) collapsed.add(node.key);
  });
  return collapsed;
}

export function expandAncestors(collapsed, model, documentId) {
  const found = findDocument(model, documentId);
  if (!found) return collapsed;
  for (const node of found.ancestors) collapsed.delete(node.key);
  collapsed.delete(found.node.key);
  return collapsed;
}

function splitSearchLabel(documentId) {
  const slash = documentId.lastIndexOf('/');
  if (slash === -1) return null;
  return { dir: documentId.slice(0, slash + 1), base: documentId.slice(slash + 1) };
}

function rowFor(node, { depth, listKey, collapsed, file, ancestors, search = false, filesModel = false }) {
  const collapsible = node.children.length > 0;
  const isCollapsed = !search && collapsible && collapsed.has(node.key);
  const ancestorRoles = ancestors.map((item) => item.role);
  const id = node.documentId || node.key;
  const searchLabel = search && filesModel && node.documentId;
  return {
    kind: search && node.metadata?.searchResultRole ? node.metadata.searchResultRole : node.role,
    id,
    nodeId: node.key,
    depth,
    listKey,
    label: search && node.metadata?.searchResultLabel
      ? node.metadata.searchResultLabel
      : (searchLabel ? node.documentId : node.label),
    ...(searchLabel ? { labelParts: splitSearchLabel(node.documentId) } : {}),
    ...(!search && node.role === 'dir' && node.labelParts ? { labelParts: node.labelParts } : {}),
    nested: node.role === 'file' && depth > 0,
    ...(node.role === 'file' && (ancestorRoles.includes('skill') || ancestorRoles.includes('project')) ? { underSkill: true } : {}),
    collapsible,
    collapsed: isCollapsed,
    opensFile: !!node.documentId,
    current: node.documentId === file,
    ...(node.metadata?.skill ? { skill: node.metadata.skill } : {}),
    ...(node.metadata?.title ? { title: node.metadata.title } : {}),
  };
}

function isFilesModel(model) {
  return model.roots.every((node) => node.role === 'file' || node.role === 'dir');
}

function searchableText(node, ancestors) {
  const inherited = ancestors.flatMap((item) => item.metadata?.searchText || []);
  return [node.label, node.documentId || '', ...(node.metadata?.searchText || []), ...inherited].join(' ');
}

function flatSearchRows(model, query, file, filesModel) {
  const matches = [];
  walkNodes(model.roots, (node, ancestors) => {
    if (!node.documentId || !matchesQuery(searchableText(node, ancestors), query)) return;
    matches.push({
      row: rowFor(node, { depth: 0, listKey: 'search', collapsed: new Set(), file, ancestors: [], search: true, filesModel }),
      basenameMatch: matchesQuery(node.label, query),
    });
  });
  matches.sort((a, b) => Number(b.basenameMatch) - Number(a.basenameMatch));
  return matches.map((item) => item.row);
}

function filteredTreeRows(model, query, file) {
  const include = (node, ancestors, parentMatched = false) => {
    const selfMatched = parentMatched || (!!node.documentId && matchesQuery(searchableText(node, ancestors), query));
    const childRows = [];
    for (const child of node.children) childRows.push(...include(child, [...ancestors, node], selfMatched));
    if (!selfMatched && childRows.length === 0) return [];
    const listKey = node.metadata?.listKey || ancestors.at(-1)?.key || 'root';
    return [rowFor(node, { depth: ancestors.length, listKey, collapsed: new Set(), file, ancestors, search: true }), ...childRows];
  };
  return model.roots.flatMap((node) => include(node, []));
}

export function visibleRows(model, { query = '', collapsed = new Set(), file = null } = {}) {
  const filesModel = isFilesModel(model);
  if (query) {
    const flatSearch = filesModel || model.roots.some((node) => node.metadata?.flatSearch);
    return flatSearch ? flatSearchRows(model, query, file, filesModel) : filteredTreeRows(model, query, file);
  }

  const rows = [];
  const append = (node, ancestors, inheritedListKey) => {
    const listKey = node.metadata?.listKey || inheritedListKey || 'root';
    const row = rowFor(node, { depth: ancestors.length, listKey, collapsed, file, ancestors });
    rows.push(row);
    if (row.collapsed) return;
    const childListKey = ['scope', 'group', 'dir'].includes(node.role) ? node.key : listKey;
    for (const child of node.children) append(child, [...ancestors, node], childListKey);
  };
  for (const root of model.roots) append(root, [], root.role === 'file' ? 'dir:' : 'root');
  return rows;
}

export function keyIntent(rows, key, { selected = null, file = null } = {}) {
  if (rows.length === 0) return null;
  let idx = rows.findIndex((row) => row.id === selected);
  if (idx === -1 && selected == null && file) idx = rows.findIndex((row) => row.id === file);
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
  if (key === 'Enter' || key === ' ') return row.collapsible ? { type: 'toggle', row } : { type: 'open', row };
  if (key === 'ArrowRight') {
    if (row.collapsed) return { type: 'toggle', row };
    const child = rows[idx + 1];
    return child && child.depth > row.depth ? { type: 'select', row: child } : null;
  }
  if (key === 'ArrowLeft') {
    if (row.collapsible && !row.collapsed) return { type: 'toggle', row };
    for (let i = idx - 1; i >= 0; i--) if (rows[i].depth < row.depth) return { type: 'select', row: rows[i] };
  }
  return null;
}

export function toggleNode(collapsed, nodeId) {
  if (collapsed.has(nodeId)) collapsed.delete(nodeId);
  else collapsed.add(nodeId);
  return collapsed;
}

export const INITIAL_NAV = { collapsed: new Set(), query: '', selected: null, initialized: false, expandedFor: null, rows: [] };

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
    case 'reset':
      return { ...nav, collapsed: new Set(), initialized: false, expandedFor: null, rows: [] };
    case 'sync-rows': {
      const { model, file = null, hideFile = false } = ctx;
      let collapsed = nav.collapsed;
      let initialized = nav.initialized;
      let expandedFor = nav.expandedFor;
      if (!initialized) {
        collapsed = initialCollapsed(model);
        initialized = true;
      }
      if (file && file !== expandedFor) {
        collapsed = expandAncestors(new Set(collapsed), model, file);
        expandedFor = file;
      }
      const rows = visibleRows(model, { query: nav.query, collapsed, file: hideFile ? null : file });
      return { ...nav, collapsed, initialized, expandedFor, rows };
    }
    default:
      return nav;
  }
}
