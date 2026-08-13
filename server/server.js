'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const proc = require('./proc.js');
const { createDocumentStore, safeResolve, classifyRootTarget, isMarkdownFile } = require('./documents.js');
const { defaultRevealFile, defaultOpenInfoWindow } = require('./reveal.js');
const { createFolderPicker } = require('./folder-picker.js');
const settings = require('./settings.js');
const ports = require('./ports.js');
const { discoverRegistry } = require('./registry.js');
const recents = require('./recents.js');
const { getSettingsView } = require('./settings-view.js');
const updateCheck = require('./update-check.js');
const { createUpdateController } = require('./updater.js');
const history = require('./history.js');
const installers = require('./install-app.js');
const { resolveContext, rootInfo } = require('./route-request.js');
const { shapeVersionResponse, getInstanceMetadata, CAPABILITIES, DEFAULT_MODE } = require('./protocol.js');
const { writeRestartHandoff, adoptRestartHandoff, cleanupRestartHandoffs, restartDir } = require('./restart-handoff.js');
const { createRootManager } = require('./root-manager.js');
const { createRootRuntime } = require('./root-runtime.js');
const { isRootKey } = require('./root-identity.js');
const { createRouteResolutionDependencies } = require('./route-resources.js');
const { resolveRouteResources, mapRouteResolutionToHttp } = require('./route-resolution.js');
const { parseRouteContext, formatRouteContext } = require('./route-context.js');
const { createSkillsContextRegistry } = require('./skills-context-registry.js');
const { newContextKey, skillsSpace, agentsSpace } = require('./spaces.js');

const MAX_CONTEXT_PROJECT_DIRS = 32;
// Document verbs address one file inside a space; the rest of the query is the
// space selection itself and stays under the route parser's strict grammar.
const DOCUMENT_PARAMS = ['id', 'rev', 'repo'];
const pendingServerCleanups = new Set();

async function drainServerCleanups() {
  while (pendingServerCleanups.size) await Promise.allSettled(pendingServerCleanups);
}

function installFnFor(platform) {
  return { darwin: installers.installApp, win32: installers.installAppWin, linux: installers.installAppLinux }[platform] || null;
}

// Restart with saved settings, not an inherited --port, and reuse the open tab.
function restartArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') { i++; continue; }
    if (a.startsWith('--port=')) continue;
    out.push(a);
  }
  if (!out.includes('--no-open')) out.push('--no-open');
  return out;
}

const CLIENT_DIR = path.join(__dirname, '..', 'client');
const SHELL_PATH = path.join(CLIENT_DIR, 'index.html');
const VENDOR_DIR = path.join(CLIENT_DIR, 'dist', 'vendor');
const MARKDOWN_IT_UMD = path.join(VENDOR_DIR, 'markdown-it.min.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// trust boundary: vendor serving is allowlist-only — every entry is a fixed
// file copied into client/dist/vendor at build time (scripts/vendor.js)
const VENDOR_FILES = {};
for (const rel of [
  'mermaid/mermaid.min.js',
  'katex/katex.min.js',
  'katex/katex.min.css',
]) {
  VENDOR_FILES[rel] = { file: path.join(VENDOR_DIR, ...rel.split('/')), type: MIME[path.extname(rel)] };
}
const KATEX_FONTS_DIR = path.join(VENDOR_DIR, 'katex', 'fonts');
const FONT_MIME = { '.woff2': 'font/woff2' };

// Package managers replace files in place. Keep every shell and lazy asset on
// the build this process booted with so an old server can never serve a newer,
// incompatible client halfway through an upgrade.
function snapshotTree(dir, base = dir, out = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) snapshotTree(full, base, out);
    else if (entry.isFile()) out.set(path.relative(base, full).split(path.sep).join('/'), fs.readFileSync(full));
  }
  return out;
}

const CLIENT_BUILD = snapshotTree(CLIENT_DIR);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const ERROR_STATUS = {
  forbidden: [403, 'forbidden'],
  not_found: [404, 'not found'],
  invalid_rev: [400, 'invalid rev'],
  unavailable: [503, 'history unavailable'],
  write_failed: [500, 'write failed'],
  no_root: [409, 'no root set'],
  invalid_json: [400, 'invalid json body'],
};

// Mark rootless HTML so the launcher appears on first paint.
function renderShell(html, boot, { launcherBoot = false } = {}) {
  if (launcherBoot) {
    html = html.replace('<body>', '<body class="launcher launcher-boot">');
  }
  // Stamp explicit themes for first paint; system mode already follows the OS.
  if (boot.settings.colorMode === 'light' || boot.settings.colorMode === 'dark') {
    html = html.replace('<html lang="en">', `<html lang="en" data-theme="${boot.settings.colorMode}">`);
  }
  const bootJSON = JSON.stringify(boot).replace(/</g, '\\u003c');
  html = html.replace('<script type="module"', `<script type="application/json" id="boot-data">${bootJSON}</script>\n<script type="module"`);
  return html;
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function sendFile(res, filePath, contentType, headers = {}) {
  const body = await fsp.readFile(filePath);
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length, ...headers });
  res.end(body);
}

async function sendFileOr404(res, filePath, contentType, headers = {}) {
  try {
    return await sendFile(res, filePath, contentType, headers);
  } catch {
    return sendError(res, { code: 'not_found' });
  }
}

function sendBuildAssetOr404(res, rel, contentType, headers = {}) {
  const body = CLIENT_BUILD.get(rel);
  if (!body) return sendError(res, { code: 'not_found' });
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length, ...headers });
  return res.end(body);
}

function shapeRootSummary(root) {
  return { key: root.key, dir: root.dir, name: root.name, url: `/r/${root.key}/` };
}

function sendError(res, result) {
  const [status, message] = ERROR_STATUS[result.code];
  return sendJSON(res, status, { error: message });
}

function sendText(res, text, headers = {}) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  return res.end(text);
}

function broadcastSSE(clients, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

function findRoute(routes, method, pathname, url) {
  for (const route of routes) {
    if (route.method && route.method !== method) continue;
    if (route.match(pathname, url)) return route;
  }
  return null;
}

const ROOT_SCOPED_TAILS = new Set(['tree', 'raw', 'asset', 'history', 'diff', 'restore', 'reveal']);

// Split before decoding so encoded slashes cannot become route separators.
function matchRootScopedPath(rawPathname) {
  const parts = rawPathname.split('/');
  if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'roots') return null;
  let key, tail;
  try {
    key = decodeURIComponent(parts[3]);
    tail = decodeURIComponent(parts[4]);
  } catch {
    return null;
  }
  if (!isRootKey(key) || !ROOT_SCOPED_TAILS.has(tail)) return null;
  return { key, tail };
}

const AGENT_SCOPED_TAILS = new Set(['tree', 'raw', 'asset', 'history', 'diff', 'restore', 'reveal']);

function matchAgentScopedPath(rawPathname) {
  const parts = rawPathname.split('/');
  if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'agents') return null;
  let agentKey, tail;
  try {
    agentKey = decodeURIComponent(parts[3]);
    tail = decodeURIComponent(parts[4]);
  } catch {
    return null;
  }
  if (!agentKey || !AGENT_SCOPED_TAILS.has(tail)) return null;
  return { agentKey, tail };
}

// Same still-encoded-first split as matchRootScopedPath, for the bare
// /api/roots/:key path (no tail) that DELETE closes.
function matchRootKeyPath(rawPathname) {
  const parts = rawPathname.split('/');
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'roots') return null;
  let key;
  try {
    key = decodeURIComponent(parts[3]);
  } catch {
    return null;
  }
  return isRootKey(key) ? key : null;
}

async function symlinkHeaders(docs, full) {
  const info = await docs.symlinkInfo(full);
  if (!info) return {};
  const headers = { 'X-Showmd-Symlink': '1', 'X-Showmd-Symlink-Target': encodeURIComponent(info.target) };
  if (info.docId) headers['X-Showmd-Symlink-Doc'] = encodeURIComponent(info.docId);
  return headers;
}

const ASSET_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

// A null boot root starts launcher mode; RootManager owns runtime roots.
function createServer(root, {
  skillsContexts = [], revealFile = defaultRevealFile, openInfoFn = defaultOpenInfoWindow, platform = process.platform, warmPickerOnStart = false,
  installFn, appStatusFn, registerMdFn, restartFn, mdHandlerDefaultFn, folderPickerFactory = createFolderPicker, initialDoc = null,
  cliPath = process.argv[1] || '', selfHealOnBoot = false, selfHealFn, exitFn = process.exit, mode = DEFAULT_MODE,
  launchDetachedFn = proc.launchDetached, statFn = fsp.stat, updateRunFn,
  updateOnVerifiedFn, updateInfoFn = updateCheck.updateInfo,
} = {}) {
  const folderPicker = folderPickerFactory({ platform });
  // shutdown must wait for warm-up: osacompile keeps writing the helper
  // bundle after the process is told to exit, racing external cleanup
  const pickerWarm = (warmPickerOnStart && platform === 'darwin'
    ? Promise.resolve(folderPicker.warm())
    : Promise.resolve()
  ).catch(() => {});
  // silent and once per boot: cheap because generation is local, safe because
  // selfHealApp only touches a bundle it can prove we built
  if (selfHealOnBoot) {
    try {
      (selfHealFn || installers.selfHealApp)(platform, { installFn, appStatusFn });
    } catch {}
  }
  let roots = root === null ? [] : [{ key: null, dir: path.resolve(root), label: null }];
  const bootedRootless = root === null;
  const storeConfig = { addressing: 'relative' };
  // RootManager/RootRuntime is the sole store+watcher owner for every root,
  // including the boot root.
  const rootlessStore = createDocumentStore([], storeConfig);
  let primaryRuntime = null;
  // snapshot of the settings this process actually booted with, so the
  // client can tell "saved" and "running" apart and flag a restart
  const effectiveSettingsPromise = settings.readSettings();

  const sseClients = new Set();

  const skillsContextRegistry = createSkillsContextRegistry(skillsContexts);

  const rootManager = createRootManager({
    createRuntime: (target) => createRootRuntime(target, {
      onChange: ({ root, path: id, event }) => broadcastSSE(sseClients, { rootKey: root.key, path: id, event }),
      onRootRemoved: (root) => handleRootVanished(root),
    }),
  });

  // chokidar reports unlinkDir for the watched root itself on delete, move,
  // or unmount; without this a tab would keep pointing at a dead root
  async function handleRootVanished(root) {
    const result = await rootManager.remove(root.key).catch(() => ({ removed: false }));
    if (result.removed) broadcastSSE(sseClients, { rootKey: root.key, path: null, event: 'root-removed' });
    await removeRecent(root.dir);
  }

  // stale handoffs (crashed restart, abandoned temp file) never get their own
  // cleanup pass otherwise — same spirit as ports.js sweeping dead pids
  cleanupRestartHandoffs(restartDir()).catch(() => {});

  const bootRootReady = (async () => {
    if (roots.length === 1) {
      try {
        const result = await rootManager.add(roots[0].dir);
        primaryRuntime = rootManager.getRuntime(result.root.key);
      } catch (err) {
        console.error(`showmd: failed to register boot root with RootManager: ${err.message}`);
      }
    }
    const handoffPath = process.env.SHOWMD_RESTART_HANDOFF;
    if (!handoffPath) return;
    try {
      const result = await adoptRestartHandoff(handoffPath, {
        newInstance: getInstanceMetadata(),
        async adopt(snapshot) {
          for (const snapshotRoot of snapshot.roots) {
            await rootManager.add(snapshotRoot.dir);
          }
          for (const context of snapshot.skillsContexts) skillsContextRegistry.register(context);
        },
      });
      if (result.kind !== 'adopted') {
        console.error(`showmd: restart handoff not adopted (${result.kind})`);
      }
    } catch (err) {
      console.error(`showmd: restart handoff adoption errored: ${err.message}`);
    }
  })();

  function currentStore() {
    return primaryRuntime ? primaryRuntime.store : rootlessStore;
  }

  // guards /api/shutdown and /api/restart against firing twice on concurrent
  // requests — both end the process, so a second call is a no-op, not an error
  let stopping = false;
  let updateToken = randomUUID();

  // Serialize Recents writes so reads never overtake boot recording.
  let recentsWrite = Promise.resolve();
  function recordRecent(p) {
    recentsWrite = recentsWrite.then(() => recents.add(p)).catch(() => {});
    return recentsWrite;
  }

  function removeRecent(p) {
    recentsWrite = recentsWrite.then(() => recents.remove(p)).catch(() => {});
    return recentsWrite;
  }

  async function listRecents() {
    await recentsWrite;
    const entries = [];
    for (const entry of await recents.list()) {
      let st;
      try {
        st = await statFn(entry.path);
      } catch (err) {
        if (err.code === 'ENOENT') { await removeRecent(entry.path); continue; }
        entries.push({ path: entry.path, ts: entry.ts, kind: isMarkdownFile(entry.path) ? 'file' : 'folder' });
        continue;
      }
      entries.push({ path: entry.path, ts: entry.ts, kind: st.isDirectory() ? 'folder' : 'file' });
    }
    return entries;
  }

  // Record real boot targets in Recents, but not the rootless launcher.
  if (roots.length) {
    recordRecent(roots[0].dir);
    if (initialDoc) recordRecent(path.join(roots[0].dir, initialDoc));
  }

  // Snapshot roots and Skills contexts for the detached replacement process.
  async function writeRuntimeHandoff(newInstance) {
    const snapshotPath = path.join(restartDir(), `restart-${newInstance.instanceId}.json`);
    const metadata = getInstanceMetadata();
    const state = {
      oldInstance: { instanceId: metadata.instanceId, pid: process.pid, startedAt: metadata.startedAt, actualPort: server.address().port },
      newInstance,
      roots: rootManager.list(),
      skillsContexts: skillsContextRegistry.list(),
    };
    await writeRestartHandoff(snapshotPath, state);
    return snapshotPath;
  }

  async function defaultRestart(replacementLaunch = null, beforeClose = null) {
    const argv = replacementLaunch
      ? [...replacementLaunch.prefixArgs, ...restartArgv(process.argv.slice(2))]
      : restartArgv(process.argv.slice(1));
    const command = replacementLaunch ? replacementLaunch.command : process.execPath;
    const newInstanceId = randomUUID();
    let snapshotPath;
    try {
      snapshotPath = await writeRuntimeHandoff({
        instanceId: newInstanceId,
        // Adoption matches instanceId, so PID may be a placeholder before spawn.
        pid: 1,
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`showmd: failed to write restart handoff: ${err.message}`);
      if (replacementLaunch) throw err;
    }
    launchDetachedFn(command, argv, {
      cwd: process.cwd(),
      env: { ...process.env, SHOWMD_INSTANCE_ID: newInstanceId, SHOWMD_RESTART_HANDOFF: snapshotPath },
    }).unref();
    if (beforeClose) beforeClose();
    server.close(() => server.whenClosed().then(() => exitFn(0)));
    // as in /api/shutdown: a keep-alive socket or a missed SSE stream would
    // otherwise block close()'s callback forever
    server.closeAllConnections();
  }
  const restart = restartFn || defaultRestart;
  const updateController = createUpdateController({
    channel: installers.installChannel(cliPath),
    cliPath,
    ...(updateRunFn ? { run: updateRunFn } : {}),
    onVerified: async (result) => {
      if (updateOnVerifiedFn) return updateOnVerifiedFn(result);
      stopping = true;
      try {
        const { port: replacementPort } = await settings.readSettings();
        await defaultRestart(result.launch, () => {
          broadcastSSE(sseClients, { event: 'server-restarting', port: replacementPort });
          for (const client of sseClients) client.end();
        });
      } catch (err) {
        stopping = false;
        throw err;
      }
    },
  });

  const routeResolutionDependencies = createRouteResolutionDependencies({ rootManager, skillsContextRegistry });

  function rootScopedRootOr404(res, key) {
    const outcome = resolveRouteResources({ space: 'root', rootKey: key }, routeResolutionDependencies);
    if (outcome.kind !== 'resolved') {
      const http = mapRouteResolutionToHttp(outcome);
      sendJSON(res, http.status, http.body);
      return null;
    }
    return outcome.resources.root;
  }

  // The Skills selectors are the same strict grammar the /skills/ page uses, so
  // the route parser validates them instead of a second ad-hoc query check.
  function skillsSelection(url) {
    const params = new URLSearchParams(url.search);
    for (const key of DOCUMENT_PARAMS) params.delete(key);
    const query = params.toString();
    return parseRouteContext(new URL(`/skills/${query ? `?${query}` : ''}`, 'http://showmd.local'));
  }

  async function skillsSpaceOr4xx(res, url) {
    const context = skillsSelection(url);
    if (!context) {
      sendJSON(res, 400, { error: 'invalid_skills_selection' });
      return null;
    }
    await bootRootReady;
    const outcome = resolveRouteResources(context, routeResolutionDependencies);
    if (outcome.kind !== 'resolved') {
      const http = mapRouteResolutionToHttp(outcome);
      sendJSON(res, http.status, http.body);
      return null;
    }
    const { root, skillsContext } = outcome.resources;
    return skillsSpace(context, {
      rootDir: root ? root.dir : undefined,
      projectDirs: skillsContext ? skillsContext.projectDirs : [],
      cwd: root ? root.dir : process.cwd(),
    });
  }

  async function agentsSpaceOr4xx(res, url, agentKey) {
    const params = new URLSearchParams(url.search);
    for (const key of DOCUMENT_PARAMS) params.delete(key);
    const query = params.toString();
    const context = parseRouteContext(
      new URL(`/agents/${encodeURIComponent(agentKey)}/${query ? `?${query}` : ''}`, 'http://showmd.local'),
    );
    if (!context) {
      sendJSON(res, 400, { error: 'invalid_agents_selection' });
      return null;
    }
    await bootRootReady;
    const outcome = resolveRouteResources(context, routeResolutionDependencies);
    if (outcome.kind !== 'resolved') {
      const http = mapRouteResolutionToHttp(outcome);
      sendJSON(res, http.status, http.body);
      return null;
    }
    const space = await agentsSpace(context, { rootDir: outcome.resources.root ? outcome.resources.root.dir : undefined });
    if (!space) {
      sendJSON(res, 404, { error: 'unknown_agent', agentKey });
      return null;
    }
    return space;
  }

  function rootStoreOr4xx(res, url) {
    const match = matchRootScopedPath(url.pathname);
    if (!match) return null;
    const root = rootScopedRootOr404(res, match.key);
    if (!root) return null;
    return rootManager.getRuntime(match.key).store;
  }

  // Each Space provides only its route shape and a store resolver. Document
  // verbs themselves stay here, so their headers and errors cannot drift.
  function spaceDocumentRoutes({ tailOf, idOf, resolveStore }) {
    const on = (tail) => (pathname, url) => tailOf(url) === tail;
    return [
      { method: 'GET', match: on('raw'), handler: async ({ res, url }) => {
        const store = await resolveStore(res, url);
        if (!store) return;
        const result = await store.read(idOf(url));
        if (!result.ok) return sendError(res, result);
        return sendText(res, result.text, await symlinkHeaders(store, result.full));
      } },

      { method: 'PUT', match: on('raw'), needs: ['rawBody'], handler: async ({ res, url, rawBody }) => {
        const store = await resolveStore(res, url);
        if (!store) return;
        const result = await store.write(idOf(url), rawBody);
        if (!result.ok) return sendError(res, result);
        res.writeHead(204);
        return res.end();
      } },

      { method: 'GET', match: on('asset'), handler: async ({ res, url }) => {
        const store = await resolveStore(res, url);
        if (!store) return;
        const loc = store.resolveAsset(idOf(url));
        if (!loc) return sendError(res, { code: 'forbidden' });
        const ext = path.extname(loc.rel).toLowerCase();
        const type = ASSET_MIME[ext];
        if (!type) return sendError(res, { code: 'not_found' });
        const headers = { 'X-Content-Type-Options': 'nosniff' };
        if (ext === '.svg') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
        return await sendFileOr404(res, loc.full, type, headers);
      } },

      { method: 'GET', match: on('history'), handler: async ({ res, url }) => {
        const store = await resolveStore(res, url);
        if (!store) return;
        const result = await store.timeline(idOf(url));
        return result.ok ? sendJSON(res, 200, result.entries) : sendError(res, result);
      } },

      { method: 'GET', match: on('diff'), handler: async ({ res, url }) => {
        const store = await resolveStore(res, url);
        if (!store) return;
        const result = await store.diff(idOf(url), url.searchParams.get('rev') || '', url.searchParams.get('repo') === '1');
        return result.ok ? sendText(res, result.text) : sendError(res, result);
      } },

      { method: 'POST', match: on('restore'), handler: async ({ res, url }) => {
        const store = await resolveStore(res, url);
        if (!store) return;
        const result = await store.restore(idOf(url), url.searchParams.get('rev') || '', url.searchParams.get('repo') === '1');
        if (!result.ok) return sendError(res, result);
        res.writeHead(204);
        return res.end();
      } },

      { method: 'POST', match: on('reveal'), handler: async ({ res, url }) => {
        const store = await resolveStore(res, url);
        if (!store) return;
        const result = await store.reveal(idOf(url));
        if (!result.ok) return sendError(res, result);
        revealFile(result.full);
        res.writeHead(204);
        return res.end();
      } },
    ];
  }

  const routes = [
    { method: 'GET', match: (pathname) => pathname === '/api/version', handler: async (ctx) => {
      // Launcher capability reflects boot shape, even after a root is picked.
      return sendJSON(ctx.res, 200, shapeVersionResponse({
        version: require('../package.json').version,
        launcher: bootedRootless,
        actualPort: server.address().port,
        mode,
        capabilities: [CAPABILITIES.ROOTS_V1, CAPABILITIES.SPACES_V1],
      }));
    } },

    { method: 'GET', match: (pathname) => pathname === '/api/update', handler: async (ctx) => {
      return sendJSON(ctx.res, 200, updateController.getState());
    } },

    { method: 'POST', match: (pathname) => pathname === '/api/update', needs: ['body'], handler: async (ctx) => {
      const { res, body } = ctx;
      if (body.token !== updateToken) return sendJSON(res, 403, { error: 'invalid update token' });
      const available = updateInfoFn();
      if (!available.updateAvailable || !available.latestVersion) {
        return sendJSON(res, 409, { error: 'no update available' });
      }
      updateToken = randomUUID();
      const result = updateController.start(available.latestVersion);
      return sendJSON(res, result.started ? 202 : 200, { ...result.state, token: updateToken });
    } },

    // Any live server returns the same ordered registry.
    { method: 'GET', match: (pathname) => pathname === '/api/registry', handler: async (ctx) => {
      const configuredPortParam = ctx.url.searchParams.get('configuredPort');
      const configuredPort = configuredPortParam ? Number(configuredPortParam) : undefined;
      return sendJSON(ctx.res, 200, await discoverRegistry({ configuredPort }));
    } },

    { method: 'GET', match: (pathname) => pathname === '/api/settings', handler: async (ctx) => {
      const { res, url } = ctx;
      // Reject a closed root even though settings are no longer root-scoped.
      const key = url.searchParams.get('root');
      if (key && !rootScopedRootOr404(res, key)) return;
      return sendJSON(res, 200, await getSettingsView({
        platform, appStatusFn, mdHandlerDefaultFn, effectiveSettingsPromise, cliPath, updateToken,
      }));
    } },

    // Fetch slow history-size queries separately from settings and boot.
    { method: 'GET', match: (pathname) => pathname === '/api/history-size', handler: async (ctx) => {
      const { res, url } = ctx;
      const key = url.searchParams.get('root');
      let rootDir = null;
      if (key) {
        const root = rootScopedRootOr404(res, key);
        if (!root) return;
        rootDir = root.dir;
      }
      const [historySizeBytes, historyTotalBytes] = await Promise.all([
        rootDir ? history.historySize(rootDir) : null,
        history.totalHistorySize(),
      ]);
      return sendJSON(res, 200, { historySizeBytes, historyTotalBytes });
    } },

    { method: 'PUT', match: (pathname) => pathname === '/api/settings', needs: ['body'], handler: async (ctx) => {
      return sendJSON(ctx.res, 200, await settings.writeSettings(ctx.body));
    } },

    // Derive prune paths internally; the body only selects an open root or all.
    { method: 'POST', match: (pathname) => pathname === '/api/prune', needs: ['body'], handler: async (ctx) => {
      const { res, body } = ctx;
      const scope = body.scope || 'root';
      if (scope !== 'root' && scope !== 'all') return sendJSON(res, 400, { error: 'invalid scope' });
      if (scope === 'root' && !body.rootKey) return sendJSON(res, 400, { error: 'rootKey required' });
      const root = scope === 'root' ? rootScopedRootOr404(res, body.rootKey) : null;
      if (scope === 'root' && !root) return;
      try {
        if (scope === 'all') await history.pruneAll();
        else await history.prune(root.dir);
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
      return sendJSON(res, 200, { ok: true });
    } },

    { method: 'POST', match: (pathname) => pathname === '/api/install-app', handler: async (ctx) => {
      const { res } = ctx;
      const fn = installFn || installFnFor(platform);
      if (!fn) return sendJSON(res, 501, { error: 'unsupported platform' });
      try {
        const result = fn();
        return sendJSON(res, 200, { ok: true, dest: result.dest, ephemeral: result.ephemeral });
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
    } },

    { method: 'POST', match: (pathname) => pathname === '/api/register-markdown', handler: async (ctx) => {
      const { res } = ctx;
      if (platform !== 'darwin') return sendJSON(res, 501, { error: 'unsupported platform' });
      const fn = registerMdFn || installers.registerMarkdownHandler;
      let result;
      try {
        result = fn();
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
      // best-effort nudge: registration itself already succeeded, so a
      // missing .md file or a Finder that won't cooperate still reports 200
      let opened = false;
      try {
        await bootRootReady;
        const store = currentStore();
        const mdFiles = roots.length === 0 ? [] : await store.walkMd(roots[0].dir, roots[0].dir, []);
        const loc = mdFiles.length ? store.resolveAsset(mdFiles[0]) : null;
        if (loc) opened = await openInfoFn(loc.full);
      } catch {}
      return sendJSON(res, 200, { ok: true, dest: result.dest, opened });
    } },

    { method: 'POST', match: (pathname) => pathname === '/api/restart', handler: (ctx) => {
      sendJSON(ctx.res, 200, { ok: true });
      if (stopping) return;
      stopping = true;
      // Broadcast the replacement port before scheduling shutdown.
      settings.readSettings()
        .then(({ port }) => {
          broadcastSSE(sseClients, { event: 'server-restarting', port });
          for (const res of sseClients) res.end();
        })
        .catch(() => {})
        .finally(() => setImmediate(restart));
    } },

    // A newly invoked CLI can take ownership itself. The request names only
    // its identity; the running process chooses the snapshot path and executes
    // no browser-supplied program or arguments.
    { method: 'POST', match: (pathname) => pathname === '/api/runtime-handoff', needs: ['body'], handler: async (ctx) => {
      const { res, body } = ctx;
      const validId = typeof body.instanceId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.instanceId);
      const validPid = Number.isInteger(body.pid) && body.pid > 0 && body.pid <= 0x7fffffff;
      const validStartedAt = typeof body.startedAt === 'string' && !Number.isNaN(Date.parse(body.startedAt));
      if (!validId || !validPid || !validStartedAt) return sendJSON(res, 400, { error: 'invalid replacement identity' });
      if (stopping) return sendJSON(res, 409, { error: 'already stopping' });

      let snapshotPath;
      try {
        snapshotPath = await writeRuntimeHandoff({
          instanceId: body.instanceId,
          pid: body.pid,
          startedAt: body.startedAt,
        });
      } catch {
        return sendJSON(res, 500, { error: 'handoff failed' });
      }

      stopping = true;
      sendJSON(res, 200, { handoffPath: snapshotPath, port: server.address().port });
      broadcastSSE(sseClients, { event: 'server-restarting', port: server.address().port });
      for (const client of sseClients) client.end();
      res.once('finish', () => {
        server.close(() => server.whenClosed().then(() => exitFn(0)));
        server.closeAllConnections();
      });
    } },

    { method: 'POST', match: (pathname) => pathname === '/api/shutdown', handler: async (ctx) => {
      const { res } = ctx;
      sendJSON(res, 200, { ok: true });
      if (stopping) return;
      stopping = true;
      res.once('finish', () => {
        // close() waits for every socket to drain; keep-alive sockets and open
        // SSE streams never do, so destroy them or 'close' never fires
        server.close(() => server.whenClosed().then(() => exitFn(0)));
        server.closeAllConnections();
      });
    } },

    { method: 'POST', match: (pathname) => pathname === '/api/reveal', handler: async (ctx) => {
      const { res, url } = ctx;
      if (url.searchParams.get('settings') === '1') {
        revealFile(settings.settingsFile());
        res.writeHead(204);
        return res.end();
      }
      return sendError(res, { code: 'not_found' });
    } },

    { method: 'GET', match: (pathname) => pathname === '/api/roots', handler: async (ctx) => {
      await bootRootReady;
      return sendJSON(ctx.res, 200, { roots: rootManager.list().map(shapeRootSummary) });
    } },

    { method: 'POST', match: (pathname) => pathname === '/api/pick-folder', needs: ['body'], handler: async (ctx) => {
      const { res, body } = ctx;
      const mode = body.mode === 'file' || body.mode === 'folder' ? body.mode : undefined;
      if (!mode) return sendJSON(res, 400, { error: 'invalid mode' });
      const startDir = typeof body.startDir === 'string' ? body.startDir : undefined;
      let picked;
      try {
        picked = await folderPicker.pick(mode, startDir);
      } catch {
        return sendJSON(res, 500, { error: 'picker failed' });
      }
      if (picked === undefined) return sendJSON(res, 501, { error: 'picker unsupported on this platform' });
      if (picked === null) return sendJSON(res, 200, { canceled: true });
      return sendJSON(res, 200, { path: picked });
    } },

    // Classify folders as roots and markdown files as documents within a root.
    { method: 'POST', match: (pathname) => pathname === '/api/roots', needs: ['body'], handler: async (ctx) => {
      const { res, body } = ctx;
      await bootRootReady;
      if (typeof body.path !== 'string' || !body.path) return sendJSON(res, 400, { error: 'invalid path' });
      const classified = await classifyRootTarget(body.path);
      if (!classified) return sendJSON(res, 400, { error: 'not a directory or markdown file' });
      const { dir, doc } = classified;
      let result;
      try {
        result = await rootManager.add(dir);
      } catch {
        return sendJSON(res, 400, { error: 'not a directory or does not exist' });
      }
      if (result.kind === 'promoted') {
        const newRoot = shapeRootSummary(result.root);
        for (const { oldRoot, scope } of result.promoted) {
          broadcastSSE(sseClients, { event: 'root-promoted', rootKey: oldRoot.key, newRoot, scope });
        }
      }
      // Await recording so a successful response guarantees durable Recents state.
      await recordRecent(dir);
      const routeContext = { space: 'root', rootKey: result.root.key };
      if (doc) {
        await recordRecent(path.join(dir, doc));
        routeContext.documentPath = result.scope.scopePath ? `${result.scope.scopePath}/${doc}` : doc;
        if (result.scope.scopePath) routeContext.scopePath = result.scope.scopePath;
      } else if (result.scope.scopePath) {
        routeContext.scopePath = result.scope.scopePath;
      }
      return sendJSON(res, 200, { root: shapeRootSummary(result.root), scope: result.scope, url: formatRouteContext(routeContext) });
    } },

    { method: 'DELETE', match: (pathname, url) => matchRootKeyPath(url.pathname) !== null, handler: async (ctx) => {
      const { res, url } = ctx;
      await bootRootReady;
      const key = matchRootKeyPath(url.pathname);
      const result = await rootManager.remove(key);
      if (!result.removed) return sendJSON(res, 404, { error: 'root_not_open', rootKey: key });
      broadcastSSE(sseClients, { rootKey: key, path: null, event: 'root-removed' });
      return sendJSON(res, 200, { ok: true, root: shapeRootSummary(result.root) });
    } },

    { method: 'GET', match: (pathname, url) => matchRootScopedPath(url.pathname)?.tail === 'tree', handler: async (ctx) => {
      const { res, url } = ctx;
      const { key } = matchRootScopedPath(url.pathname);
      const root = rootScopedRootOr404(res, key);
      if (!root) return;
      const outcome = await rootManager.getRuntime(key).store.tree({ scope: url.searchParams.get('scope') });
      if (outcome.ok) return sendJSON(res, 200, outcome.tree);
      if (outcome.code === 'unreadable_root') {
        return sendJSON(res, 500, { error: 'unreadable_root', dir: outcome.dir, code: outcome.errno });
      }
      return sendError(res, outcome);
    } },

    ...spaceDocumentRoutes({
      tailOf: (url) => matchRootScopedPath(url.pathname)?.tail || null,
      idOf: (url) => url.searchParams.get('path') || '',
      resolveStore: rootStoreOr4xx,
    }),

    { method: 'GET', match: (pathname) => pathname === '/api/skills/tree', handler: async (ctx) => {
      const space = await skillsSpaceOr4xx(ctx.res, ctx.url);
      if (!space) return;
      return sendJSON(ctx.res, 200, space.tree);
    } },

    ...spaceDocumentRoutes({
      tailOf: (url) => (url.pathname.startsWith('/api/skills/') ? url.pathname.slice('/api/skills/'.length) : null),
      idOf: (url) => url.searchParams.get('id') || '',
      resolveStore: async (res, url) => (await skillsSpaceOr4xx(res, url))?.store || null,
    }),

    { method: 'GET', match: (pathname, url) => matchAgentScopedPath(url.pathname)?.tail === 'tree', handler: async (ctx) => {
      const { agentKey } = matchAgentScopedPath(ctx.url.pathname);
      const space = await agentsSpaceOr4xx(ctx.res, ctx.url, agentKey);
      if (!space) return;
      return sendJSON(ctx.res, 200, space.tree);
    } },

    ...spaceDocumentRoutes({
      tailOf: (url) => matchAgentScopedPath(url.pathname)?.tail || null,
      idOf: (url) => url.searchParams.get('id') || '',
      resolveStore: async (res, url) => {
        const { agentKey } = matchAgentScopedPath(url.pathname);
        return (await agentsSpaceOr4xx(res, url, agentKey))?.store || null;
      },
    }),

    { method: 'POST', match: (pathname) => pathname === '/api/skills/contexts', needs: ['body'], handler: async (ctx) => {
      const { res, body } = ctx;
      const dirs = body.projectDirs;
      if (!Array.isArray(dirs) || !dirs.length || dirs.length > MAX_CONTEXT_PROJECT_DIRS
        || dirs.some((dir) => typeof dir !== 'string' || !dir)) {
        return sendJSON(res, 400, { error: 'invalid_project_dirs' });
      }
      const resolved = [];
      for (const dir of dirs) {
        const full = path.resolve(dir);
        const st = await fsp.stat(full).catch(() => null);
        if (!st || !st.isDirectory()) return sendJSON(res, 400, { error: 'invalid_project_dirs', path: dir });
        resolved.push(full);
      }
      const contextKey = newContextKey();
      skillsContextRegistry.register({ key: contextKey, projectDirs: resolved });
      return sendJSON(res, 201, {
        contextKey,
        url: formatRouteContext({ space: 'skills', selection: 'context', contextKey }),
      });
    } },

    // works rootless (launcher, before a folder is picked) and rooted alike
    { method: 'GET', match: (pathname) => pathname === '/api/recents', handler: async (ctx) => {
      return sendJSON(ctx.res, 200, { recents: await listRecents() });
    } },

    { method: 'POST', match: (pathname) => pathname === '/api/recents/delete', needs: ['body'], handler: async (ctx) => {
      const { res, body } = ctx;
      if (typeof body.path !== 'string' || !body.path) return sendJSON(res, 400, { error: 'invalid path' });
      await recentsWrite;
      await removeRecent(body.path);
      res.writeHead(204);
      return res.end();
    } },

    { method: 'GET', match: (pathname) => pathname === '/api/events', handler: async (ctx) => {
      const { req, res } = ctx;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
    } },

    { method: 'GET', match: (pathname) => pathname.startsWith('/assets/vendor/'), handler: async (ctx) => {
      const { res, pathname } = ctx;
      const rel = pathname.slice('/assets/vendor/'.length);
      const entry = VENDOR_FILES[rel];
      if (entry) {
        return sendBuildAssetOr404(res, path.relative(CLIENT_DIR, entry.file).split(path.sep).join('/'), entry.type);
      }
      if (rel.startsWith('katex/fonts/')) {
        const fname = rel.slice('katex/fonts/'.length);
        const ext = path.extname(fname);
        if (fname.includes('/') || !FONT_MIME[ext]) return sendJSON(res, 403, { error: 'forbidden' });
        const full = safeResolve(KATEX_FONTS_DIR, fname);
        if (!full) return sendJSON(res, 403, { error: 'forbidden' });
        return sendBuildAssetOr404(res, path.relative(CLIENT_DIR, full).split(path.sep).join('/'), FONT_MIME[ext]);
      }
      return sendError(res, { code: 'not_found' });
    } },

    { method: 'GET', match: (pathname) => pathname.startsWith('/assets/'), handler: async (ctx) => {
      const { res, pathname } = ctx;
      const rel = pathname.slice('/assets/'.length);
      if (rel === 'markdown-it.min.js') {
        return sendBuildAssetOr404(res, path.relative(CLIENT_DIR, MARKDOWN_IT_UMD).split(path.sep).join('/'), 'text/javascript; charset=utf-8');
      }
      const full = safeResolve(CLIENT_DIR, rel);
      const ext = path.extname(rel);
      const type = MIME[ext] || ASSET_MIME[ext];
      if (!full || !type) return sendError(res, { code: 'not_found' });
      // A replacement process serves new bytes at the same URLs; force tabs to
      // revalidate after handoff instead of keeping the prior build cached.
      return sendBuildAssetOr404(res, rel, type, { 'Cache-Control': 'no-cache' });
    } },

    { method: 'GET', match: (pathname) => pathname === '/favicon.ico', handler: async (ctx) => {
      return sendBuildAssetOr404(ctx.res, 'favicon-32.png', 'image/png');
    } },

    { method: 'GET', match: () => true, handler: async (ctx) => {
      const { res, url } = ctx;
      const template = CLIENT_BUILD.get(path.relative(CLIENT_DIR, SHELL_PATH).split(path.sep).join('/')).toString('utf8');
      // Inline boot data to avoid theme flashes and late Recents layout.
      const boot = {};
      boot.recents = await listRecents();
      boot.root = rootInfo(roots);
      await bootRootReady;
      boot.roots = rootManager.list().map(shapeRootSummary);
      // Parse the original URL so encoded slashes remain within route segments.
      const parsedRoute = parseRouteContext(url);
      if (!parsedRoute) {
        boot.route = { space: 'home' };
        boot.routeError = { kind: 'unroutable', requested: url.pathname };
      } else {
        boot.route = parsedRoute;
        if (parsedRoute.space === 'root' || parsedRoute.rootKey) {
          const outcome = resolveRouteResources({ space: 'root', rootKey: parsedRoute.rootKey }, routeResolutionDependencies);
          if (outcome.kind === 'root_not_open') {
            boot.routeError = { kind: 'root_not_open', rootKey: outcome.rootKey };
          }
        }
      }
      boot.settings = await getSettingsView({
        platform, appStatusFn, mdHandlerDefaultFn, effectiveSettingsPromise, cliPath, updateToken,
      });
      const html = renderShell(template, boot, { launcherBoot: boot.roots.length === 0 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      return res.end(html);
    } },
  ];

  const server = http.createServer(async (req, res) => {
    try {
      // Reject DNS rebinding and cross-origin browser writes on loopback.
      const hostname = (req.headers.host || '').replace(/:\d+$/, '');
      if (!LOOPBACK_HOSTS.has(hostname)) return sendError(res, { code: 'forbidden' });
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
        let originHost = null;
        try { originHost = new URL(req.headers.origin).hostname; } catch {}
        if (!LOOPBACK_HOSTS.has(originHost)) return sendError(res, { code: 'forbidden' });
      }

      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);

      const route = findRoute(routes, req.method, pathname, url);
      if (!route) return sendError(res, { code: 'not_found' });

      const resolved = await resolveContext(route, { req, res, url, pathname });
      if (!resolved.ok) return sendError(res, { code: resolved.error });
      return await route.handler(resolved.ctx);
    } catch (err) {
      console.error(`showmd: request error: ${err.message}`);
      if (!res.headersSent) sendJSON(res, 500, { error: 'internal error' });
    }
  });
  let resolveServerCleanup;
  const serverCleanup = new Promise((resolve) => { resolveServerCleanup = resolve; });
  pendingServerCleanups.add(serverCleanup);
  serverCleanup.finally(() => pendingServerCleanups.delete(serverCleanup));
  server.whenClosed = () => serverCleanup;
  let announcePromise = Promise.resolve(null);
  server.whenAnnounced = () => announcePromise;

  // advisory, for external launchers that need to find a live instance;
  // showmd never reads it back to pick its own port
  server.on('listening', () => {
    announcePromise = ports.announce(server.address().port).catch(() => null);
  });

  server.on('close', () => {
    for (const res of sseClients) res.end();
    Promise.allSettled([
      announcePromise,
      pickerWarm,
      recentsWrite,
      bootRootReady.then(() => Promise.all(rootManager.list().map((openRoot) => rootManager.remove(openRoot.key)))),
    ]).then(([announcement]) => {
      if (announcement.status === 'fulfilled') ports.retract(announcement.value);
      resolveServerCleanup();
    });
  });

  return server;
}

module.exports = { createServer, restartArgv, findRoute, broadcastSSE, drainServerCleanups };
