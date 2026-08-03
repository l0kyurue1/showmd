'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { settingsDir, writeJSONAtomic } = require('./settings.js');

const MAX = 10;

function recentsFile() {
  return path.join(settingsDir(), 'recents.json');
}

async function readAll() {
  try {
    const parsed = JSON.parse(await fsp.readFile(recentsFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.path === 'string' && typeof e.ts === 'number') : [];
  } catch {
    return [];
  }
}

async function writeAll(list) {
  await writeJSONAtomic(recentsFile(), list);
}

async function list() {
  return readAll();
}

async function add(entryPath) {
  if (!entryPath) return;
  const rest = (await readAll()).filter((e) => e.path !== entryPath);
  await writeAll([{ path: entryPath, ts: Date.now() }, ...rest].slice(0, MAX));
}

async function remove(entryPath) {
  await writeAll((await readAll()).filter((e) => e.path !== entryPath));
}

module.exports = { recentsFile, list, add, remove };
