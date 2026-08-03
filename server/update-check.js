'use strict';

const REGISTRY_URL = 'https://registry.npmjs.org/showmd/latest';
const UPDATE_CACHE_MS = 24 * 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 3000;

let updateCache = null; // { checked: number, latest: string|null }
let updateInFlight = null;

// splits off build metadata (+abc, ignored entirely) and a prerelease tag
// (-beta.1, which sorts below its release), then reads the numeric core
function parseVersion(v) {
  const core = String(v).split('+')[0];
  const dash = core.indexOf('-');
  const release = dash === -1 ? core : core.slice(0, dash);
  const prerelease = dash === -1 ? null : core.slice(dash + 1);
  return { core: release.split('.').map(Number), prerelease };
}

function isNewerVersion(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i++) {
    const x = a.core[i] || 0;
    const y = b.core[i] || 0;
    if (x !== y) return x > y;
  }
  if (a.prerelease === b.prerelease) return false;
  if (a.prerelease === null) return true;
  if (b.prerelease === null) return false;
  return a.prerelease > b.prerelease;
}

async function fetchLatestVersion(fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    // the registry response ends up in a client innerHTML template; a version
    // string restricted to this charset can never smuggle markup
    return typeof data.version === 'string' && /^[\w.+-]+$/.test(data.version) ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshUpdateCache(fetchImpl = fetch) {
  const latest = await fetchLatestVersion(fetchImpl);
  updateCache = { checked: Date.now(), latest };
  return updateCache;
}

// updateCache stays null until a check has actually run, so a null latest
// with a non-null cache means the last check failed, not "never checked"
function updateInfo() {
  if (!updateCache) return { updateAvailable: false, latestVersion: null, checkFailed: false };
  if (!updateCache.latest) return { updateAvailable: false, latestVersion: null, checkFailed: true };
  return { updateAvailable: isNewerVersion(updateCache.latest, require('../package.json').version), latestVersion: updateCache.latest, checkFailed: false };
}

// the app's only outbound network call; a no-op when the updateCheck setting is
// off, and never awaited by callers — a hung registry must never delay anything
function checkUpdate({ enabled = true, fetchImpl = fetch } = {}) {
  if (!enabled) return updateInfo();
  const stale = !updateCache || Date.now() - updateCache.checked >= UPDATE_CACHE_MS;
  if (stale && !updateInFlight) {
    updateInFlight = refreshUpdateCache(fetchImpl).catch(() => {}).finally(() => { updateInFlight = null; });
  }
  return updateInfo();
}

module.exports = { checkUpdate, refreshUpdateCache, updateInfo, parseVersion, isNewerVersion };
