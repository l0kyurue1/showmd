import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const {
  installApp, appleScript, applicationsDir,
  installAppWin, installAppLinux, launchPs1, lnkPs1, launchSh, desktopEntry,
  appStatus, registerMarkdownHandler, prebakeFolderPicker,
  installChannel, stableBinPath, selfHealApp,
  appDest, winDest, linuxDest, declaresMarkdown,
} = await import('../../server/install-app.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'showmd-app-'));
process.on('exit', () => rmSync(workDir, { recursive: true, force: true }));

const icon = path.join(workDir, 'showmd.icns');
writeFileSync(icon, 'icns');

const mac = { skip: process.platform !== 'darwin' && 'macOS only' };

let n = 0;
function install(extra = {}) {
  const home = path.join(workDir, `home${n++}`);
  const apps = path.join(home, 'Applications');
  return { home, ...installApp({ home, applicationsDir: apps, iconPath: icon, version: '9.9.9', ...extra }) };
}

test('the applet handles every way macOS can launch it', () => {
  const s = appleScript('/usr/bin/node', '/pkg/bin/cli.js');
  for (const handler of ['on run', 'on reopen', 'on open theItems', 'on quit', 'on idle']) {
    assert.match(s, new RegExp(`^${handler}$`, 'm'), `missing ${handler}`);
  }
});

test('serve runs mkdir as its own command, never backgrounding a list', () => {
  const s = appleScript('/usr/bin/node', '/pkg/bin/cli.js');
  // a backgrounded `a && b` list leaves a subshell holding do-shell-script's
  // output pipe, and the applet blocks there instead of handling reopen
  assert.doesNotMatch(s, /&&[^\n]*& pid=\$!/);
  assert.match(s, /do shell script "mkdir -p "/);
  assert.match(s, /& " 2>&1 & pid=\$!; echo \$pid >> " & /);
});

test('launchServer merges mkdir and the backgrounded launch into a single do shell script call', () => {
  const s = appleScript('/usr/bin/node', '/pkg/bin/cli.js');
  const body = s.slice(s.indexOf('on launchServer()'), s.indexOf('end launchServer'));
  const calls = body.match(/do shell script/g) || [];
  assert.equal(calls.length, 1);
  assert.match(body, /mkdir -p/);
  assert.match(body, /--launcher >>/);
  assert.match(body, /pid=\$!; echo \$pid >> /);
});

test('prebakeFolderPicker: darwin install triggers the picker applet build, other platforms skip it', () => {
  let calls = 0;
  const folderPickerFactory = () => ({ ensureApp: () => { calls++; return Promise.resolve(); }, warm() {}, pick() {} });
  prebakeFolderPicker({ platform: 'darwin', folderPickerFactory });
  assert.equal(calls, 1);
  prebakeFolderPicker({ platform: 'linux', folderPickerFactory });
  assert.equal(calls, 1);
});

test('the applet execs the resolved interpreter and cli, not PATH', () => {
  const s = appleScript('/usr/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /"'\/usr\/bin\/node'"/);
  assert.match(s, /"'\/pkg\/bin\/cli\.js'"/);
  assert.match(s, /quoted form of thePath/);
});

test('bare run/reopen spawn the launcher; reuse is cli.js --launcher\'s job', () => {
  const s = appleScript('/usr/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /^on run\n\tlaunchServer\(\)\nend run$/m);
  assert.match(s, /^on reopen\n\tlaunchServer\(\)\nend reopen$/m);
});

test('no launcher script reimplements the live-server probe', () => {
  for (const s of [appleScript('/usr/bin/node', '/pkg/bin/cli.js'),
    launchPs1('/usr/local/bin/node', '/pkg/bin/cli.js'),
    launchSh('/usr/bin/node', '/pkg/bin/cli.js')]) {
    assert.doesNotMatch(s, /launcher\.pid/);
    assert.doesNotMatch(s, /api\/version/);
  }
});

test('launchServer spawns the cli with --launcher, no picker panel or message strings', () => {
  const s = appleScript('/usr/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /--launcher >>/);
  assert.doesNotMatch(s, /NSOpenPanel/);
  assert.doesNotMatch(s, /pickFolder/);
  assert.doesNotMatch(s, /setMessage/);
  assert.doesNotMatch(s, /Open a folder/);
});

test('every folder gets its own server; quit reaps every persisted PID, including prior sessions', () => {
  const s = appleScript('/usr/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /on quit\n\tstopServers\(\)\n\tcontinue quit/);
  assert.match(s, /^on stopServers\(\)$/m);
  assert.match(s, /paragraphs of \(do shell script "cat " & .*pids.* & " 2>\/dev\/null"\)/);
  assert.match(s, /repeat with p in pidLines/);
  // recycled PIDs: only kill one still actually running our own server
  assert.match(s, /ps -p " & p & " -o command= \| grep -qF/);
  // the persisted list is cleared so a dead session's PIDs can't be reused
  assert.match(s, /do shell script "rm -f " & .*pids/);
});

test('a dropped selection opens every folder in it', () => {
  const s = appleScript('/usr/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /repeat with anItem in theItems\n\t\tserve\(POSIX path of anItem\)/);
});

test('serve appends to the log so servers do not clobber each other', () => {
  assert.match(appleScript('/usr/bin/node', '/pkg/bin/cli.js'), /& " >>" &/);
});

test('installs system-wide when /Applications is writable, else under home', () => {
  const home = path.join(workDir, 'home-appsdir');
  const dir = applicationsDir(home);
  assert.equal(dir === '/Applications' || dir === path.join(home, 'Applications'), true);
});

test('paths with quotes and backslashes survive both quoting layers', () => {
  const s = appleScript("/opt/it's/node", '/pkg/a"b\\c/cli.js');
  // shell quoting first, then AppleScript's own backslash escaping on top
  assert.match(s, /"'\/opt\/it'\\\\''s\/node'"/);
  assert.match(s, /a\\"b\\\\c/);
});

test('flags an npx-cache install as ephemeral', mac, () => {
  assert.equal(install({ cliPath: '/pkg/bin/cli.js' }).ephemeral, false);
  assert.equal(install({ cliPath: '/Users/x/.npm/_npx/abc/node_modules/showmd/bin/cli.js' }).ephemeral, true);
});

test('builds a bundle Finder will show as ShowMD', mac, () => {
  const { dest } = install();
  assert.equal(dest.endsWith('Applications/ShowMD.app'), true);
  const plist = path.join(dest, 'Contents/Info.plist');
  const read = (key) => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
  assert.equal(read('CFBundleName'), 'ShowMD');
  assert.equal(read('CFBundleDisplayName'), 'ShowMD');
  assert.equal(read('CFBundleIdentifier'), 'io.github.l0kyurue1.showmd');
  assert.equal(read('CFBundleShortVersionString'), '9.9.9');
  assert.equal(read('CFBundleIconFile'), 'showmd');
  // CFBundleIconName + the applet's asset catalog outrank CFBundleIconFile and
  // are what leave the generic AppleScript icon showing
  assert.throws(() => read('CFBundleIconName'));
  assert.equal(existsSync(path.join(dest, 'Contents/Resources/Assets.car')), false);
  assert.equal(readFileSync(path.join(dest, 'Contents/Resources/droplet.icns'), 'utf8'), 'icns');
  assert.equal(read('CFBundleDocumentTypes.0.LSItemContentTypes.0'), 'public.folder');
  assert.equal(readFileSync(path.join(dest, 'Contents/Resources/showmd.icns'), 'utf8'), 'icns');
  assert.equal(existsSync(path.join(dest, 'Contents/MacOS')), true);
});

test('reinstalling replaces the bundle in place', mac, () => {
  const home = path.join(workDir, 'home-repeat');
  const apps = path.join(home, 'Applications');
  const first = installApp({ home, applicationsDir: apps, iconPath: icon, cliPath: '/a/cli.js', version: '1.0.0' });
  writeFileSync(path.join(first.dest, 'Contents/Resources/stale'), 'x');
  const second = installApp({ home, applicationsDir: apps, iconPath: icon, cliPath: '/b/cli.js', version: '2.0.0' });
  assert.equal(second.dest, first.dest);
  assert.equal(existsSync(path.join(second.dest, 'Contents/Resources/stale')), false);
});

test('refuses to clobber a bundle showmd did not create', () => {
  const home = path.join(workDir, 'home-foreign');
  const dest = path.join(home, 'Applications', 'ShowMD.app');
  mkdirSync(path.join(dest, 'Contents'), { recursive: true });
  writeFileSync(path.join(dest, 'Contents/Info.plist'), '<plist>someone else</plist>');
  assert.throws(() => installApp({ home, applicationsDir: path.join(home, 'Applications'), iconPath: icon }), /was not created by showmd/);
  assert.match(readFileSync(path.join(dest, 'Contents/Info.plist'), 'utf8'), /someone else/);
});

test('launchPs1: no $Path spawns the cli with --launcher, no dialog', () => {
  const s = launchPs1('/usr/local/bin/node', '/pkg/bin/cli.js');
  assert.ok(s.includes('param([string]$Path)'));
  assert.ok(s.includes("'--launcher'"));
  assert.ok(!s.includes('Dialog'));
  assert.ok(!s.includes('Open a folder'));
});

test('launchPs1: a given $Path is passed straight to the cli', () => {
  const s = launchPs1('/usr/local/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /\$cliArgs = if \(\$Path\) \{ [^}]*\$Path \} else \{ [^}]*'--launcher' \}/);
});

test('launchPs1: starts the server hidden and logs under LOCALAPPDATA', () => {
  const s = launchPs1('/usr/local/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /Start-Process[^\n]*-WindowStyle Hidden/);
  assert.ok(s.includes("Join-Path $env:LOCALAPPDATA 'showmd'"));
});

test('launchPs1: node and cli paths survive PowerShell quoting, quotes and all', () => {
  const s = launchPs1("/opt/it's/node", "/pkg/cli's.js");
  assert.ok(s.includes("'/opt/it''s/node'"));
  assert.ok(s.includes("'/pkg/cli''s.js'"));
});

test('lnkPs1 targets powershell.exe hidden with -File', () => {
  const s = lnkPs1({ lnk: '/start/ShowMD.lnk', ps1: '/data/launch.ps1', icon: '/data/showmd.ico' });
  assert.ok(s.includes('$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
  assert.ok(s.includes("'-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + '/data/launch.ps1'"));
});

test('lnkPs1 sets the icon and a minimized window style', () => {
  const s = lnkPs1({ lnk: '/start/ShowMD.lnk', ps1: '/data/launch.ps1', icon: '/data/showmd.ico' });
  assert.ok(s.includes("$s.IconLocation = '/data/showmd.ico' + ',0'"));
  assert.ok(s.includes('$s.WindowStyle = 7'));
});

test("lnkPs1 creates the shortcut at the lnk path, PowerShell-quoted", () => {
  const s = lnkPs1({ lnk: "/start/it's/ShowMD.lnk", ps1: '/data/launch.ps1', icon: '/data/showmd.ico' });
  assert.ok(s.includes("CreateShortcut('/start/it''s/ShowMD.lnk')"));
});

test('launchSh: no dir arg spawns the cli with --launcher, no picker', () => {
  const s = launchSh('/usr/bin/node', '/pkg/bin/cli.js');
  assert.ok(s.includes('--launcher'));
  assert.ok(!s.includes('zenity'));
  assert.ok(!s.includes('kdialog'));
  assert.ok(!s.includes('Open a folder'));
});

test('launchSh: a given dir is passed straight to the cli', () => {
  const s = launchSh('/usr/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /if \[ -z "\$dir" \]; then/);
  assert.ok(s.includes(`node='/usr/bin/node'`));
  assert.ok(s.includes(`cli='/pkg/bin/cli.js'`));
  assert.ok(s.includes(`exec "$node" "$cli" "$dir"`));
});

test('launchSh execs the resolved interpreter and cli, shell-quoted, appending the log', () => {
  const s = launchSh('/usr/bin/node', '/pkg/bin/cli.js');
  assert.ok(s.includes(`exec "$node" "$cli" "$dir"`));
  assert.ok(s.includes('base="${XDG_DATA_HOME:-$HOME/.local/share}/showmd"'));
  assert.ok(s.includes('>>"$base/app.log" 2>&1'));
});

test('launchSh is valid POSIX sh', () => {
  execFileSync('sh', ['-n'], { input: launchSh('/usr/bin/node', '/pkg/bin/cli.js') });
});

test('desktopEntry: Terminal=false, Type=Application, Exec takes a dropped file', () => {
  const s = desktopEntry('/home/x/.local/share/showmd/showmd-launch', '/home/x/.local/share/showmd/showmd.png');
  assert.match(s, /^Type=Application$/m);
  assert.match(s, /^Terminal=false$/m);
  assert.match(s, /^Exec=.* %f$/m);
});

test('desktopEntry: Exec quoting escapes quotes and doubles percent signs in the launcher path', () => {
  const s = desktopEntry('/home/x/My "Apps"/100% showmd-launch', '/icon.png');
  const execLine = s.split('\n').find((l) => l.startsWith('Exec='));
  assert.equal(execLine, 'Exec="/home/x/My \\"Apps\\"/100%% showmd-launch" %f');
});

test('installAppLinux writes an executable launcher and a desktop entry', () => {
  const home = path.join(workDir, 'linux-home');
  const dataDir = path.join(home, 'data', 'showmd');
  const appsDir = path.join(home, 'data', 'applications');
  const result = installAppLinux({
    home, dataDir, applicationsDir: appsDir,
    execPath: '/usr/bin/node', cliPath: '/pkg/bin/cli.js', iconPath: '/pkg/icons/showmd.png',
  });
  assert.equal(result.dest, path.join(dataDir, 'showmd-launch'));
  assert.equal(existsSync(result.dest), true);
  assert.equal(statSync(result.dest).mode & 0o111, 0o111);
  assert.equal(existsSync(path.join(appsDir, 'showmd.desktop')), true);
  assert.equal(result.ephemeral, false);
});

test('installAppLinux: reinstalling overwrites both files', () => {
  const home = path.join(workDir, 'linux-home-reinstall');
  const dataDir = path.join(home, 'data', 'showmd');
  const appsDir = path.join(home, 'data', 'applications');
  installAppLinux({ home, dataDir, applicationsDir: appsDir, execPath: '/usr/bin/node', cliPath: '/a/cli.js' });
  const second = installAppLinux({ home, dataDir, applicationsDir: appsDir, execPath: '/usr/bin/node', cliPath: '/b/cli.js' });
  const launcher = readFileSync(second.dest, 'utf8');
  assert.match(launcher, /'\/b\/cli\.js'/);
  assert.doesNotMatch(launcher, /'\/a\/cli\.js'/);
});

test('installAppLinux: an _npx cliPath is flagged ephemeral', () => {
  const home = path.join(workDir, 'linux-home-npx');
  const dataDir = path.join(home, 'data', 'showmd');
  const appsDir = path.join(home, 'data', 'applications');
  const result = installAppLinux({
    home, dataDir, applicationsDir: appsDir,
    execPath: '/usr/bin/node', cliPath: '/Users/x/.npm/_npx/abc/node_modules/showmd/bin/cli.js',
  });
  assert.equal(result.ephemeral, true);
});

const win = { skip: process.platform !== 'win32' && 'Windows only' };

test('installAppWin creates launch.ps1 and a Start Menu shortcut', win, () => {
  const home = path.join(workDir, 'win-home');
  const dataDir = path.join(home, 'data');
  const startMenuDir = path.join(home, 'startmenu');
  const result = installAppWin({ home, dataDir, startMenuDir, execPath: 'C:\\node.exe', cliPath: 'C:\\cli.js', icoPath: icon });
  assert.equal(existsSync(path.join(dataDir, 'launch.ps1')), true);
  assert.equal(result.dest, path.join(startMenuDir, 'ShowMD.lnk'));
});

test('appStatus: darwin reports not-installed before installApp runs, installed and current after', mac, () => {
  const home = path.join(workDir, 'status-darwin');
  const apps = path.join(home, 'Applications');
  assert.deepEqual(appStatus('darwin', { home, applicationsDir: apps }), {
    path: path.join(apps, 'ShowMD.app'), installed: false, stale: false, staleReason: null, appVersion: null, appMdRegistered: false,
  });
  installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.2.3' });
  assert.deepEqual(appStatus('darwin', { home, applicationsDir: apps, version: '1.2.3' }), {
    path: path.join(apps, 'ShowMD.app'), installed: true, stale: false, staleReason: null, appVersion: '1.2.3', appMdRegistered: false,
  });
});

test('appStatus: darwin reports appMdRegistered once the bundle declares the markdown UTI', mac, () => {
  const home = path.join(workDir, 'status-darwin-md');
  const apps = path.join(home, 'Applications');
  installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.2.3' });
  assert.equal(appStatus('darwin', { home, applicationsDir: apps, version: '1.2.3' }).appMdRegistered, false);
  registerMarkdownHandler({ home, applicationsDir: apps, version: '1.2.3', lsregister: 'true' });
  assert.equal(appStatus('darwin', { home, applicationsDir: apps, version: '1.2.3' }).appMdRegistered, true);
});

test('declaresMarkdown: true once the bundle declares the markdown UTI, false otherwise, false rather than throwing on an unreadable plist', mac, () => {
  const home = path.join(workDir, 'declares-md');
  const apps = path.join(home, 'Applications');
  const { dest } = installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.2.3' });
  assert.equal(declaresMarkdown(dest), false);
  registerMarkdownHandler({ home, applicationsDir: apps, version: '1.2.3', lsregister: 'true' });
  assert.equal(declaresMarkdown(dest), true);
  assert.equal(declaresMarkdown(path.join(workDir, 'does-not-exist.app')), false);
});

test('appStatus: darwin flags a version mismatch as stale and reports the app\'s own version', mac, () => {
  const home = path.join(workDir, 'status-darwin-stale-version');
  const apps = path.join(home, 'Applications');
  installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.2.3' });
  const status = appStatus('darwin', { home, applicationsDir: apps, version: '9.9.9' });
  assert.equal(status.stale, true);
  assert.equal(status.staleReason, 'version');
  assert.equal(status.appVersion, '1.2.3');
});

test('appStatus: darwin flags a vanished entry point as stale even when the version matches, with no version comparison implied', mac, () => {
  const home = path.join(workDir, 'status-darwin-stale-entry');
  const apps = path.join(home, 'Applications');
  const cliDir = mkdtempSync(path.join(tmpdir(), 'showmd-cli-'));
  const cliPath = path.join(cliDir, 'cli.js');
  writeFileSync(cliPath, '// cli');
  installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.2.3', cliPath });
  assert.equal(appStatus('darwin', { home, applicationsDir: apps, version: '1.2.3' }).stale, false);
  rmSync(cliDir, { recursive: true, force: true });
  const status = appStatus('darwin', { home, applicationsDir: apps, version: '1.2.3' });
  assert.equal(status.stale, true);
  assert.equal(status.staleReason, 'missing');
});

test('appStatus: win32/linux report installed once their app file exists, and unreadable metadata reports stale, not a throw', () => {
  const home = path.join(workDir, 'status-cross-platform');
  const startMenuDir = path.join(home, 'startmenu');
  assert.deepEqual(appStatus('win32', { home, startMenuDir }), {
    path: path.join(startMenuDir, 'ShowMD.lnk'), installed: false, stale: false, staleReason: null, appVersion: null, appMdRegistered: false,
  });
  mkdirSync(startMenuDir, { recursive: true });
  writeFileSync(path.join(startMenuDir, 'ShowMD.lnk'), 'x');
  const winStatus = appStatus('win32', { home, startMenuDir });
  assert.equal(winStatus.installed, true);
  assert.equal(winStatus.stale, true); // no version stamp written -> unreadable metadata
  assert.equal(winStatus.staleReason, 'missing');

  const appsDir = path.join(home, 'applications');
  assert.deepEqual(appStatus('linux', { home, applicationsDir: appsDir }), {
    path: path.join(appsDir, 'showmd.desktop'), installed: false, stale: false, staleReason: null, appVersion: null, appMdRegistered: false,
  });
  mkdirSync(appsDir, { recursive: true });
  writeFileSync(path.join(appsDir, 'showmd.desktop'), 'x');
  const linuxStatus = appStatus('linux', { home, applicationsDir: appsDir });
  assert.equal(linuxStatus.installed, true);
  assert.equal(linuxStatus.stale, true);
  assert.equal(linuxStatus.staleReason, 'missing');
});

test('appStatus: linux reports healthy right after install, stale on a version bump or a vanished cli', () => {
  const home = path.join(workDir, 'status-linux-stamp');
  const dataDir = path.join(home, 'data', 'showmd');
  const appsDir = path.join(home, 'data', 'applications');
  const cliDir = mkdtempSync(path.join(tmpdir(), 'showmd-cli-linux-'));
  const cliPath = path.join(cliDir, 'cli.js');
  writeFileSync(cliPath, '// cli');
  installAppLinux({ home, dataDir, applicationsDir: appsDir, execPath: '/usr/bin/node', cliPath, version: '1.0.0' });

  const healthy = appStatus('linux', { home, applicationsDir: appsDir, dataDir, version: '1.0.0' });
  assert.equal(healthy.stale, false);
  assert.equal(healthy.appVersion, '1.0.0');

  const bumped = appStatus('linux', { home, applicationsDir: appsDir, dataDir, version: '2.0.0' });
  assert.equal(bumped.stale, true);
  assert.equal(bumped.staleReason, 'version');
  assert.equal(bumped.appVersion, '1.0.0');

  rmSync(cliDir, { recursive: true, force: true });
  const vanished = appStatus('linux', { home, applicationsDir: appsDir, dataDir, version: '1.0.0' });
  assert.equal(vanished.stale, true);
  assert.equal(vanished.staleReason, 'missing');
});

test('appStatus: unsupported platform reports not installed with no path', () => {
  assert.deepEqual(appStatus('freebsd'), { path: null, installed: false, stale: false, staleReason: null, appVersion: null, appMdRegistered: false });
});

test('selfHealApp: regenerates a stale darwin app whose entry point vanished, and clears the staleness', mac, () => {
  const home = path.join(workDir, 'selfheal-darwin');
  const apps = path.join(home, 'Applications');
  const cliDir = mkdtempSync(path.join(tmpdir(), 'showmd-cli-heal-'));
  const cliPath = path.join(cliDir, 'cli.js');
  writeFileSync(cliPath, '// cli');
  installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.2.3', cliPath });
  rmSync(cliDir, { recursive: true, force: true });
  assert.equal(appStatus('darwin', { home, applicationsDir: apps, version: '1.2.3' }).stale, true);

  const freshCliDir = mkdtempSync(path.join(tmpdir(), 'showmd-cli-heal2-'));
  const freshCliPath = path.join(freshCliDir, 'cli.js');
  writeFileSync(freshCliPath, '// cli');
  const healed = selfHealApp('darwin', { home, applicationsDir: apps, iconPath: icon, version: '1.2.3', cliPath: freshCliPath });
  assert.equal(healed, true);
  assert.equal(appStatus('darwin', { home, applicationsDir: apps, version: '1.2.3' }).stale, false);
});

test('selfHealApp: regenerates a stale linux app (version bump) and clears the staleness', () => {
  const home = path.join(workDir, 'selfheal-linux');
  const dataDir = path.join(home, 'data', 'showmd');
  const appsDir = path.join(home, 'data', 'applications');
  const cliDir = mkdtempSync(path.join(tmpdir(), 'showmd-cli-linux-heal-'));
  const cliPath = path.join(cliDir, 'cli.js');
  writeFileSync(cliPath, '// cli');
  installAppLinux({ home, dataDir, applicationsDir: appsDir, execPath: '/usr/bin/node', cliPath, version: '1.0.0' });
  assert.equal(appStatus('linux', { home, applicationsDir: appsDir, dataDir, version: '2.0.0' }).stale, true);

  const healed = selfHealApp('linux', { home, applicationsDir: appsDir, dataDir, execPath: '/usr/bin/node', cliPath, version: '2.0.0' });
  assert.equal(healed, true);
  assert.equal(appStatus('linux', { home, applicationsDir: appsDir, dataDir, version: '2.0.0' }).stale, false);
});

test('selfHealApp: refuses to touch an app file it did not create (no version stamp = not verifiably ours)', () => {
  const home = path.join(workDir, 'selfheal-foreign-linux');
  const dataDir = path.join(home, 'data', 'showmd');
  const appsDir = path.join(home, 'data', 'applications');
  mkdirSync(appsDir, { recursive: true });
  const dest = path.join(appsDir, 'showmd.desktop');
  writeFileSync(dest, 'not ours');
  const before = readFileSync(dest, 'utf8');

  const healed = selfHealApp('linux', { home, applicationsDir: appsDir, dataDir, cliPath: '/pkg/bin/cli.js' });
  assert.equal(healed, false);
  assert.equal(readFileSync(dest, 'utf8'), before);
});

test('selfHealApp: a foreign darwin bundle is refused, not overwritten', mac, () => {
  const home = path.join(workDir, 'selfheal-foreign-darwin');
  const apps = path.join(home, 'Applications');
  const dest = path.join(apps, 'ShowMD.app');
  mkdirSync(path.join(dest, 'Contents'), { recursive: true });
  writeFileSync(path.join(dest, 'Contents/Info.plist'), '<plist>someone else</plist>');

  const healed = selfHealApp('darwin', { home, applicationsDir: apps, iconPath: icon });
  assert.equal(healed, false);
  assert.match(readFileSync(path.join(dest, 'Contents/Info.plist'), 'utf8'), /someone else/);
});

test('selfHealApp: a no-op when the app is healthy', mac, () => {
  const home = path.join(workDir, 'selfheal-healthy');
  const apps = path.join(home, 'Applications');
  installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.2.3' });
  assert.equal(selfHealApp('darwin', { home, applicationsDir: apps, version: '1.2.3' }), false);
});

test('registerMarkdownHandler: refuses when no ShowMD bundle is installed at the target path', mac, () => {
  const home = path.join(workDir, 'register-missing');
  const apps = path.join(home, 'Applications');
  assert.throws(() => registerMarkdownHandler({ home, applicationsDir: apps }), /not installed/);
});

test('registerMarkdownHandler: adds a markdown document type and calls lsregister on the bundle', mac, () => {
  const home = path.join(workDir, 'register-ok');
  const apps = path.join(home, 'Applications');
  const { dest } = installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.0.0' });

  const lsregister = path.join(workDir, 'fake-lsregister');
  const calls = path.join(workDir, 'lsregister-calls');
  writeFileSync(lsregister, `#!/bin/sh\necho "$@" >> ${calls}\n`, { mode: 0o755 });

  const result = registerMarkdownHandler({ home, applicationsDir: apps, lsregister });
  assert.equal(result.dest, dest);
  assert.match(readFileSync(calls, 'utf8'), new RegExp(`-f ${dest}`));

  const plist = path.join(dest, 'Contents/Info.plist');
  const read = (key) => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
  assert.equal(read('CFBundleDocumentTypes.1.LSItemContentTypes.0'), 'net.daringfireball.markdown');
  assert.equal(read('CFBundleDocumentTypes.1.LSHandlerRank'), 'Alternate');
  assert.equal(read('CFBundleDocumentTypes.1.CFBundleTypeIconFile'), 'showmd-doc');
  assert.ok(existsSync(path.join(dest, 'Contents/Resources/showmd-doc.icns')));
  // the folder entry installApp already relies on must survive the rewrite
  assert.equal(read('CFBundleDocumentTypes.0.LSItemContentTypes.0'), 'public.folder');
});

test('installApp: reinstalling keeps a registered markdown handler', mac, () => {
  const home = path.join(workDir, 'register-reinstall');
  const apps = path.join(home, 'Applications');
  const lsregister = path.join(workDir, 'fake-lsregister-reinstall');
  const calls = path.join(workDir, 'lsregister-reinstall-calls');
  writeFileSync(lsregister, `#!/bin/sh\necho "$@" >> ${calls}\n`, { mode: 0o755 });

  installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.0.0' });
  registerMarkdownHandler({ home, applicationsDir: apps, lsregister });
  const { dest } = installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.0.1', lsregister });

  const read = (key) => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', path.join(dest, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  assert.equal(read('CFBundleDocumentTypes.1.LSItemContentTypes.0'), 'net.daringfireball.markdown');
  // LaunchServices only sees the new declaration if the rebuilt bundle is re-registered
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 2);
});

test('installChannel: classifies npx, brew, npm-global and dev cli paths', () => {
  assert.equal(installChannel('/Users/x/.npm/_npx/abc123/node_modules/showmd/bin/cli.js'), 'npx');
  assert.equal(installChannel('/opt/homebrew/Cellar/showmd/1.2.3/libexec/bin/cli.js'), 'brew');
  assert.equal(installChannel('/usr/local/lib/node_modules/showmd/bin/cli.js'), 'npm-global');
  assert.equal(installChannel('/Users/x/Documents/Repository/showmd/bin/cli.js'), 'dev');
});

test('stableBinPath, cli: a brew Cellar cli is rebased to the stable prefix/bin/showmd if it exists', () => {
  const prefix = path.join(workDir, 'brew-prefix');
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  const stable = path.join(prefix, 'bin', 'showmd');
  writeFileSync(stable, '#!/usr/bin/env node\n');
  const cellarCli = path.join(prefix, 'Cellar', 'showmd', '1.2.3', 'libexec', 'bin', 'cli.js');
  assert.equal(stableBinPath(cellarCli, 'showmd'), stable);
});

test('stableBinPath, cli: falls back to the Cellar path when the stable bin is missing', () => {
  const prefix = path.join(workDir, 'brew-prefix-missing');
  const cellarCli = path.join(prefix, 'Cellar', 'showmd', '1.2.3', 'libexec', 'bin', 'cli.js');
  assert.equal(stableBinPath(cellarCli, 'showmd'), cellarCli);
});

test('stableBinPath, cli: a non-brew cli path is returned unchanged', () => {
  const cli = '/pkg/bin/cli.js';
  assert.equal(stableBinPath(cli, 'showmd'), cli);
});

test('stableBinPath, node: a brew Cellar node is rebased to the stable prefix/bin/node if it exists', () => {
  const prefix = path.join(workDir, 'brew-prefix-node');
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  const stable = path.join(prefix, 'bin', 'node');
  writeFileSync(stable, '');
  const cellarNode = path.join(prefix, 'Cellar', 'node', '20.0.0', 'bin', 'node');
  assert.equal(stableBinPath(cellarNode, 'node'), stable);
});

test('stableBinPath, node: falls back to the Cellar node when the stable bin is missing', () => {
  const prefix = path.join(workDir, 'brew-prefix-node-missing');
  const cellarNode = path.join(prefix, 'Cellar', 'node', '20.0.0', 'bin', 'node');
  assert.equal(stableBinPath(cellarNode, 'node'), cellarNode);
});

test('installApp bakes the stable brew showmd/node paths, not the Cellar path', mac, () => {
  const home = path.join(workDir, 'brew-install');
  const apps = path.join(home, 'Applications');
  const prefix = path.join(workDir, 'brew-install-prefix');
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  const stableCli = path.join(prefix, 'bin', 'showmd');
  const stableNode = path.join(prefix, 'bin', 'node');
  writeFileSync(stableCli, '#!/usr/bin/env node\n');
  writeFileSync(stableNode, '');
  const result = installApp({
    home, applicationsDir: apps, iconPath: icon,
    cliPath: path.join(prefix, 'Cellar', 'showmd', '1.2.3', 'libexec', 'bin', 'cli.js'),
    execPath: path.join(prefix, 'Cellar', 'node', '20.0.0', 'bin', 'node'),
  });
  assert.equal(result.cli, stableCli);
  assert.doesNotMatch(result.cli, /Cellar/);
});

test('installApp keeps a non-brew cli path byte-identical to current behavior', mac, () => {
  const home = path.join(workDir, 'plain-install');
  const apps = path.join(home, 'Applications');
  const result = installApp({ home, applicationsDir: apps, iconPath: icon, cliPath: '/pkg/bin/cli.js', execPath: '/usr/bin/node' });
  assert.equal(result.cli, '/pkg/bin/cli.js');
});

test('appleScript: warns and stops instead of a silent dead double-click when the cli is missing and no probe location has it either', () => {
  const s = appleScript('/usr/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /^on ensureCli\(\)$/m);
  assert.match(s, /display dialog "showmd is no longer installed at \/pkg\/bin\/cli\.js\. Install showmd, then run: showmd install-app"/);
  assert.doesNotMatch(s, /upgraded or moved/);
  assert.doesNotMatch(s, /probably after an upgrade/);
  // the dialog names no version — do-shell-script's PATH is too bare to know one
  assert.match(s, /display dialog "[^"]*"/);
  const dialogLine = s.match(/display dialog "[^"]*"/)[0];
  assert.doesNotMatch(dialogLine, /\bv\d/);
  assert.match(s, /if not ensureCli\(\) then return/);
});

test('appleScript: probes well-known locations for a replacement showmd before giving up, macOS PATH is not trusted', () => {
  const s = appleScript('/usr/bin/node', '/pkg/bin/cli.js');
  const ensureCliBody = s.slice(s.indexOf('on ensureCli()'), s.indexOf('end ensureCli'));
  assert.match(ensureCliBody, /\/opt\/homebrew\/bin\/showmd/);
  assert.match(ensureCliBody, /\/usr\/local\/bin\/showmd/);
  assert.match(ensureCliBody, /\$HOME\/\.local\/bin\/showmd/);
  assert.doesNotMatch(ensureCliBody, /command -v showmd/);
  // the probe runs before the dialog can fire
  assert.ok(ensureCliBody.indexOf('/opt/homebrew/bin/showmd') < ensureCliBody.indexOf('display dialog'));
});

test('appleScript: a probe hit launches through the found showmd instead of the dead baked path', () => {
  const s = appleScript('/usr/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /set theCli to quoted form of probed/);
  assert.match(s, /set theNode to ""/);
  assert.match(s, /if theNode is not "" then set nodePrefix to theNode & " "/);
});

test('launchPs1: shows a message box and logs when the cli and every probe location are missing', () => {
  const s = launchPs1('/usr/local/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /if \(-not \(Test-Path \$cliPath\)\) \{/);
  assert.match(s, /\.Popup\(\$msg, 0, 'ShowMD', 0x10\)/);
  assert.match(s, /Add-Content \(Join-Path \$log 'app\.err'\) \$msg/);
  assert.match(s, /showmd is no longer installed at ' \+ '\/pkg\/bin\/cli\.js' \+ '\. Install showmd, then run: showmd install-app/);
  assert.doesNotMatch(s, /upgraded or moved/);
  assert.doesNotMatch(s, /probably after an upgrade/);
});

test('launchPs1: probes the npm global shim under %APPDATA%\\npm before giving up', () => {
  const s = launchPs1('/usr/local/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /\$probe = Join-Path \$env:APPDATA 'npm\\showmd\.cmd'/);
  assert.match(s, /if \(Test-Path \$probe\) \{\s*\$exe = \$probe/);
  const probeIdx = s.indexOf('$probe = Join-Path');
  const dialogIdx = s.indexOf('.Popup(');
  assert.ok(probeIdx < dialogIdx);
});

test('launchSh: notifies and logs when the cli and every probe location are missing, then exits without launching', () => {
  const s = launchSh('/usr/bin/node', '/pkg/bin/cli.js');
  assert.match(s, /if \[ ! -e "\$cli" \]; then/);
  assert.match(s, /notify-send "ShowMD" "\$msg"/);
  assert.match(s, />>"\$base\/app\.log"/);
  assert.match(s, /showmd is no longer installed at '/);
  assert.doesNotMatch(s, /upgraded or moved/);
  assert.doesNotMatch(s, /probably after an upgrade/);
  execFileSync('sh', ['-n'], { input: s });
});

test('launchSh: probes PATH and well-known locations for a replacement showmd, PATH is trustworthy here', () => {
  const s = launchSh('/usr/bin/node', '/pkg/bin/cli.js');
  const resolveBody = s.slice(s.indexOf('if [ ! -e "$cli" ]'), s.indexOf('node=""'));
  assert.match(resolveBody, /command -v showmd/);
  assert.match(resolveBody, /\/opt\/homebrew\/bin\/showmd/);
  assert.match(resolveBody, /\/usr\/local\/bin\/showmd/);
  assert.match(resolveBody, /\$HOME\/\.local\/bin\/showmd/);
  const missIdx = s.indexOf("if [ -z \"$cli\" ]");
  const msgIdx = s.indexOf('showmd is no longer installed');
  assert.ok(missIdx < msgIdx);
});

test('launchSh: a probe hit launches through the found showmd, not through node', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'showmd-probe-'));
  const localBin = path.join(home, '.local', 'bin');
  mkdirSync(localBin, { recursive: true });
  const probeCli = path.join(localBin, 'showmd');
  writeFileSync(probeCli, '#!/bin/sh\necho probed-hit\n', { mode: 0o755 });

  const script = `
cli='/definitely/missing/cli.js'
if [ ! -e "$cli" ]; then
  cli=$(command -v showmd >/dev/null 2>&1 && { command -v showmd; exit 0; }; for c in "/opt/homebrew/bin/showmd" "/usr/local/bin/showmd" "$HOME/.local/bin/showmd"; do if [ -x "$c" ]; then printf '%s' "$c"; exit 0; fi; done; printf '')
fi
echo "resolved=$cli"
`;
  const out = execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' } }).toString();
  // a fixed candidate ahead of $HOME/.local/bin in the probe order wins if this
  // machine happens to have one installed for real — the test only cares that
  // *some* real executable was found, not which slot
  const fixedHit = existsSync('/opt/homebrew/bin/showmd') ? '/opt/homebrew/bin/showmd'
    : existsSync('/usr/local/bin/showmd') ? '/usr/local/bin/showmd' : null;
  assert.equal(out.trim(), `resolved=${fixedHit || probeCli}`);
  rmSync(home, { recursive: true, force: true });
});

test('launchSh: a probe miss (nothing on PATH, nothing at any candidate) resolves to empty', {
  skip: (existsSync('/opt/homebrew/bin/showmd') || existsSync('/usr/local/bin/showmd'))
    && 'this machine has a real showmd at a probed path, cannot exercise a genuine miss',
}, () => {
  const home = mkdtempSync(path.join(tmpdir(), 'showmd-probe-miss-'));
  const script = `
cli='/definitely/missing/cli.js'
if [ ! -e "$cli" ]; then
  cli=$(command -v showmd >/dev/null 2>&1 && { command -v showmd; exit 0; }; for c in "/opt/homebrew/bin/showmd" "/usr/local/bin/showmd" "$HOME/.local/bin/showmd"; do if [ -x "$c" ]; then printf '%s' "$c"; exit 0; fi; done; printf '')
fi
echo "resolved=[$cli]"
`;
  const out = execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' } }).toString();
  assert.equal(out.trim(), 'resolved=[]');
  rmSync(home, { recursive: true, force: true });
});

function withAppDirEnv(value, fn) {
  const prev = process.env.SHOWMD_APP_DIR;
  process.env.SHOWMD_APP_DIR = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.SHOWMD_APP_DIR;
    else process.env.SHOWMD_APP_DIR = prev;
  }
}

test('SHOWMD_APP_DIR overrides the default install directory on darwin, an explicit applicationsDir opt still wins', () => {
  const dir = path.join(workDir, 'env-launcher-dir-darwin');
  withAppDirEnv(dir, () => {
    assert.equal(appDest({ home: path.join(workDir, 'unused-home') }), path.join(dir, 'ShowMD.app'));
    const explicit = path.join(workDir, 'explicit-apps-dir');
    assert.equal(appDest({ home: path.join(workDir, 'unused-home'), applicationsDir: explicit }), path.join(explicit, 'ShowMD.app'));
  });
});

test('SHOWMD_APP_DIR overrides the default Start Menu directory on win32, ahead of APPDATA, behind an explicit startMenuDir opt', () => {
  const dir = path.join(workDir, 'env-launcher-dir-win');
  withAppDirEnv(dir, () => {
    assert.equal(winDest({ home: path.join(workDir, 'unused-home') }), path.join(dir, 'ShowMD.lnk'));
    const explicit = path.join(workDir, 'explicit-startmenu-dir');
    assert.equal(winDest({ home: path.join(workDir, 'unused-home'), startMenuDir: explicit }), path.join(explicit, 'ShowMD.lnk'));
  });
});

test('SHOWMD_APP_DIR overrides the default applications directory on linux, ahead of XDG_DATA_HOME, behind an explicit applicationsDir opt', () => {
  const dir = path.join(workDir, 'env-launcher-dir-linux');
  withAppDirEnv(dir, () => {
    assert.equal(linuxDest({ home: path.join(workDir, 'unused-home') }), path.join(dir, 'showmd.desktop'));
    const explicit = path.join(workDir, 'explicit-linux-apps-dir');
    assert.equal(linuxDest({ home: path.join(workDir, 'unused-home'), applicationsDir: explicit }), path.join(explicit, 'showmd.desktop'));
  });
});
