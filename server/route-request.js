'use strict';
const path = require('node:path');

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseJsonBody(raw) {
  if (!raw.length) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

async function readJsonBody(req) {
  return parseJsonBody(await readRawBody(req));
}

function rootInfo(roots) {
  const launchedFrom = process.env.SHOWMD_LAUNCHED_FROM || 'terminal';
  if (roots.length === 0) return { dir: null, launchedFrom };
  return { dir: roots[0].dir, name: path.basename(roots[0].dir), launchedFrom };
}

// Resolve declared route needs; callers map unmet needs to HTTP errors.
async function resolveContext(route, base) {
  const ctx = { ...base };
  const needs = route.needs || [];
  // Read the request stream once when a route needs body and rawBody.
  if (needs.includes('body') || needs.includes('rawBody')) {
    const raw = await readRawBody(base.req);
    if (needs.includes('rawBody')) ctx.rawBody = raw;
    if (needs.includes('body')) {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) return { ok: false, error: 'invalid_json' };
      ctx.body = parsed.body;
    }
  }
  return { ok: true, ctx };
}

module.exports = { readRawBody, readJsonBody, rootInfo, resolveContext };
