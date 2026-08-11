'use strict';

const { randomUUID } = require('node:crypto');

const PROTOCOL_VERSION = 1;
const CAPABILITIES = Object.freeze({
  ROOTS_V1: 'roots-v1',
  SPACES_V1: 'spaces-v1',
});
const KNOWN_CAPABILITIES = Object.freeze(Object.values(CAPABILITIES));
const KNOWN_CAPABILITY_SET = new Set(KNOWN_CAPABILITIES);
const MODES = new Set(['shared', 'dedicated']);
// a process not told otherwise is reusable by other consumers; only an
// explicit --new/--port/ancestor-conflict boot opts into 'dedicated'
const DEFAULT_MODE = 'shared';

const INSTANCE_METADATA = Object.freeze({
  instanceId: process.env.SHOWMD_INSTANCE_ID || randomUUID(),
  startedAt: new Date().toISOString(),
});

function getInstanceMetadata() {
  return INSTANCE_METADATA;
}

function shapeVersionResponse({
  version,
  launcher,
  actualPort,
  mode,
  capabilities = [],
}, metadata = INSTANCE_METADATA) {
  if (!MODES.has(mode)) throw new TypeError('mode must be shared or dedicated');
  if (!Number.isInteger(actualPort) || actualPort < 1 || actualPort > 65535) {
    throw new TypeError('actualPort must be a listening TCP port');
  }
  if (!Array.isArray(capabilities)
    || new Set(capabilities).size !== capabilities.length
    || capabilities.some((capability) => !KNOWN_CAPABILITY_SET.has(capability))) {
    throw new TypeError('capabilities must contain unique known capability names');
  }
  return {
    version,
    launcher,
    protocol: PROTOCOL_VERSION,
    instanceId: metadata.instanceId,
    startedAt: metadata.startedAt,
    actualPort,
    mode,
    capabilities: [...capabilities],
  };
}

function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// Canonical registry order lets every consumer select the first entry.
function orderRegistry(candidates, {
  configuredPort,
  protocol = PROTOCOL_VERSION,
} = {}) {
  return candidates
    .filter((candidate) => candidate?.protocol === protocol && candidate.mode === 'shared')
    .slice()
    .sort((a, b) => {
      const aConfigured = a.actualPort === configuredPort;
      const bConfigured = b.actualPort === configuredPort;
      if (aConfigured !== bConfigured) return aConfigured ? -1 : 1;

      const aStarted = Date.parse(a.startedAt);
      const bStarted = Date.parse(b.startedAt);
      const startOrder = (Number.isNaN(aStarted) ? Infinity : aStarted)
        - (Number.isNaN(bStarted) ? Infinity : bStarted);
      if (startOrder) return startOrder;

      const instanceOrder = compareText(String(a.instanceId), String(b.instanceId));
      if (instanceOrder) return instanceOrder;
      return Number(a.actualPort) - Number(b.actualPort);
    });
}

module.exports = {
  CAPABILITIES,
  DEFAULT_MODE,
  KNOWN_CAPABILITIES,
  PROTOCOL_VERSION,
  getInstanceMetadata,
  orderRegistry,
  shapeVersionResponse,
};
