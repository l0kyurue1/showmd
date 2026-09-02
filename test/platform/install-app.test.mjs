import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const {
  installApp, applicationsDir, installAppWin, launchSh, appStatus,
  registerMarkdownHandler, selfHealApp, declaresMarkdown,
} = await import('../../server/install-app.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'showmd-platform-app-'));
process.on('exit', () => rmSync(workDir, { recursive: true, force: true }));

const icon = path.join(workDir, 'showmd.icns');
writeFileSync(icon, 'icns');

const mac = { skip: process.platform !== 'darwin' && 'macOS only' };
const win = { skip: process.platform !== 'win32' && 'Windows only' };
const posix = { skip: process.platform === 'win32' && 'POSIX sh only' };

let installNumber = 0;
function install(extra = {}) {
  const home = path.join(workDir, `home${installNumber++}`);
  const apps = path.join(home, 'Applications');
  return { home, ...installApp({ home, applicationsDir: apps, iconPath: icon, version: '9.9.9', ...extra }) };
}

test('applicationsDir: uses /Applications when writable, otherwise the user Applications directory', mac, () => {
  const home = path.join(workDir, 'home-appsdir');
  const dir = applicationsDir(home);
  assert.equal(dir === '/Applications' || dir === path.join(home, 'Applications'), true);
});

test('installApp: builds a bundle Finder recognizes as ShowMD', mac, () => {
  const { dest } = install();
  assert.equal(dest.endsWith('Applications/ShowMD.app'), true);
  const plist = path.join(dest, 'Contents/Info.plist');
  const read = (key) => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
  assert.equal(read('CFBundleName'), 'ShowMD');
  assert.equal(read('CFBundleDisplayName'), 'ShowMD');
  assert.equal(read('CFBundleIdentifier'), 'io.github.l0kyurue1.showmd');
  assert.equal(read('CFBundleShortVersionString'), '9.9.9');
  assert.equal(read('CFBundleIconFile'), 'showmd');
  assert.throws(() => read('CFBundleIconName'));
  assert.equal(existsSync(path.join(dest, 'Contents/Resources/Assets.car')), false);
  assert.equal(readFileSync(path.join(dest, 'Contents/Resources/droplet.icns'), 'utf8'), 'icns');
  assert.equal(read('CFBundleDocumentTypes.0.LSItemContentTypes.0'), 'public.folder');
  assert.equal(readFileSync(path.join(dest, 'Contents/Resources/showmd.icns'), 'utf8'), 'icns');
  assert.equal(existsSync(path.join(dest, 'Contents/MacOS')), true);
});

test('installApp: reinstalling replaces the bundle in place', mac, () => {
  const home = path.join(workDir, 'home-repeat');
  const apps = path.join(home, 'Applications');
  const first = installApp({ home, applicationsDir: apps, iconPath: icon, cliPath: '/a/cli.js', version: '1.0.0' });
  writeFileSync(path.join(first.dest, 'Contents/Resources/stale'), 'x');
  const second = installApp({ home, applicationsDir: apps, iconPath: icon, cliPath: '/b/cli.js', version: '2.0.0' });
  assert.equal(second.dest, first.dest);
  assert.equal(existsSync(path.join(second.dest, 'Contents/Resources/stale')), false);
});

test('installApp: a failed rebuild leaves the previous bundle intact and no temp sibling behind', mac, () => {
  const home = path.join(workDir, 'home-atomic');
  const apps = path.join(home, 'Applications');
  const { dest } = installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.0.0' });
  const before = readFileSync(path.join(dest, 'Contents/Info.plist'), 'utf8');

  assert.throws(
    () => installApp({ home, applicationsDir: apps, iconPath: path.join(workDir, 'no-such-icon.icns'), version: '2.0.0' }),
    /ENOENT/,
  );

  assert.equal(readFileSync(path.join(dest, 'Contents/Info.plist'), 'utf8'), before);
  assert.deepEqual(readdirSync(apps), ['ShowMD.app']);
});

test('launchSh: generated launcher is valid POSIX sh', posix, () => {
  execFileSync('sh', ['-n'], { input: launchSh('/usr/bin/node', '/pkg/bin/cli.js') });
});

test('installAppWin: creates launch.ps1 and a Start Menu shortcut', win, () => {
  const home = path.join(workDir, 'win-home');
  const dataDir = path.join(home, 'data');
  const startMenuDir = path.join(home, 'startmenu');
  const result = installAppWin({ home, dataDir, startMenuDir, execPath: 'C:\\node.exe', cliPath: 'C:\\cli.js', icoPath: icon });
  assert.equal(existsSync(path.join(dataDir, 'launch.ps1')), true);
  assert.equal(result.dest, path.join(startMenuDir, 'ShowMD.lnk'));
});

test('appStatus: darwin reports not-installed before install and current afterward', mac, () => {
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

test('appStatus: darwin reports appMdRegistered after registration', mac, () => {
  const home = path.join(workDir, 'status-darwin-md');
  const apps = path.join(home, 'Applications');
  installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.2.3' });
  assert.equal(appStatus('darwin', { home, applicationsDir: apps, version: '1.2.3' }).appMdRegistered, false);
  registerMarkdownHandler({ home, applicationsDir: apps, version: '1.2.3', lsregister: 'true' });
  assert.equal(appStatus('darwin', { home, applicationsDir: apps, version: '1.2.3' }).appMdRegistered, true);
});

test('declaresMarkdown: follows the real bundle declaration and tolerates a missing bundle', mac, () => {
  const home = path.join(workDir, 'declares-md');
  const apps = path.join(home, 'Applications');
  const { dest } = installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.2.3' });
  assert.equal(declaresMarkdown(dest), false);
  registerMarkdownHandler({ home, applicationsDir: apps, version: '1.2.3', lsregister: 'true' });
  assert.equal(declaresMarkdown(dest), true);
  assert.equal(declaresMarkdown(path.join(workDir, 'does-not-exist.app')), false);
});

test('appStatus: darwin reports the installed version when a version bump makes it stale', mac, () => {
  const home = path.join(workDir, 'status-darwin-stale-version');
  const apps = path.join(home, 'Applications');
  installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.2.3' });
  const status = appStatus('darwin', { home, applicationsDir: apps, version: '9.9.9' });
  assert.equal(status.stale, true);
  assert.equal(status.staleReason, 'version');
  assert.equal(status.appVersion, '1.2.3');
});

test('appStatus: darwin reports a vanished entry point as missing', mac, () => {
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

test('selfHealApp: regenerates a stale darwin app after its entry point vanishes', mac, () => {
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
  assert.equal(selfHealApp('darwin', { home, applicationsDir: apps, iconPath: icon, version: '1.2.3', cliPath: freshCliPath }), true);
  assert.equal(appStatus('darwin', { home, applicationsDir: apps, version: '1.2.3' }).stale, false);
});

test('selfHealApp: refuses a foreign darwin bundle', mac, () => {
  const home = path.join(workDir, 'selfheal-foreign-darwin');
  const apps = path.join(home, 'Applications');
  const dest = path.join(apps, 'ShowMD.app');
  mkdirSync(path.join(dest, 'Contents'), { recursive: true });
  writeFileSync(path.join(dest, 'Contents/Info.plist'), '<plist>someone else</plist>');
  assert.equal(selfHealApp('darwin', { home, applicationsDir: apps, iconPath: icon }), false);
  assert.match(readFileSync(path.join(dest, 'Contents/Info.plist'), 'utf8'), /someone else/);
});

test('selfHealApp: is a no-op for a healthy darwin app', mac, () => {
  const home = path.join(workDir, 'selfheal-healthy');
  const apps = path.join(home, 'Applications');
  installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.2.3' });
  assert.equal(selfHealApp('darwin', { home, applicationsDir: apps, version: '1.2.3' }), false);
});

test('registerMarkdownHandler: refuses when no ShowMD bundle is installed', mac, () => {
  const home = path.join(workDir, 'register-missing');
  const apps = path.join(home, 'Applications');
  assert.throws(() => registerMarkdownHandler({ home, applicationsDir: apps }), /not installed/);
});

test('registerMarkdownHandler: adds the document type and registers the bundle', mac, () => {
  const home = path.join(workDir, 'register-ok');
  const apps = path.join(home, 'Applications');
  const { dest } = installApp({ home, applicationsDir: apps, iconPath: icon, version: '1.0.0' });
  const lsregister = path.join(workDir, 'fake-lsregister');
  const calls = path.join(workDir, 'lsregister-calls');
  writeFileSync(lsregister, `#!/bin/sh\necho "$@" >> ${calls}\n`, { mode: 0o755 });

  assert.equal(registerMarkdownHandler({ home, applicationsDir: apps, lsregister }).dest, dest);
  assert.match(readFileSync(calls, 'utf8'), new RegExp(`-f ${dest}`));
  const plist = path.join(dest, 'Contents/Info.plist');
  const read = (key) => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
  assert.equal(read('CFBundleDocumentTypes.1.LSItemContentTypes.0'), 'net.daringfireball.markdown');
  assert.equal(read('CFBundleDocumentTypes.1.LSHandlerRank'), 'Alternate');
  assert.equal(read('CFBundleDocumentTypes.1.CFBundleTypeIconFile'), 'showmd-doc');
  assert.ok(existsSync(path.join(dest, 'Contents/Resources/showmd-doc.icns')));
  assert.equal(read('CFBundleDocumentTypes.0.LSItemContentTypes.0'), 'public.folder');
});

test('installApp: reinstalling preserves a registered markdown handler', mac, () => {
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
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 2);
});

test('installApp: bakes stable Homebrew showmd/node paths into the bundle', mac, () => {
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

test('launchSh: generated launcher executes a replacement showmd found on PATH', posix, () => {
  const home = mkdtempSync(path.join(tmpdir(), 'showmd-probe-'));
  const bin = path.join(home, 'bin');
  const data = path.join(home, 'data');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'showmd'), '#!/bin/sh\nprintf "replacement:%s\\n" "$*"\n', { mode: 0o755 });
  try {
    execFileSync('sh', ['-c', launchSh('/definitely/missing/node', '/definitely/missing/cli.js')], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: data, PATH: `${bin}:/usr/bin:/bin` },
    });
    assert.equal(readFileSync(path.join(data, 'showmd', 'app.log'), 'utf8').trim(), 'replacement:--launcher');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
