'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const DEFAULTS = {
  colorMode: 'system',
  openMode: 'read',
  fontPreset: 'default',
  fontSize: 15.5,
  browser: 'default',
  port: 4321,
  updateCheck: true,
};

const FONT_PRESETS = ['default', 'serif', 'mono'];

const VALIDATORS = {
  colorMode: (v) => v === 'system' || v === 'light' || v === 'dark',
  openMode: (v) => v === 'read' || v === 'edit',
  fontPreset: (v) => FONT_PRESETS.includes(v),
  fontSize: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 10 && v <= 32,
  browser: (v) => typeof v === 'string' && v.length > 0,
  port: (v) => Number.isInteger(v) && v >= 1024 && v <= 65535,
  updateCheck: (v) => typeof v === 'boolean',
};

// where showmd keeps per-user state on each OS. `home` is a parameter because
// install-app.js needs it as the literal shell $HOME, resolved by the launcher
// scripts rather than by this process.
// history.js deliberately opts out (it stays under ~/.local/share everywhere,
// since the history store predates this convention)
function platformDataDir(platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'showmd');
  if (platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'showmd');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'showmd');
}

// SHOWMD_SETTINGS_HOME mirrors history.js's SHOWMD_HISTORY_HOME override, for
// test isolation
function settingsDir() {
  return process.env.SHOWMD_SETTINGS_HOME || platformDataDir();
}

function settingsFile() {
  return path.join(settingsDir(), 'settings.json');
}

async function writeJSONAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

async function readSettings() {
  let stored = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(settingsFile(), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
  } catch {}
  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (key in stored && VALIDATORS[key](stored[key])) merged[key] = stored[key];
  }
  return merged;
}

// unknown keys and invalid values are both dropped rather than rejecting the
// whole request, same "never crash, best-effort" stance as readSettings
async function writeSettings(patch) {
  const next = await readSettings();
  for (const [key, value] of Object.entries(patch || {})) {
    if (VALIDATORS[key] && VALIDATORS[key](value)) next[key] = value;
  }
  await writeJSONAtomic(settingsFile(), next);
  return next;
}

module.exports = {
  DEFAULTS, FONT_PRESETS, platformDataDir, settingsDir, settingsFile, readSettings, writeSettings, writeJSONAtomic,
};
