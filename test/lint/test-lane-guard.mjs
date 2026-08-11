import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const unitDir = path.join(root, 'test', 'unit');
const socketModule = /(?:from\s+|require\(\s*)['"]node:(?:http|https|net)['"]/;
const childProcessModule = /(?:from\s+|require\(\s*)['"]node:child_process['"]/;

// Real Git repositories are an explicit fast-component exception. No other
// unit test may execute a real subprocess; OS tools belong in test/platform.
const CHILD_PROCESS_ALLOWED = new Set(['test/unit/history.test.mjs']);
const offenders = [];

function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      visit(full);
      continue;
    }
    if (!entry.name.endsWith('.test.mjs')) continue;
    const rel = path.relative(root, full).split(path.sep).join('/');
    const source = readFileSync(full, 'utf8');
    if (socketModule.test(source)) offenders.push(`${rel}: imports a real socket module`);
    if (childProcessModule.test(source) && !CHILD_PROCESS_ALLOWED.has(rel)) {
      offenders.push(`${rel}: imports child_process outside the isolated-Git exception`);
    }
  }
}

visit(unitDir);

if (offenders.length) {
  console.error('test-lane-guard: unit tests crossed a network or platform boundary:');
  for (const offender of offenders) console.error(`  ${offender}`);
  process.exitCode = 1;
} else {
  console.log('test-lane-guard: unit tests import no socket modules or non-Git subprocesses');
}
