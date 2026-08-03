import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { restartArgv } = require('../../server/server.js');
const { buildRevealCommand } = require('../../server/reveal.js');

test('restartArgv: strips --port <n>, appends --no-open', () => {
  assert.deepEqual(
    restartArgv(['/path/to/showmd.js', '--port', '58231', 'SAMPLE.md']),
    ['/path/to/showmd.js', 'SAMPLE.md', '--no-open'],
  );
});

test('restartArgv: strips --port=<n> form', () => {
  assert.deepEqual(
    restartArgv(['/path/to/showmd.js', '--port=58231', 'SAMPLE.md']),
    ['/path/to/showmd.js', 'SAMPLE.md', '--no-open'],
  );
});

test('restartArgv: no-flag launch still appends --no-open (regression)', () => {
  assert.deepEqual(
    restartArgv(['/path/to/showmd.js', 'SAMPLE.md']),
    ['/path/to/showmd.js', 'SAMPLE.md', '--no-open'],
  );
});

test('restartArgv: idempotent when --no-open already present', () => {
  assert.deepEqual(
    restartArgv(['/path/to/showmd.js', '--port', '58231', '--no-open']),
    ['/path/to/showmd.js', '--no-open'],
  );
});

test('buildRevealCommand: darwin -> open -R <file>', () => {
  assert.deepEqual(buildRevealCommand('darwin', '/a/b/c.md'), { cmd: 'open', args: ['-R', '/a/b/c.md'] });
});

test('buildRevealCommand: win32 -> explorer /select,<file>', () => {
  assert.deepEqual(buildRevealCommand('win32', 'C:\\a\\b\\c.md'), { cmd: 'explorer', args: ['/select,C:\\a\\b\\c.md'] });
});

test('buildRevealCommand: linux (and any other platform) -> xdg-open <dirname>', () => {
  assert.deepEqual(buildRevealCommand('linux', '/a/b/c.md'), { cmd: 'xdg-open', args: ['/a/b'] });
});
