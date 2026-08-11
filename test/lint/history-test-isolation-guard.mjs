import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const integrationDir = path.join(root, 'test', 'integration');
const bootstrap = "import '../helpers/isolate-state.mjs';";
const offenders = [];

for (const name of fs.readdirSync(integrationDir).filter((entry) => entry.endsWith('.test.mjs'))) {
  const rel = `test/integration/${name}`;
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  if (!src.includes("require('../../server/server.js')")) continue;
  const bootstrapAt = src.indexOf(bootstrap);
  const serverAt = src.indexOf("require('../../server/server.js')");
  if (bootstrapAt === -1 || bootstrapAt > serverAt) offenders.push(rel);
}

if (offenders.length) {
  console.error('integration server tests must isolate persistent state before loading server.js');
  for (const offender of offenders) console.error('  ' + offender);
  process.exitCode = 1;
} else {
  console.log('history-test-isolation-guard: every integration server test loads the isolation bootstrap first');
}
