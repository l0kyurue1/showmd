import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { identifyRoot, isRootKey, rootRelation } = require('../../server/root-identity.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'showmd-root-identity-'));
test.after(() => rmSync(workDir, { recursive: true, force: true }));

test('identifyRoot gives path aliases one stable opaque identity', async () => {
  const dir = path.join(workDir, 'space root');
  mkdirSync(dir);

  const absolute = await identifyRoot(dir);
  const relative = await identifyRoot(path.relative(process.cwd(), dir));
  const trailing = await identifyRoot(`${dir}${path.sep}`);

  assert.deepEqual(relative, absolute);
  assert.deepEqual(trailing, absolute);
  assert.equal(absolute.dir, realpathSync(dir));
  assert.equal(absolute.name, 'space root');
  assert.match(absolute.key, /^r_[A-Za-z0-9_-]{22}$/);
  assert.equal(absolute.key.includes('space'), false);
});

test('isRootKey owns the exact route-safe root key grammar', () => {
  assert.equal(isRootKey('r_0123456789abcdefghij_A'), true);
  assert.equal(isRootKey('r_ABCDEFGHIJ-klmnopqrstu'), true);
  assert.equal(isRootKey('r_0123456789abcdefghij_'), false);
  assert.equal(isRootKey('x_0123456789abcdefghij_A'), false);
  assert.equal(isRootKey('r_0123456789abcdefghij+A'), false);
  assert.equal(isRootKey(null), false);
});

test('identifyRoot rejects missing paths and non-directories with filesystem error codes', async () => {
  const file = path.join(workDir, 'note.md');
  writeFileSync(file, '# Note\n');

  await assert.rejects(identifyRoot(path.join(workDir, 'missing')), { code: 'ENOENT' });
  await assert.rejects(identifyRoot(file), { code: 'ENOTDIR' });
});

test('rootRelation distinguishes nesting from path-prefix siblings', async () => {
  const parentDir = path.join(workDir, 'project');
  const childDir = path.join(parentDir, 'packages', 'docs');
  const siblingDir = path.join(workDir, 'project-copy');
  mkdirSync(childDir, { recursive: true });
  mkdirSync(siblingDir);
  const parent = await identifyRoot(parentDir);
  const child = await identifyRoot(childDir);
  const sibling = await identifyRoot(siblingDir);

  assert.equal(rootRelation(parent, parent), 'same');
  assert.equal(rootRelation(parent, child), 'ancestor');
  assert.equal(rootRelation(child, parent), 'descendant');
  assert.equal(rootRelation(parent, sibling), 'disjoint');
});

test('identifyRoot deduplicates a filesystem symlink alias', async () => {
  const target = path.join(workDir, 'canonical-target');
  const alias = path.join(workDir, 'target-alias');
  mkdirSync(target);
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');

  assert.deepEqual(await identifyRoot(alias), await identifyRoot(target));
});

test('identifyRoot preserves spaces and Unicode in the root summary', async () => {
  const dir = path.join(workDir, '資料 café');
  mkdirSync(dir);

  const root = await identifyRoot(dir);
  assert.equal(root.dir, realpathSync(dir));
  assert.equal(root.name, '資料 café');
  assert.match(root.key, /^r_[A-Za-z0-9_-]{22}$/);
});
