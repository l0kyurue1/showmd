import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findRoute, broadcastSSE } = require('../../server/server.js');

function fakeRoutes() {
  return [
    { method: 'GET', match: (pathname) => pathname === '/api/tree', handler: 'tree' },
    { method: 'PUT', match: (pathname) => pathname === '/api/raw', handler: 'raw-put' },
    { method: 'GET', match: (pathname) => pathname === '/api/raw', handler: 'raw-get' },
    { method: 'GET', match: (pathname) => pathname.startsWith('/assets/'), handler: 'assets' },
    { method: 'GET', match: () => true, handler: 'shell' },
  ];
}

test('findRoute: exact method + path match', () => {
  const route = findRoute(fakeRoutes(), 'GET', '/api/tree', new URL('http://x/api/tree'));
  assert.equal(route.handler, 'tree');
});

test('findRoute: same path, different method resolves independently', () => {
  const routes = fakeRoutes();
  assert.equal(findRoute(routes, 'PUT', '/api/raw', new URL('http://x/api/raw')).handler, 'raw-put');
  assert.equal(findRoute(routes, 'GET', '/api/raw', new URL('http://x/api/raw')).handler, 'raw-get');
});

test('findRoute: prefix match', () => {
  const route = findRoute(fakeRoutes(), 'GET', '/assets/app.js', new URL('http://x/assets/app.js'));
  assert.equal(route.handler, 'assets');
});

test('findRoute: unmatched method + path falls through to catch-all', () => {
  const route = findRoute(fakeRoutes(), 'GET', '/nope', new URL('http://x/nope'));
  assert.equal(route.handler, 'shell');
});

test('findRoute: unmatched method with no catch-all returns null (404)', () => {
  const routes = fakeRoutes().slice(0, -1);
  assert.equal(findRoute(routes, 'DELETE', '/api/tree', new URL('http://x/api/tree')), null);
});

test('broadcastSSE: writes SSE-formatted payload to every client', () => {
  const writes = [];
  const clients = [{ write: (chunk) => writes.push(chunk) }, { write: (chunk) => writes.push(chunk) }];
  broadcastSSE(clients, { path: 'a.md', event: 'change' });
  const expected = `data: ${JSON.stringify({ path: 'a.md', event: 'change' })}\n\n`;
  assert.deepEqual(writes, [expected, expected]);
});

test('broadcastSSE: a client whose write throws does not stop the rest', () => {
  const writes = [];
  const clients = [
    { write: () => { throw new Error('closed'); } },
    { write: (chunk) => writes.push(chunk) },
  ];
  assert.throws(() => broadcastSSE(clients, { event: 'x' }));
  assert.deepEqual(writes, []);
});
