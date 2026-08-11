'use strict';
const { execFileSync, execFile, spawn } = require('node:child_process');

// Commands use argv without a shell; every Windows child stays hidden.
function capture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { ...opts, windowsHide: true });
}

// Callback execFile needs stdin written to its child stream manually.
function tryRun(cmd, args, opts = {}) {
  const { input, ...rest } = opts;
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { ...rest, windowsHide: true }, (err, stdout) => resolve({ err, stdout }));
    if (input != null) child.stdin?.end(input);
  });
}

function launchDetached(cmd, args, opts = {}, spawnFn = spawn) {
  return spawnFn(cmd, args, { stdio: 'ignore', detached: true, ...opts, windowsHide: true });
}

module.exports = { capture, tryRun, launchDetached };
