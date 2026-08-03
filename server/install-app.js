'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createFolderPicker } = require('./folder-picker.js');
const { platformDataDir } = require('./settings.js');

const BUNDLE = 'ShowMD.app';
const BUNDLE_ID = 'io.github.l0kyurue1.showmd';
// literal $HOME, not this process's: the applet resolves it at launch time
const STATE = platformDataDir('darwin', '$HOME');

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function appleQuote(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const UNIX_PROBE_PATHS = ['/opt/homebrew/bin/showmd', '/usr/local/bin/showmd', '$HOME/.local/bin/showmd'];

function deadEntryMessage(cli) {
  return `showmd is no longer installed at ${cli}. Install showmd, then run: showmd install-app`;
}

// probes a short list of well-known absolute install locations for a
// replacement showmd before giving up on a launch — a recovery for this one
// launch, not a repair: the baked path stays wrong until the user reinstalls,
// so appStatus keeps reporting stale. `withPath` also checks PATH, only
// where the app's environment can trust it: a .desktop entry inherits
// the session environment, but the macOS applet's do-shell-script runs under
// /bin/sh with a bare PATH of /usr/bin:/bin:/usr/sbin:/sbin that never sees
// /opt/homebrew/bin or /usr/local/bin.
function unixProbeSnippet(withPath) {
  const candidates = UNIX_PROBE_PATHS.map((p) => `"${p}"`).join(' ');
  const pathCheck = withPath ? `command -v showmd >/dev/null 2>&1 && { command -v showmd; exit 0; }; ` : '';
  return `${pathCheck}for c in ${candidates}; do if [ -x "$c" ]; then printf '%s' "$c"; exit 0; fi; done; printf ''`;
}

// A stay-open applet, not a shell script in a hand-rolled bundle: macOS reaps a
// bundled app's whole process tree when its executable exits (verified against
// nohup, setsid and launchctl submit alike), and it activates an already-running
// app instead of launching it again — so a script bundle can neither outlive its
// own app nor notice the second double-click. An applet has the event loop
// that makes `reopen`, dropped folders and Quit work.
function appleScript(node, cli) {
  const nodeQ = appleQuote(shellQuote(node));
  const cliQ = appleQuote(shellQuote(cli));
  const stateQ = appleQuote(`"${STATE}"`);
  const logQ = appleQuote(`"${STATE}/app.log"`);
  const pidsQ = appleQuote(`"${STATE}/pids"`);
  const probeQ = appleQuote(unixProbeSnippet(false));
  const deadEntryQ = appleQuote(deadEntryMessage(cli));
  return `use scripting additions

on run
	launchServer()
end run

on reopen
	launchServer()
end reopen

on open theItems
	repeat with anItem in theItems
		serve(POSIX path of anItem)
	end repeat
end open

on quit
	stopServers()
	continue quit
end quit

on idle
	return 3600
end idle

-- reuse of an already-running launcher is not decided here: cli.js --launcher
-- probes the live server itself and either opens its tab or takes its port,
-- so every platform's launcher shares one implementation instead of three
--
-- theNode/theCli default to the entry point baked in at install time; when
-- that entry point is gone, ensureCli probes a short list of well-known
-- locations for a replacement showmd and points theNode/theCli at it instead
-- (theNode empty means "invoke theCli directly", since a probed showmd is
-- its own shim, not a bare cli.js needing node in front of it). Reset at the
-- top of every call so one probed launch doesn't leak into the next.
property theNode : ${nodeQ}
property theCli : ${cliQ}

on ensureCli()
	set theNode to ${nodeQ}
	set theCli to ${cliQ}
	set found to (do shell script "if [ -e " & theCli & " ]; then echo yes; else echo no; fi")
	if found is "yes" then return true
	set probed to (do shell script ${probeQ})
	if probed is "" then
		display dialog ${deadEntryQ} with title "ShowMD" buttons {"OK"} default button "OK" with icon caution
		return false
	end if
	set theNode to ""
	set theCli to quoted form of probed
	return true
end ensureCli

on launchServer()
	if not ensureCli() then return
	set nodePrefix to ""
	if theNode is not "" then set nodePrefix to theNode & " "
	-- a single shell round trip, not two: ";" not "&&" ahead of the background
	-- command — a "&&" list would force a subshell to hold the output pipe
	-- open for as long as the server runs, blocking the applet here instead of
	-- returning to handle reopen
	do shell script "mkdir -p " & ${stateQ} & "; SHOWMD_LAUNCHED_FROM=app " & nodePrefix & theCli & " --launcher >>" & ${logQ} & " 2>&1 & pid=$!; echo $pid >> " & ${pidsQ} & "; echo $pid"
end launchServer

on serve(thePath)
	if not ensureCli() then return
	do shell script "mkdir -p " & ${stateQ}
	set nodePrefix to ""
	if theNode is not "" then set nodePrefix to theNode & " "
	-- one command, not a && list: backgrounding a list leaves a subshell holding
	-- do-shell-script's output pipe for as long as the server runs, and the applet
	-- blocks there instead of returning to handle reopen
	do shell script "SHOWMD_LAUNCHED_FROM=app " & nodePrefix & theCli & " " & quoted form of thePath & " >>" & ${logQ} & " 2>&1 & pid=$!; echo $pid >> " & ${pidsQ} & "; echo $pid"
end serve

on stopServers()
	-- pids accumulates across app sessions (a fresh applet run has no memory of
	-- servers a prior session started), so quit reaps all of them, not just this
	-- session's
	try
		set pidLines to paragraphs of (do shell script "cat " & ${pidsQ} & " 2>/dev/null")
	on error
		set pidLines to {}
	end try
	repeat with p in pidLines
		if p is not "" then
			-- PIDs get recycled by the OS, so only ever kill one still running our own server
			do shell script "if ps -p " & p & " -o command= | grep -qF " & ${cliQ} & "; then kill " & p & "; fi; true"
		end if
	end repeat
	do shell script "rm -f " & ${pidsQ}
end stopServers
`;
}

function isOurBundle(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'Contents', 'Info.plist'), 'utf8').includes(BUNDLE_ID);
  } catch {
    return false;
  }
}

function applicationsDir(home) {
  if (process.env.SHOWMD_APP_DIR) return process.env.SHOWMD_APP_DIR;
  try {
    fs.accessSync('/Applications', fs.constants.W_OK);
    return '/Applications';
  } catch {
    return path.join(home, 'Applications');
  }
}

function appDest(opts = {}) {
  const home = opts.home || os.homedir();
  return path.join(opts.applicationsDir || applicationsDir(home), BUNDLE);
}

// SHOWMD_APP_DIR is the cross-platform sibling of SHOWMD_SETTINGS_HOME /
// SHOWMD_HISTORY_HOME: one env var, highest precedence after an explicit
// opts seam (test isolation), overriding the platform-default directory the
// app gets written into. Not SHOWMD_APPLICATIONS_DIR: on Windows the
// destination is a Start Menu folder, not an Applications folder.
function winStartMenuDir(opts = {}) {
  const home = opts.home || os.homedir();
  return opts.startMenuDir || process.env.SHOWMD_APP_DIR
    || path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

function winDest(opts = {}) {
  return path.join(winStartMenuDir(opts), 'ShowMD.lnk');
}

function linuxAppsDir(opts = {}) {
  const home = opts.home || os.homedir();
  const base = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return opts.applicationsDir || process.env.SHOWMD_APP_DIR || path.join(base, 'applications');
}

function linuxDest(opts = {}) {
  return path.join(linuxAppsDir(opts), 'showmd.desktop');
}

function winDataDir(opts = {}) {
  return opts.dataDir || platformDataDir('win32', opts.home || os.homedir());
}

function linuxDataDir(opts = {}) {
  return opts.dataDir || platformDataDir('linux', opts.home || os.homedir());
}

// win/linux app entries have no version stamp baked into the file itself
// (unlike macOS's Info.plist), so install time drops a small sidecar next to
// the generated launch script recording what it was built against
function stampPath(platform, opts = {}) {
  const dataDir = platform === 'win32' ? winDataDir(opts) : linuxDataDir(opts);
  return path.join(dataDir, 'app.json');
}

function readVersionStamp(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof data.version === 'string' && typeof data.cli === 'string' ? data : null;
  } catch {
    return null;
  }
}

function writeVersionStamp(platform, opts, version, cli) {
  const file = stampPath(platform, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version, cli }));
}

function readPlistString(text, key) {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
  return m ? m[1] : null;
}

// two distinct stale causes, so Settings can report accurately: 'missing'
// when the baked entry point is gone (moved, uninstalled, channel switch —
// no version to compare against), 'version' when it's still there but was
// built against an older package version (a plain upgrade).
function darwinAppInfo(dest, currentVersion) {
  try {
    const plist = fs.readFileSync(path.join(dest, 'Contents', 'Info.plist'), 'utf8');
    const version = readPlistString(plist, 'CFBundleShortVersionString');
    const cli = readPlistString(plist, 'ShowMDCliPath');
    if (!cli || !fs.existsSync(cli)) return { stale: true, reason: 'missing', version };
    if (version !== currentVersion) return { stale: true, reason: 'version', version };
    return { stale: false, reason: null, version };
  } catch {
    return { stale: true, reason: 'missing', version: null };
  }
}

// status report only, no install: feeds Settings' "Installed"/"Reinstall"
// state. Never throws — a metadata read failure is treated as stale.
function appStatus(platform, opts = {}) {
  const currentVersion = opts.version || require('../package.json').version;
  const notInstalled = (dest) => ({ path: dest, installed: false, stale: false, staleReason: null, appVersion: null, appMdRegistered: false });
  if (platform === 'darwin') {
    const dest = appDest(opts);
    if (!isOurBundle(dest)) return notInstalled(dest);
    const info = darwinAppInfo(dest, currentVersion);
    return { path: dest, installed: true, stale: info.stale, staleReason: info.reason, appVersion: info.version, appMdRegistered: declaresMarkdown(dest) };
  }
  if (platform === 'win32' || platform === 'linux') {
    const dest = platform === 'win32' ? winDest(opts) : linuxDest(opts);
    if (!fs.existsSync(dest)) return notInstalled(dest);
    const stamp = readVersionStamp(stampPath(platform, opts));
    if (!stamp) return { path: dest, installed: true, stale: true, staleReason: 'missing', appVersion: null, appMdRegistered: false };
    if (!fs.existsSync(stamp.cli)) return { path: dest, installed: true, stale: true, staleReason: 'missing', appVersion: stamp.version, appMdRegistered: false };
    if (stamp.version !== currentVersion) return { path: dest, installed: true, stale: true, staleReason: 'version', appVersion: stamp.version, appMdRegistered: false };
    return { path: dest, installed: true, stale: false, staleReason: null, appVersion: stamp.version, appMdRegistered: false };
  }
  return { path: null, installed: false, stale: false, staleReason: null, appVersion: null, appMdRegistered: false };
}

// safe to call on every boot: regenerates an installed-but-stale app in
// place, but only when we can prove we built it — isOurBundle's Info.plist
// marker on macOS, our own version stamp elsewhere — so a user's unrelated
// file sitting at the same reserved path is never touched. Never throws.
function selfHealApp(platform, opts = {}) {
  try {
    const statusFn = opts.appStatusFn || appStatus;
    const status = statusFn(platform, opts);
    if (!status.installed || !status.stale) return false;
    if (platform === 'darwin' && !isOurBundle(status.path)) return false;
    if ((platform === 'win32' || platform === 'linux') && !readVersionStamp(stampPath(platform, opts))) return false;
    const installFn = opts.installFn || { darwin: installApp, win32: installAppWin, linux: installAppLinux }[platform];
    if (!installFn) return false;
    installFn(opts);
    return true;
  } catch {
    return false;
  }
}

const MD_UTI = 'net.daringfireball.markdown';
const FOLDER_TYPE = { CFBundleTypeName: 'Folder', CFBundleTypeRole: 'Viewer', LSItemContentTypes: ['public.folder'] };
// LSHandlerRank "Alternate" (not "Owner"): claims a slot in Finder's Open With
// menu without silently taking over as the default for every plain-text file.
const MD_TYPE = { CFBundleTypeName: 'Markdown Document', CFBundleTypeRole: 'Editor', LSItemContentTypes: [MD_UTI, 'public.plain-text'], LSHandlerRank: 'Alternate', CFBundleTypeIconFile: 'showmd-doc' };

function docIcon(opts) {
  return opts.docIconPath || path.join(__dirname, '..', 'icons', 'showmd-doc.icns');
}

function declaresMarkdown(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'Contents', 'Info.plist'), 'utf8').includes(MD_UTI);
  } catch {
    return false;
  }
}

function installApp(opts = {}) {
  const node = stableBinPath(opts.execPath || process.execPath, 'node');
  const cli = stableBinPath(opts.cliPath || path.join(__dirname, '..', 'bin', 'cli.js'), 'showmd');
  const icon = opts.iconPath || path.join(__dirname, '..', 'icons', 'showmd.icns');
  const version = opts.version || require('../package.json').version;
  const dest = appDest(opts);

  if (fs.existsSync(dest) && !isOurBundle(dest)) {
    throw new Error(`${dest} exists and was not created by showmd — remove it first`);
  }
  // reinstalling rebuilds the bundle from scratch; without this the .md
  // declaration is dropped and Finder silently reverts to the old handler
  const keepMd = declaresMarkdown(dest);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'showmd-app-')), 'ShowMD.applescript');
  fs.writeFileSync(src, appleScript(node, cli));
  try {
    execFileSync('osacompile', ['-s', '-o', dest, src], { stdio: 'pipe' });
  } finally {
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
  }

  const resources = path.join(dest, 'Contents', 'Resources');
  // the applet ships an asset catalog whose CFBundleIconName wins over
  // CFBundleIconFile, which is what leaves the generic AppleScript icon showing
  fs.rmSync(path.join(resources, 'Assets.car'), { force: true });
  for (const name of ['showmd.icns', 'droplet.icns']) fs.copyFileSync(icon, path.join(resources, name));
  fs.copyFileSync(docIcon(opts), path.join(resources, 'showmd-doc.icns'));

  const plist = path.join(dest, 'Contents', 'Info.plist');
  const plutil = (...args) => execFileSync('plutil', [...args, plist], { stdio: 'pipe' });
  try {
    plutil('-remove', 'CFBundleIconName');
  } catch {
    // absent on older osacompile output; nothing to unset
  }
  for (const [key, value] of [
    ['CFBundleName', 'ShowMD'],
    ['CFBundleDisplayName', 'ShowMD'],
    ['CFBundleIconFile', 'showmd'],
    ['CFBundleIdentifier', BUNDLE_ID],
    ['CFBundleShortVersionString', version],
    ['CFBundleVersion', version],
    ['ShowMDCliPath', cli],
    // without these, macOS denies Documents/Desktop/Downloads outright (EPERM)
    // instead of prompting, and an app that never prompted never shows up in
    // Privacy & Security to be allowed by hand. osacompile's stock plist
    // declares every other usage description but not these three.
    ['NSDocumentsFolderUsageDescription', 'ShowMD opens markdown files from folders you choose.'],
    ['NSDesktopFolderUsageDescription', 'ShowMD opens markdown files from folders you choose.'],
    ['NSDownloadsFolderUsageDescription', 'ShowMD opens markdown files from folders you choose.'],
    ['NSRemovableVolumesUsageDescription', 'ShowMD opens markdown files from folders you choose.'],
  ]) {
    plutil('-replace', key, '-string', value);
  }
  // osacompile declares every extension; showmd only opens a folder unless the
  // user has registered it for .md
  plutil('-replace', 'CFBundleDocumentTypes', '-json',
    JSON.stringify(keepMd ? [FOLDER_TYPE, MD_TYPE] : [FOLDER_TYPE]));
  reseal(dest, opts);
  if (keepMd) execFileSync(opts.lsregister || LSREGISTER, ['-f', dest], { stdio: 'pipe' });

  return { dest, cli, ephemeral: isEphemeral(cli) };
}

// every edit above breaks osacompile's ad-hoc signature, and macOS remembers a
// privacy grant by code identity — an unsealed bundle would have to be allowed
// again after each install. Best-effort: a bundle that will not sign still runs
function reseal(dest, opts = {}) {
  try {
    execFileSync(opts.codesign || 'codesign', ['--force', '--sign', '-', dest], { stdio: 'pipe' });
  } catch {}
}

// darwin only: warms the folder-picker applet during install so the first
// "Open folder" click doesn't wait behind osacompile — same build the
// launcher server's own warmPickerOnStart triggers lazily on first boot
function prebakeFolderPicker(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'darwin') return;
  const factory = opts.folderPickerFactory || createFolderPicker;
  factory({ platform, ...opts.folderPickerOpts }).ensureApp().catch(() => {});
}

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';

// The user still has to pick ShowMD via Get Info > Change All — LaunchServices
// reserves the actual default-handler choice for the user, there is no
// programmatic API for it without a native module.
function registerMarkdownHandler(opts = {}) {
  const dest = appDest(opts);
  if (!isOurBundle(dest)) throw new Error('ShowMD app is not installed — install it first');
  const plist = path.join(dest, 'Contents', 'Info.plist');
  // bundles installed before the document icon shipped have no copy of it
  const docDest = path.join(dest, 'Contents', 'Resources', 'showmd-doc.icns');
  if (!fs.existsSync(docDest)) fs.copyFileSync(docIcon(opts), docDest);
  execFileSync('plutil', ['-replace', 'CFBundleDocumentTypes', '-json', JSON.stringify([FOLDER_TYPE, MD_TYPE]), plist], { stdio: 'pipe' });
  reseal(dest, opts);
  execFileSync(opts.lsregister || LSREGISTER, ['-f', dest], { stdio: 'pipe' });
  return { dest };
}

const EPHEMERAL_RE = /[/\\]_npx[/\\]/;
function isEphemeral(cli) {
  return EPHEMERAL_RE.test(cli);
}

function installChannel(cliPath) {
  if (EPHEMERAL_RE.test(cliPath)) return 'npx';
  const segments = cliPath.split(/[/\\]+/);
  if (segments.includes('Cellar')) return 'brew';
  if (segments.includes('node_modules')) return 'npm-global';
  return 'dev';
}

// brew's Cellar path is version-stamped and vanishes on `brew upgrade`; the
// prefix-relative bin/ path is the symlink brew keeps stable across upgrades
const CELLAR_RE = /^(.*)[/\\]Cellar[/\\]/;
function cellarPrefix(p) {
  const m = CELLAR_RE.exec(p);
  return m ? m[1] : null;
}

function stableBinPath(p, bin) {
  const prefix = cellarPrefix(p);
  if (!prefix) return p;
  const stable = path.join(prefix, 'bin', bin);
  return fs.existsSync(stable) ? stable : p;
}

function psQuote(s) {
  return `'${s.replace(/'/g, "''")}'`;
}

function desktopExec(s) {
  return `"${s.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%')}"`;
}

function launchPs1(node, cli) {
  const cliQ = psQuote(cli);
  return `param([string]$Path)
$log = Join-Path $env:LOCALAPPDATA 'showmd'
New-Item -ItemType Directory -Force $log | Out-Null
$env:SHOWMD_LAUNCHED_FROM = 'app'
# reuse of an already-running launcher is cli.js --launcher's job, not this
# script's - see the note in appleScript()
$exe = ${psQuote(node)}
$cliPath = ${cliQ}
if (-not (Test-Path $cliPath)) {
	$probe = Join-Path $env:APPDATA 'npm\\showmd.cmd'
	if (Test-Path $probe) {
		$exe = $probe
		$cliPath = $null
	} else {
		$msg = 'showmd is no longer installed at ' + ${cliQ} + '. Install showmd, then run: showmd install-app'
		Add-Content (Join-Path $log 'app.err') $msg
		(New-Object -ComObject WScript.Shell).Popup($msg, 0, 'ShowMD', 0x10) | Out-Null
		exit 1
	}
}
if ($cliPath) {
	$cliArgs = if ($Path) { $cliPath, $Path } else { $cliPath, '--launcher' }
} else {
	$cliArgs = if ($Path) { $Path } else { '--launcher' }
}
Start-Process -FilePath $exe -ArgumentList $cliArgs -WindowStyle Hidden -RedirectStandardOutput (Join-Path $log 'app.log') -RedirectStandardError (Join-Path $log 'app.err')
`;
}

function lnkPs1({ lnk, ps1, icon }) {
  return `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(lnk)})
$s.TargetPath = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
$s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + ${psQuote(ps1)}
$s.IconLocation = ${psQuote(icon)} + ',0'
$s.WindowStyle = 7
$s.Save()
`;
}

function launchSh(node, cli) {
  return `#!/bin/sh
dir="$1"
base="\${XDG_DATA_HOME:-$HOME/.local/share}/showmd"
mkdir -p "$base"
export SHOWMD_LAUNCHED_FROM=app
# reuse of an already-running launcher is cli.js --launcher's job, not this
# script's - see the note in appleScript()
node=${shellQuote(node)}
cli=${shellQuote(cli)}
if [ ! -e "$cli" ]; then
  cli=$(${unixProbeSnippet(true)})
  if [ -z "$cli" ]; then
    msg='showmd is no longer installed at '${shellQuote(cli)}'. Install showmd, then run: showmd install-app'
    echo "$msg" >>"$base/app.log"
    command -v notify-send >/dev/null 2>&1 && notify-send "ShowMD" "$msg"
    exit 1
  fi
  node=""
fi
if [ -z "$dir" ]; then
  if [ -n "$node" ]; then exec "$node" "$cli" --launcher >>"$base/app.log" 2>&1; fi
  exec "$cli" --launcher >>"$base/app.log" 2>&1
fi
if [ -n "$node" ]; then exec "$node" "$cli" "$dir" >>"$base/app.log" 2>&1; fi
exec "$cli" "$dir" >>"$base/app.log" 2>&1
`;
}

function desktopEntry(launcher, icon) {
  return `[Desktop Entry]
Type=Application
Name=ShowMD
Comment=Read and edit markdown in your browser.
Exec=${desktopExec(launcher)} %f
Icon=${icon}
Terminal=false
Categories=Utility;TextEditor;
`;
}

function installAppWin(opts = {}) {
  const node = stableBinPath(opts.execPath || process.execPath, 'node');
  const cli = stableBinPath(opts.cliPath || path.join(__dirname, '..', 'bin', 'cli.js'), 'showmd');
  const icon = opts.icoPath || path.join(__dirname, '..', 'icons', 'showmd.ico');
  const version = opts.version || require('../package.json').version;
  const dataDir = winDataDir(opts);
  const startMenuDir = winStartMenuDir(opts);

  fs.mkdirSync(dataDir, { recursive: true });
  const ps1 = path.join(dataDir, 'launch.ps1');
  fs.writeFileSync(ps1, launchPs1(node, cli));
  writeVersionStamp('win32', { ...opts, dataDir }, version, cli);

  fs.mkdirSync(startMenuDir, { recursive: true });
  const lnk = winDest({ ...opts, startMenuDir });
  execFileSync('powershell', ['-NoProfile', '-Command', lnkPs1({ lnk, ps1, icon })], { stdio: 'pipe' });

  return { dest: lnk, cli, ephemeral: isEphemeral(cli) };
}

function installAppLinux(opts = {}) {
  const node = stableBinPath(opts.execPath || process.execPath, 'node');
  const cli = stableBinPath(opts.cliPath || path.join(__dirname, '..', 'bin', 'cli.js'), 'showmd');
  const icon = opts.iconPath || path.join(__dirname, '..', 'icons', 'showmd.png');
  const version = opts.version || require('../package.json').version;
  const dataDir = linuxDataDir(opts);
  const appsDir = linuxAppsDir(opts);

  fs.mkdirSync(dataDir, { recursive: true });
  const launcher = path.join(dataDir, 'showmd-launch');
  fs.writeFileSync(launcher, launchSh(node, cli), { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);
  writeVersionStamp('linux', { ...opts, dataDir }, version, cli);

  fs.mkdirSync(appsDir, { recursive: true });
  fs.writeFileSync(linuxDest({ ...opts, applicationsDir: appsDir }), desktopEntry(launcher, icon));

  return { dest: launcher, cli, ephemeral: isEphemeral(cli) };
}

module.exports = {
  installApp, appleScript, applicationsDir, BUNDLE, BUNDLE_ID,
  installAppWin, installAppLinux, launchPs1, lnkPs1, launchSh, desktopEntry,
  appDest, winDest, linuxDest, appStatus, registerMarkdownHandler,
  prebakeFolderPicker, installChannel, stableBinPath,
  selfHealApp, declaresMarkdown,
};
