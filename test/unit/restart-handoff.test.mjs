import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const settingsHome = mkdtempSync(path.join(tmpdir(), 'showmd-restart-settings-'));
process.env.SHOWMD_SETTINGS_HOME = settingsHome;
test.after(() => rmSync(settingsHome, { recursive: true, force: true }));

const {
  HANDOFF_SCHEMA_VERSION,
  restartDir,
  createRestartSnapshot,
  validateRestartSnapshot,
  writeRestartHandoff,
  adoptRestartHandoff,
  cleanupRestartHandoffs,
} = await import('../../server/restart-handoff.js');

test('restartDir mirrors ports.js\'s pattern: <settingsDir>/restart', () => {
  assert.equal(restartDir(), path.join(settingsHome, 'restart'));
});

const NOW = Date.parse('2026-08-06T12:00:00.000Z');
const ROOT_KEY = `r_${'a'.repeat(22)}`;
const state = {
  oldInstance: { instanceId: 'old-instance', pid: 100, startedAt: '2026-08-06T11:00:00.000Z', actualPort: 4321 },
  newInstance: { instanceId: 'new-instance', pid: 101, startedAt: '2026-08-06T12:00:00.000Z', actualPort: 4400 },
  roots: [{ key: ROOT_KEY, dir: '/canonical/project', name: 'project' }],
  skillsContexts: [{ key: 'ctx_example', projectDirs: ['/tmp/project'] }],
};

function snapshot(overrides = {}) {
  return createRestartSnapshot({ ...state, ...overrides }, { now: () => NOW, ttlMs: 30_000 });
}

test('restart snapshot is versioned, bounded, and carries old/new instance metadata plus identity references', () => {
  const value = snapshot();
  assert.equal(value.schemaVersion, HANDOFF_SCHEMA_VERSION);
  assert.equal(value.createdAt, NOW);
  assert.equal(value.expiresAt, NOW + 30_000);
  assert.deepEqual(value.roots, state.roots);
  assert.deepEqual(value.skillsContexts, state.skillsContexts);
  assert.deepEqual(validateRestartSnapshot(value, { now: () => NOW }), value);

  assert.throws(
    () => createRestartSnapshot({ ...state, roots: Array.from({ length: 129 }, () => state.roots[0]) }, { now: () => NOW }),
    (err) => err.code === 'INVALID_HANDOFF',
  );
  assert.throws(
    () => validateRestartSnapshot({ ...value, roots: [{ ...state.roots[0], dir: 'relative' }] }, { now: () => NOW }),
    (err) => err.code === 'INVALID_HANDOFF',
  );
  for (const projectDirs of [[], ['relative/dir'], undefined]) {
    assert.throws(
      () => validateRestartSnapshot({ ...value, skillsContexts: [{ key: 'ctx_example', projectDirs }] }, { now: () => NOW }),
      (err) => err.code === 'INVALID_HANDOFF',
    );
  }
  assert.throws(
    () => validateRestartSnapshot({ ...value, schemaVersion: 99 }, { now: () => NOW }),
    (err) => err.code === 'UNSUPPORTED_HANDOFF',
  );
});

test('writeRestartHandoff uses a private temp file and atomic rename', async () => {
  const calls = [];
  const fakeFs = {
    async mkdir(dir, options) { calls.push(['mkdir', dir, options]); },
    async writeFile(file, text, options) { calls.push(['write', file, JSON.parse(text), options]); },
    async rename(from, to) { calls.push(['rename', from, to]); },
    async rm() {},
  };
  const file = '/handoffs/restart-token.json';
  const value = await writeRestartHandoff(file, state, {
    fs: fakeFs,
    now: () => NOW,
    random: () => 'random',
  });

  assert.equal(value.schemaVersion, HANDOFF_SCHEMA_VERSION);
  assert.deepEqual(calls.map((call) => call[0]), ['mkdir', 'write', 'rename']);
  assert.equal(calls[1][1], `${file}.tmp-random`);
  assert.deepEqual(calls[1][3], { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  assert.deepEqual(calls[2].slice(1), [`${file}.tmp-random`, file]);
});

test('child adoption claims and deletes a handoff exactly once', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'showmd-handoff-'));
  const file = path.join(dir, 'restart-once.json');
  try {
    await writeRestartHandoff(file, state, { now: () => NOW, random: () => 'write' });
    let adopted;
    const result = await adoptRestartHandoff(file, {
      newInstance: state.newInstance,
      adopt(value) { adopted = value; },
    }, { now: () => NOW + 1, random: () => 'claim' });

    assert.equal(result.kind, 'adopted');
    assert.deepEqual(adopted.roots, state.roots);
    assert.deepEqual(adopted.skillsContexts, state.skillsContexts);
    assert.equal(existsSync(file), false);
    assert.deepEqual(
      await adoptRestartHandoff(file, { newInstance: state.newInstance, adopt() {} }, { now: () => NOW + 2 }),
      { kind: 'missing', fallback: 'cold_start' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expired, malformed, partial, and wrong-target handoffs are consumed without adoption', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'showmd-handoff-bad-'));
  try {
    const cases = [
      ['expired', JSON.stringify(snapshot()), NOW + 30_001, state.newInstance, 'expired'],
      ['malformed', '{nope', NOW, state.newInstance, 'invalid'],
      ['partial', JSON.stringify({ schemaVersion: HANDOFF_SCHEMA_VERSION, roots: [] }), NOW, state.newInstance, 'invalid'],
      ['wrong-target', JSON.stringify(snapshot()), NOW, { ...state.newInstance, instanceId: 'other' }, 'wrong_target'],
    ];
    for (const [name, body, at, instance, kind] of cases) {
      const file = path.join(dir, `restart-${name}.json`);
      writeFileSync(file, body);
      let calls = 0;
      const result = await adoptRestartHandoff(file, {
        newInstance: instance,
        adopt() { calls += 1; },
      }, { now: () => at, random: () => name });
      assert.equal(result.kind, kind, name);
      assert.equal(result.fallback, 'cold_start', name);
      assert.equal(calls, 0, name);
      assert.equal(existsSync(file), false, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed adoption consumes the snapshot and returns cold-start fallback', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'showmd-handoff-failed-'));
  const file = path.join(dir, 'restart-failed.json');
  try {
    await writeRestartHandoff(file, state, { now: () => NOW });
    const result = await adoptRestartHandoff(file, {
      newInstance: state.newInstance,
      adopt() { throw Object.assign(new Error('root vanished'), { code: 'ENOENT' }); },
    }, { now: () => NOW + 1 });
    assert.equal(result.kind, 'adoption_failed');
    assert.equal(result.fallback, 'cold_start');
    assert.equal(result.error.code, 'ENOENT');
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale cleanup removes expired, malformed, and abandoned temp files but keeps a fresh snapshot', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'showmd-handoff-cleanup-'));
  try {
    const fresh = path.join(dir, 'restart-fresh.json');
    const expired = path.join(dir, 'restart-expired.json');
    const malformed = path.join(dir, 'restart-malformed.json');
    const temp = path.join(dir, 'restart-old.json.tmp-abandoned');
    await writeRestartHandoff(fresh, state, { now: () => NOW });
    await writeRestartHandoff(expired, state, { now: () => NOW - 60_000, ttlMs: 1_000 });
    writeFileSync(malformed, 'bad');
    writeFileSync(temp, 'partial');
    utimesSync(temp, new Date(NOW - 600_000), new Date(NOW - 600_000));

    const result = await cleanupRestartHandoffs(dir, { now: () => NOW });
    assert.deepEqual(result, { removed: 3, kept: 1 });
    assert.deepEqual(readdirSync(dir), ['restart-fresh.json']);
    assert.equal((JSON.parse(await readFile(fresh, 'utf8'))).newInstance.instanceId, 'new-instance');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed atomic write removes its temp file and never publishes the handoff', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'showmd-handoff-write-fail-'));
  const file = path.join(dir, 'restart-fail.json');
  const wrappedFs = {
    mkdir,
    async writeFile(temp, text, options) {
      await import('node:fs/promises').then((fs) => fs.writeFile(temp, text, options));
    },
    async rename() { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); },
    async rm(target, options) { return import('node:fs/promises').then((fs) => fs.rm(target, options)); },
  };
  try {
    await assert.rejects(() => writeRestartHandoff(file, state, {
      fs: wrappedFs,
      now: () => NOW,
      random: () => 'temp',
    }), { code: 'EIO' });
    assert.equal(existsSync(file), false);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
