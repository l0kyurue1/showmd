'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const settings = require('./settings.js');

// The registry: one <pid>.json per running process, so an external consumer
// (Raycast, a status bar) can list every live server.
function portsDir() {
  return path.join(settings.settingsDir(), 'ports');
}

function fileFor(pid) {
  return path.join(portsDir(), `${pid}.json`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// a killed or crashed instance never gets to retract its own file, so each
// announce sweeps the directory for dead pids instead of leaving it grow forever
async function sweep() {
  const dir = portsDir();
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names.filter((n) => n.endsWith('.json')).map(async (name) => {
    const pid = Number(name.slice(0, -'.json'.length));
    if (!Number.isInteger(pid) || !isAlive(pid)) await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
  }));
}

async function announce(port, pid = process.pid) {
  await sweep();
  await settings.writeJSONAtomic(fileFor(pid), { port, pid });
}

// sync: called from server.js's 'close' handler right before process.exit,
// which has no time left for an async fs op to settle
function retract(pid = process.pid) {
  try {
    fs.rmSync(fileFor(pid), { force: true });
  } catch { /* advisory file */ }
}

async function list() {
  const dir = portsDir();
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')));
    } catch { /* advisory file */ }
  }
  return out;
}

module.exports = { announce, retract, list, portsDir };
