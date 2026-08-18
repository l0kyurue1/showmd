import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const markdownit = require('markdown-it');
const { formatRouteContext } = require('../../../../server/route-context.js');

// a fixed key so tests can assert against a stable /r/<key>/... URL; matches
// server/root-identity.js's r_ + 22-char base64url grammar.
export const TEST_ROOT_KEY = 'r_AAAAAAAAAAAAAAAAAAAAAA';

export function rootScopedPath(tail, key = TEST_ROOT_KEY) {
  return `/api/roots/${key}/${tail}`;
}

register('./fake-editor-loader.mjs', import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const INDEX_HTML = readFileSync(path.join(REPO_ROOT, 'client/index.html'), 'utf8');
const APP_JS_URL = pathToFileURL(path.join(REPO_ROOT, 'client/app.js')).href;

// jsdom has no CSS.escape; app.js's navItemFor() needs it for querySelector
// lookups by doc id. This is the standard CSSOM escaping algorithm.
function cssEscape(value) {
  const string = String(value);
  const length = string.length;
  let result = '';
  let index = -1;
  const firstCodeUnit = string.charCodeAt(0);
  while (++index < length) {
    const codeUnit = string.charCodeAt(index);
    if (codeUnit === 0x0000) { result += '�'; continue; }
    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) || codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
    ) { result += '\\' + codeUnit.toString(16) + ' '; continue; }
    if (index === 0 && length === 1 && codeUnit === 0x002d) { result += '\\' + string.charAt(index); continue; }
    if (
      codeUnit >= 0x0080 || codeUnit === 0x002d || codeUnit === 0x005f ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) { result += string.charAt(index); continue; }
    result += '\\' + string.charAt(index);
  }
  return result;
}

function makeResponse(spec = {}) {
  const status = spec.status ?? 200;
  const ok = spec.ok ?? (status >= 200 && status < 300);
  const bodyText = spec.text !== undefined ? spec.text : JSON.stringify(spec.body ?? {});
  const headers = spec.headers || {};
  return {
    ok,
    status,
    headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
    json: async () => (spec.body !== undefined ? spec.body : JSON.parse(bodyText || '{}')),
    text: async () => bodyText,
  };
}

export function createFakeFetch() {
  const calls = [];
  const routes = [];
  const fetchFake = async (input, init) => {
    const method = (init && init.method) || 'GET';
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://localhost/');
    calls.push({ method, pathname: url.pathname, search: url.search, url, init });
    for (const route of routes) {
      if (route.method && route.method !== method) continue;
      if (!route.test(url)) continue;
      const spec = await route.handler({ url, init, method });
      return makeResponse(spec);
    }
    return makeResponse({ status: 404, body: { error: 'not found' } });
  };
  fetchFake.calls = calls;
  // last registered route wins, so a test can override a boot-time default
  // for one request without rebuilding the whole route table
  fetchFake.on = (method, matcher, handler) => {
    const test = typeof matcher === 'string' ? (url) => url.pathname === matcher : matcher;
    routes.unshift({ method, test, handler });
  };
  fetchFake.lastCallTo = (matcher) => {
    const test = typeof matcher === 'string' ? (c) => c.pathname === matcher : matcher;
    for (let i = calls.length - 1; i >= 0; i--) if (test(calls[i])) return calls[i];
    return null;
  };
  return fetchFake;
}

export function createFakeEventSource() {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.onopen = null;
      this.onerror = null;
      this.onmessage = null;
      this.closed = false;
      instances.push(this);
    }
    close() { this.closed = true; }
    emit(data) { if (this.onmessage) this.onmessage({ data: JSON.stringify(data) }); }
    open() { if (this.onopen) this.onopen(); }
    fail() { if (this.onerror) this.onerror(new Event('error')); }
  }
  FakeEventSource.instances = instances;
  return FakeEventSource;
}

function createFakeMatchMedia() {
  const lists = new Map();
  function matchMedia(query) {
    if (!lists.has(query)) {
      const listeners = new Set();
      lists.set(query, {
        media: query,
        matches: false,
        addEventListener: (_type, fn) => listeners.add(fn),
        removeEventListener: (_type, fn) => listeners.delete(fn),
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
        _fire() { for (const fn of listeners) fn({ matches: lists.get(query).matches }); },
      });
    }
    return lists.get(query);
  }
  matchMedia.lists = lists;
  return matchMedia;
}

async function waitFor(cond, { timeout = 4000, interval = 5 } = {}) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('boot-app: waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

let bootCount = 0;
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

function createTimerControl(deferredDelays) {
  const delays = new Set(deferredDelays);
  const pending = new Map();
  let nextId = 0;
  const setTimeoutControlled = (fn, delay = 0, ...args) => {
    if (!delays.has(delay)) return nativeSetTimeout(fn, delay, ...args);
    const id = { deferredTimer: ++nextId };
    pending.set(id, { fn, delay, args });
    return id;
  };
  const clearTimeoutControlled = (id) => {
    if (!pending.delete(id)) nativeClearTimeout(id);
  };
  const run = async (delay) => {
    const selected = [...pending].filter(([, timer]) => delay === undefined || timer.delay === delay);
    for (const [id] of selected) pending.delete(id);
    await Promise.all(selected.map(([, timer]) => timer.fn(...timer.args)));
    return selected.length;
  };
  const count = (delay) => [...pending.values()].filter((timer) => delay === undefined || timer.delay === delay).length;
  return { setTimeoutControlled, clearTimeoutControlled, run, count };
}

// Boot the real client under jsdom with browser seams and captured window errors.
export async function bootApp({
  tree = [], root = null, settings = {}, settingsResponse = null, files = {}, rawOverrides = {},
  userAgent, systemDark = false, localStorageSeed = {},
  route, roots, routeError, skillsTree = null, skillFiles = {}, agentTree = null, agentFiles = {},
  recents, deferredTimeouts = [],
} = {}) {
  bootCount += 1;
  // Synthesize a fixed Root Space for legacy root-only fixtures.
  const resolvedRoute = route !== undefined ? route : (root ? { space: 'root', rootKey: TEST_ROOT_KEY } : null);
  const resolvedRoots = roots !== undefined ? roots
    : (root ? [{ key: TEST_ROOT_KEY, dir: root.dir, name: root.name || 'root', url: `/r/${TEST_ROOT_KEY}/` }] : []);
  const bootUrl = resolvedRoute ? new URL(formatRouteContext(resolvedRoute), 'http://localhost/').href : 'http://localhost/';

  // Omit boot settings so tests exercise /api/settings; settingsResponse overrides it.
  const bootData = { root, roots: resolvedRoots };
  if (resolvedRoute) bootData.route = resolvedRoute;
  if (routeError) bootData.routeError = routeError;
  if (recents !== undefined) bootData.recents = recents;
  const html = INDEX_HTML.replace(
    '<script type="module"',
    `<script type="application/json" id="boot-data">${JSON.stringify(bootData)}</script>\n<script type="module"`
  );

  // pretendToBeVisual: CodeMirror's editor bundle calls window.requestAnimationFrame
  const dom = new JSDOM(html, { url: bootUrl, pretendToBeVisual: true });
  const { window } = dom;
  // Override userAgent directly to avoid enabling jsdom network resources.
  if (userAgent) Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error || new Error(e.message)));

  const fetchFake = createFakeFetch();
  const rootScopedTail = (tail) => new RegExp(`^/api/roots/[^/]+/${tail}$`);
  fetchFake.on('GET', (url) => rootScopedTail('tree').test(url.pathname), () => ({ body: tree }));
  if (skillsTree) {
    fetchFake.on('GET', '/api/skills/tree', () => ({ body: skillsTree }));
    fetchFake.on('GET', '/api/skills/raw', ({ url }) => {
      const id = url.searchParams.get('id');
      return Object.prototype.hasOwnProperty.call(skillFiles, id)
        ? { status: 200, text: skillFiles[id] }
        : { status: 404, body: { error: 'not found' } };
    });
  }
  if (agentTree) {
    fetchFake.on('GET', (url) => /^\/api\/agents\/[^/]+\/tree$/.test(url.pathname), () => ({ body: agentTree }));
    fetchFake.on('GET', (url) => /^\/api\/agents\/[^/]+\/raw$/.test(url.pathname), ({ url }) => {
      const id = url.searchParams.get('id');
      return Object.prototype.hasOwnProperty.call(agentFiles, id)
        ? { status: 200, text: agentFiles[id] }
        : { status: 404, body: { error: 'not found' } };
    });
  }
  // Stub eager settings before init; lazy endpoints can be replaced later.
  fetchFake.on('GET', '/api/settings', () => (settingsResponse || { body: settings }));
  fetchFake.on('GET', '/api/recents', () => ({ body: { recents: [] } }));
  fetchFake.on('GET', '/api/roots', () => ({ body: { roots: resolvedRoots } }));
  fetchFake.on('GET', (url) => rootScopedTail('raw').test(url.pathname), ({ url }) => {
    const p = url.searchParams.get('path');
    if (Object.prototype.hasOwnProperty.call(rawOverrides, p)) return rawOverrides[p];
    if (Object.prototype.hasOwnProperty.call(files, p)) return { status: 200, text: files[p] };
    return { status: 404, body: { error: 'not found' } };
  });
  fetchFake.on('PUT', (url) => rootScopedTail('raw').test(url.pathname), () => ({ status: 200, body: { ok: true } }));

  const EventSourceFake = createFakeEventSource();
  const matchMediaFake = createFakeMatchMedia();
  const timerControl = createTimerControl(deferredTimeouts);
  if (systemDark) matchMediaFake('(prefers-color-scheme: dark)').matches = true;

  window.fetch = fetchFake;
  window.EventSource = EventSourceFake;
  window.matchMedia = matchMediaFake;
  window.CSS = { escape: cssEscape };
  window.markdownit = markdownit;
  window.Element.prototype.scrollIntoView = window.Element.prototype.scrollIntoView || (() => {});
  const printCalls = [];
  window.print = () => printCalls.push(true);

  for (const [k, v] of Object.entries(localStorageSeed)) window.localStorage.setItem(k, v);

  // Node ships several of these as its own read-only globals (navigator,
  // fetch, Event...); only jsdom's versions may replace them here.
  const defineGlobal = (name, value) => Object.defineProperty(global, name, { value, configurable: true, writable: true });

  defineGlobal('window', window);
  defineGlobal('document', window.document);
  defineGlobal('navigator', window.navigator);
  defineGlobal('location', window.location);
  defineGlobal('history', window.history);
  defineGlobal('localStorage', window.localStorage);
  defineGlobal('matchMedia', window.matchMedia);
  defineGlobal('fetch', window.fetch);
  defineGlobal('EventSource', window.EventSource);
  defineGlobal('CSS', window.CSS);
  defineGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  defineGlobal('requestAnimationFrame', window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : ((fn) => setTimeout(fn, 0)));
  defineGlobal('HTMLElement', window.HTMLElement);
  defineGlobal('Node', window.Node);
  defineGlobal('Event', window.Event);
  defineGlobal('KeyboardEvent', window.KeyboardEvent);
  defineGlobal('MouseEvent', window.MouseEvent);
  defineGlobal('URLSearchParams', window.URLSearchParams);
  defineGlobal('setTimeout', timerControl.setTimeoutControlled);
  defineGlobal('clearTimeout', timerControl.clearTimeoutControlled);

  await import(APP_JS_URL + '?boot=' + bootCount);
  await waitFor(() => EventSourceFake.instances.length > 0);

  return {
    dom,
    window,
    document: window.document,
    fetch: fetchFake,
    EventSource: EventSourceFake,
    matchMedia: matchMediaFake,
    printCalls,
    errors,
    runDeferredTimers: timerControl.run,
    pendingDeferredTimers: timerControl.count,
    keydown(key, mods = {}) {
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', {
        key, bubbles: true, cancelable: true, metaKey: false, ctrlKey: false, shiftKey: false, ...mods,
      }));
    },
    click(el) {
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    waitFor,
  };
}
