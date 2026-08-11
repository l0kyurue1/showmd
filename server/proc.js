'use strict';
const { execFileSync, execFile, spawn } = require('node:child_process');

// commands take argv arrays and never touch a shell — spawn/execFile never
// see a shell metacharacter — and windowsHide is forced here so no call site
// can forget it
function capture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { ...opts, windowsHide: true });
}

// execFile's callback form has no `input` option of its own (that's only on
// the sync variants) — feeding stdin means writing to the returned child's
// stream ourselves before the callback fires
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
