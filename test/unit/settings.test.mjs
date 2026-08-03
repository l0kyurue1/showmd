import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workDir = mkdtempSync(path.join(tmpdir(), 'showmd-settings-'));
process.env.SHOWMD_SETTINGS_HOME = path.join(workDir, 'state');
test.after(() => rmSync(workDir, { recursive: true, force: true }));

const { DEFAULTS, settingsFile, readSettings, writeSettings, writeJSONAtomic } = await import('../../server/settings.js');

test('readSettings returns defaults when the file is missing', async () => {
  assert.deepEqual(await readSettings(), DEFAULTS);
});

test('readSettings merges a partial file over defaults', async () => {
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify({ colorMode: 'dark', port: 5000 }));
  assert.deepEqual(await readSettings(), { ...DEFAULTS, colorMode: 'dark', port: 5000 });
});

test('a corrupt file falls back to defaults instead of crashing', async () => {
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), '{not json');
  assert.deepEqual(await readSettings(), DEFAULTS);
});

test('writeSettings persists and re-reads the merged result', async () => {
  writeFileSync(settingsFile(), JSON.stringify({}));
  const result = await writeSettings({ colorMode: 'light', openMode: 'edit' });
  assert.deepEqual(result, { ...DEFAULTS, colorMode: 'light', openMode: 'edit' });
  assert.deepEqual(await readSettings(), { ...DEFAULTS, colorMode: 'light', openMode: 'edit' });
});

test('writeSettings ignores unknown keys and wrong-typed values', async () => {
  writeFileSync(settingsFile(), JSON.stringify({}));
  const result = await writeSettings({ colorMode: 'purple', bogusKey: 'x', port: 'not-a-number', updateCheck: false });
  assert.deepEqual(result, { ...DEFAULTS, updateCheck: false });
  assert.equal('bogusKey' in result, false);
});

test('port validator: accepts 1024-65535, rejects outside the range', async () => {
  writeFileSync(settingsFile(), JSON.stringify({}));
  assert.deepEqual(await writeSettings({ port: 1023 }), DEFAULTS);
  assert.deepEqual(await writeSettings({ port: 65536 }), DEFAULTS);
  assert.equal((await writeSettings({ port: 1024 })).port, 1024);
  assert.equal((await writeSettings({ port: 65535 })).port, 65535);
});

test('fontSize validator: accepts 10-32, rejects outside the range', async () => {
  writeFileSync(settingsFile(), JSON.stringify({}));
  assert.deepEqual(await writeSettings({ fontSize: 9.9 }), DEFAULTS);
  assert.deepEqual(await writeSettings({ fontSize: 32.1 }), DEFAULTS);
  assert.equal((await writeSettings({ fontSize: 10 })).fontSize, 10);
  assert.equal((await writeSettings({ fontSize: 32 })).fontSize, 32);
});

test('fontPreset validator: only known presets are accepted', async () => {
  writeFileSync(settingsFile(), JSON.stringify({}));
  assert.deepEqual(await writeSettings({ fontPreset: 'comic-sans' }), DEFAULTS);
  assert.equal((await writeSettings({ fontPreset: 'serif' })).fontPreset, 'serif');
});

test('writeJSONAtomic writes the file and leaves no tmp file behind', async () => {
  const file = path.join(workDir, 'atomic', 'data.json');
  await writeJSONAtomic(file, { a: 1 });
  const { readFileSync, readdirSync } = await import('node:fs');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1 });
  assert.deepEqual(readdirSync(path.dirname(file)), ['data.json']);
});
