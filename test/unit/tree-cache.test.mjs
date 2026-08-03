import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTreeCache } = require('../../server/tree-cache.js');

test('createTreeCache: rebuilds only when the key changes or the TTL elapses', async () => {
  const cache = createTreeCache();
  let builds = 0;
  const build = () => { builds++; return { tree: { n: builds }, roots: null }; };
  let now = 1000;

  const { tree: t1 } = await cache.getTree('a', build, { now: () => now });
  assert.equal(t1.n, 1);

  const { tree: t2 } = await cache.getTree('a', build, { now: () => now + 1 });
  assert.equal(t2.n, 1, 'same key within TTL reuses the cached tree');

  const { tree: t3 } = await cache.getTree('b', build, { now: () => now + 1 });
  assert.equal(t3.n, 2, 'a different key forces a rebuild');

  now += 30001;
  const { tree: t4 } = await cache.getTree('b', build, { now: () => now });
  assert.equal(t4.n, 3, 'TTL elapsed forces a rebuild');
});

test('createTreeCache: invalidate() forces a rebuild even inside the TTL', async () => {
  const cache = createTreeCache();
  let builds = 0;
  const build = () => { builds++; return { tree: { n: builds }, roots: null }; };

  await cache.getTree('a', build);
  cache.invalidate();
  const { tree } = await cache.getTree('a', build);
  assert.equal(tree.n, 2);
});

test('createTreeCache: no store is built when the build result has no roots (e.g. unknown agent)', async () => {
  const cache = createTreeCache();
  const { tree, store } = await cache.getTree('x', () => ({ tree: null, roots: null }));
  assert.equal(tree, null);
  assert.equal(store, null);
});
