'use strict';
const { execFileSync, execFile, spawn } = require('node:child_process');

// commands take argv arrays and never touch a shell — spawn/execFile never
// see a shell metacharacter — and windowsHide is forced here so no call site
// can forget it
function capture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { ...opts, windowsHide: true });
}

function tryRun(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { ...opts, windowsHide: true }, (err, stdout) => resolve({ err, stdout }));
  });
}

function launchDetached(cmd, args, opts = {}, spawnFn = spawn) {
  return spawnFn(cmd, args, { stdio: 'ignore', detached: true, ...opts, windowsHide: true });
}

module.exports = { capture, tryRun, launchDetached };
