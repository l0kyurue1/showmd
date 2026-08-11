import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdateCta } from '../../../client/update-cta.js';

test('nothing pending renders nothing', () => {
  assert.equal(buildUpdateCta({ updateAvailable: false, appInstalled: false }), null);
});

test('showmd update available: one primary Update action, dismissible in the sidebar', () => {
  const brew = buildUpdateCta({ updateAvailable: true, latestVersion: '0.2.0', updateChannel: 'brew' });
  assert.equal(brew.state, 'showmd');
  assert.equal(brew.title, 'There is a new version 0.2.0');
  assert.equal(brew.command, undefined);
  assert.equal(brew.buttonLabel, 'Update');
  assert.equal(brew.buttonWeight, 'primary');
  assert.equal(brew.action, 'update');
  assert.equal(brew.showDismiss, true);
  assert.equal(brew.dismissVersion, '0.2.0');

  const settings = buildUpdateCta(
    { updateAvailable: true, latestVersion: '0.2.0', updateChannel: 'npm-global' },
    { allowDismiss: false },
  );
  assert.equal(settings.buttonLabel, 'Update');
  assert.equal(settings.showDismiss, false);
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

test('both package and app pending collapse into the same primary Update action', () => {
  const vm = buildUpdateCta({
    updateAvailable: true, latestVersion: '0.3.0', updateChannel: 'brew',
    appInstalled: true, appStale: true, appStaleReason: 'version', showmdVersion: '0.2.0',
  });
  assert.equal(vm.state, 'both');
  assert.equal(vm.title, 'There is a new version 0.3.0');
  assert.equal(vm.command, undefined);
  assert.equal(vm.subline, undefined);
  assert.equal(vm.buttonLabel, 'Update');
  assert.equal(vm.buttonWeight, 'primary');
  assert.equal(vm.action, 'update');
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
  assert.equal(vm.title, 'Updated to 0.2.0');
  assert.equal(vm.success, true);
  assert.equal(vm.showDismiss, false);
});

test('update operation copy stays product-level; fallback command appears only after failure', () => {
  const settings = { updateAvailable: true, latestVersion: '2.0.0', updateChannel: 'brew' };
  const updating = buildUpdateCta(settings, { operation: { state: 'updating' } });
  assert.deepEqual(updating, { state: 'updating', title: 'Updating…', showDismiss: false });
  const finishing = buildUpdateCta(settings, { operation: { state: 'finishing' } });
  assert.deepEqual(finishing, { state: 'finishing', title: 'Finishing update…', showDismiss: false });
  const failure = buildUpdateCta(settings, {
    operation: { state: 'failure', manualCommand: 'brew upgrade showmd' },
  });
  assert.equal(failure.buttonLabel, 'Try again');
  assert.equal(failure.command, 'brew upgrade showmd');
  assert.equal(failure.showDismiss, false);
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
