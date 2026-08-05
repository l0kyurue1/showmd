'use strict';
const path = require('node:path');
const os = require('node:os');
const nodeFsp = require('node:fs/promises');
const proc = require('./proc.js');

// preserves the node:child_process execFile/promisify(execFile) shapes so
// createFolderPicker's injection points don't have to change
function nodeExecFile(cmd, args, optsOrCb, maybeCb) {
  const opts = typeof optsOrCb === 'function' ? {} : optsOrCb;
  const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
  proc.tryRun(cmd, args, opts).then(({ err, stdout }) => cb(err, stdout));
}

async function nodeExecFileP(cmd, args, opts) {
  const { err, stdout } = await proc.tryRun(cmd, args, opts);
  if (err) throw err;
  return { stdout };
}

const PICKER_APP_VERSION = '0.1.3';

// macOS: a bare osascript process has no LaunchServices identity, so its
// NSOpenPanel draws on screen but can never become key — clicks don't land
// and the dialog looks like it dismisses itself. Only a real .app can show a
// working panel, so the panel lives in a tiny stay-open LSUIElement applet
// compiled once into Application Support. A pick is signaled by a request
// file plus `open -g` (launch and reopen both route to checkPick) and
// answered through a result file; the applet keeps running afterwards, which
// also swallows the 1-2s AppKit load that made the first dialog slow.
function buildPickerAppletSource({ requestFile, resultFile }) {
  return `use framework "AppKit"
use framework "UniformTypeIdentifiers"
use scripting additions

on run
	checkPick()
end run

on reopen
	checkPick()
end reopen

on idle
	return 3600
end idle

on checkPick()
	set reqFile to "${requestFile}"
	set resFile to "${resultFile}"
	set reqText to ""
	try
		set reqText to do shell script "cat " & quoted form of reqFile
	on error
		return
	end try
	do shell script "rm -f " & quoted form of reqFile
	set AppleScript's text item delimiters to linefeed
	set reqParts to text items of reqText
	set AppleScript's text item delimiters to ""
	set pickMode to item 1 of reqParts
	set startDir to ""
	if (count of reqParts) > 1 then set startDir to item 2 of reqParts
	activate
	set app_ to current application
	set mdType to app_'s UTType's typeWithFilenameExtension:"md"
	set mdownType to app_'s UTType's typeWithFilenameExtension:"markdown"
	set folderType to app_'s UTType's typeWithIdentifier:"public.folder"
	set thePanel to app_'s NSOpenPanel's openPanel()
	thePanel's setAllowsMultipleSelection:false
	if pickMode is "folder" then
		thePanel's setCanChooseFiles:false
		thePanel's setCanChooseDirectories:true
		thePanel's setAllowedContentTypes:{folderType}
	else if pickMode is "file" then
		thePanel's setCanChooseFiles:true
		thePanel's setCanChooseDirectories:false
		thePanel's setAllowedContentTypes:{mdType, mdownType}
	else
		thePanel's setCanChooseFiles:true
		thePanel's setCanChooseDirectories:true
		thePanel's setAllowedContentTypes:{mdType, mdownType, folderType}
	end if
	if startDir is not "" then
		thePanel's setDirectoryURL:(app_'s NSURL's fileURLWithPath:startDir)
	end if
	set theResponse to thePanel's runModal()
	if theResponse is 1 then
		set out to (thePanel's |URL|()'s |path|()) as text
	else
		set out to "__CANCELED__"
	end if
	do shell script "printf %s " & quoted form of out & " > " & quoted form of (resFile & ".tmp") & " && mv " & quoted form of (resFile & ".tmp") & " " & quoted form of resFile
end checkPick`;
}

function createFolderPicker({
  platform = process.platform,
  supportDir = require('./settings.js').platformDataDir('darwin'),
  execFile = nodeExecFile,
  execFileP = nodeExecFileP,
  fsp = nodeFsp,
  // test-only seams: production never sets these, so pickViaApplet's real
  // wait is always the full 120s/100ms below
  timeoutMs = 120000,
  pollMs = 100,
} = {}) {
  const appDir = path.join(supportDir, 'ShowMD Helper.app');
  const requestFile = path.join(supportDir, 'pick-request');
  const resultFile = path.join(supportDir, 'pick-result');

  // build-once memoization, scoped to this picker instance; the on-disk
  // PICKER_APP_VERSION marker (checked inside buildApp) already makes
  // rebuild-skipping robust across separate instances/processes
  let build = null;
  function ensureApp() {
    if (!build) build = buildApp().catch((err) => { build = null; throw err; });
    return build;
  }

  async function buildApp() {
    const marker = path.join(appDir, 'Contents', 'Resources', 'showmd-picker-version');
    if ((await fsp.readFile(marker, 'utf8').catch(() => null)) === PICKER_APP_VERSION) return;
    await fsp.mkdir(supportDir, { recursive: true });
    await execFileP('pkill', ['-f', 'ShowMD Helper.app']).catch(() => {});
    await fsp.rm(appDir, { recursive: true, force: true });
    const src = path.join(os.tmpdir(), `showmd-picker-${process.pid}.applescript`);
    await fsp.writeFile(src, buildPickerAppletSource({ requestFile, resultFile }));
    await execFileP('osacompile', ['-s', '-o', appDir, src]);
    await fsp.rm(src, { force: true });
    const resources = path.join(appDir, 'Contents', 'Resources');
    const plist = path.join(appDir, 'Contents', 'Info.plist');
    await execFileP('/usr/libexec/PlistBuddy', ['-c', 'Add :LSUIElement bool true', plist]);
    // same dance as install-app.js: the asset catalog's CFBundleIconName wins
    // over CFBundleIconFile, so it has to go for the custom icon to show
    await fsp.rm(path.join(resources, 'Assets.car'), { force: true });
    await fsp.copyFile(path.join(__dirname, '..', 'icons', 'showmd-helper.icns'), path.join(resources, 'applet.icns'));
    await execFileP('plutil', ['-remove', 'CFBundleIconName', plist]).catch(() => {});
    for (const [key, value] of [['CFBundleName', 'ShowMD Helper'], ['CFBundleDisplayName', 'ShowMD Helper'], ['CFBundleIconFile', 'applet'], ['CFBundleShortVersionString', PICKER_APP_VERSION], ['CFBundleVersion', PICKER_APP_VERSION]]) {
      await execFileP('plutil', ['-replace', key, '-string', value, plist]);
    }
    await fsp.writeFile(marker, PICKER_APP_VERSION);
  }

  function warm() {
    ensureApp()
      .then(() => fsp.rm(requestFile, { force: true }))
      .then(() => execFileP('open', ['-g', '-a', appDir]))
      .catch(() => {});
  }

  async function pickViaApplet(mode, startDir) {
    await ensureApp();
    await fsp.rm(resultFile, { force: true });
    await fsp.writeFile(requestFile, startDir ? `${mode || ''}\n${startDir}` : (mode || ''));
    await execFileP('open', ['-g', '-a', appDir]);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const out = await fsp.readFile(resultFile, 'utf8').catch(() => null);
      if (out !== null) {
        await fsp.rm(resultFile, { force: true });
        return out.trim() === '__CANCELED__' ? null : out.trim();
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    await fsp.rm(requestFile, { force: true });
    throw new Error('picker timed out');
  }

  // plain `choose folder`/`choose file` can't offer both in one panel, so
  // macOS gets the NSOpenPanel applet above. Filtering must use UTType —
  // setAllowedFileTypes is dead on current macOS and greys out every file —
  // and the UTType filter also gates folders despite setCanChooseDirectories,
  // so public.folder must be listed too.
  // mode is 'folder' | 'file' | undefined; undefined means the legacy combined
  // panel (both at once), which only macOS's NSOpenPanel can offer — win32 and
  // linux never had a combined mode, so undefined defaults to folder there too
  // startDir opens the panel already inside that folder. macOS records a
  // per-item privacy grant (com.apple.macl) for whatever the panel returns, so
  // a folder the server got EPERM on becomes readable once the user confirms
  // it here — no Privacy pane trip. macOS only; the other pickers ignore it.
  function pick(mode, startDir) {
    if (platform === 'win32') {
      const script = mode === 'file'
        ? `Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter='Markdown (*.md;*.markdown)|*.md;*.markdown'; if($d.ShowDialog() -eq 'OK'){$d.FileName}else{'__CANCELED__'}`
        : `Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}else{'__CANCELED__'}`;
      return new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true }, (err, stdout) => {
          if (err) return reject(err);
          const out = stdout.trim();
          resolve(out === '__CANCELED__' ? null : out);
        });
      });
    }
    if (platform === 'linux') {
      const zenityArgs = mode === 'file'
        ? ['--file-selection', '--file-filter=*.md *.markdown']
        : ['--file-selection', '--directory'];
      return new Promise((resolve) => {
        execFile('zenity', zenityArgs, (err, stdout) => {
          if (!err) return resolve(stdout.trim());
          if (err.code !== 'ENOENT') return resolve(null);
          const kdialogArgs = mode === 'file'
            ? ['--getopenfilename', os.homedir(), '*.md *.markdown|Markdown files']
            : ['--getexistingdirectory', os.homedir()];
          execFile('kdialog', kdialogArgs, (err2, stdout2) => {
            if (!err2) return resolve(stdout2.trim());
            resolve(err2.code === 'ENOENT' ? undefined : null);
          });
        });
      });
    }
    if (platform !== 'darwin') return Promise.resolve(undefined);
    return pickViaApplet(mode, startDir);
  }

  return { warm, pick, ensureApp };
}

module.exports = { buildPickerAppletSource, createFolderPicker };
