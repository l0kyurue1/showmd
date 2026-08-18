import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAgentWithContent } from '../../../client/agent-picker.js';

test('pickAgentWithContent: default agent has groups -> picks it without probing further', async () => {
  const calls = [];
  const fetchTree = async (key) => {
    calls.push(key);
    return { groups: [{ name: 'Instructions' }], agents: [{ key: 'claude', detected: true }, { key: 'codex', detected: true }] };
  };
  const result = await pickAgentWithContent('claude', fetchTree);
  assert.deepEqual(result, { key: 'claude', data: await fetchTree('claude') });
  assert.deepEqual(calls, ['claude', 'claude'], 'only the default was probed (second call is the assertion re-fetch)');
});

test('pickAgentWithContent: default empty, a later detected agent has groups -> picks that one', async () => {
  const trees = {
    claude: { groups: [], agents: [{ key: 'claude', detected: false }, { key: 'codex', detected: true }] },
    codex: { groups: [{ name: 'Instructions' }] },
  };
  const calls = [];
  const fetchTree = async (key) => { calls.push(key); return trees[key]; };
  const result = await pickAgentWithContent('claude', fetchTree);
  assert.equal(result.key, 'codex');
  assert.deepEqual(calls, ['claude', 'codex']);
});

test('pickAgentWithContent: undetected candidates are skipped', async () => {
  const trees = {
    claude: { groups: [], agents: [{ key: 'claude', detected: false }, { key: 'codex', detected: false }] },
  };
  const fetchTree = async (key) => trees[key] || null;
  const result = await pickAgentWithContent('claude', fetchTree);
  assert.equal(result, null);
});

test('pickAgentWithContent: every agent empty -> null, no notice decision made here', async () => {
  const trees = {
    claude: { groups: [], agents: [{ key: 'claude', detected: true }, { key: 'codex', detected: true }] },
    codex: { groups: [] },
  };
  const fetchTree = async (key) => trees[key];
  const result = await pickAgentWithContent('claude', fetchTree);
  assert.equal(result, null);
});
