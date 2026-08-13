import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const { buildPickerAppletSource, createFolderPicker } = await import('../../server/folder-picker.js');

test('buildPickerAppletSource: embeds the request and result file paths verbatim', () => {
  const src = buildPickerAppletSource({ requestFile: '/tmp/req', resultFile: '/tmp/res' });
  assert.match(src, /set reqFile to "\/tmp\/req"/);
  assert.match(src, /set resFile to "\/tmp\/res"/);
});

// Fake a current marker so these tests cover polling, not osacompile.
function makeFakes({ resultSequence = [] } = {}) {
  const calls = [];
  let resultCalls = 0;
  const fsp = {
    async readFile(p) {
      if (p.endsWith('showmd-picker-version')) return '0.1.1';
      if (p.endsWith('pick-result')) {
        const v = resultSequence[resultCalls];
        resultCalls++;
        if (v === undefined) throw new Error('ENOENT');
        return v;
      }
      throw new Error('ENOENT');
    },
    async writeFile(p, data) { calls.push({ fn: 'writeFile', p, data }); },
    async rm(p) { calls.push({ fn: 'rm', p }); },
    async mkdir() {},
    async copyFile() {},
  };
  const execFileP = async (cmd, args) => { calls.push({ fn: 'execFileP', cmd, args }); return { stdout: '' }; };
  const execFile = (cmd, args, cb) => { calls.push({ fn: 'execFile', cmd, args }); cb(null, ''); };
  return { calls, fsp, execFileP, execFile };
}

test('darwin pick(): writes the request file and invokes `open -g` on the helper app, resolves the picked path', async () => {
  const { calls, fsp, execFileP, execFile } = makeFakes({ resultSequence: ['/picked/dir'] });
  const picker = createFolderPicker({ platform: 'darwin', supportDir: '/fake/support', execFile, execFileP, fsp, pollMs: 1 });
  const result = await picker.pick();
  assert.equal(result, '/picked/dir');
  assert.ok(calls.some((c) => c.fn === 'writeFile' && c.p.endsWith('pick-request')), 'request file was written');
  const open = calls.find((c) => c.fn === 'execFileP' && c.cmd === 'open');
  assert.deepEqual(open.args, ['-g', '-a', path.join('/fake/support', 'ShowMD Helper.app')]);
});

test('darwin pick(): a canceled dialog resolves null', async () => {
  const { fsp, execFileP, execFile } = makeFakes({ resultSequence: ['__CANCELED__'] });
  const picker = createFolderPicker({ platform: 'darwin', supportDir: '/fake/support', execFile, execFileP, fsp, pollMs: 1 });
  assert.equal(await picker.pick(), null);
});

test('darwin pick(): times out and rejects if the result file never appears', async () => {
  const { fsp, execFileP, execFile } = makeFakes({ resultSequence: [] });
  const picker = createFolderPicker({ platform: 'darwin', supportDir: '/fake/support', execFile, execFileP, fsp, pollMs: 1, timeoutMs: 5 });
  await assert.rejects(() => picker.pick(), /picker timed out/);
});

test('ensureApp(): exposed so install-time prebaking can share warm()\'s build/memoization', async () => {
  const { fsp, execFileP } = makeFakes();
  const picker = createFolderPicker({ platform: 'darwin', supportDir: '/fake/support', execFileP, fsp });
  await assert.doesNotReject(() => picker.ensureApp());
});

test('warm(): swallows every failure instead of throwing or rejecting', async () => {
  const execFileP = async () => { throw new Error('boom'); };
  const fsp = {
    readFile: async () => { throw new Error('ENOENT'); },
    mkdir: async () => { throw new Error('boom'); },
    rm: async () => { throw new Error('boom'); },
    writeFile: async () => { throw new Error('boom'); },
    copyFile: async () => { throw new Error('boom'); },
  };
  const picker = createFolderPicker({ platform: 'darwin', supportDir: '/fake/support', execFileP, fsp });
  // returns a settled promise so server shutdown can wait on the build chain
  await assert.doesNotReject(() => picker.warm());
});

test('warm(): resolves within warmTimeoutMs even if the build chain hangs', async () => {
  const execFileP = () => new Promise(() => {});
  const fsp = {
    readFile: async () => { throw new Error('ENOENT'); },
    mkdir: async () => {},
    rm: async () => {},
    writeFile: async () => {},
    copyFile: async () => {},
  };
  const picker = createFolderPicker({ platform: 'darwin', supportDir: '/fake/support', execFileP, fsp, warmTimeoutMs: 20 });
  await picker.warm();
});

test('buildPickerAppletSource: branches the panel by pickMode, no setMessage anywhere', () => {
  const src = buildPickerAppletSource({ requestFile: '/tmp/req', resultFile: '/tmp/res' });
  assert.match(src, /if pickMode is "folder" then/);
  assert.match(src, /else if pickMode is "file" then/);
  assert.doesNotMatch(src, /setMessage/);
});

test('darwin pick(mode): writes the mode into the request file', async () => {
  const { calls, fsp, execFileP, execFile } = makeFakes({ resultSequence: ['/picked/folder'] });
  const picker = createFolderPicker({ platform: 'darwin', supportDir: '/fake/support', execFile, execFileP, fsp, pollMs: 1 });
  await picker.pick('folder');
  const write = calls.find((c) => c.fn === 'writeFile' && c.p.endsWith('pick-request'));
  assert.equal(write.data, 'folder');
});

test('darwin pick(): no mode writes an empty request file (legacy combined panel)', async () => {
  const { calls, fsp, execFileP, execFile } = makeFakes({ resultSequence: ['/picked/either'] });
  const picker = createFolderPicker({ platform: 'darwin', supportDir: '/fake/support', execFile, execFileP, fsp, pollMs: 1 });
  await picker.pick();
  const write = calls.find((c) => c.fn === 'writeFile' && c.p.endsWith('pick-request'));
  assert.equal(write.data, '');
});

test('darwin pick(mode, startDir): appends the start directory as a second line', async () => {
  const { calls, fsp, execFileP, execFile } = makeFakes({ resultSequence: ['/blocked/dir'] });
  const picker = createFolderPicker({ platform: 'darwin', supportDir: '/fake/support', execFile, execFileP, fsp, pollMs: 1 });
  await picker.pick('folder', '/blocked/dir');
  const write = calls.find((c) => c.fn === 'writeFile' && c.p.endsWith('pick-request'));
  assert.equal(write.data, 'folder\n/blocked/dir');
});

test('picker applet seeds the panel from the request file second line', () => {
  const src = buildPickerAppletSource({ requestFile: '/tmp/req', resultFile: '/tmp/res' });
  assert.match(src, /set startDir to item 2 of reqParts/);
  assert.match(src, /setDirectoryURL:\(app_'s NSURL's fileURLWithPath:startDir\)/);
});

test('win32 pick("folder"): FolderBrowserDialog, no Description string', async () => {
  let script;
  let opts;
  const execFile = (cmd, args, o, cb) => { script = args[args.length - 1]; opts = o; cb(null, 'C:\\picked'); };
  const picker = createFolderPicker({ platform: 'win32', execFile });
  const result = await picker.pick('folder');
  assert.equal(result, 'C:\\picked');
  assert.match(script, /FolderBrowserDialog/);
  assert.doesNotMatch(script, /Description/);
  // without this the Start Menu launch flashes a console behind the dialog
  assert.equal(opts.windowsHide, true);
});

test('win32 pick("file"): OpenFileDialog with a Markdown filter', async () => {
  let script;
  const execFile = (cmd, args, o, cb) => { script = args[args.length - 1]; cb(null, 'C:\\picked.md'); };
  const picker = createFolderPicker({ platform: 'win32', execFile });
  const result = await picker.pick('file');
  assert.equal(result, 'C:\\picked.md');
  assert.match(script, /OpenFileDialog/);
  assert.match(script, /Markdown \(\*\.md;\*\.markdown\)\|\*\.md;\*\.markdown/);
});

test('linux pick("folder"): zenity --directory, no --title', async () => {
  let calledArgs;
  const execFile = (cmd, args, cb) => { calledArgs = args; cb(null, '/picked/dir'); };
  const picker = createFolderPicker({ platform: 'linux', execFile });
  const result = await picker.pick('folder');
  assert.equal(result, '/picked/dir');
  assert.deepEqual(calledArgs, ['--file-selection', '--directory']);
});

test('linux pick("file"): zenity --file-selection with a markdown file-filter', async () => {
  let calledArgs;
  const execFile = (cmd, args, cb) => { calledArgs = args; cb(null, '/picked/file.md'); };
  const picker = createFolderPicker({ platform: 'linux', execFile });
  const result = await picker.pick('file');
  assert.equal(result, '/picked/file.md');
  assert.deepEqual(calledArgs, ['--file-selection', '--file-filter=*.md *.markdown']);
});

test('linux pick("file"): zenity missing falls back to kdialog --getopenfilename', async () => {
  const execFile = (cmd, args, cb) => {
    if (cmd === 'zenity') {
      const err = new Error('not found');
      err.code = 'ENOENT';
      return cb(err);
    }
    assert.equal(cmd, 'kdialog');
    assert.equal(args[0], '--getopenfilename');
    cb(null, '/picked/file.md');
  };
  const picker = createFolderPicker({ platform: 'linux', execFile });
  const result = await picker.pick('file');
  assert.equal(result, '/picked/file.md');
});
