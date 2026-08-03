import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHex, contrast, oklch, parseRoot, audit } from '../../../client/theme-lab.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const CSS = readFileSync(path.join(ROOT, 'client/app.css'), 'utf8');

test('parseHex handles 3/6/8-digit and alpha', () => {
  assert.deepEqual(parseHex('#fff'), [1, 1, 1, 1]);
  assert.deepEqual(parseHex('#000000'), [0, 0, 0, 1]);
  assert.equal(parseHex('#00000080')[3].toFixed(2), '0.50');
  assert.equal(parseHex('nope'), null);
});

test('contrast matches known WCAG values', () => {
  assert.equal(contrast(parseHex('#000'), parseHex('#fff')).toFixed(2), '21.00');
  assert.equal(contrast(parseHex('#767676'), parseHex('#fff')).toFixed(1), '4.5');
});

test('oklch: white is L1 C0, pure red hue ~29deg', () => {
  const w = oklch(parseHex('#ffffff'));
  assert.equal(w.L.toFixed(3), '1.000');
  assert.ok(w.C < 0.001, `white chroma ${w.C}`);
  const r = oklch(parseHex('#ff0000'));
  assert.ok(Math.abs(r.H - 29.2) < 1, `red hue ${r.H}`);
  assert.ok(Math.abs(r.L - 0.628) < 0.005, `red L ${r.L}`);
});

test('parseRoot reads both sides of every light-dark token in app.css', () => {
  const { names, defaults } = parseRoot(CSS);
  for (const n of ['bg', 'ink', 'accent', 'add', 'del', 'question', 'warning', 'code-kw']) {
    assert.ok(names.includes(n), `missing --${n}`);
    assert.ok(parseHex(defaults[n].light), `--${n} light unparsed: ${defaults[n].light}`);
    assert.ok(parseHex(defaults[n].dark), `--${n} dark unparsed: ${defaults[n].dark}`);
  }
  assert.equal(defaults.bg.light, '#ffffff');
  assert.notEqual(defaults.bg.light, defaults.bg.dark);
  assert.equal(defaults.white.single, true);
});

test('audit composites alpha tokens over bg instead of failing', () => {
  const { defaults } = parseRoot(CSS);
  for (const s of ['light', 'dark']) {
    const rows = audit(defaults, s);
    assert.ok(rows.length > 15, `${s}: only ${rows.length} checks`);
    assert.ok(rows.every((r) => r.val && r.val !== 'NaN'), `${s}: NaN in audit`);
    const ink = rows.find((r) => r.text === 'ink / bg');
    assert.ok(Number(ink.val.split(':')[0]) > 4, `${s}: ink contrast ${ink.val}`);
  }
});
