'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');

// pure so tests can assert the argv for all three platforms without spawning
function buildRevealCommand(platform, fullPath) {
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', fullPath] };
  if (platform === 'win32') return { cmd: 'explorer', args: [`/select,${fullPath}`] };
  return { cmd: 'xdg-open', args: [path.dirname(fullPath)] };
}

// trust boundary: the resolved path never touches a shell — execFile takes
// an argv array, so nothing in `fullPath` can be interpreted as a shell
// metacharacter
function defaultRevealFile(fullPath) {
  const { cmd, args } = buildRevealCommand(process.platform, fullPath);
  execFile(cmd, args, (err) => {
    if (err) console.error(`showmd: reveal failed: ${err.message}`);
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
  return new Promise((resolve) => execFile(cmd, args, (err) => resolve(!err)));
}

module.exports = { buildRevealCommand, defaultRevealFile, buildOpenInfoCommand, defaultOpenInfoWindow };
