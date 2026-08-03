// Callers get the raw Response back — ok checks, status branches, json vs text
// differ per call site, so only URL shapes and query encoding live here.

function enc(v) {
  return encodeURIComponent(v);
}

export function raw(path) {
  return fetch('/api/raw?path=' + enc(path));
}

export async function putRaw(path, text) {
  const res = await fetch('/api/raw?path=' + enc(path), { method: 'PUT', body: text });
  if (!res.ok) throw new Error('save failed: ' + res.status);
}

export function tree() {
  return fetch('/api/tree');
}

export function treeSkills() {
  return fetch('/api/tree?view=skills');
}

export function treeAgents(agentKey) {
  return fetch(`/api/tree?view=agents&agent=${enc(agentKey)}`);
}

export function recents() {
  return fetch('/api/recents');
}

export function deleteRecent(path) {
  return fetch('/api/recents/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
  });
}

export function pickRoot(body) {
  return fetch('/api/pick-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function installApp() {
  return fetch('/api/install-app', { method: 'POST' });
}

export function registerMarkdown() {
  return fetch('/api/register-markdown', { method: 'POST' });
}

export function prune(scope) {
  return fetch('/api/prune', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
}

export function ping(url, opts) {
  return fetch(url, opts);
}

export function restart() {
  return fetch('/api/restart', { method: 'POST' });
}

export function getSettings() {
  return fetch('/api/settings');
}

export function putSettings(values) {
  return fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  });
}

export function root() {
  return fetch('/api/root');
}

export function history(path) {
  return fetch('/api/history?path=' + enc(path));
}

export function diff(path, rev, repo) {
  return fetch('/api/diff?path=' + enc(path) + '&rev=' + rev + (repo ? '&repo=1' : ''));
}

/** @param {import('../types/showmd').RevealOptions} [opts] */
export function reveal({ settings, path } = {}) {
  const target = settings ? '/api/reveal?settings=1' : path && '/api/reveal?path=' + enc(path);
  return target ? fetch(target, { method: 'POST' }) : null;
}

export function restore(path, rev, repo) {
  return fetch('/api/restore?path=' + enc(path) + '&rev=' + rev + (repo ? '&repo=1' : ''), { method: 'POST' });
}
