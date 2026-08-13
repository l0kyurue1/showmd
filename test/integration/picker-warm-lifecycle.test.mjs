import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import '../helpers/isolate-state.mjs';

const require = createRequire(import.meta.url);
const { createServer } = require('../../server/server.js');

// Regression: server shutdown must own picker warm-up. The macOS helper
// build (osacompile and friends) kept writing into HOME after the CLI
// exited, so external cleanup of that directory raced it (ENOTEMPTY).
test('server.whenClosed() waits for a pending picker warm-up', async () => {
  let resolveWarm;
  const warm = new Promise((resolve) => { resolveWarm = resolve; });
  const server = createServer(null, {
    platform: 'darwin',
    warmPickerOnStart: true,
    folderPickerFactory: () => ({ warm: () => warm, pick: async () => null }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.close();

  let closed = false;
  const whenClosed = server.whenClosed().then(() => { closed = true; });
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, 'whenClosed must stay pending while warm-up is pending');

  resolveWarm();
  await whenClosed;
});

test('a rejected warm-up still lets the server close', async () => {
  const server = createServer(null, {
    platform: 'darwin',
    warmPickerOnStart: true,
    folderPickerFactory: () => ({ warm: () => Promise.reject(new Error('no osacompile')), pick: async () => null }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.close();
  await server.whenClosed();
});
