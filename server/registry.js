'use strict';
const http = require('node:http');
const ports = require('./ports.js');
const { orderRegistry } = require('./protocol.js');

// Raw probes identify showmd by version without protocol compatibility filtering.
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

// Every server reads and orders the shared registry identically.
async function discoverRegistry({ configuredPort } = {}) {
  const entries = await ports.list();
  const candidates = (await Promise.all(entries.map((e) => probeVersion(e.port)))).filter(Boolean);
  return orderRegistry(candidates, { configuredPort });
}

module.exports = { probeVersion, discoverRegistry };
