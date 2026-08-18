import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, rootScopedPath, TEST_ROOT_KEY } from './helpers/boot-app.mjs';

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';

function kbdText(document, selector) {
  return document.querySelector(selector).querySelector('kbd').textContent;
}

test('app.js boots the real index.html and app.js without throwing', async () => {
  const h = await bootApp({ root: { dir: null, name: null } });
  assert.deepEqual(h.errors, []);
  assert.equal(h.document.body.classList.contains('launcher'), true);
  assert.equal(h.EventSource.instances.length, 1);
});

test('app.js boots straight into a file when a root and tree are given', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title\n\n- [ ] task one' },
  });
  assert.deepEqual(h.errors, []);
  assert.equal(h.document.getElementById('doc').textContent.includes('task one'), true);
  assert.equal(h.document.title, 'a.md');
});

test('Export PDF waits for Read Mode block rendering to finish before printing', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title\n\n```js\nconst ready = true;\n```' },
  });

  const highlighterScript = h.document.querySelector('script[src="/assets/dist/hljs.js"]');
  assert.ok(highlighterScript, 'syntax highlighting must still be loading');

  h.click(h.document.getElementById('export-btn'));
  await Promise.resolve();
  assert.equal(h.printCalls.length, 0, 'printing must wait for async block enhancement');

  h.window.hljs = { highlightElement: () => {} };
  highlighterScript.dispatchEvent(new h.window.Event('load'));
  await h.waitFor(() => h.printCalls.length === 1);
  assert.deepEqual(h.errors, []);
});

test('keyboard shortcuts wired at the bottom of app.js run without a ReferenceError', async (t) => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title\n\nbody text' },
  });
  assert.deepEqual(h.errors, []);

  await t.test('mod+E cycles the mode', async () => {
    h.keydown('e', { metaKey: true });
    await h.waitFor(() => h.document.getElementById('editor-host').hidden === false);
    assert.equal(h.document.getElementById('doc').hidden, true);
    assert.deepEqual(h.errors, []);
  });

  await t.test('mod+S saves while not in read mode', () => {
    h.keydown('s', { metaKey: true });
    assert.deepEqual(h.errors, []);
  });

  await t.test('mod+backslash toggles the sidebar', () => {
    const before = h.document.getElementById('sidebar').classList.contains('collapsed');
    h.keydown('\\', { metaKey: true });
    assert.notEqual(h.document.getElementById('sidebar').classList.contains('collapsed'), before);
    assert.deepEqual(h.errors, []);
  });

  await t.test('shift+mod+backslash toggles the right panel', () => {
    const before = h.document.getElementById('panel').classList.contains('collapsed');
    h.keydown('|', { metaKey: true, shiftKey: true });
    assert.notEqual(h.document.getElementById('panel').classList.contains('collapsed'), before);
    assert.deepEqual(h.errors, []);
  });

  await t.test('shift+mod+H goes Home from a file view', async () => {
    h.keydown('h', { metaKey: true, shiftKey: true });
    await h.waitFor(() => h.document.body.classList.contains('launcher'));
    assert.deepEqual(h.errors, []);
  });
});

test('an SSE change event for the open file whose refetch 500s does not blank the document or the saved baseline', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title\n\n- [ ] task one' },
  });
  assert.equal(h.document.getElementById('doc').textContent.includes('task one'), true);

  h.fetch.on('GET', (url) => url.pathname === rootScopedPath('raw') && url.searchParams.get('path') === 'a.md', () => ({
    status: 500, body: { error: 'boom' },
  }));

  const before = h.fetch.calls.length;
  h.EventSource.instances[0].emit({ path: 'a.md', event: 'change' });
  await h.waitFor(() => h.fetch.calls.length > before);
  await h.waitFor(() => h.document.getElementById('save-chip-text').textContent === 'Refresh failed');

  assert.equal(h.document.getElementById('doc').textContent.includes('task one'), true, 'document must not be blanked');
  assert.equal(h.document.getElementById('banner').hidden, true, 'no external-edit banner: nothing valid was staged');
  assert.equal(h.document.getElementById('save-chip-dot').className.includes('error'), true);
  assert.deepEqual(h.errors, []);
});

test('loadFile against a 500 renders a placeholder but never adopts it as a saveable baseline', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['missing.md'],
    rawOverrides: { 'missing.md': { status: 500, body: { error: 'boom' } } },
  });

  assert.equal(h.document.getElementById('doc').textContent.includes('boom'), true);
  assert.equal(h.document.getElementById('save-chip-text').textContent, 'Not saved');
  assert.equal(h.document.getElementById('save-chip-dot').className.includes('error'), true);

  const putCallsBefore = h.fetch.calls.filter((c) => c.method === 'PUT' && c.pathname === rootScopedPath('raw')).length;
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const putCallsAfter = h.fetch.calls.filter((c) => c.method === 'PUT' && c.pathname === rootScopedPath('raw')).length;
  assert.equal(putCallsAfter, putCallsBefore, 'a detached document must never autosave the placeholder');
  assert.deepEqual(h.errors, []);
});

// --- platform labels and initial theme through observable DOM behavior ---

test('on a Mac user agent, kbd hints keep their glyphs untouched', async () => {
  const h = await bootApp({ root: { dir: null, name: null }, userAgent: MAC_UA });
  assert.equal(kbdText(h.document, '#sidebar-btn'), '⌘\\');
  assert.equal(kbdText(h.document, '#edit-btn'), '⌘E');
  assert.equal(kbdText(h.document, '#launcher-open-folder'), '⇧⌘O');
});

test('off a Mac user agent, kbd hints spell out the modifiers, Ctrl first', async () => {
  const h = await bootApp({ root: { dir: null, name: null } });
  assert.equal(kbdText(h.document, '#sidebar-btn'), 'Ctrl+\\');
  assert.equal(kbdText(h.document, '#edit-btn'), 'Ctrl+E');
  assert.equal(kbdText(h.document, '#launcher-open-folder'), 'Ctrl+Shift+O');
});

test('revealLabel: the reveal tooltip is picked from the boot settings platform', async () => {
  const darwin = await bootApp({ root: { dir: null, name: null }, settings: { platform: 'darwin' } });
  assert.equal(darwin.document.getElementById('reveal-btn').querySelector('.tip').textContent, 'Reveal in Finder');

  const win32 = await bootApp({ root: { dir: null, name: null }, settings: { platform: 'win32' } });
  assert.equal(win32.document.getElementById('reveal-btn').querySelector('.tip').textContent, 'Show in File Explorer');

  const linux = await bootApp({ root: { dir: null, name: null }, settings: { platform: 'linux' } });
  assert.equal(linux.document.getElementById('reveal-btn').querySelector('.tip').textContent, 'Show in file manager');
});

test('resolveTheme: system colorMode follows the media query at boot', async () => {
  const light = await bootApp({ root: { dir: null, name: null }, systemDark: false });
  assert.equal(light.document.documentElement.dataset.theme, 'light');

  const dark = await bootApp({ root: { dir: null, name: null }, systemDark: true });
  assert.equal(dark.document.documentElement.dataset.theme, 'dark');
});

test('resolveTheme: an explicit stored colorMode wins over the system query', async () => {
  const h = await bootApp({ root: { dir: null, name: null }, systemDark: false, settings: { colorMode: 'dark' } });
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
  const persisted = h.fetch.calls.some((c) => c.method === 'PUT' && c.pathname === '/api/settings');
  assert.equal(persisted, false, 'an explicit setting needs no migration write');
});

test('initialColorMode: a legacy localStorage theme migrates once into settings, then is cleared', async () => {
  const h = await bootApp({
    root: { dir: null, name: null },
    systemDark: false,
    localStorageSeed: { 'showmd-theme': 'dark' },
  });
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
  assert.equal(h.window.localStorage.getItem('showmd-theme'), null);
  const migration = h.fetch.calls.find((c) => c.method === 'PUT' && c.pathname === '/api/settings');
  assert.ok(migration, 'the legacy value must be persisted as the real setting');
  assert.deepEqual(JSON.parse(migration.init.body), { colorMode: 'dark' });
});

test('the theme button flips and persists colorMode through setTheme/resolveTheme', async () => {
  const h = await bootApp({ root: { dir: null, name: null }, systemDark: false });
  assert.equal(h.document.documentElement.dataset.theme, 'light');
  h.click(h.document.getElementById('theme-btn'));
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
  const toggle = h.fetch.calls.findLast((c) => c.method === 'PUT' && c.pathname === '/api/settings');
  assert.deepEqual(JSON.parse(toggle.init.body), { colorMode: 'dark' });
});

// --- silent-failure site coverage: restore, fetchSettings, reveal, refreshTree ---

test('restore: a non-ok response reports the failure and leaves the version pane open', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  h.fetch.on('GET', rootScopedPath('history'), () => ({ body: [{ rev: 'deadbeef', ts: Math.floor(Date.now() / 1000), source: 'you', repo: false }] }));
  h.fetch.on('GET', rootScopedPath('diff'), () => ({ status: 200, text: '@@ -1 +1 @@\n-old\n+new' }));
  h.click(h.document.getElementById('panel-btn'));
  await h.waitFor(() => h.document.querySelector('#ver-list .ver'));
  h.click(h.document.querySelector('#ver-list .ver'));
  await h.waitFor(() => h.document.getElementById('diff-view').hidden === false);

  h.fetch.on('POST', rootScopedPath('restore'), () => ({ status: 500, body: { error: 'boom' } }));
  h.click(h.document.getElementById('restore-btn'));
  await h.waitFor(() => h.document.getElementById('save-chip-text').textContent === 'Restore failed');

  assert.equal(h.document.getElementById('save-chip-dot').className.includes('error'), true);
  assert.equal(h.document.getElementById('diff-view').hidden, false, 'version pane must stay open: the file was never restored');
  assert.deepEqual(h.errors, []);
});

test('restore: a network rejection also reports the failure without touching the version pane', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  h.fetch.on('GET', rootScopedPath('history'), () => ({ body: [{ rev: 'deadbeef', ts: Math.floor(Date.now() / 1000), source: 'you', repo: false }] }));
  h.fetch.on('GET', rootScopedPath('diff'), () => ({ status: 200, text: '@@ -1 +1 @@\n-old\n+new' }));
  h.click(h.document.getElementById('panel-btn'));
  await h.waitFor(() => h.document.querySelector('#ver-list .ver'));
  h.click(h.document.querySelector('#ver-list .ver'));
  await h.waitFor(() => h.document.getElementById('diff-view').hidden === false);

  h.fetch.on('POST', rootScopedPath('restore'), () => { throw new Error('network down'); });
  h.click(h.document.getElementById('restore-btn'));
  await h.waitFor(() => h.document.getElementById('save-chip-text').textContent === 'Restore failed');

  assert.equal(h.document.getElementById('diff-view').hidden, false);
  assert.deepEqual(h.errors, []);
});

test('restore: a successful restore returns to current, closing the version pane', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  h.fetch.on('GET', rootScopedPath('history'), () => ({ body: [{ rev: 'deadbeef', ts: Math.floor(Date.now() / 1000), source: 'you', repo: false }] }));
  h.fetch.on('GET', rootScopedPath('diff'), () => ({ status: 200, text: '@@ -1 +1 @@\n-old\n+new' }));
  h.click(h.document.getElementById('panel-btn'));
  await h.waitFor(() => h.document.querySelector('#ver-list .ver'));
  h.click(h.document.querySelector('#ver-list .ver'));
  await h.waitFor(() => h.document.getElementById('diff-view').hidden === false);
  assert.equal(h.document.getElementById('diff-view').hidden, false);

  h.fetch.on('POST', rootScopedPath('restore'), () => ({ status: 200, body: { ok: true } }));
  h.click(h.document.getElementById('restore-btn'));
  await h.waitFor(() => h.document.getElementById('diff-view').hidden === true);

  assert.equal(h.document.getElementById('save-chip-text').textContent !== 'Restore failed', true);
  assert.deepEqual(h.errors, []);
});

test('fetchSettings: a non-ok response at boot reports the failure and falls back to defaults', async () => {
  // no root/tree/file here on purpose: a successful loadFile's own setSaveState('Saved')
  // would otherwise overwrite the settings-error chip before this can observe it
  const h = await bootApp({
    root: { dir: null, name: null },
    settingsResponse: { status: 500, body: { error: 'no_root' } },
  });
  assert.equal(h.document.getElementById('save-chip-text').textContent, 'Settings unavailable');
  assert.equal(h.document.getElementById('save-chip-dot').className.includes('error'), true);
  assert.deepEqual(h.errors, []);
});

test('fetchSettings: the error body of a non-ok response is never rendered as a settings object', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
    settingsResponse: { status: 500, body: { error: 'no_root' } },
  });
  h.click(h.document.querySelector('.nav-footer-gear'));
  await h.waitFor(() => h.document.getElementById('settings-view').children.length > 0);
  assert.equal(h.document.getElementById('settings-view').textContent.includes('no_root'), false);
  assert.deepEqual(h.errors, []);
});

test('fetchSettings: a successful response boots with the real settings applied', async () => {
  const h = await bootApp({
    root: { dir: null, name: null },
    settings: { platform: 'darwin' },
  });
  assert.equal(h.document.getElementById('reveal-btn').querySelector('.tip').textContent, 'Reveal in Finder');
  assert.notEqual(h.document.getElementById('save-chip-text').textContent, 'Settings unavailable');
  assert.deepEqual(h.errors, []);
});

test('reveal: a non-ok response reports the failure, then the chip recovers', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
    deferredTimeouts: [2500],
  });
  h.fetch.on('POST', rootScopedPath('reveal'), () => ({ status: 500, body: { error: 'boom' } }));
  h.click(h.document.getElementById('reveal-btn'));
  await h.waitFor(() => h.document.getElementById('save-chip-text').textContent === 'Reveal failed');
  assert.equal(h.document.getElementById('save-chip-dot').className.includes('error'), true);

  assert.equal(h.pendingDeferredTimers(2500), 1);
  assert.equal(await h.runDeferredTimers(2500), 1);
  assert.notEqual(h.document.getElementById('save-chip-text').textContent, 'Reveal failed');
  assert.deepEqual(h.errors, []);
});

test('refreshTree: a non-ok skills-tree refresh reports the failure and keeps the last known list', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  h.fetch.on('GET', (url) => url.pathname === '/api/skills/tree', () => ({
    body: { scopes: [{ groups: [{ skills: [{ id: 'sk', files: [{ id: 'sk/one.md' }], badges: [] }] }], skills: [] }] },
  }));
  h.fetch.on('GET', (url) => url.pathname === '/api/skills/raw' && url.searchParams.get('id') === 'sk/one.md', () => ({ status: 200, text: '# one' }));
  h.keydown('s', { metaKey: true, shiftKey: true });
  await h.waitFor(() => h.document.querySelector('[data-nav-id="sk/one.md"]'));

  h.fetch.on('GET', (url) => url.pathname === '/api/skills/tree', () => ({
    status: 500, body: { error: 'boom' },
  }));
  h.EventSource.instances[0].emit({ path: 'sk/two.md', event: 'change' });
  await h.waitFor(() => h.document.getElementById('save-chip-text').textContent === 'Refresh failed');

  assert.equal(h.document.getElementById('save-chip-dot').className.includes('error'), true);
  assert.ok(h.document.querySelector('[data-nav-id="sk/one.md"]'), 'the last known list must still be showing');
  assert.deepEqual(h.errors, []);
});

test('refreshTree: a successful skills-tree refresh applies the new tree', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  h.fetch.on('GET', (url) => url.pathname === '/api/skills/tree', () => ({
    body: { scopes: [{ groups: [{ skills: [{ id: 'sk', files: [{ id: 'sk/one.md' }], badges: [] }] }], skills: [] }] },
  }));
  h.fetch.on('GET', (url) => url.pathname === '/api/skills/raw' && url.searchParams.get('id') === 'sk/one.md', () => ({ status: 200, text: '# one' }));
  h.keydown('s', { metaKey: true, shiftKey: true });
  await h.waitFor(() => h.document.querySelector('[data-nav-id="sk/one.md"]'));

  h.fetch.on('GET', (url) => url.pathname === '/api/skills/tree', () => ({
    body: { scopes: [{ groups: [{ skills: [{ id: 'sk', files: [{ id: 'sk/two.md' }], badges: [] }] }], skills: [] }] },
  }));
  h.EventSource.instances[0].emit({ path: 'sk/two.md', event: 'change' });
  await h.waitFor(() => h.document.querySelector('[data-nav-id="sk/two.md"]'));

  assert.equal(h.document.getElementById('save-chip-text').textContent !== 'Refresh failed', true);
  assert.deepEqual(h.errors, []);
});

test('installing from the update banner also refreshes the app row in settings', async () => {
  const settings = {
    appInstalled: true, appStale: true, appStaleReason: 'version',
    appVersion: '0.1.0', showmdVersion: '0.1.1', platform: 'darwin',
    appPath: '/Applications/ShowMD.app',
  };
  const h = await bootApp({ root: { dir: '/tmp/proj', name: 'proj' }, tree: ['a.md'], files: { 'a.md': '# T' }, settings });
  h.fetch.on('POST', '/api/install-app', () => {
    Object.assign(settings, { appStale: false, appStaleReason: null, appVersion: '0.1.1' });
    return { body: { ok: true } };
  });

  h.click(h.document.querySelector('.nav-footer-gear'));
  const rowBtn = () => h.document.querySelector('[data-key="installApp"] .settings-row-control button:not(.settings-reset-btn)');
  await h.waitFor(() => rowBtn());
  assert.equal(rowBtn().textContent, 'Update');

  h.click(h.document.querySelector('.update-cta-btn'));
  await h.waitFor(() => rowBtn().textContent === 'Installed');
  assert.equal(rowBtn().disabled, true);
  assert.deepEqual(h.errors, []);
});

// --- Root Space addressing, SSE rootKey gate, navigateTo/popstate ---

const KEY = TEST_ROOT_KEY;
const rootRoutes = (dir = '/tmp/proj', name = 'proj') => [{ key: KEY, dir, name, url: `/r/${KEY}/` }];

test('boot at /r/<key>/a.md renders a.md from the Route Context, not the pathname parser', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  assert.deepEqual(h.errors, []);
  assert.equal(h.document.title, 'a.md');
  assert.equal(h.window.location.pathname, `/r/${KEY}/a.md`);
});

test('boot at an encoded Unicode/#/.markdown document path round-trips through raw', async () => {
  const doc = 'dir/Ünïcode #.markdown';
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: doc },
    roots: rootRoutes(),
    tree: [doc],
    files: { [doc]: '# hi' },
  });
  assert.deepEqual(h.errors, []);
  assert.equal(h.document.getElementById('doc').textContent.includes('hi'), true);
  const rawCall = h.fetch.lastCallTo((c) => c.pathname === `/api/roots/${KEY}/raw`);
  assert.equal(rawCall.search, `?path=${encodeURIComponent(doc)}`);
});

test('boot at ?scope=docs sends scope on the tree call', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, scopePath: 'docs' },
    roots: rootRoutes(),
    tree: ['docs/a.md'],
  });
  assert.deepEqual(h.errors, []);
  const treeCall = h.fetch.lastCallTo((c) => c.pathname === `/api/roots/${KEY}/tree`);
  assert.equal(treeCall.search, '?scope=docs');
});

test('opening one file with its folder scope renders sibling files in the sidebar', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, scopePath: 'docs', documentPath: 'docs/a.md' },
    roots: rootRoutes(),
    tree: ['docs/a.md', 'docs/b.md'],
    files: { 'docs/a.md': '# A', 'docs/b.md': '# B' },
  });

  assert.deepEqual(
    [...h.document.querySelectorAll('[data-nav-id]')].map((el) => el.dataset.navId),
    ['dir:docs/', 'docs/a.md', 'docs/b.md'],
  );
  assert.equal(h.document.querySelector('[data-nav-id="docs/a.md"]').classList.contains('on'), true);
  assert.deepEqual(h.errors, []);
});

test('boot at an unknown rootKey renders the recoverable root-not-open state', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY },
    roots: [],
    routeError: { kind: 'root_not_open', rootKey: KEY },
  });
  assert.deepEqual(h.errors, []);
  assert.equal(h.document.body.classList.contains('launcher') || !h.document.getElementById('launcher-view').hidden, true);
  assert.equal(h.document.getElementById('launcher-error').textContent, 'This root is no longer open.');
});

test('boot at a known-but-closed rootKey renders plain Home with the sticky notice, and never auto-registers the root', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY },
    roots: [],
    routeError: { kind: 'root_not_open', rootKey: KEY },
  });
  assert.deepEqual(h.errors, []);
  assert.equal(h.document.body.classList.contains('launcher') || !h.document.getElementById('launcher-view').hidden, true);
  assert.equal(h.document.getElementById('launcher-error').textContent, 'This root is no longer open.');
  assert.equal(h.fetch.calls.some((c) => c.pathname === '/api/roots' && c.method === 'POST'), false);
});

test('an SSE event for a different rootKey does not refetch this tab\'s tree or file', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  const before = h.fetch.calls.length;
  h.EventSource.instances[0].emit({ rootKey: 'r_BBBBBBBBBBBBBBBBBBBBBB', path: 'a.md', event: 'change' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.fetch.calls.length, before, 'a foreign rootKey event must not trigger any refetch');
});

test('navigate pushes the formatRouteContext URL for the target document', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md', 'b.md'],
    files: { 'a.md': '[[b]]', 'b.md': '# B' },
  });
  const link = h.document.querySelector('a.wikilink');
  h.click(link);
  await h.waitFor(() => h.document.title === 'b.md');
  assert.equal(h.window.location.pathname, `/r/${KEY}/b.md`);
});

test('popstate restores both document and scope together', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md', 'docs/c.md'],
    files: { 'a.md': '# A', 'docs/c.md': '# C' },
  });
  h.window.history.pushState({ idx: 1 }, '', `/r/${KEY}/docs/c.md?scope=docs`);
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate', { state: { idx: 1 } }));
  await h.waitFor(() => h.document.title === 'c.md');
  const treeCall = h.fetch.lastCallTo((c) => c.pathname === `/api/roots/${KEY}/tree`);
  assert.equal(treeCall.search, '?scope=docs');
});

test('popstate flushes a dirty document to its source root before entering another root', async () => {
  const OTHER_KEY = 'r_BBBBBBBBBBBBBBBBBBBBBB';
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'notes.md' },
    roots: [
      ...rootRoutes(),
      { key: OTHER_KEY, dir: '/tmp/other', name: 'other', url: `/r/${OTHER_KEY}/` },
    ],
    tree: ['notes.md'],
    files: { 'notes.md': '# A' },
  });
  h.keydown('e', { metaKey: true });
  await h.waitFor(() => h.document.getElementById('editor-host').hidden === false);
  h.document.getElementById('editor-host').fakeEditor._fireChange('# edited in A');
  h.fetch.on('GET', (url) => url.pathname === rootScopedPath('raw', OTHER_KEY), () => ({ status: 200, text: '# B' }));

  h.window.history.pushState({ idx: 1 }, '', `/r/${OTHER_KEY}/notes.md`);
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate', { state: { idx: 1 } }));
  await h.waitFor(() => h.fetch.calls.some((call) => call.method === 'PUT'));

  const put = h.fetch.calls.find((call) => call.method === 'PUT');
  assert.equal(put.pathname, rootScopedPath('raw', KEY));
  assert.equal(put.url.searchParams.get('path'), 'notes.md');
});

test('a rejected popstate flush restores the source URL and keeps its dirty buffer', async () => {
  const OTHER_KEY = 'r_BBBBBBBBBBBBBBBBBBBBBB';
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'notes.md' },
    roots: [
      ...rootRoutes(),
      { key: OTHER_KEY, dir: '/tmp/other', name: 'other', url: `/r/${OTHER_KEY}/` },
    ],
    tree: ['notes.md'],
    files: { 'notes.md': '# A' },
  });
  h.keydown('e', { metaKey: true });
  await h.waitFor(() => h.document.getElementById('editor-host').hidden === false);
  const editor = h.document.getElementById('editor-host').fakeEditor;
  editor._fireChange('# unsaved A');
  h.fetch.on('PUT', (url) => url.pathname === rootScopedPath('raw', KEY), () => ({ status: 500, body: { error: 'disk full' } }));

  h.window.history.pushState({ idx: 1 }, '', `/r/${OTHER_KEY}/notes.md`);
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate', { state: { idx: 1 } }));
  await h.waitFor(() => h.document.getElementById('save-chip-text').textContent === 'Save failed');
  await h.waitFor(() => h.window.location.pathname === `/r/${KEY}/notes.md`);

  assert.equal(editor.getContent(), '# unsaved A');
  assert.equal(h.document.title, 'notes.md');
});

// Regression: a new root must not reuse the previous root's relative path.
test('opening a different folder from an already-open root loads that folder\'s own file, never the previous root\'s', async () => {
  const OTHER_KEY = 'r_BBBBBBBBBBBBBBBBBBBBBB';
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  assert.equal(h.document.title, 'a.md');

  h.fetch.on('GET', '/api/recents', () => ({ body: { recents: [{ path: '/tmp/other', kind: 'folder' }] } }));
  h.fetch.on('GET', (url) => url.pathname === rootScopedPath('tree', OTHER_KEY), () => ({ body: ['b.md'] }));
  h.fetch.on('GET', (url) => url.pathname === rootScopedPath('raw', OTHER_KEY), ({ url }) => {
    const p = url.searchParams.get('path');
    return p === 'b.md' ? { status: 200, text: '# B' } : { status: 404, body: { error: 'not found' } };
  });
  h.fetch.on('POST', (url) => url.pathname === '/api/roots', () => ({
    body: { root: { key: OTHER_KEY, dir: '/tmp/other', name: 'other', url: `/r/${OTHER_KEY}/` }, url: `/r/${OTHER_KEY}/` },
  }));

  h.click(h.document.querySelector('.root-switcher-btn'));
  await h.waitFor(() => h.document.querySelector('.root-switcher-recent-row'));
  h.click(h.document.querySelector('.root-switcher-recent-row'));

  await h.waitFor(() => h.document.title === 'b.md');
  assert.equal(h.window.location.pathname, `/r/${OTHER_KEY}/`);
  assert.equal(
    h.fetch.calls.some((c) => c.pathname === rootScopedPath('raw', OTHER_KEY) && c.search.includes('a.md')),
    false,
    'must never fetch the previous root\'s file path against the new root',
  );
  assert.deepEqual(h.errors, []);
});

test('opening a Recent from rootless Skills reaches the root on the first click', async () => {
  const h = await bootApp({
    route: { space: 'skills', selection: 'global' },
    roots: [],
    recents: [{ path: '/tmp/proj/README.md', kind: 'file' }],
    skillsTree: { scopes: [] },
    tree: ['README.md'],
    files: { 'README.md': '# Read me' },
  });
  h.fetch.on('POST', '/api/roots', () => ({
    body: {
      root: { key: KEY, dir: '/tmp/proj', name: 'proj', url: `/r/${KEY}/` },
      scope: { rootKey: KEY, scopePath: '' },
      url: `/r/${KEY}/README.md`,
    },
  }));

  const recent = h.document.querySelector('[data-kind="recent"]');
  assert.ok(recent, 'the rootless Skills Home shows Recents');
  h.click(recent);

  await h.waitFor(() => h.window.location.pathname === `/r/${KEY}/README.md`);
  assert.equal(h.document.title, 'README.md');
  assert.equal(h.document.getElementById('launcher-error').hidden, true);
  assert.deepEqual(h.errors, []);
});

// --- root-removed SSE (forgetting a folder) ---

test('a root-removed SSE event for this tab\'s root lands on plain Home with the sticky notice, without refetching the tree', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  const treeCallsBefore = h.fetch.calls.filter((c) => c.pathname === `/api/roots/${KEY}/tree`).length;

  h.EventSource.instances[0].emit({ rootKey: KEY, path: null, event: 'root-removed' });
  await h.waitFor(() => h.document.body.classList.contains('launcher'));

  assert.equal(h.document.getElementById('launcher-error').textContent, 'This root is no longer open.');
  const treeCallsAfter = h.fetch.calls.filter((c) => c.pathname === `/api/roots/${KEY}/tree`).length;
  assert.equal(treeCallsAfter, treeCallsBefore, 'root-removed must not trigger a doomed tree refetch');
  assert.deepEqual(h.errors, []);
});

test('a root-removed SSE event for a different rootKey leaves this tab alone', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });

  h.EventSource.instances[0].emit({ rootKey: 'r_BBBBBBBBBBBBBBBBBBBBBB', path: null, event: 'root-removed' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(h.document.body.classList.contains('launcher'), false, 'a foreign root closing must not send this tab home');
  assert.equal(h.document.getElementById('doc').textContent.includes('Title'), true);
  assert.deepEqual(h.errors, []);
});

test('a dirty editor buffer keeps its content when its own root is removed', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title\n\nbody text' },
  });
  h.keydown('e', { metaKey: true });
  await h.waitFor(() => h.document.getElementById('editor-host').hidden === false);

  const fakeEditor = h.document.getElementById('editor-host').fakeEditor;
  fakeEditor._fireChange('# Title\n\nedited but unsaved');
  assert.equal(h.document.getElementById('save-chip-text').textContent, 'Saving…');

  h.EventSource.instances[0].emit({ rootKey: TEST_ROOT_KEY, path: null, event: 'root-removed' });
  await h.waitFor(() => h.document.body.classList.contains('launcher'));

  assert.equal(fakeEditor.getContent(), '# Title\n\nedited but unsaved', 'the dirty buffer must survive the root closing');
  // The launcher hides but does not remove the editor or its buffer.
  assert.equal(h.document.getElementById('editor-host').fakeEditor, fakeEditor);
  assert.deepEqual(h.errors, []);
});

// --- root-promoted SSE (ancestor overlap resolves by promoting the root) ---

const NEW_KEY = 'r_CCCCCCCCCCCCCCCCCCCCCC';

test('a root-promoted SSE event rewrites the URL and reloads the addressed tree without refetching the document', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  h.fetch.on('GET', (url) => url.pathname === rootScopedPath('tree', NEW_KEY), () => ({ body: ['proj/a.md'] }));
  const before = h.fetch.calls.length;

  h.EventSource.instances[0].emit({
    rootKey: KEY,
    event: 'root-promoted',
    newRoot: { key: NEW_KEY, dir: '/tmp', name: 'tmp', url: `/r/${NEW_KEY}/` },
    scope: { rootKey: NEW_KEY, scopePath: 'proj' },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(h.window.location.pathname, `/r/${NEW_KEY}/proj/a.md`);
  const promotionCalls = h.fetch.calls.slice(before);
  assert.equal(promotionCalls.filter((call) => call.pathname === rootScopedPath('tree', NEW_KEY)).length, 1);
  assert.equal(promotionCalls.filter((call) => call.pathname === rootScopedPath('raw', NEW_KEY)).length, 0,
    'promotion keeps the open bytes and only refreshes navigation');
  assert.deepEqual(h.errors, []);
});

test('a root promotion rebases and saves a dirty document at its prefixed address', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# A' },
  });
  h.keydown('e', { metaKey: true });
  await h.waitFor(() => h.document.getElementById('editor-host').hidden === false);
  const editor = h.document.getElementById('editor-host').fakeEditor;
  editor._fireChange('# unsaved promoted A');
  h.fetch.on('GET', (url) => url.pathname === rootScopedPath('tree', NEW_KEY), () => ({ body: ['proj/a.md', 'proj/b.md'] }));

  h.EventSource.instances[0].emit({
    rootKey: KEY,
    event: 'root-promoted',
    newRoot: { key: NEW_KEY, dir: '/tmp', name: 'tmp', url: `/r/${NEW_KEY}/` },
    scope: { rootKey: NEW_KEY, scopePath: 'proj' },
  });
  await h.waitFor(() => h.fetch.calls.some((call) => call.method === 'PUT'));
  await h.waitFor(() => h.document.querySelector('[data-nav-id="proj/b.md"]'));

  const put = h.fetch.calls.find((call) => call.method === 'PUT');
  assert.equal(put.pathname, rootScopedPath('raw', NEW_KEY));
  assert.equal(put.url.searchParams.get('path'), 'proj/a.md');
  assert.equal(editor.getContent(), '# unsaved promoted A');
  assert.equal(h.window.location.pathname, `/r/${NEW_KEY}/proj/a.md`);
});

test('a root-promoted SSE event for a different rootKey leaves this tab alone', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });

  h.EventSource.instances[0].emit({
    rootKey: 'r_BBBBBBBBBBBBBBBBBBBBBB',
    event: 'root-promoted',
    newRoot: { key: NEW_KEY, dir: '/tmp', name: 'tmp', url: `/r/${NEW_KEY}/` },
    scope: { rootKey: NEW_KEY, scopePath: 'proj' },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(h.window.location.pathname, `/r/${KEY}/a.md`, 'a foreign root\'s promotion must not rewrite this tab\'s URL');
  assert.deepEqual(h.errors, []);
});

test('a root-promoted SSE event with no scope prefix (same-directory promotion) rewrites to a bare parent URL', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });

  h.EventSource.instances[0].emit({
    rootKey: KEY,
    event: 'root-promoted',
    newRoot: { key: NEW_KEY, dir: '/tmp', name: 'tmp', url: `/r/${NEW_KEY}/` },
    scope: { rootKey: NEW_KEY, scopePath: '' },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(h.window.location.pathname, `/r/${NEW_KEY}/a.md`);
});

// --- server-restarting SSE ---
// restart-follow unit tests cover hashes and timeout without a 20s app wait.

test('a server-restarting SSE event shows a transient state, then recovers in place once the same port answers', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  // bootApp's URL has no explicit port, so http's implicit default (80) is
  // what restart-follow.js's currentPort() reads back from location.port
  h.EventSource.instances[0].emit({ event: 'server-restarting', port: 80 });
  assert.equal(h.document.getElementById('save-chip-text').textContent, 'Restarting…');

  await h.waitFor(() => h.document.getElementById('save-chip-text').textContent !== 'Restarting…');

  assert.equal(h.document.getElementById('save-chip-dot').className.includes('error'), false,
    'a same-port recovery must not end in the stopped state');
  assert.deepEqual(h.errors, []);
});

test('a server-restarting SSE event for a port change polls the replacement origin, not the dead one', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });

  h.EventSource.instances[0].emit({ event: 'server-restarting', port: 4321 });
  assert.equal(h.document.getElementById('save-chip-text').textContent, 'Restarting…');
  await h.waitFor(() => h.fetch.calls.some((c) => c.url.href.startsWith('http://localhost:4321/')));

  const pinged = h.fetch.calls.some((c) => c.url.href.startsWith('http://localhost:4321/'));
  assert.ok(pinged, 'polls the replacement origin, not the dead one');
  assert.deepEqual(h.errors, []);
});

// --- Settings as a route ---

test('boot at /settings/?root=<key> opens Settings over the root it names', async () => {
  const h = await bootApp({
    route: { space: 'settings', rootKey: KEY },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  assert.deepEqual(h.errors, []);
  assert.equal(h.document.getElementById('settings-view').hidden, false);
  assert.equal(h.window.location.pathname, '/settings/');
  assert.equal(h.window.location.search, `?root=${KEY}`);
  const settingsCall = h.fetch.lastCallTo((c) => c.pathname === '/api/settings');
  assert.equal(settingsCall.search, `?root=${KEY}`);
});

test('boot at /settings/ with no root asks for the unscoped settings', async () => {
  const h = await bootApp({ route: { space: 'settings' }, roots: [] });
  assert.deepEqual(h.errors, []);
  assert.equal(h.document.getElementById('settings-view').hidden, false);
  const settingsCall = h.fetch.lastCallTo((c) => c.pathname === '/api/settings');
  assert.equal(settingsCall.search, '');
});

test('Settings follows a promoted root instead of keeping a dead root key', async () => {
  const h = await bootApp({
    route: { space: 'settings', rootKey: KEY },
    roots: rootRoutes(),
  });
  const before = h.fetch.calls.length;

  h.EventSource.instances[0].emit({
    rootKey: KEY,
    event: 'root-promoted',
    newRoot: { key: NEW_KEY, dir: '/tmp', name: 'tmp', url: `/r/${NEW_KEY}/` },
    scope: { rootKey: NEW_KEY, scopePath: 'proj' },
  });
  await h.waitFor(() => h.window.location.search === `?root=${NEW_KEY}`);

  assert.equal(h.window.location.pathname, '/settings/');
  assert.ok(h.fetch.calls.slice(before).some((call) => call.pathname === '/api/settings' && call.search === `?root=${NEW_KEY}`));
  assert.equal(h.fetch.calls.slice(before).some((call) => call.search.includes(KEY)), false);
});

test('root-scoped Skills follows a promoted root and reloads its catalog', async () => {
  const id = 'agents/demo/SKILL.md';
  const h = await bootApp({
    route: { space: 'skills', selection: 'root', rootKey: KEY, documentRoute: id },
    roots: rootRoutes(),
    skillsTree: { scopes: [{ name: 'Project', groups: [], skills: [{ id, name: 'demo', files: [], badges: [] }] }] },
    skillFiles: { [id]: '# demo' },
  });
  const before = h.fetch.calls.length;

  h.EventSource.instances[0].emit({
    rootKey: KEY,
    event: 'root-promoted',
    newRoot: { key: NEW_KEY, dir: '/tmp', name: 'tmp', url: `/r/${NEW_KEY}/` },
    scope: { rootKey: NEW_KEY, scopePath: 'proj' },
  });
  await h.waitFor(() => h.window.location.search === `?root=${NEW_KEY}`);

  assert.ok(h.fetch.calls.slice(before).some((call) => call.pathname === '/api/skills/tree' && call.search === `?root=${NEW_KEY}`));
  assert.equal(h.fetch.calls.slice(before).some((call) => call.search.includes(KEY)), false);
});

test('root-scoped Agents follows a promoted root and reloads its config tree', async () => {
  const id = 'project/AGENTS.md';
  const h = await bootApp({
    route: { space: 'agents', agentKey: 'codex', rootKey: KEY, documentRoute: id },
    roots: rootRoutes(),
    agentTree: {
      displayName: 'Codex', agents: [],
      groups: [{ name: 'Instructions', files: [{ id, label: 'AGENTS.md' }] }],
    },
    agentFiles: { [id]: '# agents' },
  });
  const before = h.fetch.calls.length;

  h.EventSource.instances[0].emit({
    rootKey: KEY,
    event: 'root-promoted',
    newRoot: { key: NEW_KEY, dir: '/tmp', name: 'tmp', url: `/r/${NEW_KEY}/` },
    scope: { rootKey: NEW_KEY, scopePath: 'proj' },
  });
  await h.waitFor(() => h.window.location.search === `?root=${NEW_KEY}`);

  assert.ok(h.fetch.calls.slice(before).some((call) => call.pathname === '/api/agents/codex/tree' && call.search === `?root=${NEW_KEY}`));
  assert.equal(h.fetch.calls.slice(before).some((call) => call.search.includes(KEY)), false);
});

test('the gear pushes /settings/ carrying the open root, and Back returns to the document', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  h.click(h.document.querySelector('.nav-footer-gear'));
  await h.waitFor(() => h.window.location.pathname === '/settings/');
  assert.equal(h.window.location.search, `?root=${KEY}`);
  assert.equal(h.document.getElementById('settings-view').hidden, false);

  h.window.history.pushState({ idx: 0 }, '', `/r/${KEY}/a.md`);
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate', { state: { idx: 0 } }));
  await h.waitFor(() => h.document.getElementById('settings-view').hidden);
  assert.equal(h.document.title, 'a.md');
  assert.deepEqual(h.errors, []);
});

test('leaving a deep-linked Settings with nothing behind it lands on its own root', async () => {
  const h = await bootApp({
    route: { space: 'settings', rootKey: KEY },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  h.click(h.document.querySelector('.nav-footer-gear'));
  await h.waitFor(() => h.window.location.pathname === `/r/${KEY}/`);
  assert.equal(h.document.getElementById('settings-view').hidden, true);
  assert.deepEqual(h.errors, []);
});

test('the history folder selector names the open roots and routes to the one picked', async () => {
  const OTHER = 'r_BBBBBBBBBBBBBBBBBBBBBB';
  const h = await bootApp({
    route: { space: 'settings', rootKey: KEY },
    roots: [
      ...rootRoutes(),
      { key: OTHER, dir: '/tmp/other', name: 'other', url: `/r/${OTHER}/` },
    ],
    tree: ['a.md'],
  });
  const selectEl = h.document.querySelector('[data-key="historyRoot"] .settings-select');
  assert.equal(selectEl.dataset.value, KEY);

  h.click(selectEl.querySelector('.settings-select-btn'));
  assert.deepEqual(
    [...selectEl.querySelectorAll('.settings-select-option')].map((o) => o.textContent),
    ['No folder', 'proj', 'other']
  );
  h.click([...selectEl.querySelectorAll('.settings-select-option')].find((o) => o.textContent === 'other'));
  await h.waitFor(() => h.window.location.search === `?root=${OTHER}`);
  assert.equal(h.window.location.pathname, '/settings/');
  const settingsCall = h.fetch.lastCallTo((c) => c.pathname === '/api/settings');
  assert.equal(settingsCall.search, `?root=${OTHER}`);
  assert.deepEqual(h.errors, []);
});

test('a folder name in a settings row is text, never markup', async () => {
  const h = await bootApp({
    route: { space: 'settings', rootKey: KEY },
    roots: [{ key: KEY, dir: '/tmp/x', name: '<img src=x onerror=boom>', url: `/r/${KEY}/` }],
  });
  const selectEl = h.document.querySelector('[data-key="historyRoot"] .settings-select');
  h.click(selectEl.querySelector('.settings-select-btn'));
  assert.equal(selectEl.querySelectorAll('img').length, 0);
  assert.ok([...selectEl.querySelectorAll('.settings-select-option')]
    .some((o) => o.textContent === '<img src=x onerror=boom>'));
  assert.deepEqual(h.errors, []);
});

test('a route move whose save flush is rejected leaves the address bar on the document', async () => {
  const h = await bootApp({
    route: { space: 'root', rootKey: KEY, documentPath: 'a.md' },
    roots: rootRoutes(),
    tree: ['a.md'],
    files: { 'a.md': '# Title\n\nbody text' },
  });
  h.keydown('e', { metaKey: true });
  await h.waitFor(() => h.document.getElementById('editor-host').hidden === false);
  h.fetch.on('PUT', (url) => /^\/api\/roots\/[^/]+\/raw$/.test(url.pathname), () => ({ status: 500, body: { error: 'disk full' } }));
  h.document.getElementById('editor-host').fakeEditor._fireChange('# Title\n\nedited but unsaved');

  h.click(h.document.querySelector('.nav-footer-gear'));
  await h.waitFor(() => h.document.getElementById('save-chip-text').textContent === 'Save failed');

  assert.equal(h.window.location.pathname, `/r/${KEY}/a.md`, 'a rejected flush must not move the URL');
  assert.equal(h.document.getElementById('settings-view').hidden, true);
  assert.deepEqual(h.errors, []);
});

test('booting on a Skills route loads the catalog and opens the document the URL names', async () => {
  const h = await bootApp({
    route: { space: 'skills', selection: 'global', documentRoute: 'agents/demo/SKILL.md' },
    roots: [],
    skillsTree: { scopes: [{ groups: [], skills: [{ id: 'agents/demo/SKILL.md', name: 'demo', files: [], badges: [] }] }] },
    skillFiles: { 'agents/demo/SKILL.md': '# demo skill' },
  });
  await h.waitFor(() => h.document.querySelector('[data-nav-id="agents/demo/SKILL.md"]'));
  const raw = h.fetch.calls.find((c) => c.pathname === '/api/skills/raw');
  assert.ok(raw, 'the skill document is read through the skills space');
  assert.equal(raw.url.searchParams.get('id'), 'agents/demo/SKILL.md');
  assert.deepEqual(h.errors, []);
});

test('the Skills footer button navigates into the Skills space, carrying the open root', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  h.fetch.on('GET', '/api/skills/tree', () => ({ body: { scopes: [] } }));
  h.click(h.document.querySelector('.nav-footer-skills'));
  await h.waitFor(() => h.fetch.calls.some((c) => c.pathname === '/api/skills/tree'));
  assert.equal(h.window.location.pathname, '/skills/');
  assert.equal(h.window.location.search, `?root=${TEST_ROOT_KEY}`);
  assert.deepEqual(h.errors, []);
});

test('clicking a skill uses the href the server emitted, not a client-built URL', async () => {
  const h = await bootApp({
    route: { space: 'skills', selection: 'global' },
    roots: [],
    skillsTree: {
      scopes: [{
        groups: [],
        skills: [{
          id: 'agents/demo/SKILL.md',
          name: 'demo',
          badges: [],
          href: '/skills/agents/demo/SKILL.md?scope=all',
          files: [],
        }],
      }],
    },
    skillFiles: { 'agents/demo/SKILL.md': '# demo skill' },
  });
  await h.waitFor(() => h.document.querySelector('[data-nav-id="agents/demo/SKILL.md"]'));
  h.click(h.document.querySelector('[data-nav-id="agents/demo/SKILL.md"]'));
  await h.waitFor(() => h.window.location.search === '?scope=all');
  assert.equal(h.window.location.pathname, '/skills/agents/demo/SKILL.md');
  assert.deepEqual(h.errors, []);
});

test('a direct URL into an empty skills or agents catalog names the empty state in the sidebar', async () => {
  const skills = await bootApp({
    route: { space: 'skills', selection: 'global' },
    skillsTree: { scopes: [] },
  });
  await skills.waitFor(() => skills.document.querySelector('.nav-body .nav-empty')?.textContent.startsWith('No skills installed yet'));
  assert.deepEqual(skills.errors, []);

  const agents = await bootApp({
    route: { space: 'agents', agentKey: 'claude' },
    agentTree: { agent: 'claude', displayName: 'Claude', detected: false, agents: [], groups: [], roots: [] },
  });
  await agents.waitFor(() => agents.document.querySelector('.nav-body .nav-empty')?.textContent.startsWith('No agent config found'));
  assert.deepEqual(agents.errors, []);
});
