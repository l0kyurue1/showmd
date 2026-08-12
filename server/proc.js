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

function pipeThrough(left, right, opts = {}) {
  const spawnOpts = { ...opts, windowsHide: true };
  const a = spawn(left.cmd, left.args, { ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'] });
  const b = spawn(right.cmd, right.args, { ...spawnOpts, stdio: ['pipe', 'ignore', 'pipe'] });
  const errs = { left: '', right: '' };
  a.stderr.on('data', (d) => { errs.left += d; });
  b.stderr.on('data', (d) => { errs.right += d; });
  a.stdout.on('error', () => {});
  b.stdin.on('error', () => {});
  a.stdout.pipe(b.stdin);
  const wait = (child, onError) => new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? -1));
    child.on('error', (err) => { onError(err); resolve(-1); });
  });
  return Promise.all([
    wait(a, (err) => { errs.left += err.message; b.stdin.destroy(); }),
    wait(b, (err) => { errs.right += err.message; a.kill(); }),
  ]).then(([leftCode, rightCode]) => ({ leftCode, rightCode, leftStderr: errs.left, rightStderr: errs.right }));
}

module.exports = { capture, tryRun, launchDetached, pipeThrough };
