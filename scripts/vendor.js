'use strict';
const fs = require('node:fs');
const path = require('node:path');

const NM = path.join(__dirname, '..', 'node_modules');
const OUT = path.join(__dirname, '..', 'client', 'dist', 'vendor');

const COPIES = [
  ['mermaid/dist/mermaid.min.js', 'mermaid/mermaid.min.js'],
  ['katex/dist/katex.min.js', 'katex/katex.min.js'],
  ['katex/dist/katex.min.css', 'katex/katex.min.css'],
  ['markdown-it/dist/markdown-it.min.js', 'markdown-it.min.js'],
];

for (const [src, dest] of COPIES) {
  const to = path.join(OUT, dest);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(NM, src), to);
}

// woff2-only covers every current browser; add woff/ttf if one shows up
fs.cpSync(path.join(NM, 'katex', 'dist', 'fonts'), path.join(OUT, 'katex', 'fonts'), {
  recursive: true,
  filter: (src) => fs.statSync(src).isDirectory() || src.endsWith('.woff2'),
});

console.log('vendored assets ->', OUT);
