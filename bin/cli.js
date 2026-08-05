#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const proc = require('../server/proc.js');
const { createServer } = require('../server/server.js');
const { classifyRootTarget } = require('../server/documents.js');
const VERSION = require('../package.json').version;

function parseArgs(argv, defaultPort = 4321) {
  const args = { port: defaultPort, open: true, portExplicit: false, launcher: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') { args.port = Number(argv[++i]); args.portExplicit = true; }
    else if (a.startsWith('--port=')) { args.port = Number(a.slice('--port='.length)); args.portExplicit = true; }
    else if (a === '--no-open') args.open = false;
    // internal, Helper-only: not in --help. Boots with no root (server.js's
    // launcher mode) instead of resolving a target dir/file below.
    else if (a === '--launcher') args.launcher = true;
    else if (a.startsWith('-')) {
      console.error(`showmd: unknown option ${a} (try --help)`);
      process.exit(1);
    }
    else rest.push(a);
  }
  return { args, rest };
}

function resolveSkillsMode(rest, cwd) {
  const { isSkillsProjectDir } = require('../server/skills.js');
  if (rest.length === 0) {
    return isSkillsProjectDir(cwd) ? { mode: 'project', projectDirs: [cwd] } : { mode: 'all', projectDirs: [] };
  }
  if (rest.length === 1 && rest[0] === 'all') return { mode: 'all', projectDirs: [] };
  if (rest.length === 1 && rest[0] === 'global') return { mode: 'global', projectDirs: [] };
  return { mode: 'project', projectDirs: rest.map((d) => path.resolve(cwd, d)) };
}

// pure so it's unit-testable without binding a real port
function formatPortWarning(port, version, pid) {
  return `showmd: port ${port} is held by showmd ${version}${pid ? ` (pid ${pid})` : ''}`;
}

// a short GET, not the full /api/settings probe: cheap enough to run on every
// silent port fallback. Answering at all is what proves a process is ours —
// the launcher scripts used to reimplement it in AppleScript/PowerShell/sh
function probeShowmd(port, { timeout = 300 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/version', timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          resolve(typeof body.version === 'string' ? body : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// netstat's STATE column is localized ("ESCUCHANDO"), so the listener is found
// by local address: an accepted connection to it belongs to the same process
function parseNetstatPid(output, port) {
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') continue;
    if (parts[1] !== `127.0.0.1:${port}`) continue;
    if (/^\d+$/.test(parts[4])) return parts[4];
  }
  return null;
}

// more than a nicety for the warning line: takeover of a stale showmd below
// refuses to kill anything it cannot identify, so no pid means an outdated
// install keeps the port forever. Windows has no lsof, hence the netstat arm
function findPidOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = proc.capture('netstat', ['-ano', '-p', 'TCP'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
      return parseNetstatPid(out, port);
    }
    return proc.capture('lsof', ['-ti', `tcp:${port}`], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8').trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

module.exports = { resolveSkillsMode, formatPortWarning, probeShowmd, findPidOnPort, parseNetstatPid, buildOpenBrowserCommand, openBrowser };

// top-level return keeps `require` of this file (tests) from running the CLI
if (require.main !== module) return;

const HELP = `showmd — Read and edit markdown in your browser.

Usage:
  showmd [dir|file.md] [options]                serve a folder or single file
  showmd skills [all|global|<dir>...] [options] browse installed agent skills
  showmd agents [options]                       show your agent's config/memory
  showmd prune <dir> | showmd prune --all       delete saved history
  showmd install-app                            add a double-clickable ShowMD app
  showmd install-skill [--copy]                 teach your agents to use showmd

Options:
  --port <n>     port to listen on (default 4321, falls back to a free port)
  --no-open      don't launch the browser
  -h, --help     show this help
  -v, --version  print version`;

{
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return; }
  if (argv.includes('--version') || argv.includes('-v')) { console.log(VERSION); return; }
}

// pure so tests can assert the argv for all three platforms without spawning.
// `launcher` marks a command that hands off and exits, so its code means
// something; a named browser on linux is the browser itself and exits on quit
function buildOpenBrowserCommand(platform, url, browser) {
  const named = browser && browser !== 'default';
  if (platform === 'darwin') return { cmd: 'open', args: named ? ['-a', browser, url] : [url], launcher: true };
  if (platform === 'win32') return { cmd: 'cmd', args: named ? ['/c', 'start', '', browser, url] : ['/c', 'start', '', url], launcher: true };
  return named ? { cmd: browser, args: [url], launcher: false } : { cmd: 'xdg-open', args: [url], launcher: true };
}

// two ways to fail: an opener that isn't installed emits 'error', which kills
// the server we just started if unhandled; a browser name that no longer
// resolves exits non-zero, which used to vanish silently
function openBrowser(url, browser, launchFn = proc.launchDetached) {
  const { cmd, args, launcher } = buildOpenBrowserCommand(process.platform, url, browser);
  const child = launchFn(cmd, args);
  child.on('error', (err) => console.error(`showmd: could not open ${cmd}: ${err.message}`));
  if (launcher) child.on('exit', (code) => { if (code) console.error(`showmd: ${cmd} could not open ${url} (exit ${code})`); });
  child.unref();
  return child;
}

const BIND_RETRIES = 20;
const BIND_RETRY_MS = 100;
// trust boundary: every listen() below binds 127.0.0.1, never 0.0.0.0 — the
// served file tree must not reach the network
function serve(server, args, urlPath, describe, browser) {
  function onListening() {
    const actualPort = server.address().port;
    const url = `http://127.0.0.1:${actualPort}/${urlPath}`;
    console.log(describe());
    console.log(url);
    if (args.open) openBrowser(url, browser);
  }
  let retries = 0;
  let stalePortTaken = false;
  // a restarting server's replacement can start before the old process has
  // fully released the port, so a same-port EADDRINUSE retries before giving up
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    if (retries < BIND_RETRIES) {
      retries++;
      setTimeout(() => server.listen(args.port, '127.0.0.1'), BIND_RETRY_MS);
      return;
    }
    if (args.portExplicit) {
      console.error(`showmd: port ${args.port} is already in use`);
      process.exit(1);
    }
    probeShowmd(args.port).then((live) => {
      const pid = live ? findPidOnPort(args.port) : null;
      // yielding the default port to an outdated showmd is what leaves a
      // browser tab talking to an old client and old API forever; take the
      // port instead. Only a process that answered /api/version is killed,
      // and only once — a kill that doesn't free the port falls through
      if (live && pid && live.version !== VERSION && !stalePortTaken) {
        stalePortTaken = true;
        retries = 0;
        console.error(`showmd: replacing stale showmd ${live.version} on port ${args.port} (pid ${pid})`);
        try { process.kill(Number(pid)); } catch {}
        setTimeout(() => server.listen(args.port, '127.0.0.1'), BIND_RETRY_MS);
        return;
      }
      if (live) console.error(formatPortWarning(args.port, live.version, pid));
      // no callback: onListening is already attached, a second one would print
      // the banner twice
      server.listen(0, '127.0.0.1');
    });
  });
  server.listen(args.port, '127.0.0.1', onListening);
}

if (process.argv[2] === 'prune') {
  const history = require('../server/history.js');
  const target = process.argv[3];
  if (target === '--all') {
    fs.rmSync(history.pruneAllDir(), { recursive: true, force: true });
    console.log('showmd: removed all save history');
  } else if (target) {
    history.prune(path.resolve(target)).then((dir) => console.log(`showmd: removed save history for ${path.resolve(target)} (${dir})`));
  } else {
    console.error('usage: showmd prune <dir> | showmd prune --all');
    process.exit(1);
  }
  return;
}

if (process.argv[2] === 'install-app') {
  const installers = require('../server/install-app.js');
  const install = { darwin: installers.installApp, win32: installers.installAppWin, linux: installers.installAppLinux }[process.platform];
  if (!install) {
    console.error('showmd: install-app supports macOS, Windows and Linux');
    process.exit(1);
  }
  const { dest, ephemeral } = install();
  console.log(`showmd: installed ${dest}`);
  if (ephemeral) {
    console.error('showmd: warning — this copy lives in the npx cache and will be cleared.');
    console.error('        run `npm i -g showmd-cli && showmd install-app` for an app that lasts.');
  }
  installers.prebakeFolderPicker();
  return;
}

if (process.argv[2] === 'install-skill') {
  const { installSkill } = require('../server/install-skill.js');
  const { canonical, linked, skipped } = installSkill({ copy: process.argv.includes('--copy') });
  console.log(`showmd: installed the showmd skill to ${canonical}`);
  if (linked.length) console.log(`showmd: available to ${linked.map((l) => l.agent.displayName).join(', ')}`);
  else console.log('showmd: no other agent directories detected; agents reading ~/.agents/skills pick it up');
  for (const s of skipped) {
    if (s.reason === 'exists') console.error(`showmd: left ${s.dest} alone (not installed by showmd)`);
    else console.error(`showmd: could not install to ${s.dest} (${s.reason})`);
  }
  return;
}

if (process.argv[2] === 'skills') {
  (async () => {
    const stored = await require('../server/settings.js').readSettings();
    const skillsMod = require('../server/skills.js');
    const { args, rest } = parseArgs(process.argv.slice(3), stored.port);
    const cwd = process.cwd();
    const { mode, projectDirs } = resolveSkillsMode(rest, cwd);

    const roots = skillsMod.discoverSkillRoots({ mode, projectDirs });

    if (!roots.length) {
      console.error('showmd: no skill directories found');
      process.exit(1);
    }
    require('../server/update-check.js').checkUpdate({ enabled: stored.updateCheck });
    const server = createServer(roots, { skillsMode: mode === 'project' ? 'project' : undefined });
    serve(server, args, '', () => `showmd serving ${roots.length} skill root(s): ${roots.map((r) => r.key).join(', ')}`, stored.browser);
  })();
  return;
}

if (process.argv[2] === 'agents') {
  (async () => {
    const stored = await require('../server/settings.js').readSettings();
    const { args } = parseArgs(process.argv.slice(3), stored.port);
    require('../server/update-check.js').checkUpdate({ enabled: stored.updateCheck });
    const server = createServer(null, { warmPickerOnStart: true, bootView: 'agents' });
    serve(server, args, '', () => 'showmd serving agent config', stored.browser);
  })();
  return;
}

(async () => {
  const stored = await require('../server/settings.js').readSettings();
  const { args, rest } = parseArgs(process.argv.slice(2), stored.port);

  if (args.launcher) {
    // every app launch runs this, so reuse lives here rather than in each
    // platform's launcher script: a same-version launcher already on the port
    // just gets its tab opened; a stale one is killed by serve()'s takeover
    const live = args.portExplicit ? null : await probeShowmd(args.port);
    if (live && live.launcher && live.version === VERSION) {
      const url = `http://127.0.0.1:${args.port}/`;
      console.log(url);
      if (args.open) openBrowser(url, stored.browser);
      return;
    }
    require('../server/update-check.js').checkUpdate({ enabled: stored.updateCheck });
    serve(createServer(null, { warmPickerOnStart: true }), args, '', () => 'showmd launcher', stored.browser);
    return;
  }

  const target = path.resolve(rest[0] || '.');

  const classified = await classifyRootTarget(target);
  if (!classified) {
    if (fs.existsSync(target)) console.error(`showmd: not a directory or markdown file: ${target}`);
    else console.error(`showmd: no such file or directory: ${target}`);
    process.exit(1);
  }

  const { dir: root, doc } = classified;
  const urlPath = doc ? encodeURIComponent(doc) : '';

  require('../server/update-check.js').checkUpdate({ enabled: stored.updateCheck });
  const server = createServer(root, { warmPickerOnStart: true, initialDoc: doc });
  serve(server, args, urlPath, () => `showmd serving ${root}`, stored.browser);
})();
