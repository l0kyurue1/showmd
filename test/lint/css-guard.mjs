import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g;

const failures = [];

function blankRoot(content) {
  return content.replace(/^:root\s*\{[\s\S]*?\n\}/m, (block) => block.replace(/[^\n]/g, ' '));
}

function scan(file, { skipRoot = false } = {}) {
  const content = readFileSync(path.join(ROOT, file), 'utf8');
  const haystack = skipRoot ? blankRoot(content) : content;
  const lines = content.split('\n');
  let match;
  while ((match = COLOR_RE.exec(haystack))) {
    const line = haystack.slice(0, match.index).split('\n').length;
    failures.push(`${file}:${line}: ${lines[line - 1].trim()}`);
  }
}

scan('client/app.css', { skipRoot: true });
scan('client/index.html');

// Exclude the raw-value Theme Lab and generated/vendor subdirectories.
const CLIENT_EXCLUDE = new Set(['theme-lab.js']);
for (const name of readdirSync(path.join(ROOT, 'client')).sort()) {
  if (name.endsWith('.js') && !CLIENT_EXCLUDE.has(name)) scan(`client/${name}`);
}

// checks token names, not values, to avoid false positives on unrelated 3/10/22px in chrome rules
const DERIVED_GEOMETRY = ['--task-box', '--task-hang'];
const SHARED_GEOMETRY = ['--list-indent', '--task-gap', '--quote-bar', '--quote-pad'];
const CONSUMERS = ['client/app.css', 'client/editor-src.js'];
// the editor bundles several modules; the contract is shared across them, so each
// consumer is a bundle, not a file.
const CONSUMER_FILES = {
  'client/app.css': ['client/app.css'],
  'client/editor-src.js': ['client/editor-src.js', 'client/editor-blocks.js'],
};

const rootBlock = readFileSync(path.join(ROOT, 'client/app.css'), 'utf8').match(/^:root\s*\{[\s\S]*?\n\}/m)[0];
const sources = CONSUMERS.map((name) => [
  name,
  CONSUMER_FILES[name]
    .map((file) => {
      const body = readFileSync(path.join(ROOT, file), 'utf8');
      return file === 'client/app.css' ? blankRoot(body) : body;
    })
    .join('\n'),
]);

for (const token of [...SHARED_GEOMETRY, ...DERIVED_GEOMETRY]) {
  if (!rootBlock.includes(`${token}:`)) {
    failures.push(`client/app.css: geometry token ${token} is not defined in :root`);
    continue;
  }
  const readers = sources.filter(([, body]) => body.includes(`var(${token})`)).map(([file]) => file);
  const required = SHARED_GEOMETRY.includes(token) ? CONSUMERS : [];
  for (const file of required) {
    if (!readers.includes(file)) failures.push(`${file}: never reads var(${token}) — geometry restated instead of shared?`);
  }
  if (readers.length === 0 && !rootBlock.includes(`var(${token})`)) {
    failures.push(`client/app.css: geometry token ${token} is defined but nothing reads it`);
  }
}

// Enforce the tokens deliberately identical across both themes.
const THEME_INVARIANT = new Set(['--white', '--tooltip-bg', '--tooltip-kbd-bg', '--shadow-1', '--shadow-2', '--shadow-3']);
const LIGHT_DARK_RE = /^light-dark\(/i;
const COLOR_VALUE_RE = /^#[0-9a-fA-F]{3,8}$|^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

for (const [, name, rawValue] of rootBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
  const value = rawValue.trim();
  const usesLightDark = LIGHT_DARK_RE.test(value);
  if (!usesLightDark && !COLOR_VALUE_RE.test(value)) continue;
  const invariant = THEME_INVARIANT.has(name);
  if (invariant && usesLightDark) {
    failures.push(`client/app.css: ${name} is in THEME_INVARIANT but uses light-dark(...) — drop it from the allowlist or remove light-dark()`);
  } else if (!invariant && !usesLightDark) {
    failures.push(`client/app.css: ${name} is a color token but does not use light-dark(...) — wrap it, or add it to THEME_INVARIANT if deliberately theme-invariant`);
  }
}

if (failures.length) {
  console.error('css-guard: the variable contract is not the only source of these values:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`css-guard: ok — no raw color literals outside :root, ${SHARED_GEOMETRY.length} shared geometry tokens read by both modes, light-dark() contract enforced on all non-invariant color tokens`);
