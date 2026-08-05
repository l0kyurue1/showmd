'use strict';
const path = require('node:path');
const proc = require('./proc.js');

// pure so tests can assert the argv for all three platforms without spawning
function buildRevealCommand(platform, fullPath) {
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', fullPath] };
  if (platform === 'win32') return { cmd: 'explorer', args: [`/select,${fullPath}`] };
  return { cmd: 'xdg-open', args: [path.dirname(fullPath)] };
}

// explorer.exe exits 1 even when the reveal worked; a missing explorer still
// reports honestly, that arrives as ENOENT
function revealErrorIsBenign(platform, err) {
  return platform === 'win32' && err.code === 1;
}

// trust boundary: the resolved path never touches a shell — execFile takes
// an argv array, so nothing in `fullPath` can be interpreted as a shell
// metacharacter
function defaultRevealFile(fullPath) {
  const { cmd, args } = buildRevealCommand(process.platform, fullPath);
  proc.tryRun(cmd, args).then(({ err }) => {
    if (err && !revealErrorIsBenign(process.platform, err)) console.error(`showmd: reveal failed: ${err.message}`);
  });
}

// JSON.stringify's quoting (backslash then quote) doubles as valid AppleScript
// string-literal escaping, so it's reused here instead of a bespoke quoter
function buildOpenInfoCommand(fullPath) {
  const script = `tell application "Finder" to open information window of (POSIX file ${JSON.stringify(fullPath)} as alias)`;
  return { cmd: 'osascript', args: ['-e', script, '-e', 'activate application "Finder"'] };
}

// best-effort: register-markdown still reports success even if Finder can't
// be nudged (no Info.plist to point at, no display, osascript missing)
function defaultOpenInfoWindow(fullPath) {
  const { cmd, args } = buildOpenInfoCommand(fullPath);
  return proc.tryRun(cmd, args).then(({ err }) => !err);
}

module.exports = { buildRevealCommand, revealErrorIsBenign, defaultRevealFile, buildOpenInfoCommand, defaultOpenInfoWindow };
