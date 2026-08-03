import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AGENT_REGISTRY = require('../../server/agent-registry.js');

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('AGENT_REGISTRY: only Claude Code and Codex carry agent-config fields', () => {
  const keyed = AGENT_REGISTRY.filter((a) => a.key);
  assert.deepEqual(keyed.map((a) => a.key), ['claude', 'codex']);
  const cursor = AGENT_REGISTRY.find((a) => a.name === 'cursor');
  assert.equal(cursor.key, undefined);
});

test('AGENT_REGISTRY: claude-code detect/globalDir/instructionsFile/rulesDir/projectsDir agree on ~/.claude', () => {
  const home = tmp('showmd-registry-home-');
  try {
    const claude = AGENT_REGISTRY.find((a) => a.name === 'claude-code');
    assert.equal(claude.detect(home), false);
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    assert.equal(claude.detect(home), true);
    assert.equal(claude.globalDir(home), path.join(home, '.claude', 'skills'));
    assert.equal(claude.instructionsFile(home), path.join(home, '.claude', 'CLAUDE.md'));
    assert.equal(claude.rulesDir(home), path.join(home, '.claude', 'rules'));
    assert.equal(claude.projectsDir(home), path.join(home, '.claude', 'projects'));
    assert.equal(claude.configLabel, 'Claude');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('AGENT_REGISTRY: codex detect/instructionsFile agree on ~/.codex, no rules/projects dirs', () => {
  const home = tmp('showmd-registry-home-');
  try {
    const codex = AGENT_REGISTRY.find((a) => a.name === 'codex');
    assert.equal(codex.detect(home), false);
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    assert.equal(codex.detect(home), true);
    assert.equal(codex.instructionsFile(home), path.join(home, '.codex', 'AGENTS.md'));
    assert.equal(codex.rulesDir, null);
    assert.equal(codex.projectsDir, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
