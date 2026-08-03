import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// node --test takes a glob on 22+, a directory on 20, and cmd.exe expands
// neither, so the file list is built here instead of by the shell or the runner
const root = fileURLToPath(new URL('..', import.meta.url));

function testFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(full));
    else if (entry.name.endsWith('.test.mjs')) found.push(full);
  }
  return found.sort();
}

const files = testFiles(path.join(root, process.argv[2]));
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(run.status ?? 1);
