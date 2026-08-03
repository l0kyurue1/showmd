import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers/boot-app.mjs';

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

  await t.test('shift+mod+H toggles the right panel', () => {
    const before = h.document.getElementById('panel').classList.contains('collapsed');
    h.keydown('h', { metaKey: true, shiftKey: true });
    assert.notEqual(h.document.getElementById('panel').classList.contains('collapsed'), before);
    assert.deepEqual(h.errors, []);
  });
});

test('shift+mod+S and shift+mod+A run without a ReferenceError when Home is showing', async () => {
  const h = await bootApp({ root: { dir: null, name: null } });
  assert.equal(h.document.body.classList.contains('launcher'), true);

  h.keydown('s', { metaKey: true, shiftKey: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(h.errors, []);

  h.keydown('a', { metaKey: true, shiftKey: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(h.errors, []);
});

test('an SSE change event for the open file whose refetch 500s does not blank the document or the saved baseline', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title\n\n- [ ] task one' },
  });
  assert.equal(h.document.getElementById('doc').textContent.includes('task one'), true);

  h.fetch.on('GET', (url) => url.pathname === '/api/raw' && url.searchParams.get('path') === 'a.md', () => ({
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

  const putCallsBefore = h.fetch.calls.filter((c) => c.method === 'PUT' && c.pathname === '/api/raw').length;
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const putCallsAfter = h.fetch.calls.filter((c) => c.method === 'PUT' && c.pathname === '/api/raw').length;
  assert.equal(putCallsAfter, putCallsBefore, 'a detached document must never autosave the placeholder');
  assert.deepEqual(h.errors, []);
});

// --- restored coverage for isMacPlatform, shortcutLabel, revealLabel, resolveTheme,
// initialColorMode -- these lived in the deleted theme.test.mjs / shortcuts.test.mjs
// and are folded into app.js now, exercised here through observable DOM behaviour.

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
  h.fetch.on('GET', '/api/history', () => ({ body: [{ rev: 'deadbeef', ts: Math.floor(Date.now() / 1000), source: 'you', repo: false }] }));
  h.fetch.on('GET', '/api/diff', () => ({ status: 200, text: '@@ -1 +1 @@\n-old\n+new' }));
  h.click(h.document.getElementById('panel-btn'));
  await h.waitFor(() => h.document.querySelector('#ver-list .ver'));
  h.click(h.document.querySelector('#ver-list .ver'));
  await h.waitFor(() => h.document.getElementById('diff-view').hidden === false);

  h.fetch.on('POST', '/api/restore', () => ({ status: 500, body: { error: 'boom' } }));
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
  h.fetch.on('GET', '/api/history', () => ({ body: [{ rev: 'deadbeef', ts: Math.floor(Date.now() / 1000), source: 'you', repo: false }] }));
  h.fetch.on('GET', '/api/diff', () => ({ status: 200, text: '@@ -1 +1 @@\n-old\n+new' }));
  h.click(h.document.getElementById('panel-btn'));
  await h.waitFor(() => h.document.querySelector('#ver-list .ver'));
  h.click(h.document.querySelector('#ver-list .ver'));
  await h.waitFor(() => h.document.getElementById('diff-view').hidden === false);

  h.fetch.on('POST', '/api/restore', () => { throw new Error('network down'); });
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
  h.fetch.on('GET', '/api/history', () => ({ body: [{ rev: 'deadbeef', ts: Math.floor(Date.now() / 1000), source: 'you', repo: false }] }));
  h.fetch.on('GET', '/api/diff', () => ({ status: 200, text: '@@ -1 +1 @@\n-old\n+new' }));
  h.click(h.document.getElementById('panel-btn'));
  await h.waitFor(() => h.document.querySelector('#ver-list .ver'));
  h.click(h.document.querySelector('#ver-list .ver'));
  await h.waitFor(() => h.document.getElementById('diff-view').hidden === false);
  assert.equal(h.document.getElementById('diff-view').hidden, false);

  h.fetch.on('POST', '/api/restore', () => ({ status: 200, body: { ok: true } }));
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
  });
  h.fetch.on('POST', '/api/reveal', () => ({ status: 500, body: { error: 'boom' } }));
  h.click(h.document.getElementById('reveal-btn'));
  await h.waitFor(() => h.document.getElementById('save-chip-text').textContent === 'Reveal failed');
  assert.equal(h.document.getElementById('save-chip-dot').className.includes('error'), true);

  await h.waitFor(() => h.document.getElementById('save-chip-text').textContent !== 'Reveal failed', { timeout: 3500 });
  assert.deepEqual(h.errors, []);
});

test('reveal: a successful reveal reports no error', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  h.fetch.on('POST', '/api/reveal', () => ({ status: 200, body: { ok: true } }));
  h.click(h.document.getElementById('reveal-btn'));
  await h.waitFor(() => h.fetch.calls.some((c) => c.method === 'POST' && c.pathname === '/api/reveal'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.notEqual(h.document.getElementById('save-chip-text').textContent, 'Reveal failed');
  assert.deepEqual(h.errors, []);
});

test('refreshTree: a non-ok skills-tree refresh reports the failure and keeps the last known list', async () => {
  const h = await bootApp({
    root: { dir: '/tmp/proj', name: 'proj' },
    tree: ['a.md'],
    files: { 'a.md': '# Title' },
  });
  h.fetch.on('GET', (url) => url.pathname === '/api/tree' && url.searchParams.get('view') === 'skills', () => ({
    body: { scopes: [{ groups: [{ skills: [{ id: 'sk', files: [{ id: 'sk/one.md' }], badges: [] }] }], skills: [] }] },
  }));
  h.fetch.on('GET', (url) => url.pathname === '/api/raw' && url.searchParams.get('path') === 'sk/one.md', () => ({ status: 200, text: '# one' }));
  h.keydown('s', { metaKey: true, shiftKey: true });
  await h.waitFor(() => h.document.querySelector('[data-nav-id="sk/one.md"]'));

  h.fetch.on('GET', (url) => url.pathname === '/api/tree' && url.searchParams.get('view') === 'skills', () => ({
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
  h.fetch.on('GET', (url) => url.pathname === '/api/tree' && url.searchParams.get('view') === 'skills', () => ({
    body: { scopes: [{ groups: [{ skills: [{ id: 'sk', files: [{ id: 'sk/one.md' }], badges: [] }] }], skills: [] }] },
  }));
  h.fetch.on('GET', (url) => url.pathname === '/api/raw' && url.searchParams.get('path') === 'sk/one.md', () => ({ status: 200, text: '# one' }));
  h.keydown('s', { metaKey: true, shiftKey: true });
  await h.waitFor(() => h.document.querySelector('[data-nav-id="sk/one.md"]'));

  h.fetch.on('GET', (url) => url.pathname === '/api/tree' && url.searchParams.get('view') === 'skills', () => ({
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
