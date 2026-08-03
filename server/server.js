'use strict';
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createDocumentStore, safeResolve, isMarkdownFile, classifyRootTarget } = require('./documents.js');
const { defaultRevealFile, defaultOpenInfoWindow } = require('./reveal.js');
const { createFolderPicker } = require('./folder-picker.js');
const skills = require('./skills.js');
const agentConfig = require('./agent-config.js');
const settings = require('./settings.js');
const recents = require('./recents.js');
const { getSettingsView } = require('./settings-view.js');
const history = require('./history.js');
const installers = require('./install-app.js');
const { resolveContext, rootInfo } = require('./route-request.js');

function installFnFor(platform) {
  return { darwin: installers.installApp, win32: installers.installAppWin, linux: installers.installAppLinux }[platform] || null;
}

// restart means "come back up on the saved settings" — a stale --port on the
// inherited argv would otherwise outrank the new port on the next boot
// (bin/cli.js gives an explicit --port priority over stored settings), so it
// has to be stripped rather than carried forward. --no-open is forced because
// the browser tab is already open and will reconnect on its own.
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

// launcherBoot marks the shell so app.css/app.js show the launcher from first
// paint instead of flashing doc chrome (see app.css and init()'s early
// removal of the second, JS-stripped launcher-boot marker)
function renderShell(html, boot, { launcherBoot = false } = {}) {
  if (launcherBoot) {
    html = html.replace('<body>', '<body class="launcher launcher-boot">');
  }
  // explicit light/dark gets stamped on <html> so the very first paint is
  // the right palette; 'system' needs nothing — :root's light-dark() +
  // `color-scheme: light dark` already follow the OS pre-JS
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

// `root` is a directory string, an array of `{ key, dir }` groups for
// multi-root mode (`showmd skills`), where file ids are `key/relPath`, or
// `null` for launcher mode (no root picked yet — POST /api/pick-root sets
// one via setRoot). Every route resolves the multi-root prefix back to the
// group's own directory before touching disk, so traversal protection and
// save history stay scoped per root.
function createServer(root, {
  skillsMode, bootView, revealFile = defaultRevealFile, openInfoFn = defaultOpenInfoWindow, platform = process.platform, warmPickerOnStart = false,
  installFn, appStatusFn, registerMdFn, restartFn, mdHandlerDefaultFn, folderPickerFactory = createFolderPicker, initialDoc = null,
  cliPath = process.argv[1] || '', selfHealOnBoot = false, selfHealFn,
} = {}) {
  const folderPicker = folderPickerFactory({ platform });
  if (warmPickerOnStart && platform === 'darwin') folderPicker.warm();
  // silent and once per boot: cheap because generation is local, safe because
  // selfHealApp only touches a bundle it can prove we built
  if (selfHealOnBoot) {
    try {
      (selfHealFn || installers.selfHealApp)(platform, { installFn, appStatusFn });
    } catch {}
  }
  let roots = root === null
    ? []
    : Array.isArray(root)
      ? root.map(({ key, dir, label, project }) => ({ key, dir: path.resolve(dir), label: label || key, project }))
      : [{ key: null, dir: path.resolve(root), label: null }];
  const multi = root === null ? false : !(roots.length === 1 && roots[0].key === null);
  const bootedRootless = root === null;
  const docs = createDocumentStore(roots, multi);
  // snapshot of the settings this process actually booted with, so the
  // client can tell "saved" and "running" apart and flag a restart
  const effectiveSettingsPromise = settings.readSettings();

  const sseClients = new Set();

  // serializes recents.js writes and gives GET /api/recents something to
  // await, so a request landing right after boot or a pick-root never reads
  // a stale list while that write is still in flight
  let recentsWrite = Promise.resolve();
  function recordRecent(p) {
    recentsWrite = recentsWrite.then(() => recents.add(p)).catch(() => {});
    return recentsWrite;
  }

  async function listRecents() {
    await recentsWrite;
    const entries = [];
    for (const entry of await recents.list()) {
      const st = await fsp.stat(entry.path).catch(() => null);
      if (!st) { await recents.remove(entry.path); continue; }
      entries.push({ path: entry.path, ts: entry.ts, kind: st.isDirectory() ? 'folder' : 'file' });
    }
    return entries;
  }

  // a real single-root boot (cli path/file open, Helper double-click) is a
  // recents entry point same as picking one via the launcher — skills-mode
  // (multi) and the rootless launcher boot itself are not
  if (!multi && roots.length) {
    recordRecent(roots[0].dir);
    if (initialDoc) recordRecent(path.join(roots[0].dir, initialDoc));
  }

  const pendingTimers = new Map();

  function startWatchers() {
    if (roots.length === 0) return [];
    // launcher mode boots with zero roots and thus zero watchers — deferring
    // the require here means that boot never pays for chokidar's dependency tree
    const chokidar = require('chokidar');
    // an FSWatcher 'error' with no listener is an uncaught exception, and a
    // folder the process may not read (macOS permissions on a picked folder)
    // raises one — losing the whole server over a watch we can live without
    const survive = (watcher, dir) => watcher.on('error', (err) => {
      console.error(`showmd: stopped watching ${dir}: ${err.message}`);
    });
    return roots.flatMap((r) => {
      const watcher = chokidar.watch(r.dir, {
        ignored: (filePath) => docs.ignorePath(r.dir, filePath),
        ignoreInitial: true,
      });
      watcher.on('all', (event, filePath) => {
        if (!isMarkdownFile(filePath)) return;
        const fullId = docs.idFor(r, filePath);
        clearTimeout(pendingTimers.get(fullId));
        // ownership is decided once the burst has settled, against what is
        // actually on disk — deciding per raw event miscounts either way when
        // the platform coalesces or duplicates them
        pendingTimers.set(fullId, setTimeout(() => {
          pendingTimers.delete(fullId);
          broadcastSSE(sseClients, { path: fullId, event });
          docs.recordIfExternal(fullId);
        }, 100));
      });
      survive(watcher, r.dir);
      if (multi) return [watcher];
      // project skill dirs (.agents/skills, .claude/skills) are dot-prefixed,
      // so the tree watcher above never sees them — docs.ignorePath excludes
      // every dot-segment, and that exclusion is load-bearing for the main
      // watcher (it must not emit SSE/history traffic for skill files). A
      // second, separate watcher busts the skills cache directly instead.
      // ignoreInitial stays off here, unlike the tree watcher above: a file
      // created while chokidar is still scanning is reported as an initial
      // entry and would be swallowed, losing the invalidation for good. The
      // only effect is dropping a cache, so replaying the scan costs nothing
      const skillsWatcher = chokidar.watch(
        ['.agents/skills', '.claude/skills'].map((rel) => path.join(r.dir, rel)),
        { ignoreInitial: false }
      );
      skillsWatcher.on('all', () => skills.invalidate());
      survive(skillsWatcher, path.join(r.dir, '.*/skills'));
      return [watcher, skillsWatcher];
    });
  }

  let watchers = startWatchers();

  function setRoot(dir, doc) {
    for (const w of watchers) w.close();
    for (const t of pendingTimers.values()) clearTimeout(t);
    pendingTimers.clear();
    roots = [{ key: null, dir: path.resolve(dir), label: null }];
    docs.setRoots(roots);
    watchers = startWatchers();
    skills.invalidate();
    agentConfig.invalidate();
    recordRecent(roots[0].dir);
    if (doc) recordRecent(path.join(roots[0].dir, doc));
    const info = rootInfo(roots);
    const payload = doc ? { event: 'root-changed', root: info, doc } : { event: 'root-changed', root: info };
    broadcastSSE(sseClients, payload);
    return info;
  }

  function pickStore(id) {
    return docs.storeFor(id, { cwd: roots.length ? roots[0].dir : process.cwd() });
  }

  // restarting spawns a detached copy of this same process (node + argv) before
  // this one exits, so the reload the client triggers lands on a fresh process
  // with whatever settings were just saved (a new port, say)
  function defaultRestart() {
    const argv = restartArgv(process.argv.slice(1));
    spawn(process.execPath, argv, { cwd: process.cwd(), env: process.env, stdio: 'ignore', detached: true }).unref();
    server.close(() => process.exit(0));
  }
  const restart = restartFn || defaultRestart;

  const routes = [
    { method: 'GET', match: (pathname) => pathname === '/api/tree', handler: async (ctx) => {
      const { res, url } = ctx;
      const outcome = await docs.tree(url.searchParams.get('view'), {
        agent: url.searchParams.get('agent') || 'claude',
        skillsMode,
      });
      if (outcome.ok) return sendJSON(res, 200, outcome.tree);
      if (outcome.code === 'unknown_agent') return sendJSON(res, 400, { error: 'unknown agent' });
      if (outcome.code === 'unreadable_root') {
        return sendJSON(res, 500, { error: 'unreadable_root', dir: outcome.dir, code: outcome.errno });
      }
      return sendError(res, outcome);
    } },

    { method: 'GET', match: (pathname) => pathname === '/api/version', handler: async (ctx) => {
      // `launcher` is the boot shape, not the current one: a launcher whose
      // root was picked later stays the app's reuse target, while a server
      // started as `showmd file.md` never is
      return sendJSON(ctx.res, 200, { version: require('../package.json').version, launcher: bootedRootless });
    } },

    { method: 'GET', match: (pathname) => pathname === '/api/settings', handler: async (ctx) => {
      return sendJSON(ctx.res, 200, await getSettingsView({
        platform, multi, rootDir: roots.length ? roots[0].dir : null, appStatusFn, mdHandlerDefaultFn, effectiveSettingsPromise, cliPath,
      }));
    } },

    { method: 'PUT', match: (pathname) => pathname === '/api/settings', needs: ['body'], handler: async (ctx) => {
      return sendJSON(ctx.res, 200, await settings.writeSettings(ctx.body));
    } },

    // destructive: scope 'root' removes only the currently served root's own
    // shadow history dir; scope 'all' removes the whole history home. Either
    // way the target path comes from historyDirFor/pruneAllDir, never from
    // the request body — scope only selects which of those two runs.
    { method: 'POST', match: (pathname) => pathname === '/api/prune', needs: ['body'], handler: async (ctx) => {
      const { res, body } = ctx;
      const scope = body.scope || 'root';
      if (scope !== 'root' && scope !== 'all') return sendJSON(res, 400, { error: 'invalid scope' });
      if (scope === 'all') {
        await history.pruneAll();
        return sendJSON(res, 200, { ok: true });
      }
      if (multi) return sendError(res, { code: 'not_found' });
      if (roots.length === 0) return sendError(res, { code: 'no_root' });
      await history.prune(roots[0].dir);
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
        const mdFiles = multi || roots.length === 0 ? [] : await docs.walkMd(roots[0].dir, roots[0].dir, []);
        const loc = mdFiles.length ? docs.resolveAsset(mdFiles[0]) : null;
        if (loc) opened = await openInfoFn(loc.full);
      } catch {}
      return sendJSON(res, 200, { ok: true, dest: result.dest, opened });
    } },

    { method: 'POST', match: (pathname) => pathname === '/api/restart', handler: async (ctx) => {
      sendJSON(ctx.res, 200, { ok: true });
      setImmediate(restart);
    } },

    { method: 'GET', match: (pathname) => pathname === '/api/raw', needs: ['store'], handler: async (ctx) => {
      const { res, id, store } = ctx;
      const result = await store.read(id);
      if (!result.ok) return sendError(res, result);
      return sendText(res, result.text, await symlinkHeaders(store, result.full));
    } },

    { method: 'GET', match: (pathname) => pathname === '/api/asset', needs: ['store'], handler: async (ctx) => {
      const { res, id, store } = ctx;
      const loc = store.resolveAsset(id);
      if (!loc) return sendError(res, { code: 'forbidden' });
      const ext = path.extname(loc.rel).toLowerCase();
      const type = ASSET_MIME[ext];
      if (!type) return sendError(res, { code: 'not_found' });
      const headers = { 'X-Content-Type-Options': 'nosniff' };
      if (ext === '.svg') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
      return await sendFileOr404(res, loc.full, type, headers);
    } },

    { method: 'PUT', match: (pathname) => pathname === '/api/raw', needs: ['rawBody', 'store'], handler: async (ctx) => {
      const { res, id, store, rawBody } = ctx;
      const result = await store.write(id, rawBody);
      if (!result.ok) return sendError(res, result);
      res.writeHead(204);
      return res.end();
    } },

    // store lookup stays manual here (not via `needs: ['store']`): the
    // settings-reveal branch must not require a root at all, so resolving
    // the store unconditionally before the handler runs would wrongly 409
    // a rootless request for the settings file.
    { method: 'POST', match: (pathname) => pathname === '/api/reveal', handler: async (ctx) => {
      const { res, url, id } = ctx;
      if (url.searchParams.get('settings') === '1') {
        revealFile(settings.settingsFile());
        res.writeHead(204);
        return res.end();
      }
      const store = await pickStore(id);
      if (!store) return sendError(res, { code: 'no_root' });
      const result = await store.reveal(id);
      if (!result.ok) return sendError(res, result);
      revealFile(result.full);
      res.writeHead(204);
      return res.end();
    } },

    { method: 'GET', match: (pathname) => pathname === '/api/history', needs: ['store'], handler: async (ctx) => {
      const { res, id, store } = ctx;
      const result = await store.timeline(id);
      return result.ok ? sendJSON(res, 200, result.entries) : sendError(res, result);
    } },

    { method: 'GET', match: (pathname) => pathname === '/api/diff', needs: ['store'], handler: async (ctx) => {
      const { res, id, rev, fromRepo, store } = ctx;
      const result = await store.diff(id, rev, fromRepo);
      return result.ok ? sendText(res, result.text) : sendError(res, result);
    } },

    { method: 'POST', match: (pathname) => pathname === '/api/restore', needs: ['store'], handler: async (ctx) => {
      const { res, id, rev, fromRepo, store } = ctx;
      const result = await store.restore(id, rev, fromRepo);
      if (!result.ok) return sendError(res, result);
      res.writeHead(204);
      return res.end();
    } },

    // lets the client learn the current root's name at page load and after a
    // reconnect, without duplicating setRoot's {dir, name} shape; 404 on a
    // multi-root (`showmd skills`) server doubles as the client's doc-mode signal
    { method: 'GET', match: (pathname) => pathname === '/api/root', handler: async (ctx) => {
      const { res } = ctx;
      if (multi) return sendError(res, { code: 'not_found' });
      return sendJSON(res, 200, rootInfo(roots));
    } },

    { method: 'POST', match: (pathname) => pathname === '/api/pick-root' && !multi, needs: ['body'], handler: async (ctx) => {
      const { res, body } = ctx;
      let dir = typeof body.dir === 'string' && body.dir ? body.dir : null;
      if (!dir) {
        const mode = body.mode === 'folder' || body.mode === 'file' ? body.mode : undefined;
        const startDir = typeof body.startDir === 'string' && body.startDir ? body.startDir : undefined;
        dir = await folderPicker.pick(mode, startDir);
        if (dir === undefined) return sendJSON(res, 501, { error: 'no folder picker available (install zenity or kdialog)' });
        if (dir === null) return sendJSON(res, 200, { canceled: true });
      }
      const target = await classifyRootTarget(dir);
      if (!target) return sendJSON(res, 400, { error: 'not a directory or markdown file' });
      const root = setRoot(target.dir, target.doc);
      return sendJSON(res, 200, target.doc ? { ok: true, root, doc: target.doc } : { ok: true, root });
    } },

    // works rootless (launcher, before a folder is picked) and rooted alike;
    // multi-root (`showmd skills`) has no single recents concept and stays 404
    { method: 'GET', match: (pathname) => pathname === '/api/recents' && !multi, handler: async (ctx) => {
      return sendJSON(ctx.res, 200, { recents: await listRecents() });
    } },

    { method: 'POST', match: (pathname) => pathname === '/api/recents/delete' && !multi, needs: ['body'], handler: async (ctx) => {
      const { res, body } = ctx;
      if (typeof body.path !== 'string' || !body.path) return sendJSON(res, 400, { error: 'invalid path' });
      await recentsWrite;
      await recents.remove(body.path);
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
        return await sendFileOr404(res, entry.file, entry.type);
      }
      if (rel.startsWith('katex/fonts/')) {
        const fname = rel.slice('katex/fonts/'.length);
        const ext = path.extname(fname);
        if (fname.includes('/') || !FONT_MIME[ext]) return sendJSON(res, 403, { error: 'forbidden' });
        const full = safeResolve(KATEX_FONTS_DIR, fname);
        if (!full) return sendJSON(res, 403, { error: 'forbidden' });
        return await sendFileOr404(res, full, FONT_MIME[ext]);
      }
      return sendError(res, { code: 'not_found' });
    } },

    { method: 'GET', match: (pathname) => pathname.startsWith('/assets/'), handler: async (ctx) => {
      const { res, pathname } = ctx;
      const rel = pathname.slice('/assets/'.length);
      if (rel === 'markdown-it.min.js') {
        return await sendFile(res, MARKDOWN_IT_UMD, 'text/javascript; charset=utf-8');
      }
      const full = safeResolve(CLIENT_DIR, rel);
      const ext = path.extname(rel);
      const type = MIME[ext] || ASSET_MIME[ext];
      if (!full || !type) return sendError(res, { code: 'not_found' });
      // an upgrade changes these files in place at the same URLs; a cached copy
      // from the previous version reads payload keys that no longer exist
      return await sendFileOr404(res, full, type, { 'Cache-Control': 'no-cache' });
    } },

    { method: 'GET', match: (pathname) => pathname === '/favicon.ico', handler: async (ctx) => {
      return await sendFileOr404(ctx.res, path.join(CLIENT_DIR, 'favicon-32.png'), 'image/png');
    } },

    { method: 'GET', match: () => true, handler: async (ctx) => {
      const { res } = ctx;
      const template = await fsp.readFile(SHELL_PATH, 'utf8');
      // boot data inlined so first paint needs no /api/settings, /api/recents
      // or /api/root round trips — that post-paint gap is what flashed the
      // wrong theme and popped Recent in late
      const boot = {
        settings: await getSettingsView({
          platform, multi, rootDir: roots.length ? roots[0].dir : null, appStatusFn, mdHandlerDefaultFn, effectiveSettingsPromise, cliPath,
        }),
      };
      if (bootView) boot.view = bootView;
      if (!multi) {
        boot.recents = await listRecents();
        boot.root = rootInfo(roots);
      }
      const html = renderShell(template, boot, { launcherBoot: !multi && roots.length === 0 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      return res.end(html);
    } },
  ];

  const server = http.createServer(async (req, res) => {
    try {
      // trust boundary: the server listens on loopback only, but any web page
      // can still address it. Reject non-loopback Host headers (DNS rebinding)
      // and cross-origin non-GET requests (blind CSRF writes from a browser).
      const hostname = (req.headers.host || '').replace(/:\d+$/, '');
      if (!LOOPBACK_HOSTS.has(hostname)) return sendError(res, { code: 'forbidden' });
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
        let originHost = null;
        try { originHost = new URL(req.headers.origin).hostname; } catch {}
        if (!LOOPBACK_HOSTS.has(originHost)) return sendError(res, { code: 'forbidden' });
      }

      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      const id = url.searchParams.get('path') || '';
      const rev = url.searchParams.get('rev') || '';
      const fromRepo = url.searchParams.get('repo') === '1';

      const route = findRoute(routes, req.method, pathname, url);
      if (!route) return sendError(res, { code: 'not_found' });

      const resolved = await resolveContext(route, { req, res, url, pathname, id, rev, fromRepo }, { pickStore });
      if (!resolved.ok) return sendError(res, { code: resolved.error });
      return await route.handler(resolved.ctx);
    } catch (err) {
      console.error(`showmd: request error: ${err.message}`);
      if (!res.headersSent) sendJSON(res, 500, { error: 'internal error' });
    }
  });

  server.on('close', () => {
    for (const w of watchers) w.close();
    for (const res of sseClients) res.end();
  });

  return server;
}

module.exports = { createServer, restartArgv, findRoute, broadcastSSE };
