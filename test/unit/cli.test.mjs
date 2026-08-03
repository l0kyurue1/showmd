import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatPortWarning } = require('../../bin/cli.js');

test('formatPortWarning: includes port, version and pid', () => {
  assert.equal(formatPortWarning(4321, '0.1.0', '86136'), 'showmd: port 4321 is held by showmd 0.1.0 (pid 86136)');
});

test('formatPortWarning: omits the pid parens when pid is not obtainable', () => {
  assert.equal(formatPortWarning(4321, '0.1.0', null), 'showmd: port 4321 is held by showmd 0.1.0');
});
