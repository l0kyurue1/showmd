import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workDir = mkdtempSync(path.join(tmpdir(), 'showmd-settings-view-'));
process.env.SHOWMD_SETTINGS_HOME = path.join(workDir, 'settings-state');
process.env.SHOWMD_HISTORY_HOME = path.join(workDir, 'history-state');
test.after(() => rmSync(workDir, { recursive: true, force: true }));

const settingsMod = await import('../../server/settings.js');
const updateCheckMod = await import('../../server/update-check.js');
const { getSettingsView } = await import('../../server/settings-view.js');

function view(overrides = {}) {
  return getSettingsView({
    platform: 'linux',
    mdHandlerDefaultFn: () => false,
    appStatusFn: () => ({ installed: false, stale: false, path: null }),
    effectiveSettingsPromise: Promise.resolve(settingsMod.DEFAULTS),
    cliPath: '/pkg/bin/cli.js',
    ...overrides,
  });
}

test('getSettingsView: browsers list has "default" first, even with nothing installed on this platform', async () => {
  const body = await view();
  assert.ok(Array.isArray(body.browsers));
  assert.equal(body.browsers[0], 'default');
  assert.equal(body.port, settingsMod.DEFAULTS.port);
});

test('getSettingsView: includes settingsPath, defaults, and effective straight from injected values', async () => {
  const body = await view({ effectiveSettingsPromise: Promise.resolve({ port: 9999, browser: 'firefox' }) });
  assert.equal(body.settingsPath, settingsMod.settingsFile());
  assert.deepEqual(body.defaults, settingsMod.DEFAULTS);
  assert.deepEqual(body.effective, { port: 9999, browser: 'firefox' });
});

test('getSettingsView: mdHandlerDefault and appInstalled/appStale/appPath come from the injected seams', async () => {
  const body = await view({
    mdHandlerDefaultFn: () => true,
    appStatusFn: () => ({ installed: true, stale: true, path: '/fake/ShowMD.app', staleReason: 'version', appVersion: '0.1.0' }),
  });
  assert.equal(body.mdHandlerDefault, true);
  assert.equal(body.appInstalled, true);
  assert.equal(body.appStale, true);
  assert.equal(body.appPath, '/fake/ShowMD.app');
});

test('getSettingsView: appMdRegistered comes straight from the appStatus seam, false when absent', async () => {
  const registered = await view({
    appStatusFn: () => ({ installed: true, stale: false, path: '/fake/ShowMD.app', appMdRegistered: true }),
  });
  assert.equal(registered.appMdRegistered, true);

  const notRegistered = await view();
  assert.equal(notRegistered.appMdRegistered, false);
});

test('getSettingsView: appStaleReason and appVersion come straight from the appStatus seam', async () => {
  const versionMismatch = await view({
    appStatusFn: () => ({ installed: true, stale: true, path: '/fake/ShowMD.app', staleReason: 'version', appVersion: '0.1.0' }),
  });
  assert.equal(versionMismatch.appStaleReason, 'version');
  assert.equal(versionMismatch.appVersion, '0.1.0');

  const vanished = await view({
    appStatusFn: () => ({ installed: true, stale: true, path: '/fake/ShowMD.app', staleReason: 'missing', appVersion: null }),
  });
  assert.equal(vanished.appStaleReason, 'missing');
  assert.equal(vanished.appVersion, null);

  const healthy = await view({
    appStatusFn: () => ({ installed: true, stale: false, path: '/fake/ShowMD.app', staleReason: null, appVersion: '0.2.0' }),
  });
  assert.equal(healthy.appStaleReason, null);
  assert.equal(healthy.appVersion, '0.2.0');
});

test('getSettingsView: showmdVersion is the running package version', async () => {
  const body = await view();
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(body.showmdVersion, pkg.version);
});

test('getSettingsView: updateChannel reflects the running cli path', async () => {
  const brew = await view({ cliPath: '/opt/homebrew/Cellar/showmd/1.2.3/libexec/bin/cli.js' });
  assert.equal(brew.updateChannel, 'brew');
  const npmGlobal = await view({ cliPath: '/usr/local/lib/node_modules/showmd/bin/cli.js' });
  assert.equal(npmGlobal.updateChannel, 'npm-global');
});

// history sizes are slow prefix queries over the shadow git store; they moved
// out to GET /api/history-size so the boot payload never waits on git
test('getSettingsView: the boot payload carries no history size fields', async () => {
  const body = await view();
  assert.ok(!('historySizeBytes' in body));
  assert.ok(!('historyTotalBytes' in body));
});

test('getSettingsView: update fields default to the "no update" shape before any refresh has run', async () => {
  const body = await view();
  assert.equal(body.updateAvailable, false);
  assert.equal(body.latestVersion, null);
  assert.equal(body.checkFailed, false);
});

test('getSettingsView: checkFailed surfaces once a check has actually failed', async () => {
  await updateCheckMod.refreshUpdateCache(async () => { throw new Error('registry down'); });
  const body = await view();
  assert.equal(body.checkFailed, true);
});

test('getSettingsView: checkFailed stays false while update checks are turned off, even after a failed check', async () => {
  await settingsMod.writeSettings({ updateCheck: false });
  const off = await view();
  assert.equal(off.checkFailed, false);
  await settingsMod.writeSettings({ updateCheck: true });
});
