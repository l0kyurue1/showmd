'use strict';
const http = require('node:http');
const ports = require('./ports.js');
const { orderRegistry } = require('./protocol.js');

// raw, unranked: any JSON body with a string `version` counts as a live
// showmd, so callers that need to identify a specific port (e.g. a stale
// takeover check) are not filtered by protocol/mode compatibility here.
function probeVersion(port, { timeout = 300 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/version', timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          resolve(typeof body.version === 'string' ? body : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// the canonical Registry answer: every live server reads the same ports
// directory and applies the same order (server/protocol.js's orderRegistry),
// so any one of them gives every consumer the identical result.
async function discoverRegistry({ configuredPort } = {}) {
  const entries = await ports.list();
  const candidates = (await Promise.all(entries.map((e) => probeVersion(e.port)))).filter(Boolean);
  return orderRegistry(candidates, { configuredPort });
}

module.exports = { probeVersion, discoverRegistry };
