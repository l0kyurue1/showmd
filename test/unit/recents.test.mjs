import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workDir = mkdtempSync(path.join(tmpdir(), 'showmd-recents-'));
process.env.SHOWMD_SETTINGS_HOME = path.join(workDir, 'state');
test.after(() => rmSync(workDir, { recursive: true, force: true }));

const { recentsFile, list, add, remove } = await import('../../server/recents.js');

test('list returns [] when the file is missing', async () => {
  assert.deepEqual(await list(), []);
});

test('add prepends a new entry, newest first', async () => {
  await add('/a');
  await add('/b');
  assert.deepEqual((await list()).map((e) => e.path), ['/b', '/a']);
});

test('add dedupes by path, moving the existing entry to the front', async () => {
  await add('/a');
  const entries = await list();
  assert.deepEqual(entries.map((e) => e.path), ['/a', '/b']);
  assert.equal(entries.length, 2);
});

test('add caps the list at 10 entries', async () => {
  for (let i = 0; i < 12; i++) await add(`/n${i}`);
  const entries = await list();
  assert.equal(entries.length, 10);
  assert.equal(entries[0].path, '/n11');
});

test('remove drops an entry by path', async () => {
  await remove('/n11');
  assert.ok(!(await list()).some((e) => e.path === '/n11'));
});

test('remove on a path that is not in the list is a no-op, not a crash', async () => {
  const before = await list();
  await remove('/never-added');
  assert.deepEqual(await list(), before);
});

test('a corrupt file falls back to [] instead of crashing', async () => {
  mkdirSync(path.dirname(recentsFile()), { recursive: true });
  writeFileSync(recentsFile(), '{not json');
  assert.deepEqual(await list(), []);
});

test('add still works after a corrupt file, overwriting it with a valid one', async () => {
  await add('/fresh');
  assert.deepEqual((await list()).map((e) => e.path), ['/fresh']);
});
