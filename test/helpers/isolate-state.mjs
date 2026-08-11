import { after } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const stateDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'showmd-test-state-')));
process.env.SHOWMD_HISTORY_HOME = path.join(stateDir, 'history');
process.env.SHOWMD_SETTINGS_HOME = path.join(stateDir, 'settings');

after(async () => {
  const require = createRequire(import.meta.url);
  const { drainServerCleanups } = require('../../server/server.js');
  await drainServerCleanups();
  rmSync(stateDir, { recursive: true, force: true });
});
