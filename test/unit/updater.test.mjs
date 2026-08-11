import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MANUAL_COMMANDS, updateCommand, runtimeLaunch, createUpdateController } = require('../../server/updater.js');

test('update commands are fixed argv selected only by the trusted install channel', () => {
  assert.deepEqual(updateCommand('brew'), { command: 'brew', args: ['upgrade', 'showmd'] });
  assert.deepEqual(updateCommand('npm-global', 'linux'), { command: 'npm', args: ['i', '-g', 'showmd-cli@latest'] });
  assert.deepEqual(updateCommand('npm-global', 'win32'), { command: 'npm.cmd', args: ['i', '-g', 'showmd-cli@latest'] });
  assert.equal(updateCommand('dev'), null);
  assert.equal(updateCommand('brew; rm -rf /'), null);
});

test('runtime verification and restart use the stable installed entry point', () => {
  assert.deepEqual(runtimeLaunch('npm-global', '/global/node_modules/showmd-cli/bin/cli.js', '/node'), {
    command: '/node', prefixArgs: ['/global/node_modules/showmd-cli/bin/cli.js'],
  });
  assert.equal(runtimeLaunch('dev', '/checkout/bin/cli.js'), null);
});

test('successful update moves through updating and finishing, verifies exact version, then hands off', async () => {
  const calls = [];
  const states = [];
  const controller = createUpdateController({
    channel: 'npm-global', cliPath: '/global/node_modules/showmd-cli/bin/cli.js', execPath: '/node',
    run: async (command, args) => {
      calls.push([command, args]);
      return args.includes('--version') ? { err: null, stdout: '2.0.0\n' } : { err: null, stdout: '' };
    },
    onVerified: async ({ version, launch }) => {
      states.push(controller.getState().state);
      assert.equal(version, '2.0.0');
      assert.deepEqual(launch, { command: '/node', prefixArgs: ['/global/node_modules/showmd-cli/bin/cli.js'] });
    },
  });

  assert.equal(controller.start('2.0.0').started, true);
  assert.equal(controller.getState().state, 'updating');
  await controller.whenSettled();
  assert.deepEqual(calls, [
    ['npm', ['i', '-g', 'showmd-cli@latest']],
    ['/node', ['/global/node_modules/showmd-cli/bin/cli.js', '--version']],
  ]);
  assert.deepEqual(states, ['finishing']);
  assert.deepEqual(controller.getState(), { state: 'updated', version: '2.0.0' });
});

test('concurrent starts execute one update; failure keeps the runtime usable and reveals only the fixed fallback', async () => {
  let release;
  let runs = 0;
  const controller = createUpdateController({
    channel: 'brew', cliPath: '/opt/homebrew/Cellar/showmd/1/bin/cli.js',
    run: async () => {
      runs++;
      await new Promise((resolve) => { release = resolve; });
      return { err: new Error('permission denied'), stdout: '' };
    },
  });

  assert.equal(controller.start('2.0.0').started, true);
  assert.equal(controller.start('2.0.0').started, false);
  release();
  await controller.whenSettled();
  assert.equal(runs, 1);
  assert.deepEqual(controller.getState(), {
    state: 'failure', message: 'Update failed.', manualCommand: MANUAL_COMMANDS.brew,
  });
});

test('a successful install with the wrong version does not hand off', async () => {
  let handedOff = false;
  let call = 0;
  const controller = createUpdateController({
    channel: 'npm-global', cliPath: '/global/node_modules/showmd-cli/bin/cli.js',
    run: async () => (++call === 1 ? { err: null, stdout: '' } : { err: null, stdout: '1.9.0\n' }),
    onVerified: async () => { handedOff = true; },
  });
  controller.start('2.0.0');
  await controller.whenSettled();
  assert.equal(handedOff, false);
  assert.equal(controller.getState().state, 'failure');
  assert.equal(controller.getState().manualCommand, MANUAL_COMMANDS['npm-global']);
});
