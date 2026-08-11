import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
