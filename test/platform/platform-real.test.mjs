import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Every test here runs a real system tool. Each is gated on the platform that
// ships it; only CI's OS matrix proves the complete lane.
const require = createRequire(import.meta.url);
const { findPidOnPort } = require('../../bin/cli.js');
const { revealErrorIsBenign } = require('../../server/reveal.js');

const win32Only = { skip: process.platform !== 'win32' && 'Windows only' };

test('findPidOnPort: real netstat output finds a real listener', win32Only, async () => {
  const server = createServer();
  try {
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    assert.equal(findPidOnPort(port), String(process.pid));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('explorer /select, really does exit 1 on success', win32Only, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'showmd-reveal-'));
  const file = path.join(dir, 'revealed.md');
  writeFileSync(file, '# hi\n');
  try {
    const err = await new Promise((resolve) => execFile('explorer', [`/select,${file}`], { windowsHide: true }, resolve));
    assert.equal(err?.code, 1);
    assert.equal(revealErrorIsBenign('win32', err), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
