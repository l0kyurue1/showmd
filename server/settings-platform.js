'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const proc = require('./proc.js');
const { isDirEntry } = require('./documents.js');

async function execFileP(cmd, args, opts) {
  const { err, stdout } = await proc.tryRun(cmd, args, opts);
  if (err) throw err;
  return { stdout };
}

const LINUX_BROWSERS = ['firefox', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge'];

async function anyExists(paths) {
  for (const p of paths) {
    if (await fsp.access(p).then(() => true, () => false)) return true;
  }
  return false;
}

async function detectBrowsersLinux(pathDirs) {
  const found = [];
  for (const exe of LINUX_BROWSERS) {
    if (await anyExists(pathDirs.map((d) => path.join(d, exe)))) found.push(exe);
  }
  return found;
}

// Treat bundles declaring HTTP(S) schemes as browsers. Seams avoid real plutil in tests.
function bundleClaimsHttpScheme(info) {
  if (!info || !Array.isArray(info.CFBundleURLTypes)) return false;
  return info.CFBundleURLTypes.some((t) => Array.isArray(t.CFBundleURLSchemes)
    && t.CFBundleURLSchemes.some((s) => typeof s === 'string' && (s.toLowerCase() === 'http' || s.toLowerCase() === 'https')));
}

async function readPlutilJson(plistPath) {
  try {
    const { stdout } = await execFileP('plutil', ['-convert', 'json', '-o', '-', plistPath]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function isMarkdownHandlerEntry(h) {
  if (h.LSHandlerContentType === 'net.daringfireball.markdown') return true;
  return h.LSHandlerContentTag === 'md' && h.LSHandlerContentTagClass === 'public.filename-extension';
}

function lsHandlerIsDefault(secureJson, bundleId) {
  if (!bundleId || !secureJson || !Array.isArray(secureJson.LSHandlers)) return false;
  return secureJson.LSHandlers.some((h) => isMarkdownHandlerEntry(h)
    && (h.LSHandlerRoleAll === bundleId || h.LSHandlerRoleViewer === bundleId));
}

function launchServicesSecurePlist(home = os.homedir()) {
  return path.join(home, 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
}

// Use a short TTL because Change All can alter LaunchServices mid-process.
const MD_HANDLER_CACHE_TTL_MS = 10_000;
let mdHandlerCache = null; // { value, ts, bundleId }

let _mdHandlerNow = Date.now;
let _readMdHandlerPlist = readPlutilJson;

function _resetMdHandlerCache() {
  mdHandlerCache = null;
}

function _setMdHandlerCacheTestHooks({ now, readPlist } = {}) {
  _mdHandlerNow = now || Date.now;
  _readMdHandlerPlist = readPlist || readPlutilJson;
}

// Test seams bypass the cache; plist failures mean not default and never throw.
async function detectMdHandlerDefault({ platform = process.platform, bundleId, home, plistPath, readPlist } = {}) {
  if (platform !== 'darwin') return false;
  if (readPlist || plistPath || home) {
    const secureJson = await (readPlist || readPlutilJson)(plistPath || launchServicesSecurePlist(home));
    return lsHandlerIsDefault(secureJson, bundleId);
  }
  const now = _mdHandlerNow();
  if (!mdHandlerCache || mdHandlerCache.bundleId !== bundleId || now - mdHandlerCache.ts >= MD_HANDLER_CACHE_TTL_MS) {
    const secureJson = await _readMdHandlerPlist(launchServicesSecurePlist());
    mdHandlerCache = { value: lsHandlerIsDefault(secureJson, bundleId), ts: now, bundleId };
  }
  return mdHandlerCache.value;
}

// Safari.app may be a symlink, so stat symlinks before rejecting them.
async function isDir(full, entry) {
  return isDirEntry(full, entry);
}

// top-level .app bundles plus one level into subfolders (e.g. /Applications/Utilities)
async function listAppBundles(dirs) {
  const found = [];
  for (const dir of dirs) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (!(await isDir(full, entry))) continue;
      if (entry.name.endsWith('.app')) { found.push(full); continue; }
      const sub = await fsp.readdir(full, { withFileTypes: true }).catch(() => []);
      for (const inner of sub) {
        const innerFull = path.join(full, inner.name);
        if (inner.name.endsWith('.app') && await isDir(innerFull, inner)) found.push(innerFull);
      }
    }
  }
  return found;
}

// a bundle's display name — its .app filename minus the extension — is exactly
// what `open -a <name>` expects
async function detectBrowsersDarwin(appDirs, readPlist = readPlutilJson) {
  const bundles = await listAppBundles(appDirs);
  const names = [];
  await Promise.all(bundles.map(async (bundle) => {
    const info = await readPlist(path.join(bundle, 'Contents', 'Info.plist')).catch(() => null);
    if (bundleClaimsHttpScheme(info)) names.push(path.basename(bundle, '.app'));
  }));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

// Cache macOS browser scanning because installed apps do not change mid-process.
let darwinBrowserCache = null;

// scans /Applications + ~/Applications (darwin) or $PATH (linux). Windows is
// best-effort, 'default' only for now.
async function detectBrowsers({ platform = process.platform, appDirs, pathDirs, readPlist } = {}) {
  const home = os.homedir();
  let names = [];
  if (platform === 'darwin') {
    const dirs = appDirs || ['/Applications', path.join(home, 'Applications')];
    if (appDirs || readPlist) names = await detectBrowsersDarwin(dirs, readPlist);
    else {
      if (!darwinBrowserCache) darwinBrowserCache = await detectBrowsersDarwin(dirs);
      names = darwinBrowserCache;
    }
  } else if (platform === 'linux') {
    names = await detectBrowsersLinux(pathDirs || (process.env.PATH || '').split(path.delimiter).filter(Boolean));
  }
  return ['default', ...names];
}

module.exports = {
  detectBrowsers, bundleClaimsHttpScheme, lsHandlerIsDefault, detectMdHandlerDefault,
  _resetMdHandlerCache, _setMdHandlerCacheTestHooks,
};
