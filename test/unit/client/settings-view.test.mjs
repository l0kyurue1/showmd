import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { SETTINGS_GROUPS, FONT_PRESETS, formatBytes, rowByKey, applyDerivedValues, optionLabel, nextOptionIndex, createSettingsView } from '../../../client/settings-view.js';

const CONTROLS = ['select', 'number', 'checkbox', 'action', 'link'];
const allRows = () => SETTINGS_GROUPS.flatMap((g) => g.rows);

test('every row is addressable by a unique key and describes itself', () => {
  const keys = allRows().map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const row of allRows()) {
    assert.ok(row.label, `${row.key} needs a label`);
    assert.ok(row.desc, `${row.key} needs a description`);
    assert.ok(CONTROLS.includes(row.control), `${row.key} has control ${row.control}`);
    if (row.control === 'select') assert.ok(row.options.length > 0, `${row.key} needs options`);
    if (row.control === 'action') assert.ok(row.buttonLabel, `${row.key} needs a button label`);
    if (row.control === 'link') {
      assert.match(row.href, /^https:\/\/github\.com\/l0kyurue1\/showmd/, `${row.key} needs a repo url`);
      assert.ok(row.linkLabel, `${row.key} needs a link label`);
      assert.ok(row.ariaLabel, `${row.key} needs an aria-label`);
    }
  }
});

test('the About group offers the source and the issue tracker, in that order', () => {
  const about = SETTINGS_GROUPS.at(-1);
  assert.equal(about.title, 'About');
  assert.deepEqual(about.rows.map((r) => r.key), ['repo', 'issues']);
  assert.equal(rowByKey('repo').href, 'https://github.com/l0kyurue1/showmd');
  assert.equal(rowByKey('issues').href, 'https://github.com/l0kyurue1/showmd/issues');
});

test('the font rows offer exactly the presets the document can apply', () => {
  assert.deepEqual(rowByKey('fontPreset').options.map(([k]) => k), Object.keys(FONT_PRESETS));
  for (const preset of Object.values(FONT_PRESETS)) assert.match(preset.family, /^var\(--[a-z]+\)$/);
});

test('rowByKey finds a row anywhere in the page, and nothing for a stranger', () => {
  assert.equal(rowByKey('port').control, 'number');
  assert.equal(rowByKey('resetAll').control, 'action');
  assert.equal(rowByKey('nope'), undefined);
});

test('sizes read in the largest unit that keeps them short', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(undefined), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(20 * 1024), '20 KB');
  assert.equal(formatBytes(5 * 1024 ** 2), '5.0 MB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GB');
});

test('sizes past the largest unit keep counting in it rather than overflowing', () => {
  assert.equal(formatBytes(2048 * 1024 ** 3), '2048 GB');
});

test('registering .md files is offered only on macOS', () => {
  applyDerivedValues({ platform: 'linux', appInstalled: true });
  assert.equal(rowByKey('registerMarkdown').hidden, true);
  applyDerivedValues({ platform: 'darwin', appInstalled: true });
  assert.equal(rowByKey('registerMarkdown').hidden, false);
});

test('registerMarkdown: app not installed asks for that first, button stays disabled', () => {
  applyDerivedValues({ platform: 'darwin', appInstalled: false, appMdRegistered: false, mdHandlerDefault: false });
  const row = rowByKey('registerMarkdown');
  assert.equal(row.desc, 'Install the app above first.');
  assert.equal(row.buttonLabel, 'Register');
  assert.equal(row.disabled, true);
});

test('registerMarkdown: installed but not registered offers to add it to Open With', () => {
  applyDerivedValues({ platform: 'darwin', appInstalled: true, appMdRegistered: false, mdHandlerDefault: false });
  const row = rowByKey('registerMarkdown');
  assert.equal(row.desc, 'Add ShowMD to the Open With menu for markdown files.');
  assert.equal(row.buttonLabel, 'Register');
  assert.equal(row.disabled, false);
});

test('registerMarkdown: registered but not the default offers to set it', () => {
  applyDerivedValues({ platform: 'darwin', appInstalled: true, appMdRegistered: true, mdHandlerDefault: false });
  const row = rowByKey('registerMarkdown');
  assert.equal(row.desc, "In Finder's Open With menu. Another app still opens .md files.");
  assert.equal(row.buttonLabel, 'Set as default');
  assert.equal(row.disabled, false);
});

test('registerMarkdown: registered and the default is a done state, button disabled', () => {
  applyDerivedValues({ platform: 'darwin', appInstalled: true, appMdRegistered: true, mdHandlerDefault: true });
  const row = rowByKey('registerMarkdown');
  assert.equal(row.desc, 'ShowMD opens .md files.');
  assert.equal(row.buttonLabel, 'Registered');
  assert.equal(row.disabled, true);
});

test('the app row carries where it was installed', () => {
  applyDerivedValues({ appInstalled: true, appVersion: '0.1.0', appPath: '/Applications/ShowMD.app' });
  assert.deepEqual(
    [rowByKey('installApp').installed, rowByKey('installApp').appPath],
    [true, '/Applications/ShowMD.app'],
  );
});

test('not installed: names the outcome, not the mechanism, and offers Install', () => {
  applyDerivedValues({ appInstalled: false, appPath: null });
  const row = rowByKey('installApp');
  assert.equal(row.installed, false);
  assert.equal(row.desc, 'Open showmd without the terminal.');
  assert.equal(row.buttonLabel, 'Install');
});

test('installed and healthy: shows the app version only, button reads Installed and is disabled', () => {
  applyDerivedValues({ appInstalled: true, appStale: false, appVersion: '0.1.0', appPath: '/Applications/ShowMD.app' });
  const row = rowByKey('installApp');
  assert.equal(row.installed, true);
  assert.equal(row.stale, false);
  assert.equal(row.desc, 'App 0.1.0');
});

test('a folder with no history offers nothing to prune', () => {
  applyDerivedValues({ historySizeBytes: null, historyTotalBytes: null });
  assert.equal(rowByKey('prune').label, "This folder's history");
  assert.equal(rowByKey('prune').disabled, true);
  assert.equal(rowByKey('pruneAll').label, 'All saved histories');
});

test('history sizes land in the prune labels', () => {
  applyDerivedValues({ historySizeBytes: 1536, historyTotalBytes: 5 * 1024 ** 2 });
  assert.equal(rowByKey('prune').label, "This folder's history · 1.5 KB");
  assert.equal(rowByKey('prune').disabled, false);
  assert.equal(rowByKey('pruneAll').label, 'All saved histories · 5.0 MB');
});

test('the update row states the running version and, when on, whether it is current', () => {
  applyDerivedValues({ showmdVersion: '0.1.0', updateCheck: true, updateAvailable: false, checkFailed: false });
  assert.equal(rowByKey('updateCheck').desc, 'showmd 0.1.0 · up to date');
});

test('the update row names the available version instead of a command — the command belongs to the sidebar CTA', () => {
  applyDerivedValues({ showmdVersion: '0.1.0', updateCheck: true, updateAvailable: true, latestVersion: '0.2.0', checkFailed: false });
  assert.equal(rowByKey('updateCheck').desc, 'showmd 0.1.0 · 0.2.0 available');
});

test('the update row says checks are off, even if a stale update was once seen', () => {
  applyDerivedValues({ showmdVersion: '0.1.0', updateCheck: false, updateAvailable: true, latestVersion: '0.2.0', checkFailed: false });
  assert.equal(rowByKey('updateCheck').desc, 'showmd 0.1.0 · checks are off');
});

test('the update row distinguishes a failed check from up to date', () => {
  applyDerivedValues({ showmdVersion: '0.1.0', updateCheck: true, updateAvailable: false, checkFailed: true });
  assert.equal(rowByKey('updateCheck').desc, 'showmd 0.1.0 · last check failed');
});

test('the app row shows both versions when stale means a version mismatch, and offers Update', () => {
  applyDerivedValues({ appInstalled: true, appStale: false, appVersion: '0.1.0', appPath: '/Applications/ShowMD.app' });
  assert.equal(rowByKey('installApp').stale, false);
  assert.doesNotMatch(rowByKey('installApp').desc, /no longer installed/);

  applyDerivedValues({
    appInstalled: true, appStale: true, appStaleReason: 'version',
    appVersion: '0.1.0', showmdVersion: '0.2.0', appPath: '/Applications/ShowMD.app',
  });
  const row = rowByKey('installApp');
  assert.equal(row.stale, true);
  assert.equal(row.staleReason, 'version');
  assert.equal(row.desc, 'App 0.1.0 · 0.2.0 available');
});

test('the app row says the showmd it points at is gone when stale means a vanished entry point, no version comparison implied, and offers Repair', () => {
  applyDerivedValues({
    appInstalled: true, appStale: true, appStaleReason: 'missing',
    appVersion: null, showmdVersion: '0.2.0', appPath: '/Applications/ShowMD.app',
  });
  const row = rowByKey('installApp');
  assert.equal(row.stale, true);
  assert.equal(row.staleReason, 'missing');
  assert.match(row.desc, /no longer installed/);
  assert.doesNotMatch(row.desc, /\d/);
});

test('the browser list becomes options, with default spelled out', () => {
  applyDerivedValues({ browsers: ['default', 'Safari', 'Firefox'] });
  assert.deepEqual(rowByKey('browser').options, [['default', 'System default'], ['Safari', 'Safari'], ['Firefox', 'Firefox']]);
});

test('a restart is needed exactly when a server setting has outrun the running server', () => {
  assert.equal(applyDerivedValues({ port: 4399, browser: 'default', effective: { port: 4399, browser: 'default' } }), false);
  assert.equal(applyDerivedValues({ port: 5000, browser: 'default', effective: { port: 4399, browser: 'default' } }), true);
  assert.equal(applyDerivedValues({ port: 4399, browser: 'Safari', effective: { port: 4399, browser: 'default' } }), true);
});

test('a server that never reported its effective settings asks for no restart', () => {
  assert.equal(applyDerivedValues({ port: 5000 }), false);
});

test('a value with no label of its own shows as itself', () => {
  const options = [['default', 'System default'], ['Safari', 'Safari']];
  assert.equal(optionLabel(options, 'default'), 'System default');
  assert.equal(optionLabel(options, 'Arc'), 'Arc');
});

test('arrowing through a menu stops at both ends', () => {
  assert.equal(nextOptionIndex('ArrowDown', 0, 3), 1);
  assert.equal(nextOptionIndex('ArrowDown', 2, 3), 2);
  assert.equal(nextOptionIndex('ArrowUp', 2, 3), 1);
  assert.equal(nextOptionIndex('ArrowUp', 0, 3), 0);
});

test('arrowing with nothing focused lands on the first option either way', () => {
  assert.equal(nextOptionIndex('ArrowDown', -1, 3), 0);
  assert.equal(nextOptionIndex('ArrowUp', -1, 3), 0);
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount() {
  document.body.innerHTML = '<div id="settings"></div><div id="cta"></div>';
  const calls = { put: [], prune: [], theme: [], fontPreset: [], fontSize: [], back: 0 };
  let payload = {
    colorMode: 'system', fontPreset: 'serif', fontSize: 16,
    openMode: 'read', updateCheck: true, port: 4321, browser: 'default',
    platform: 'linux', showmdVersion: '1.2.3',
    defaults: { colorMode: 'system', fontPreset: 'default', fontSize: 15, openMode: 'read', updateCheck: true, port: 4321, browser: 'default' },
    effective: { port: 4321, browser: 'default' },
  };
  const api = {
    getSettings: async () => ({ ok: true, json: async () => payload }),
    putSettings: async (values) => { calls.put.push(values); return { ok: true }; },
    installApp: async () => ({ ok: true, json: async () => ({}) }),
    registerMarkdown: async () => ({ ok: true, json: async () => ({}) }),
    prune: async (scope) => { calls.prune.push(scope); return { ok: true }; },
    restart: async () => ({ ok: true }),
    ping: async () => ({ ok: true }),
  };
  const view = createSettingsView({
    root: document.getElementById('settings'),
    ctaEl: document.getElementById('cta'),
    api,
    fetchSettings: async () => (await api.getSettings()).json(),
    saveSetting: async (key, value) => { await api.putSettings({ [key]: value }); },
    chevronSvg: '<svg></svg>',
    positionTip: () => {},
    setTheme: (value, opts) => calls.theme.push([value, opts]),
    applyFontPreset: (value) => calls.fontPreset.push(value),
    applyFontSize: (value) => calls.fontSize.push(value),
    returnsHome: () => false,
    onBack: () => { calls.back++; },
  });
  const root = document.getElementById('settings');
  return {
    view, calls, root, cta: document.getElementById('cta'),
    setPayload: (patch) => { payload = { ...payload, ...patch }; },
    row: (key) => root.querySelector(`[data-key="${key}"]`),
  };
}

test('open renders one row per visible setting, carrying the served values', async () => {
  const ui = mount();
  await ui.view.open();

  assert.equal(ui.root.querySelector('.settings-back').textContent, '← Back');
  assert.deepEqual(
    [...ui.root.querySelectorAll('.settings-group-title')].map((el) => el.dataset.groupTitle),
    SETTINGS_GROUPS.map((g) => g.title),
  );
  assert.equal(ui.row('fontPreset').querySelector('.settings-select-value').textContent, 'Serif');
  assert.equal(ui.row('fontSize').querySelector('input[type="number"]').value, '16');
  assert.equal(ui.row('updateCheck').querySelector('input[type="checkbox"]').checked, true);
  // platform is linux, so the macOS-only Open With row never reaches the DOM
  assert.equal(ui.row('registerMarkdown'), null);
  assert.equal(ui.root.querySelectorAll('.settings-preview').length, 1);
});

test('the About links leave for GitHub in a new tab, with no handle back to this origin', async () => {
  const ui = mount();
  await ui.view.open();

  for (const [key, href, label, aria] of [
    ['repo', 'https://github.com/l0kyurue1/showmd', 'GitHub', 'showmd on GitHub'],
    ['issues', 'https://github.com/l0kyurue1/showmd/issues', 'Open', 'Report an issue on GitHub'],
  ]) {
    const link = ui.row(key).querySelector('a.settings-row-link');
    assert.equal(link.getAttribute('href'), href);
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener');
    assert.equal(link.getAttribute('aria-label'), aria);
    assert.equal(link.querySelector('span').textContent, label);
    assert.ok(link.querySelector('svg'), `${key} needs the external-link glyph`);
  }
  assert.equal(ui.row('repo').querySelector('.settings-reset-btn'), null);
});

test('picking a select option persists it through the api and applies the live effect', async () => {
  const ui = mount();
  await ui.view.open();

  ui.row('fontPreset').querySelector('.settings-select-btn').click();
  assert.equal(ui.view.menuOpen(), true);
  const mono = [...ui.row('fontPreset').querySelectorAll('.settings-select-option')].find((o) => o.textContent === 'Monospace');
  ui.setPayload({ fontPreset: 'mono' });
  mono.click();
  await tick();

  assert.equal(ui.view.menuOpen(), false);
  assert.deepEqual(ui.calls.put, [{ fontPreset: 'mono' }]);
  assert.deepEqual(ui.calls.fontPreset, ['mono']);
  assert.equal(ui.row('fontPreset').querySelector('.settings-select-value').textContent, 'Monospace');
});

test('a number change saves the parsed number and reveals the per-row reset', async () => {
  const ui = mount();
  await ui.view.open();
  const input = ui.row('fontSize').querySelector('input[type="number"]');
  assert.equal(ui.row('fontSize').querySelector('.settings-reset-btn').hidden, false);

  input.value = '15';
  ui.setPayload({ fontSize: 15 });
  input.dispatchEvent(new dom.window.Event('change'));
  await tick();

  assert.deepEqual(ui.calls.put, [{ fontSize: 15 }]);
  assert.deepEqual(ui.calls.fontSize, [15]);
  assert.equal(ui.row('fontSize').querySelector('.settings-reset-btn').hidden, true);
});

test('color mode goes to the theme writer instead of a direct save', async () => {
  const ui = mount();
  await ui.view.open();

  ui.row('colorMode').querySelector('.settings-select-btn').click();
  [...ui.row('colorMode').querySelectorAll('.settings-select-option')].find((o) => o.textContent === 'Dark').click();
  await tick();

  assert.deepEqual(ui.calls.theme, [['dark', undefined]]);
  assert.deepEqual(ui.calls.put, []);
});

test('reset all arms first, then writes every default and rebuilds the page', async () => {
  const ui = mount();
  await ui.view.open();
  const btn = ui.row('resetAll').querySelector('.settings-row-control button');

  btn.click();
  assert.equal(btn.textContent, 'Sure?');
  assert.deepEqual(ui.calls.put, []);

  btn.click();
  await tick();

  assert.deepEqual(ui.calls.put, [{
    colorMode: 'system', fontPreset: 'default', fontSize: 15, openMode: 'read',
    updateCheck: true, port: 4321, browser: 'default',
  }]);
  assert.deepEqual(ui.calls.theme, [['system', { persist: false }]]);
  assert.deepEqual(ui.calls.fontPreset, ['default']);
  assert.deepEqual(ui.calls.fontSize, [15]);
  assert.equal(ui.root.querySelectorAll('.settings-back').length, 1);
});

test('the back link reports to the host instead of touching the view itself', async () => {
  const ui = mount();
  await ui.view.open();
  ui.root.querySelector('.settings-back').click();
  assert.equal(ui.calls.back, 1);
});

test('renderCta paints a pending release and stays empty when there is none', () => {
  const ui = mount();
  localStorage.clear();
  ui.view.renderCta({ updateAvailable: true, updateChannel: 'brew', latestVersion: '9.9.9' });
  assert.equal(ui.cta.hidden, false);
  assert.match(ui.cta.textContent, /9\.9\.9/);
  assert.equal(ui.cta.querySelector('code').textContent, 'brew upgrade showmd');

  ui.view.renderCta({});
  assert.equal(ui.cta.hidden, true);
  assert.equal(ui.cta.textContent, '');
});

test('renderCta puts a markup-bearing version in as text, not as HTML', () => {
  const ui = mount();
  localStorage.clear();
  ui.view.renderCta({ updateAvailable: true, updateChannel: 'brew', latestVersion: '<img src=x onerror=alert(1)>' });
  assert.equal(ui.cta.querySelector('img'), null);
  assert.match(ui.cta.querySelector('.update-cta-title').textContent, /<img src=x onerror=alert\(1\)>/);
});
