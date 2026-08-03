import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const tapIndex = args.indexOf('--tap');
const tap = tapIndex === -1 ? null : args[tapIndex + 1];
const version = args.find((a) => !a.startsWith('--') && a !== tap) ?? pkg.version;

const meta = await fetch(`https://registry.npmjs.org/${pkg.name}/${version}`);
if (!meta.ok) {
  console.error(`brew-bump: ${pkg.name}@${version} is not on the registry (${meta.status}) — publish first`);
  process.exit(1);
}
const { dist } = await meta.json();

const tarball = Buffer.from(await (await fetch(dist.tarball)).arrayBuffer());
const sha256 = createHash('sha256').update(tarball).digest('hex');

const formula = path.join(root, 'contrib/brew/showmd.rb');
const bumped = fs
  .readFileSync(formula, 'utf8')
  .replace(/^  url ".*"$/m, `  url "${dist.tarball}"`)
  .replace(/^  sha256 ".*"$/m, `  sha256 "${sha256}"`);
fs.writeFileSync(formula, bumped);
console.log(`${path.relative(root, formula)} -> ${version} ${sha256}`);

if (tap) {
  const dest = path.join(tap, 'Formula', 'showmd.rb');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bumped);
  console.log(`${dest} -> ${version}`);
}
