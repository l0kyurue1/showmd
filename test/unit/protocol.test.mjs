import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getInstanceMetadata,
  orderRegistry,
  shapeVersionResponse,
} = require('../../server/protocol.js');

test('instance metadata is generated once for the process', () => {
  const first = getInstanceMetadata();
  const second = getInstanceMetadata();

  assert.strictEqual(second, first);
  assert.match(first.instanceId, /^[0-9a-f-]{36}$/);
  assert.equal(new Date(first.startedAt).toISOString(), first.startedAt);
  assert.equal(Object.isFrozen(first), true);
});

test('version response shapes core fields and requires an explicit mode', () => {
  const metadata = Object.freeze({ instanceId: 'instance-a', startedAt: '2026-08-06T12:00:00.000Z' });
  assert.deepEqual(shapeVersionResponse({
    version: '0.1.3',
    launcher: true,
    actualPort: 4400,
    mode: 'dedicated',
    capabilities: [],
  }, metadata), {
    version: '0.1.3',
    launcher: true,
    protocol: 1,
    instanceId: 'instance-a',
    startedAt: '2026-08-06T12:00:00.000Z',
    actualPort: 4400,
    mode: 'dedicated',
    capabilities: [],
  });

  assert.throws(() => shapeVersionResponse({ actualPort: 4400 }), /mode/);
  assert.throws(
    () => shapeVersionResponse({ actualPort: 4400, mode: 'shared', capabilities: ['future-v1'] }),
    /capability/,
  );
});

test('registry ordering follows compatible mode, configured port, start time, and stable ties', () => {
  const candidates = [
    { protocol: 2, mode: 'shared', actualPort: 4400, startedAt: '2026-01-01T00:00:00.000Z', instanceId: 'wrong-protocol' },
    { protocol: 1, mode: 'dedicated', actualPort: 4400, startedAt: '2026-01-01T00:00:00.000Z', instanceId: 'dedicated' },
    { protocol: 1, mode: 'shared', actualPort: 4402, startedAt: '2026-02-01T00:00:00.000Z', instanceId: 'later' },
    { protocol: 1, mode: 'shared', actualPort: 4401, startedAt: '2026-03-01T00:00:00.000Z', instanceId: 'configured' },
    { protocol: 1, mode: 'shared', actualPort: 4403, startedAt: '2026-02-01T00:00:00.000Z', instanceId: 'alpha' },
    { protocol: 1, mode: 'shared', actualPort: 4404, startedAt: '2026-02-01T00:00:00.000Z', instanceId: 'alpha' },
  ];

  assert.deepEqual(
    orderRegistry(candidates, { configuredPort: 4401 }).map(({ actualPort }) => actualPort),
    [4401, 4403, 4404, 4402],
  );
  assert.deepEqual(candidates.map(({ actualPort }) => actualPort), [4400, 4400, 4402, 4401, 4403, 4404]);
});
