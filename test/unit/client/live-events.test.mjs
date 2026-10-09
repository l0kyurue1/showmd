import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerConnection } from '../../../client/live-events.js';

function setup() {
  const instances = [];
  class FakeEventSource {
    constructor(url) { this.url = url; instances.push(this); }
  }
  const reports = [];
  let reconnected = 0;
  const connection = createServerConnection({
    EventSource: FakeEventSource,
    followRestart: async () => ({ ok: true }),
    location: { pathname: '/', search: '', hash: '' },
    report: (...args) => reports.push(args),
    lostHint: 'hint',
    onReconnected: () => { reconnected += 1; },
    onEvent: async () => {},
  });
  connection.connect();
  return { es: instances[0], reports, reconnected: () => reconnected };
}

test('repeated errors while lost report once; an open without a prior loss does not call onReconnected', () => {
  const { es, reports, reconnected } = setup();

  es.onopen();
  assert.equal(reconnected(), 0);

  es.onerror();
  es.onerror();
  assert.deepEqual(reports, [['error', 'Connection lost', 'hint']]);

  es.onopen();
  assert.equal(reconnected(), 1);
});

test('a loss after a reconnect reports Connection lost again', () => {
  const { es, reports } = setup();

  es.onerror();
  es.onopen();
  es.onerror();

  assert.equal(reports.length, 2);
  assert.deepEqual(reports[1], ['error', 'Connection lost', 'hint']);
});
