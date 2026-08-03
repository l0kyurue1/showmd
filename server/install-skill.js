'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AGENT_REGISTRY = require('./agent-registry.js');

const SKILL_NAME = 'showmd';
const SOURCE = path.join(__dirname, '..', 'skills', SKILL_NAME);

function canonicalDir(home) {
  return path.join(home, '.agents', 'skills', SKILL_NAME);
}

function installSkill({ home = os.homedir(), cwd = process.cwd(), source = SOURCE, copy = false } = {}) {
  const canonical = canonicalDir(home);
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  fs.rmSync(canonical, { recursive: true, force: true });
  fs.cpSync(source, canonical, { recursive: true });

  const linked = [];
  const skipped = [];
  for (const agent of AGENT_REGISTRY) {
    let detected = false;
    try { detected = !!agent.detect(home, cwd); } catch {}
    if (!detected) continue;

    const dest = path.join(agent.globalDir(home), SKILL_NAME);
    if (path.resolve(dest) === path.resolve(canonical)) continue;

    const existing = fs.lstatSync(dest, { throwIfNoEntry: false });
    // a real directory there is someone else's copy of the skill, not ours to
    // replace; only links we could have made are overwritten
    if (existing && !existing.isSymbolicLink()) {
      skipped.push({ agent, dest, reason: 'exists' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (existing) fs.rmSync(dest);
      if (copy) fs.cpSync(canonical, dest, { recursive: true });
      else {
        try {
          fs.symlinkSync(canonical, dest, 'junction');
        } catch (err) {
          // unprivileged Windows cannot symlink; a copy goes stale on update
          // but beats no install, and re-running install-skill refreshes it
          if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
          fs.cpSync(canonical, dest, { recursive: true });
        }
      }
      linked.push({ agent, dest });
    } catch (err) {
      skipped.push({ agent, dest, reason: err.code || 'error' });
    }
  }
  return { canonical, linked, skipped };
}

module.exports = { installSkill, canonicalDir, SKILL_NAME, SOURCE };
