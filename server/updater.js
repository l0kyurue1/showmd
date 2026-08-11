'use strict';

const proc = require('./proc.js');
const installers = require('./install-app.js');

const MANUAL_COMMANDS = Object.freeze({
  brew: 'brew upgrade showmd',
  'npm-global': 'npm i -g showmd-cli@latest',
});

function updateCommand(channel, platform = process.platform) {
  if (channel === 'brew') return { command: 'brew', args: ['upgrade', 'showmd'] };
  if (channel === 'npm-global') return { command: platform === 'win32' ? 'npm.cmd' : 'npm', args: ['i', '-g', 'showmd-cli@latest'] };
  return null;
}

function runtimeLaunch(channel, cliPath, execPath = process.execPath) {
  if (channel === 'brew') {
    return { command: installers.stableBinPath(cliPath, 'showmd'), prefixArgs: [] };
  }
  if (channel === 'npm-global') return { command: execPath, prefixArgs: [cliPath] };
  return null;
}

function createUpdateController({
  channel,
  cliPath,
  execPath = process.execPath,
  platform = process.platform,
  run = proc.tryRun,
  onVerified = async () => {},
} = {}) {
  let state = { state: 'idle' };
  let inFlight = null;

  function set(next) {
    state = Object.freeze(next);
    return state;
  }

  async function perform(expectedVersion) {
    const command = updateCommand(channel, platform);
    const launch = runtimeLaunch(channel, cliPath, execPath);
    const manualCommand = MANUAL_COMMANDS[channel] || null;
    if (!command || !launch) return set({ state: 'failure', message: 'Automatic update is unavailable.', manualCommand });

    set({ state: 'updating', targetVersion: expectedVersion });
    const installed = await run(command.command, command.args);
    if (installed.err) return set({ state: 'failure', message: 'Update failed.', manualCommand });

    const verified = await run(launch.command, [...launch.prefixArgs, '--version']);
    const actualVersion = String(verified.stdout || '').trim();
    if (verified.err || actualVersion !== expectedVersion) {
      return set({ state: 'failure', message: 'The new version could not be verified.', manualCommand });
    }

    set({ state: 'finishing', targetVersion: expectedVersion });
    try {
      await onVerified({ version: expectedVersion, launch });
    } catch {
      return set({ state: 'failure', message: 'The update could not be finished.', manualCommand });
    }
    return set({ state: 'updated', version: expectedVersion });
  }

  function start(expectedVersion) {
    if (inFlight) return { started: false, state };
    if (typeof expectedVersion !== 'string' || !/^[\w.+-]+$/.test(expectedVersion)) {
      return { started: false, state: set({ state: 'failure', message: 'No valid update is available.', manualCommand: null }) };
    }
    inFlight = perform(expectedVersion).finally(() => { inFlight = null; });
    return { started: true, state };
  }

  return {
    start,
    getState: () => state,
    whenSettled: () => inFlight || Promise.resolve(state),
  };
}

module.exports = { MANUAL_COMMANDS, updateCommand, runtimeLaunch, createUpdateController };
