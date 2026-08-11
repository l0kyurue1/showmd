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

// resolves everything a route's `needs` asks for onto a context object handed
// to the handler, so every route stops re-implementing body-parse and
// store-lookup boilerplate. Returns { ok:false, error: <ERROR_STATUS code> }
// on the first unmet need, leaving status/message mapping to the caller's
// sendError (route-request.js has no opinion on HTTP status codes).
async function resolveContext(route, base) {
  const ctx = { ...base };
  const needs = route.needs || [];
  // both 'body' and 'rawBody' read the same request stream, which yields
  // nothing on a second pass — read it once and derive both from it, so a
  // route that declares both can never hang or see an empty second read.
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
