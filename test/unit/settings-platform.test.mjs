import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const {
  detectBrowsers, bundleClaimsHttpScheme, lsHandlerIsDefault, detectMdHandlerDefault,
  _resetMdHandlerCache, _setMdHandlerCacheTestHooks,
} = await import('../../server/settings-platform.js');

test('detectBrowsers: always includes "default" first, even with nothing installed', async () => {
  const emptyDir = mkdtempSync(path.join(tmpdir(), 'showmd-browsers-empty-'));
  try {
    const result = await detectBrowsers({ platform: 'darwin', appDirs: [emptyDir] });
    assert.deepEqual(result, ['default']);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('bundleClaimsHttpScheme: true for a plist claiming http/https, false otherwise', () => {
  assert.equal(bundleClaimsHttpScheme({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['https'] }] }), true);
  assert.equal(bundleClaimsHttpScheme({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['HTTP'] }] }), true);
  assert.equal(bundleClaimsHttpScheme({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['ftp'] }] }), false);
  assert.equal(bundleClaimsHttpScheme({ CFBundleURLTypes: [] }), false);
  assert.equal(bundleClaimsHttpScheme({}), false);
  assert.equal(bundleClaimsHttpScheme(null), false);
});

test('detectBrowsers: darwin scan reads each bundle\'s Info.plist via the injected readPlist and keeps only http/https handlers', async () => {
  const fakeApps = mkdtempSync(path.join(tmpdir(), 'showmd-browsers-'));
  try {
    mkdirSync(path.join(fakeApps, 'Dia.app', 'Contents'), { recursive: true });
    mkdirSync(path.join(fakeApps, 'TextEdit.app', 'Contents'), { recursive: true });
    const readPlist = async (plistPath) => {
      if (plistPath.includes('Dia.app')) return { CFBundleURLTypes: [{ CFBundleURLSchemes: ['http', 'https'] }] };
      if (plistPath.includes('TextEdit.app')) return { CFBundleURLTypes: [{ CFBundleURLSchemes: ['public.textedit-doc'] }] };
      return null;
    };
    const result = await detectBrowsers({ platform: 'darwin', appDirs: [fakeApps], readPlist });
    assert.deepEqual(result, ['default', 'Dia']);
  } finally {
    rmSync(fakeApps, { recursive: true, force: true });
  }
});

test('detectBrowsers: darwin scan recurses one level into subfolders (e.g. Utilities)', async () => {
  const fakeApps = mkdtempSync(path.join(tmpdir(), 'showmd-browsers-'));
  try {
    mkdirSync(path.join(fakeApps, 'Utilities', 'Zeta.app', 'Contents'), { recursive: true });
    mkdirSync(path.join(fakeApps, 'Alpha.app', 'Contents'), { recursive: true });
    const readPlist = async () => ({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['https'] }] });
    const result = await detectBrowsers({ platform: 'darwin', appDirs: [fakeApps], readPlist });
    assert.deepEqual(result, ['default', 'Alpha', 'Zeta']);
  } finally {
    rmSync(fakeApps, { recursive: true, force: true });
  }
});

test('detectBrowsers: darwin scan skips a bundle whose plist is unreadable instead of throwing', async () => {
  const fakeApps = mkdtempSync(path.join(tmpdir(), 'showmd-browsers-'));
  try {
    mkdirSync(path.join(fakeApps, 'Broken.app', 'Contents'), { recursive: true });
    const readPlist = async () => { throw new Error('corrupt plist'); };
    const result = await detectBrowsers({ platform: 'darwin', appDirs: [fakeApps], readPlist });
    assert.deepEqual(result, ['default']);
  } finally {
    rmSync(fakeApps, { recursive: true, force: true });
  }
});

test('detectBrowsers: finds a fake executable on the injected linux PATH', async () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'showmd-browsers-bin-'));
  try {
    writeFileSync(path.join(fakeBin, 'firefox'), '');
    const result = await detectBrowsers({ platform: 'linux', pathDirs: [fakeBin] });
    assert.deepEqual(result, ['default', 'firefox']);
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('lsHandlerIsDefault: true when LSHandlerRoleAll matches the bundle id on a markdown entry', () => {
  const secure = { LSHandlers: [{ LSHandlerContentType: 'net.daringfireball.markdown', LSHandlerRoleAll: 'io.github.l0kyurue1.showmd' }] };
  assert.equal(lsHandlerIsDefault(secure, 'io.github.l0kyurue1.showmd'), true);
});

test('lsHandlerIsDefault: true via LSHandlerContentTag "md" + LSHandlerContentTagClass, and via LSHandlerRoleViewer', () => {
  const secure = { LSHandlers: [{ LSHandlerContentTag: 'md', LSHandlerContentTagClass: 'public.filename-extension', LSHandlerRoleViewer: 'io.github.l0kyurue1.showmd' }] };
  assert.equal(lsHandlerIsDefault(secure, 'io.github.l0kyurue1.showmd'), true);
});

test('lsHandlerIsDefault: false when the default is some other app', () => {
  const secure = { LSHandlers: [{ LSHandlerContentType: 'net.daringfireball.markdown', LSHandlerRoleAll: 'com.apple.TextEdit' }] };
  assert.equal(lsHandlerIsDefault(secure, 'io.github.l0kyurue1.showmd'), false);
});

test('lsHandlerIsDefault: false when the entry is absent, and false on malformed/missing input', () => {
  assert.equal(lsHandlerIsDefault({ LSHandlers: [] }, 'io.github.l0kyurue1.showmd'), false);
  assert.equal(lsHandlerIsDefault(null, 'io.github.l0kyurue1.showmd'), false);
  assert.equal(lsHandlerIsDefault({}, 'io.github.l0kyurue1.showmd'), false);
  assert.equal(lsHandlerIsDefault({ LSHandlers: 'not-an-array' }, 'io.github.l0kyurue1.showmd'), false);
  assert.equal(lsHandlerIsDefault({ LSHandlers: [{ LSHandlerContentType: 'net.daringfireball.markdown', LSHandlerRoleAll: 'io.github.l0kyurue1.showmd' }] }, ''), false);
});

test('detectMdHandlerDefault: reads the injected plist via readPlist and reports the match', async () => {
  const readPlist = async (p) => {
    assert.equal(p, '/fake/secure.plist');
    return { LSHandlers: [{ LSHandlerContentType: 'net.daringfireball.markdown', LSHandlerRoleAll: 'io.github.l0kyurue1.showmd' }] };
  };
  const result = await detectMdHandlerDefault({ platform: 'darwin', bundleId: 'io.github.l0kyurue1.showmd', plistPath: '/fake/secure.plist', readPlist });
  assert.equal(result, true);
});

test('detectMdHandlerDefault: false on non-darwin platforms without touching readPlist', async () => {
  let calls = 0;
  const readPlist = async () => { calls++; return {}; };
  const result = await detectMdHandlerDefault({ platform: 'linux', bundleId: 'io.github.l0kyurue1.showmd', readPlist });
  assert.equal(result, false);
  assert.equal(calls, 0);
});

test('detectMdHandlerDefault: a readPlist failure (missing/unreadable file) reports not-default instead of throwing', async () => {
  const readPlist = async () => null;
  const result = await detectMdHandlerDefault({ platform: 'darwin', bundleId: 'io.github.l0kyurue1.showmd', plistPath: '/nope.plist', readPlist });
  assert.equal(result, false);
});

test('detectMdHandlerDefault: an injected readPlist bypasses the TTL cache and is called every time', async () => {
  let calls = 0;
  const readPlist = async () => { calls++; return { LSHandlers: [] }; };
  await detectMdHandlerDefault({ platform: 'darwin', bundleId: 'io.github.l0kyurue1.showmd', plistPath: '/nope.plist', readPlist });
  await detectMdHandlerDefault({ platform: 'darwin', bundleId: 'io.github.l0kyurue1.showmd', plistPath: '/nope.plist', readPlist });
  assert.equal(calls, 2);
});

test('detectMdHandlerDefault: the uncached (no readPlist/plistPath/home) branch reuses a fresh cache entry', async (t) => {
  t.after(() => { _resetMdHandlerCache(); _setMdHandlerCacheTestHooks(); });
  _resetMdHandlerCache();
  let calls = 0;
  const readPlist = async () => { calls++; return { LSHandlers: [{ LSHandlerContentType: 'net.daringfireball.markdown', LSHandlerRoleAll: 'io.github.l0kyurue1.showmd' }] }; };
  let now = 1_000_000;
  _setMdHandlerCacheTestHooks({ now: () => now, readPlist });

  const first = await detectMdHandlerDefault({ bundleId: 'io.github.l0kyurue1.showmd' });
  now += 1_000;
  const second = await detectMdHandlerDefault({ bundleId: 'io.github.l0kyurue1.showmd' });

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(calls, 1);
});

test('detectMdHandlerDefault: the uncached branch refetches once the TTL has elapsed', async (t) => {
  t.after(() => { _resetMdHandlerCache(); _setMdHandlerCacheTestHooks(); });
  _resetMdHandlerCache();
  let calls = 0;
  const readPlist = async () => { calls++; return { LSHandlers: [] }; };
  let now = 2_000_000;
  _setMdHandlerCacheTestHooks({ now: () => now, readPlist });

  await detectMdHandlerDefault({ bundleId: 'io.github.l0kyurue1.showmd' });
  now += 10_001;
  await detectMdHandlerDefault({ bundleId: 'io.github.l0kyurue1.showmd' });

  assert.equal(calls, 2);
});

test('detectMdHandlerDefault: the uncached branch keys the cache by bundleId, missing when it differs', async (t) => {
  t.after(() => { _resetMdHandlerCache(); _setMdHandlerCacheTestHooks(); });
  _resetMdHandlerCache();
  let calls = 0;
  const readPlist = async () => { calls++; return { LSHandlers: [] }; };
  _setMdHandlerCacheTestHooks({ now: () => 3_000_000, readPlist });

  await detectMdHandlerDefault({ bundleId: 'io.github.l0kyurue1.showmd' });
  await detectMdHandlerDefault({ bundleId: 'com.apple.TextEdit' });

  assert.equal(calls, 2);
});
