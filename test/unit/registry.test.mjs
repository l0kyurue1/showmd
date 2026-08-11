import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { probeVersion } = require('../../server/registry.js');

function withFakeServer(body, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    srv.listen(0, '127.0.0.1', async () => {
      try {
        await fn(srv.address().port);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        srv.close();
      }
    });
  });
}

test('probeVersion: a JSON body with a string version is trusted verbatim, unfiltered by protocol or mode', async () => {
  await withFakeServer({ version: '0.0.0-old', launcher: true }, async (port) => {
    const hit = await probeVersion(port);
    assert.deepEqual(hit, { version: '0.0.0-old', launcher: true });
  });
});

test('probeVersion: no listener resolves null instead of throwing', async () => {
  const hit = await probeVersion(1);
  assert.equal(hit, null);
});

test('probeVersion: a non-JSON or version-less body resolves null', async () => {
  await withFakeServer({ not: 'showmd' }, async (port) => {
    const hit = await probeVersion(port);
    assert.equal(hit, null);
  });
});
