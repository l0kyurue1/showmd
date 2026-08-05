import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// windowsHide has no observable effect in headless CI, so the invariant is
// enforced structurally — only proc.js can reach spawn
const root = fileURLToPath(new URL('../..', import.meta.url));
const dirs = ['bin', 'server'];
const ALLOWED = 'server/proc.js';

const offenders = [];
for (const dir of dirs) {
  for (const name of fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.js'))) {
    const rel = `${dir}/${name}`;
    if (rel === ALLOWED) continue;
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    const pattern = /require\(\s*['"](?:node:)?child_process['"]\s*\)/g;
    for (const m of src.matchAll(pattern)) {
      offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length} — requires child_process outside proc.js`);
    }
  }
}

if (offenders.length) {
  console.error('only server/proc.js may require child_process');
  for (const o of offenders) console.error('  ' + o);
  process.exitCode = 1;
} else {
  console.log('proc-seam-guard: only server/proc.js requires child_process');
}
