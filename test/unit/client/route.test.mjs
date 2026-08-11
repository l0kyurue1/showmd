import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseRouteContext, formatRouteContext, isMarkdownPath } from '../../../client/route.js';

const require = createRequire(import.meta.url);
const server = require('../../../server/route-context.js');
const { isMarkdownFile } = require('../../../server/documents.js');

const rootKey = 'r_0123456789abcdefghij_A';
const otherRootKey = 'r_ABCDEFGHIJ-klmnopqrstu';

// Shared case table: every entry is checked identically against the client
// twin and the server original, so the two parsers cannot silently diverge.
const VALID_ROUTES = [
  '/home',
  '/home/',
  `/r/${rootKey}`,
  `/r/${rootKey}/`,
  `/r/${rootKey}/guide.md`,
  `/r/${rootKey}/space name.md`,
  `/r/${rootKey}/hash # percent %.markdown`,
  `/r/${rootKey}/query ? mark.MD`,
  `/r/${rootKey}/資料/café.md`,
  `/r/${rootKey}/guide.md?scope=packages%2Fdocs%20site`,
  `/r/${rootKey}/?scope=%E8%B3%87%E6%96%99%2Fdocs+site`,
  '/settings',
  '/settings/',
  `/settings/?root=${rootKey}`,
  '/skills/',
  '/skills/?scope=all',
  `/skills/?root=${rootKey}`,
  '/skills/?context=ctx_opaque-%-key',
  '/skills/built%20in/Skill%20%231.markdown?scope=all',
  `/skills/project/%E8%B3%87%E6%96%99.MD?root=${rootKey}`,
  '/agents/Claude%20Code/',
  `/agents/Claude%20Code/rules/AGENTS.md?root=${rootKey}`,
];

const INVALID_ROUTES = [
  '/',
  '/unknown/',
  '/home/extra',
  '/home/?root=x',
  '/r/',
  '/r/not-a-root/note.md',
  `/r/${rootKey}/bad%encoding.md`,
  `/r/${rootKey}/encoded%2Fslash.md`,
  `/r/${rootKey}/?scope=docs&scope=other`,
  `/r/${rootKey}/?root=${otherRootKey}`,
  `/r/${rootKey}/docs/%2E%2E/secret.md`,
  `/r/${rootKey}/?scope=docs%2F..`,
  '/skills/?scope=all&scope=all',
  '/skills/?scope=global',
  `/skills/?scope=all&root=${rootKey}`,
  `/skills/?root=${rootKey}&context=ctx_one`,
  `/skills/?root=${rootKey}&root=${otherRootKey}`,
  '/skills/?context=',
  '/skills/%2E/',
  '/skills/good/%2E%2E/bad.md',
  `/skills/doc.md?root=bad-key`,
  '/agents/',
  '/agents/claude/%2E%2E/AGENTS.md',
  `/agents/claude/?root=${rootKey}&root=${otherRootKey}`,
  '/agents/claude/?context=ctx_one',
  `/settings/?scope=all`,
  '/settings/?ignored=true',
  `/settings/extra?root=${rootKey}`,
];

const VALID_CONTEXTS = [
  { space: 'home' },
  { space: 'root', rootKey },
  { space: 'root', rootKey, scopePath: 'packages/docs' },
  { space: 'root', rootKey, documentPath: 'guides/getting started.md' },
  { space: 'root', rootKey, scopePath: '資料/docs site' },
  { space: 'root', rootKey, documentPath: '資料/hash #?.MD' },
  { space: 'skills', selection: 'global' },
  { space: 'skills', selection: 'all', documentRoute: 'built in/Skill #1.markdown' },
  { space: 'skills', selection: 'root', rootKey, documentRoute: 'project/資料.MD' },
  { space: 'skills', selection: 'context', contextKey: 'ctx_opaque-%-key' },
  { space: 'agents', agentKey: 'Claude Code' },
  { space: 'agents', agentKey: 'Claude Code', rootKey, documentRoute: 'rules/AGENTS.md' },
  { space: 'settings' },
  { space: 'settings', rootKey },
];

const INVALID_CONTEXTS = [
  { space: 'root', rootKey: 'bad-key' },
  { space: 'root', rootKey, documentPath: '' },
  { space: 'root', rootKey, scopePath: 'docs/..' },
  { space: 'root', rootKey, documentPath: './README.md' },
  { space: 'skills', selection: 'root', rootKey: 'bad-key' },
  { space: 'skills', selection: 'context', contextKey: '' },
  { space: 'skills', selection: 'unknown' },
  { space: 'skills', selection: 'global', documentRoute: '../SKILL.md' },
  { space: 'agents', agentKey: '' },
  { space: 'agents', agentKey: '.', documentRoute: 'AGENTS.md' },
  { space: 'settings', rootKey: 'bad-key' },
  { space: 'unknown' },
];

test('parseRouteContext matches server/route-context.js for every valid route', () => {
  for (const route of VALID_ROUTES) {
    assert.deepEqual(parseRouteContext(route), server.parseRouteContext(route), route);
  }
});

test('parseRouteContext matches server/route-context.js for every invalid route', () => {
  for (const route of INVALID_ROUTES) {
    assert.equal(parseRouteContext(route), null, route);
    assert.equal(server.parseRouteContext(route), null, route);
  }
});

test('formatRouteContext matches server/route-context.js for every valid context', () => {
  for (const context of VALID_CONTEXTS) {
    assert.equal(formatRouteContext(context), server.formatRouteContext(context), JSON.stringify(context));
  }
});

test('formatRouteContext round-trips through parseRouteContext', () => {
  for (const context of VALID_CONTEXTS) {
    assert.deepEqual(parseRouteContext(formatRouteContext(context)), context);
  }
});

test('formatRouteContext matches server/route-context.js rejection for every invalid context', () => {
  for (const context of INVALID_CONTEXTS) {
    assert.throws(() => formatRouteContext(context), TypeError, JSON.stringify(context));
    assert.throws(() => server.formatRouteContext(context), TypeError, JSON.stringify(context));
  }
});

test('parseRouteContext accepts a URL instance carrying the original, undecoded pathname', () => {
  const url = new URL(`http://localhost/r/${rootKey}/space%20name.md`);
  assert.deepEqual(parseRouteContext(url), { space: 'root', rootKey, documentPath: 'space name.md' });
  assert.deepEqual(parseRouteContext(url), server.parseRouteContext(url));
});

test('parseRouteContext rejects an encoded %2F rather than treating it as a segment separator', () => {
  const encoded = `/r/${rootKey}/a%2Fb.md`;
  assert.equal(parseRouteContext(encoded), null);
  assert.equal(server.parseRouteContext(encoded), null);
});

test('parseRouteContext does not collapse a pre-decoded pathname the way an outer router would', () => {
  // If a caller decodes the pathname before handing it here (conflict #23),
  // 'a/b.md' becomes two ordinary segments instead of being rejected.
  const preDecoded = `/r/${rootKey}/a/b.md`;
  assert.deepEqual(parseRouteContext(preDecoded), { space: 'root', rootKey, documentPath: 'a/b.md' });
});

test('isMarkdownPath matches server documents.js isMarkdownFile across the shared grammar', () => {
  const paths = [
    'README.md', 'README.MD', 'notes.markdown', 'notes.MARKDOWN',
    'no-extension', 'image.png', 'file.mdx', 'a/b/c.md', '',
  ];
  for (const p of paths) {
    assert.equal(isMarkdownPath(p), isMarkdownFile(p), p);
  }
});
