// Callers get the raw Response back — ok checks, status branches, json vs text
// differ per call site, so only URL shapes and query encoding live here.

function enc(v) {
  return encodeURIComponent(v);
}

function skillsSelector(route) {
  if (route.selection === 'all') return 'scope=all';
  if (route.selection === 'root') return 'root=' + enc(route.rootKey);
  if (route.selection === 'context') return 'context=' + enc(route.contextKey);
  return '';
}

// Every space names its documents the same way; only the prefix, the selection
// carried alongside each request, and the id parameter differ.
function spaceEndpoint(route) {
  if (route.space === 'skills') return { prefix: '/api/skills', selector: skillsSelector(route), idKey: 'id' };
  if (route.space === 'agents') {
    return {
      prefix: `/api/agents/${enc(route.agentKey)}`,
      selector: route.rootKey ? 'root=' + enc(route.rootKey) : '',
      idKey: 'id',
    };
  }
  return { prefix: `/api/roots/${enc(route.rootKey)}`, selector: '', idKey: 'path' };
}

/**
 * @param {import('../types/showmd').RouteContext} route
 */
export function documentApi(route) {
  const { prefix, selector, idKey } = spaceEndpoint(route);
  const at = (tail, params = []) => {
    const query = [selector, ...params].filter(Boolean).join('&');
    return `${prefix}/${tail}${query ? '?' + query : ''}`;
  };
  const doc = (tail, id, params = []) => at(tail, [`${idKey}=${enc(id)}`, ...params]);
  const revision = (rev, repo) => [`rev=${rev}`, repo ? 'repo=1' : ''];
  return {
    /** @param {{ scope?: string }} [opts] */
    tree: (opts = {}) => fetch(at('tree', opts.scope ? ['scope=' + enc(opts.scope)] : [])),
    raw: (id) => fetch(doc('raw', id)),
    async putRaw(id, text) {
      const res = await fetch(doc('raw', id), { method: 'PUT', body: text });
      if (!res.ok) throw new Error('save failed: ' + res.status);
    },
    assetUrl: (id) => doc('asset', id),
    history: (id) => fetch(doc('history', id)),
    diff: (id, rev, repo) => fetch(doc('diff', id, revision(rev, repo))),
    restore: (id, rev, repo) => fetch(doc('restore', id, revision(rev, repo)), { method: 'POST' }),
    reveal: (id) => fetch(doc('reveal', id), { method: 'POST' }),
  };
}

export function createSkillsContext(projectDirs) {
  return fetch('/api/skills/contexts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDirs }),
  });
}

export function recents() {
  return fetch('/api/recents');
}

export function deleteRecent(path) {
  return fetch('/api/recents/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
  });
}

export function addRoot(path) {
  return fetch('/api/roots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

export function pickFolder(body) {
  return fetch('/api/pick-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function listRoots() {
  return fetch('/api/roots');
}

export function removeRoot(key) {
  return fetch(`/api/roots/${enc(key)}`, { method: 'DELETE' });
}

export function installApp() {
  return fetch('/api/install-app', { method: 'POST' });
}

export function startUpdate(token) {
  return fetch('/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

export function getUpdateState() {
  return fetch('/api/update', { cache: 'no-store' });
}

export function registerMarkdown() {
  return fetch('/api/register-markdown', { method: 'POST' });
}

export function prune(scope, rootKey) {
  return fetch('/api/prune', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, rootKey }),
  });
}

export function ping(url, opts) {
  return fetch(url, opts);
}

export function restart() {
  return fetch('/api/restart', { method: 'POST' });
}

export function getSettings(rootKey) {
  return fetch(rootKey ? `/api/settings?root=${enc(rootKey)}` : '/api/settings');
}

export function getHistorySize(rootKey) {
  return fetch(rootKey ? `/api/history-size?root=${enc(rootKey)}` : '/api/history-size');
}

export function putSettings(values) {
  return fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  });
}

export function revealSettings() {
  return fetch('/api/reveal?settings=1', { method: 'POST' });
}
