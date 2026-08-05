import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { formatPortWarning, parseNetstatPid, buildOpenBrowserCommand, openBrowser } = require('../../bin/cli.js');
const proc = require('../../server/proc.js');

// `netstat -ano -p TCP`: the header and STATE column are localized, the
// column layout is not
const NETSTAT_EN = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044
  TCP    127.0.0.1:4321         0.0.0.0:0              LISTENING       8123
  TCP    127.0.0.1:52001        127.0.0.1:4321         ESTABLISHED     9090
`;

const NETSTAT_ES = `
Conexiones activas

  Proto  Dirección local        Dirección remota       Estado          PID
  TCP    127.0.0.1:4321         0.0.0.0:0              ESCUCHANDO      8123
`;

test('formatPortWarning: includes port, version and pid', () => {
  assert.equal(formatPortWarning(4321, '0.1.0', '86136'), 'showmd: port 4321 is held by showmd 0.1.0 (pid 86136)');
});

test('formatPortWarning: omits the pid parens when pid is not obtainable', () => {
  assert.equal(formatPortWarning(4321, '0.1.0', null), 'showmd: port 4321 is held by showmd 0.1.0');
});

test('parseNetstatPid: finds the listener by local address', () => {
  assert.equal(parseNetstatPid(NETSTAT_EN, 4321), '8123');
});

test('parseNetstatPid: a localized STATE column still resolves (regression)', () => {
  assert.equal(parseNetstatPid(NETSTAT_ES, 4321), '8123');
});

test('parseNetstatPid: a longer port sharing our prefix is not a match', () => {
  const out = '  TCP    127.0.0.1:43210        0.0.0.0:0              LISTENING       7777\n';
  assert.equal(parseNetstatPid(out, 4321), null);
});

test('parseNetstatPid: a port we only connect to is not ours', () => {
  const out = '  TCP    127.0.0.1:52001        127.0.0.1:9999         ESTABLISHED     9090\n';
  assert.equal(parseNetstatPid(out, 9999), null);
});

test('parseNetstatPid: no listener yields null', () => {
  assert.equal(parseNetstatPid(NETSTAT_EN, 5000), null);
});

test('buildOpenBrowserCommand: darwin, default browser', () => {
  assert.deepEqual(buildOpenBrowserCommand('darwin', 'http://127.0.0.1:4321/', 'default'), { cmd: 'open', args: ['http://127.0.0.1:4321/'], launcher: true });
});

test('buildOpenBrowserCommand: darwin, named browser', () => {
  assert.deepEqual(buildOpenBrowserCommand('darwin', 'http://x/', 'Google Chrome'), { cmd: 'open', args: ['-a', 'Google Chrome', 'http://x/'], launcher: true });
});

test('buildOpenBrowserCommand: win32 keeps the empty start title argument', () => {
  assert.deepEqual(buildOpenBrowserCommand('win32', 'http://x/', 'default'), { cmd: 'cmd', args: ['/c', 'start', '', 'http://x/'], launcher: true });
  assert.deepEqual(buildOpenBrowserCommand('win32', 'http://x/', 'Firefox'), { cmd: 'cmd', args: ['/c', 'start', '', 'Firefox', 'http://x/'], launcher: true });
});

test('buildOpenBrowserCommand: linux runs the browser itself, else xdg-open', () => {
  assert.deepEqual(buildOpenBrowserCommand('linux', 'http://x/', 'default'), { cmd: 'xdg-open', args: ['http://x/'], launcher: true });
  assert.deepEqual(buildOpenBrowserCommand('linux', 'http://x/', 'firefox'), { cmd: 'firefox', args: ['http://x/'], launcher: false });
});

test('buildOpenBrowserCommand: an unset browser is treated as default', () => {
  assert.deepEqual(buildOpenBrowserCommand('linux', 'http://x/', undefined), { cmd: 'xdg-open', args: ['http://x/'], launcher: true });
});

function fakeSpawn(behavior) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    if (behavior === 'enoent') {
      const err = new Error(`spawn ${cmd} ENOENT`);
      err.code = 'ENOENT';
      queueMicrotask(() => child.emit('error', err));
    }
    if (behavior === 'exit1') queueMicrotask(() => child.emit('exit', 1));
    return child;
  };
  const launchFn = (cmd, args) => proc.launchDetached(cmd, args, {}, spawnFn);
  return { spawnFn, launchFn, calls };
}

test('openBrowser: a missing opener is logged, not fatal (regression)', async () => {
  const { launchFn } = fakeSpawn('enoent');
  const errors = [];
  const realError = console.error;
  console.error = (msg) => errors.push(msg);
  try {
    openBrowser('http://127.0.0.1:4321/', 'default', launchFn);
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.error = realError;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^showmd: could not open .+ENOENT$/);
});

// `open -a NoSuchBrowser` exits 1 rather than failing to spawn, so the error
// event alone would let a stale browser setting fail in silence
test('openBrowser: a launcher exiting non-zero is reported', { skip: process.platform === 'linux' }, async () => {
  const { launchFn } = fakeSpawn('exit1');
  const errors = [];
  const realError = console.error;
  console.error = (msg) => errors.push(msg);
  try {
    openBrowser('http://127.0.0.1:4321/', 'NoSuchBrowser', launchFn);
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.error = realError;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not open http:\/\/127\.0\.0\.1:4321\/ \(exit 1\)$/);
});

test('openBrowser: spawns detached with windowsHide', () => {
  const { launchFn, calls } = fakeSpawn();
  openBrowser('http://127.0.0.1:4321/', 'default', launchFn);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { stdio: 'ignore', detached: true, windowsHide: true });
});
