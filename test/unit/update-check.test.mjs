import test from 'node:test';
import assert from 'node:assert/strict';

const { checkUpdate, refreshUpdateCache, updateInfo, isNewerVersion } = await import('../../server/update-check.js');

test('updateInfo: nothing checked yet is not the same as a failed check', () => {
  assert.deepEqual(updateInfo(), { updateAvailable: false, latestVersion: null, checkFailed: false });
});

test('refreshUpdateCache: a newer registry version reports updateAvailable', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://registry.npmjs.org/showmd/latest');
    return { ok: true, json: async () => ({ version: '999.0.0' }) };
  };
  await refreshUpdateCache(fetchImpl);
  assert.deepEqual(updateInfo(), { updateAvailable: true, latestVersion: '999.0.0', checkFailed: false });
});

test('refreshUpdateCache: current or older registry version reports no update', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: '0.0.1' }) });
  await refreshUpdateCache(fetchImpl);
  assert.deepEqual(updateInfo(), { updateAvailable: false, latestVersion: '0.0.1', checkFailed: false });
});

test('refreshUpdateCache: a failed fetch never throws and reports checkFailed instead of "never checked"', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  await refreshUpdateCache(fetchImpl);
  assert.deepEqual(updateInfo(), { updateAvailable: false, latestVersion: null, checkFailed: true });
});

test('refreshUpdateCache: a non-ok response is treated as a failed check', async () => {
  const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
  await refreshUpdateCache(fetchImpl);
  assert.deepEqual(updateInfo(), { updateAvailable: false, latestVersion: null, checkFailed: true });
});

test('refreshUpdateCache: fetch is called with an abort signal (timeout guard wired)', async () => {
  let sawSignal = null;
  const fetchImpl = async (url, opts) => {
    sawSignal = opts && opts.signal;
    return { ok: true, json: async () => ({ version: '1.2.3' }) };
  };
  await refreshUpdateCache(fetchImpl);
  assert.ok(sawSignal instanceof AbortSignal);
});

test('checkUpdate: enabled=false never calls fetch', () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ version: '999.0.0' }) }; };
  checkUpdate({ enabled: false, fetchImpl });
  assert.equal(calls, 0);
});

test('isNewerVersion: a release outranks its own prerelease', () => {
  assert.equal(isNewerVersion('1.0.0', '1.0.0-beta'), true);
  assert.equal(isNewerVersion('1.0.0-beta', '1.0.0'), false);
});

test('isNewerVersion: two prereleases of the same release compare lexically', () => {
  assert.equal(isNewerVersion('1.0.0-beta.2', '1.0.0-beta.1'), true);
  assert.equal(isNewerVersion('1.0.0-beta.1', '1.0.0-beta.2'), false);
  assert.equal(isNewerVersion('1.0.0-beta', '1.0.0-beta'), false);
});

test('isNewerVersion: build metadata is ignored entirely', () => {
  assert.equal(isNewerVersion('1.0.0+abc', '1.0.0+xyz'), false);
  assert.equal(isNewerVersion('1.0.1+build.5', '1.0.0+build.9'), true);
});

test('isNewerVersion: unequal segment counts pad the shorter with zeros', () => {
  assert.equal(isNewerVersion('1.2', '1.2.0'), false);
  assert.equal(isNewerVersion('1.2.1', '1.2'), true);
});

test('isNewerVersion: numeric comparison, not lexical (10.0.0 > 9.0.0)', () => {
  assert.equal(isNewerVersion('10.0.0', '9.0.0'), true);
});

test('isNewerVersion: equal versions report no update', () => {
  assert.equal(isNewerVersion('1.2.3', '1.2.3'), false);
});

test('checkUpdate: a fresh cache is reused without calling fetch again', async () => {
  await refreshUpdateCache(async () => ({ ok: true, json: async () => ({ version: '5.0.0' }) }));
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ version: '6.0.0' }) }; };
  const result = checkUpdate({ enabled: true, fetchImpl });
  assert.equal(calls, 0);
  assert.deepEqual(result, { updateAvailable: true, latestVersion: '5.0.0', checkFailed: false });
});
