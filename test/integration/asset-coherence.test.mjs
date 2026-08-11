import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../helpers/isolate-state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');

async function bodyAt(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  assert.equal(response.status, 200, pathname);
  return createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
}

test('a running server keeps serving its boot-time shell and lazy asset build after package files change', async () => {
  const packageDir = mkdtempSync(path.join(tmpdir(), 'showmd-package-snapshot-'));
  let server;
  try {
    cpSync(path.join(PROJECT, 'server'), path.join(packageDir, 'server'), { recursive: true });
    cpSync(path.join(PROJECT, 'client'), path.join(packageDir, 'client'), { recursive: true });
    cpSync(path.join(PROJECT, 'package.json'), path.join(packageDir, 'package.json'));
    symlinkSync(path.join(PROJECT, 'node_modules'), path.join(packageDir, 'node_modules'), 'dir');

    const requireFromCopy = createRequire(path.join(packageDir, 'package.json'));
    const { createServer } = requireFromCopy('./server/server.js');
    server = createServer(null);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const assets = [
      ['/', 'client/index.html'],
      ['/assets/app.js', 'client/app.js'],
      ['/assets/dist/editor.js', 'client/dist/editor.js'],
      ['/assets/vendor/mermaid/mermaid.min.js', 'client/dist/vendor/mermaid/mermaid.min.js'],
      ['/assets/vendor/katex/fonts/KaTeX_AMS-Regular.woff2', 'client/dist/vendor/katex/fonts/KaTeX_AMS-Regular.woff2'],
    ];
    const before = await Promise.all(assets.map(([url]) => bodyAt(base, url)));

    for (const [, file] of assets) {
      writeFileSync(path.join(packageDir, file), 'replacement package bytes');
    }

    const after = await Promise.all(assets.map(([url]) => bodyAt(base, url)));
    for (let i = 0; i < assets.length; i++) {
      assert.deepEqual(after[i], before[i], `${assets[i][0]} must stay on the process's boot-time build`);
    }
  } finally {
    if (server) {
      server.close();
      await server.whenClosed();
    }
    rmSync(packageDir, { recursive: true, force: true });
  }
});
