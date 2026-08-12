import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { installSkill, SOURCE } = require('../../server/install-skill.js');

// the registry honours CLAUDE_CONFIG_DIR/CODEX_HOME/XDG_CONFIG_HOME; a
// developer with those set would otherwise leak real dirs into these fixtures
for (const v of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'AUTOHAND_HOME', 'VIBE_HOME', 'HERMES_HOME']) delete process.env[v];

function home() {
  return mkdtempSync(path.join(tmpdir(), 'showmd-skill-home-'));
}

test('installSkill: writes the shipped SKILL.md into the canonical store', () => {
  const h = home();
  try {
    const { canonical, linked } = installSkill({ home: h, cwd: h });
    assert.equal(canonical, path.join(h, '.agents', 'skills', 'showmd'));
    assert.equal(
      readFileSync(path.join(canonical, 'SKILL.md'), 'utf8'),
      readFileSync(path.join(SOURCE, 'SKILL.md'), 'utf8'),
    );
    assert.deepEqual(linked, []);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('installSkill: links the canonical copy into a detected agent dir', () => {
  const h = home();
  try {
    mkdirSync(path.join(h, '.claude'), { recursive: true });
    const { canonical, linked } = installSkill({ home: h, cwd: h });
    const dest = path.join(h, '.claude', 'skills', 'showmd');
    assert.deepEqual(linked.map((l) => l.agent.name), ['claude-code']);
    assert.equal(linked[0].dest, dest);
    assert.equal(lstatSync(dest).isSymbolicLink(), true);
    assert.equal(realpathSync(dest), realpathSync(canonical));
    assert.equal(readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), readFileSync(path.join(SOURCE, 'SKILL.md'), 'utf8'));
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('installSkill: --copy writes real files instead of links', () => {
  const h = home();
  try {
    mkdirSync(path.join(h, '.claude'), { recursive: true });
    installSkill({ home: h, cwd: h, copy: true });
    const dest = path.join(h, '.claude', 'skills', 'showmd');
    assert.equal(lstatSync(dest).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), readFileSync(path.join(SOURCE, 'SKILL.md'), 'utf8'));
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('installSkill: never clobbers a skill directory showmd did not create', () => {
  const h = home();
  try {
    mkdirSync(path.join(h, '.claude'), { recursive: true });
    const dest = path.join(h, '.claude', 'skills', 'showmd');
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'SKILL.md'), 'someone else\n');
    const { linked, skipped } = installSkill({ home: h, cwd: h });
    assert.deepEqual(linked, []);
    assert.deepEqual(skipped.map((s) => [s.agent.name, s.reason]), [['claude-code', 'exists']]);
    assert.equal(readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), 'someone else\n');
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('installSkill: is idempotent and refreshes a stale canonical copy', () => {
  const h = home();
  try {
    mkdirSync(path.join(h, '.claude'), { recursive: true });
    const { canonical } = installSkill({ home: h, cwd: h });
    writeFileSync(path.join(canonical, 'SKILL.md'), 'stale\n');
    writeFileSync(path.join(canonical, 'leftover.md'), 'gone next time\n');
    const second = installSkill({ home: h, cwd: h });
    assert.equal(second.skipped.length, 0);
    assert.deepEqual(second.linked.map((l) => l.agent.name), ['claude-code']);
    assert.equal(readFileSync(path.join(canonical, 'SKILL.md'), 'utf8'), readFileSync(path.join(SOURCE, 'SKILL.md'), 'utf8'));
    assert.equal(existsSync(path.join(canonical, 'leftover.md')), false);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});
