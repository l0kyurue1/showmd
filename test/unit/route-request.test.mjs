import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const { readJsonBody, readRawBody, rootInfo, resolveContext } = require('../../server/route-request.js');

function reqWith(chunks) {
  return Readable.from(chunks);
}

test('readJsonBody: parses a valid JSON body', async () => {
  const result = await readJsonBody(reqWith([Buffer.from('{"a":1}')]));
  assert.deepEqual(result, { ok: true, body: { a: 1 } });
});

test('readJsonBody: empty body resolves to {}', async () => {
  const result = await readJsonBody(reqWith([]));
  assert.deepEqual(result, { ok: true, body: {} });
});

test('readJsonBody: malformed JSON fails', async () => {
  const result = await readJsonBody(reqWith([Buffer.from('{not json')]));
  assert.deepEqual(result, { ok: false });
});

test('readRawBody: concatenates chunks into a single buffer', async () => {
  const result = await readRawBody(reqWith([Buffer.from('ab'), Buffer.from('cd')]));
  assert.equal(result.toString('utf8'), 'abcd');
});

test('rootInfo: rootless roots omit dir/name', () => {
  const info = rootInfo([]);
  assert.deepEqual(info, { dir: null, launchedFrom: 'terminal' });
});

test('rootInfo: rooted server reports dir + basename', () => {
  const info = rootInfo([{ key: null, dir: '/tmp/some-project' }]);
  assert.deepEqual(info, { dir: '/tmp/some-project', name: 'some-project', launchedFrom: 'terminal' });
});

test('resolveContext: needs store, missing store fails with no_root', async () => {
  const route = { needs: ['store'] };
  const result = await resolveContext(route, { id: 'a.md' }, { pickStore: async () => null });
  assert.deepEqual(result, { ok: false, error: 'no_root' });
});

test('resolveContext: needs store, resolved store attaches to context', async () => {
  const store = { read: () => {} };
  const route = { needs: ['store'] };
  const result = await resolveContext(route, { id: 'a.md' }, { pickStore: async () => store });
  assert.equal(result.ok, true);
  assert.equal(result.ctx.store, store);
});

test('resolveContext: needs body, malformed JSON fails with invalid_json', async () => {
  const route = { needs: ['body'] };
  const base = { req: reqWith([Buffer.from('{bad')]) };
  const result = await resolveContext(route, base, { pickStore: async () => null });
  assert.deepEqual(result, { ok: false, error: 'invalid_json' });
});

test('resolveContext: no needs passes the base context through unchanged', async () => {
  const route = {};
  const base = { pathname: '/api/version' };
  const result = await resolveContext(route, base, { pickStore: async () => null });
  assert.deepEqual(result, { ok: true, ctx: { pathname: '/api/version' } });
});

test('resolveContext: needs both body and rawBody, both resolve from a single read of req', async () => {
  const route = { needs: ['body', 'rawBody'] };
  const base = { req: reqWith([Buffer.from('{"a":1}')]) };
  const result = await resolveContext(route, base, { pickStore: async () => null });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ctx.body, { a: 1 });
  assert.equal(result.ctx.rawBody.toString('utf8'), '{"a":1}');
});
