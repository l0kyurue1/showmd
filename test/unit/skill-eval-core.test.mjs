import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { claudeAdapter } from '../skill-evals/showmd/adapters/claude.mjs';
import { codexAdapter } from '../skill-evals/showmd/adapters/codex.mjs';
import { piAdapter } from '../skill-evals/showmd/adapters/pi.mjs';
import {
  evaluateBehavior,
  parseCommandTrace,
  readResumeState,
  readyUrl,
} from '../skill-evals/showmd/eval-core.mjs';

test('agent adapters expose the shared runtime contract', () => {
  for (const adapter of [codexAdapter, claudeAdapter, piAdapter]) {
    assert.equal(typeof adapter.id, 'string');
    for (const method of ['setup', 'preflight', 'authenticate', 'invocation', 'parseOutput']) {
      assert.equal(typeof adapter[method], 'function', `${adapter.id}.${method}`);
    }
  }
});

test('shared assertions evaluate normalized command traces', () => {
  const testCase = {
    expectation: 'invoke',
    expectedCommand: '(?:^|/)README\\.md$',
    responsePattern: '-',
  };
  const result = evaluateBehavior(testCase, {
    assistantText: `The preview is ready at ${readyUrl}`,
    exitCode: 0,
  }, '/tmp/workspace/README.md');

  assert.equal(result.passed, true);
  assert.deepEqual(result.commands, [{
    matchText: '/tmp/workspace/README.md',
    program: 'showmd',
    raw: '/tmp/workspace/README.md',
    rawArgs: '/tmp/workspace/README.md',
  }]);
});

test('shared command trace rejects global installation without shell-specific parsing', () => {
  const commands = parseCommandTrace('npm install --global showmd-cli\n');
  assert.equal(commands[0].program, 'npm');
  assert.equal(commands[0].rawArgs, 'install --global showmd-cli');
});

test('Pi adapter normalizes final assistant messages and cumulative usage', () => {
  const output = [
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Opening the preview.' }],
        usage: {
          input: 100,
          output: 20,
          cacheRead: 30,
          cacheWrite: 4,
          cost: { total: 0 },
        },
      },
    }),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: readyUrl }],
        usage: {
          input: 50,
          output: 10,
          cacheRead: 5,
          cacheWrite: 0,
          cost: { total: 0 },
        },
      },
    }),
  ].join('\n');

  const result = piAdapter.parseOutput(output);
  assert.equal(result.assistantText, `Opening the preview.\n${readyUrl}`);
  assert.equal(result.usage.inputTokens, 189);
  assert.equal(result.usage.outputTokens, 30);
  assert.equal(result.usage.cachedInputTokens, 39);
  assert.equal(result.usage.costUsd, 0);
  assert.equal(result.usage.source, 'reported');
});

test('resume state restores completed trials, failures, and consumed budget', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'showmd-eval-core-test-'));
  const manifest = path.join(directory, 'results.jsonl');
  writeFileSync(manifest, [
    JSON.stringify({ agent: 'pi', caseId: '01', model: 'local', trial: 1, behaviorStatus: 'PASS', usage: { inputTokens: 100 } }),
    JSON.stringify({ agent: 'pi', caseId: '02', model: 'local', trial: 1, behaviorStatus: 'FAIL', usage: { inputTokens: 250 } }),
    JSON.stringify({ type: 'suite_summary', totalInputTokens: 350 }),
    '',
  ].join('\n'));

  try {
    const state = readResumeState(manifest, { agent: 'pi', model: 'local' });
    assert.deepEqual([...state.completedTrials], ['01:1', '02:1']);
    assert.equal(state.behaviorFailed, true);
    assert.equal(state.totalInputTokens, 350);
    assert.equal(state.largestObservedTrial, 250);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('resume state refuses results from another agent or model', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'showmd-eval-core-test-'));
  const manifest = path.join(directory, 'results.jsonl');
  writeFileSync(manifest, `${JSON.stringify({
    agent: 'claude',
    caseId: '01',
    model: 'haiku',
    trial: 1,
    usage: { inputTokens: 100 },
  })}\n`);

  try {
    assert.throws(
      () => readResumeState(manifest, { agent: 'pi', model: 'local' }),
      /does not match/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
