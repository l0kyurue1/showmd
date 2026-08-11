import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workDir = mkdtempSync(path.join(tmpdir(), 'showmd-ports-'));
process.env.SHOWMD_SETTINGS_HOME = path.join(workDir, 'state');
test.after(() => rmSync(workDir, { recursive: true, force: true }));

const { announce, retract, list, portsDir } = await import('../../server/ports.js');

test('announce writes <pid>.json, list finds it, retract removes it', async () => {
  await announce(4321, 111);
  assert.deepEqual(JSON.parse(readFileSync(path.join(portsDir(), '111.json'), 'utf8')), { port: 4321, pid: 111 });
  assert.deepEqual(await list(), [{ port: 4321, pid: 111 }]);
  retract(111);
  assert.ok(!existsSync(path.join(portsDir(), '111.json')));
  assert.deepEqual(await list(), []);
});

test('two instances announce, one retracts, the other stays listed', async () => {
  await announce(4321, 222);
  await announce(4322, 333);
  retract(222);
  assert.deepEqual(await list(), [{ port: 4322, pid: 333 }]);
  retract(333);
});

test('an old registration cannot retract a newer port for the same pid', async () => {
  const oldRegistration = await announce(4321, 444);
  const currentRegistration = await announce(4322, 444);

  assert.deepEqual(oldRegistration, {
    file: path.join(portsDir(), '444.json'),
    port: 4321,
    pid: 444,
  });

  retract(oldRegistration);

  assert.deepEqual(await list(), [{ port: 4322, pid: 444 }]);
  retract(currentRegistration);
  assert.deepEqual(await list(), []);
});

test('a stale pid (process no longer running) is swept on the next announce', async () => {
  const deadPid = 999999;
  await announce(4321, deadPid);
  assert.ok(existsSync(path.join(portsDir(), `${deadPid}.json`)));
  await announce(4322, process.pid);
  assert.ok(!existsSync(path.join(portsDir(), `${deadPid}.json`)), 'dead pid swept by the live announce');
  const listed = await list();
  assert.deepEqual(listed, [{ port: 4322, pid: process.pid }]);
  retract(process.pid);
});

test('retract on a pid with no file is a no-op', () => {
  assert.doesNotThrow(() => retract(123456));
});

test('list on a missing ports dir returns an empty array', async () => {
  rmSync(portsDir(), { recursive: true, force: true });
  assert.deepEqual(await list(), []);
});
