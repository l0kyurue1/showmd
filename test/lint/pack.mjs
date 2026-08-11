import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.dirname needs 20.11; engines allows >=20
const root = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = pkg.files ?? [];

// npm includes package.json in every pack regardless of "files"
const covered = (rel) => rel === 'package.json' || files.some((f) => f === rel || rel.startsWith(f + '/'));

// only the CommonJS entry points ship-and-require each other; client/ is ESM
// loaded by the browser, so its imports are served, not resolved by node
const shipped = [
  ...files.filter((f) => f.endsWith('.js')),
  ...(covered('bin') ? fs.readdirSync(path.join(root, 'bin')).filter((f) => f.endsWith('.js')).map((f) => 'bin/' + f) : []),
  ...(covered('server') ? fs.readdirSync(path.join(root, 'server')).filter((f) => f.endsWith('.js')).map((f) => 'server/' + f) : []),
];

const missing = [];
for (const rel of shipped) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const [, , spec] of src.matchAll(/require\((['"])(\.\.?\/[^'"]+)\1\)/g)) {
    const target = path.relative(root, path.resolve(path.dirname(path.join(root, rel)), spec)).split(path.sep).join('/');
    if (!covered(target)) missing.push(`${rel} -> ${target}`);
  }
}

// Guard runtime assets referenced by path rather than require.
const RUNTIME_FILES = [
  'skills/showmd/SKILL.md',
  'icons/showmd.icns',
  'icons/showmd-doc.icns',
  'icons/showmd-helper.icns',
  'icons/showmd.ico',
  'icons/showmd.png',
];
for (const rel of RUNTIME_FILES) {
  if (!covered(rel)) missing.push(`package.json "files" -> ${rel}`);
  else if (!fs.existsSync(path.join(root, rel))) missing.push(`missing on disk -> ${rel}`);
}

if (missing.length) {
  console.error('package.json "files" omits required modules:');
  for (const m of missing) console.error('  ' + m);
  process.exitCode = 1;
} else {
  console.log(`pack-guard: ${shipped.length} shipped modules + ${RUNTIME_FILES.length} runtime files, all covered`);
}
