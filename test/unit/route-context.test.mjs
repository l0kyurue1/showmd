import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseRouteContext, formatRouteContext } = require('../../server/route-context.js');

const rootKey = 'r_0123456789abcdefghij_A';
const otherRootKey = 'r_ABCDEFGHIJ-klmnopqrstu';

test('home and root routes round trip through their canonical URLs', () => {
  const contexts = [
    { space: 'home' },
    { space: 'root', rootKey },
    { space: 'root', rootKey, scopePath: 'packages/docs' },
    {
      space: 'root',
      rootKey,
      scopePath: 'packages/docs',
      documentPath: 'packages/docs/getting started.md',
    },
    { space: 'root', rootKey, documentPath: 'guides/getting started.md' },
  ];

  for (const context of contexts) {
    const route = formatRouteContext(context);
    assert.deepEqual(parseRouteContext(route), context);
  }

  assert.equal(formatRouteContext({ space: 'home' }), '/home/');
  assert.equal(formatRouteContext({ space: 'root', rootKey }), `/r/${rootKey}/`);
});

test('root documents encode and decode each path segment independently', () => {
  const documentPaths = [
    'space name.md',
    'hash # percent %.markdown',
    'query ? mark.MD',
    '資料/café.md',
  ];

  for (const documentPath of documentPaths) {
    const context = { space: 'root', rootKey, documentPath };
    assert.deepEqual(parseRouteContext(formatRouteContext(context)), context);
  }

  assert.equal(
    formatRouteContext({ space: 'root', rootKey, documentPath: '資料/hash #?.MD' }),
    `/r/${rootKey}/%E8%B3%87%E6%96%99/hash%20%23%3F.MD`,
  );
});

test('skills round trips each discriminated selection and opaque document routes', () => {
  const contexts = [
    { space: 'skills', selection: 'global' },
    { space: 'skills', selection: 'all', documentRoute: 'built in/Skill #1.markdown' },
    { space: 'skills', selection: 'root', rootKey, documentRoute: 'project/資料.MD' },
    { space: 'skills', selection: 'context', contextKey: 'ctx_opaque-%-key' },
  ];

  for (const context of contexts) {
    assert.deepEqual(parseRouteContext(formatRouteContext(context)), context);
  }

  assert.equal(formatRouteContext(contexts[0]), '/skills/');
  assert.equal(
    formatRouteContext(contexts[1]),
    '/skills/built%20in/Skill%20%231.markdown?scope=all',
  );
  assert.equal(
    formatRouteContext(contexts[2]),
    `/skills/project/%E8%B3%87%E6%96%99.MD?root=${rootKey}`,
  );
  assert.equal(
    formatRouteContext(contexts[3]),
    '/skills/?context=ctx_opaque-%25-key',
  );
});

test('agents and settings round trip their optional root selection', () => {
  const contexts = [
    { space: 'agents', agentKey: 'Claude Code' },
    { space: 'agents', agentKey: 'Claude Code', rootKey, documentRoute: 'rules/AGENTS.md' },
    { space: 'settings' },
    { space: 'settings', rootKey },
  ];

  for (const context of contexts) {
    assert.deepEqual(parseRouteContext(formatRouteContext(context)), context);
  }

  assert.equal(formatRouteContext(contexts[0]), '/agents/Claude%20Code/');
  assert.equal(formatRouteContext(contexts[2]), '/settings/');
});

test('parsing accepts slash variants and formatting canonicalizes them', () => {
  assert.deepEqual(parseRouteContext('/home'), { space: 'home' });
  assert.deepEqual(parseRouteContext(`/r/${rootKey}`), { space: 'root', rootKey });
  assert.deepEqual(parseRouteContext('/settings?lab'), { space: 'settings' });
});

test('root scope is segment-safe and independent from the selected document', () => {
  assert.deepEqual(
    parseRouteContext(`/r/${rootKey}/guide.md?scope=packages%2Fdocs%20site`),
    { space: 'root', rootKey, scopePath: 'packages/docs site', documentPath: 'guide.md' },
  );
  assert.equal(
    formatRouteContext({ space: 'root', rootKey, scopePath: '資料/docs site' }),
    `/r/${rootKey}/?scope=%E8%B3%87%E6%96%99%2Fdocs+site`,
  );
});

test('semantic query parameters reject duplicates, conflicts, and unsupported selectors', () => {
  const invalidRoutes = [
    '/home/?root=x',
    `/r/${rootKey}/?scope=docs&scope=other`,
    `/r/${rootKey}/?root=${otherRootKey}`,
    '/skills/?scope=all&scope=all',
    '/skills/?scope=global',
    `/skills/?scope=all&root=${rootKey}`,
    `/skills/?root=${rootKey}&context=ctx_one`,
    `/skills/?root=${rootKey}&root=${otherRootKey}`,
    '/skills/?context=',
    `/agents/claude/?root=${rootKey}&root=${otherRootKey}`,
    '/agents/claude/?context=ctx_one',
    `/settings/?scope=all`,
    '/settings/?ignored=true',
  ];

  for (const route of invalidRoutes) assert.equal(parseRouteContext(route), null, route);
});

test('dot and separator path segments are rejected by parsing and formatting', () => {
  const invalidRoutes = [
    `/r/${rootKey}/docs/%2E%2E/secret.md`,
    `/r/${rootKey}/?scope=docs%2F..`,
    '/skills/%2E/',
    '/skills/good/%2E%2E/bad.md',
    '/agents/claude/%2E%2E/AGENTS.md',
  ];
  for (const route of invalidRoutes) assert.equal(parseRouteContext(route), null, route);

  const invalidContexts = [
    { space: 'root', rootKey, scopePath: 'docs/..' },
    { space: 'root', rootKey, documentPath: './README.md' },
    { space: 'skills', selection: 'global', documentRoute: '../SKILL.md' },
    { space: 'agents', agentKey: '.', documentRoute: 'AGENTS.md' },
  ];
  for (const context of invalidContexts) {
    assert.throws(() => formatRouteContext(context), TypeError);
  }
});

test('malformed encodings, malformed routes, and invalid root keys are rejected', () => {
  const invalidRoutes = [
    '/',
    '/unknown/',
    '/home/extra',
    '/r/',
    '/r/not-a-root/note.md',
    `/r/${rootKey}/bad%encoding.md`,
    `/r/${rootKey}/encoded%2Fslash.md`,
    `/skills/doc.md?root=bad-key`,
    '/agents/',
    `/settings/extra?root=${rootKey}`,
  ];

  for (const route of invalidRoutes) assert.equal(parseRouteContext(route), null, route);
});

test('formatting rejects invalid or incomplete contexts', () => {
  const invalidContexts = [
    { space: 'root', rootKey: 'bad-key' },
    { space: 'root', rootKey, documentPath: '' },
    { space: 'skills', selection: 'root', rootKey: 'bad-key' },
    { space: 'skills', selection: 'context', contextKey: '' },
    { space: 'skills', selection: 'unknown' },
    { space: 'agents', agentKey: '' },
    { space: 'settings', rootKey: 'bad-key' },
    { space: 'unknown' },
  ];

  for (const context of invalidContexts) {
    assert.throws(() => formatRouteContext(context), TypeError);
  }
});
