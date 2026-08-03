import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdateCta } from '../../../client/update-cta.js';

test('nothing pending renders nothing', () => {
  assert.equal(buildUpdateCta({ updateAvailable: false, appInstalled: false }), null);
});

test('showmd update available: title, command per channel, dismissible', () => {
  const brew = buildUpdateCta({ updateAvailable: true, latestVersion: '0.2.0', updateChannel: 'brew' });
  assert.equal(brew.state, 'showmd');
  assert.equal(brew.title, 'There is a new version 0.2.0');
  assert.equal(brew.command, 'brew upgrade showmd');
  assert.equal(brew.showDismiss, true);
  assert.equal(brew.dismissVersion, '0.2.0');

  const npmGlobal = buildUpdateCta({ updateAvailable: true, latestVersion: '0.2.0', updateChannel: 'npm-global' });
  assert.equal(npmGlobal.command, 'npm i -g showmd-cli@latest');
});

test('npx and dev channels never produce the showmd-update state', () => {
  assert.equal(buildUpdateCta({ updateAvailable: true, latestVersion: '0.2.0', updateChannel: 'npx' }), null);
  assert.equal(buildUpdateCta({ updateAvailable: true, latestVersion: '0.2.0', updateChannel: 'dev' }), null);
});

test('app behind on version: same title shape, Update app button', () => {
  const vm = buildUpdateCta({
    appInstalled: true, appStale: true, appStaleReason: 'version', showmdVersion: '0.2.0',
  });
  assert.equal(vm.state, 'app');
  assert.equal(vm.title, 'There is a new version 0.2.0');
  assert.equal(vm.buttonLabel, 'Update app');
  assert.equal(vm.buttonWeight, 'primary');
  assert.equal(vm.showDismiss, true);
  assert.equal(vm.dismissVersion, '0.2.0');
});

test('both pending: showmd command first, divider subline, secondary Update app button', () => {
  const vm = buildUpdateCta({
    updateAvailable: true, latestVersion: '0.3.0', updateChannel: 'brew',
    appInstalled: true, appStale: true, appStaleReason: 'version', showmdVersion: '0.2.0',
  });
  assert.equal(vm.state, 'both');
  assert.equal(vm.title, 'There is a new version 0.3.0');
  assert.equal(vm.command, 'brew upgrade showmd');
  assert.equal(vm.subline, 'Update the app after that.');
  assert.equal(vm.buttonLabel, 'Update app');
  assert.equal(vm.buttonWeight, 'secondary');
});

test('app entry point gone: no version claim, Repair app, not dismissible', () => {
  const vm = buildUpdateCta({
    appInstalled: true, appStale: true, appStaleReason: 'missing', showmdVersion: '0.2.0',
    updateAvailable: true, latestVersion: '0.3.0', updateChannel: 'brew',
  });
  assert.equal(vm.state, 'missing');
  assert.doesNotMatch(vm.title, /\d/);
  assert.equal(vm.buttonLabel, 'Repair app');
  assert.equal(vm.showDismiss, false);
});

test('just updated: transient success state, no dismiss, takes priority over pending checks', () => {
  const vm = buildUpdateCta(
    { updateAvailable: true, latestVersion: '0.3.0', updateChannel: 'brew' },
    { justUpdatedVersion: '0.2.0' },
  );
  assert.equal(vm.state, 'updated');
  assert.equal(vm.title, 'App updated to 0.2.0');
  assert.equal(vm.success, true);
  assert.equal(vm.showDismiss, false);
});

test('dismissing a version hides the CTA for that version', () => {
  const settings = { updateAvailable: true, latestVersion: '0.2.0', updateChannel: 'brew' };
  assert.equal(buildUpdateCta(settings, { dismissedVersion: '0.2.0' }), null);
});

test('a newer release un-dismisses the CTA', () => {
  const settings = { updateAvailable: true, latestVersion: '0.3.0', updateChannel: 'brew' };
  const vm = buildUpdateCta(settings, { dismissedVersion: '0.2.0' });
  assert.equal(vm.state, 'showmd');
  assert.equal(vm.title, 'There is a new version 0.3.0');
});

test('app-only dismissal is independent of a stale unrelated dismissed version', () => {
  const vm = buildUpdateCta(
    { appInstalled: true, appStale: true, appStaleReason: 'version', showmdVersion: '0.2.0' },
    { dismissedVersion: '0.1.0' },
  );
  assert.equal(vm.showDismiss, true);
  assert.equal(vm.dismissVersion, '0.2.0');
});
