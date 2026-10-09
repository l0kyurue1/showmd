import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPipeline } from '../../../client/pipeline.js';

const require = createRequire(import.meta.url);
const markdownit = require('markdown-it');

function pipeline() {
  return createPipeline(markdownit);
}

test('parseFrontmatter: plain values', () => {
  const { meta, body } = pipeline().parseFrontmatter('---\ntitle: Hello\ntags:\n  - a\n  - b\n---\nBody text');
  assert.equal(meta.title, 'Hello');
  assert.deepEqual(meta.tags, ['a', 'b']);
  assert.equal(body, 'Body text');
});

test('parseFrontmatter: quoted values', () => {
  const { meta } = pipeline().parseFrontmatter('---\ntitle: "Hello, World"\nauthor: \'Jane\'\n---\nBody');
  assert.equal(meta.title, 'Hello, World');
  assert.equal(meta.author, 'Jane');
});

test('parseFrontmatter: no frontmatter', () => {
  const text = '# Just a heading\n\nSome text';
  const { meta, body } = pipeline().parseFrontmatter(text);
  assert.equal(meta, null);
  assert.equal(body, text);
});

test('parseFrontmatter: malformed (unterminated) frontmatter', () => {
  const text = '---\ntitle: Hello\nno closing fence here';
  const { meta, body } = pipeline().parseFrontmatter(text);
  assert.equal(meta, null);
  assert.equal(body, text);
});

test('resolveWikilink: basic exact and nested match', () => {
  const p = pipeline();
  p.setTree(['foo.md', 'bar/baz.md']);
  assert.equal(p.resolveWikilink('foo'), 'foo.md');
  assert.equal(p.resolveWikilink('bar/baz'), 'bar/baz.md');
});

test('resolveWikilink: basename fallback and unresolved', () => {
  const p = pipeline();
  p.setTree(['notes/todo.md']);
  assert.equal(p.resolveWikilink('todo'), 'notes/todo.md');
  assert.equal(p.resolveWikilink('missing'), null);
});

test('task-list rendering: emits line-mapped checkbox, checked and unchecked', () => {
  const html = pipeline().render('- [ ] one\n- [x] two');
  assert.match(html, /<input type="checkbox" class="cb" data-line="0">/);
  assert.match(html, /<input type="checkbox" class="cb" data-line="1" checked>/);
  assert.match(html, /class="task-item"/);
  assert.match(html, /class="task-item done-t"/);
});

test('callout rendering: produces the callout structure', () => {
  const html = pipeline().render('> [!note] Heads up\n> body line');
  assert.match(html, /class="callout callout-note"/);
  assert.match(html, /class="callout-title"/);
  assert.match(html, /class="callout-name">Heads up</);
});

test('wikilink rendering: resolved and unresolved', () => {
  const p = pipeline();
  p.setTree(['target.md']);
  const resolved = p.render('[[target]]');
  assert.match(resolved, /<a href="#" class="wikilink" data-file="target\.md">target<\/a>/);
  const unresolved = p.render('[[missing]]');
  assert.match(unresolved, /<span class="wikilink-unresolved">missing<\/span>/);
});

test('wikilink rendering: uses the injected docHref for real hrefs', () => {
  const p = pipeline();
  p.setTree(['target.md']);
  p.setDocHref((file) => `/r/root/${file}`);
  const html = p.render('[[target]]');
  assert.match(html, /<a href="\/r\/root\/target\.md" class="wikilink" data-file="target\.md">target<\/a>/);
});

test('wikilink rendering: falls back to "#" when docHref is unset or returns nothing', () => {
  const p = pipeline();
  p.setTree(['target.md']);
  p.setDocHref(() => null);
  assert.match(p.render('[[target]]'), /<a href="#" class="wikilink"/);
});

test('renderPropValue: plain string escapes', () => {
  const html = pipeline().renderPropValue('<b>hi</b>');
  assert.equal(html, '&lt;b&gt;hi&lt;/b&gt;');
});

test('renderPropValue: wikilink string', () => {
  const p = pipeline();
  p.setTree(['target.md']);
  assert.match(p.renderPropValue('[[target]]'), /<a href="#" class="wikilink" data-file="target\.md">target<\/a>/);
  assert.match(p.renderPropValue('[[missing]]'), /<span class="wikilink-unresolved">missing<\/span>/);
});

test('renderPropValue: array of strings and wikilinks', () => {
  const p = pipeline();
  p.setTree(['target.md']);
  const html = p.renderPropValue(['plain', '[[target]]']);
  assert.equal(html, '<div>plain</div><div><a href="#" class="wikilink" data-file="target.md">target</a></div>');
});

test('mark: ==text== renders <mark>', () => {
  const html = pipeline().render('some ==highlighted== text');
  assert.match(html, /<mark>highlighted<\/mark>/);
  assert.doesNotMatch(pipeline().render('not==mark'), /<mark>/);
});

test('img tag: sized <img> renders with whitelisted attrs and resolved src', () => {
  const p = pipeline();
  p.setDocId('docs/guide.md');
  p.setAssetUrl((id) => `/api/roots/r_AAAAAAAAAAAAAAAAAAAAAA/asset?path=${encodeURIComponent(id)}`);
  const html = p.render('<img src="media/logo.png" width="64" height="64">');
  assert.match(html, /<img src="\/api\/roots\/r_AAAAAAAAAAAAAAAAAAAAAA\/asset\?path=docs%2Fmedia%2Flogo\.png"[^>]*>/);
  assert.match(html, /width="64"/);
  assert.match(html, /height="64"/);
});

test('img tag: without an asset URL builder the src is left unresolved (no space to address)', () => {
  const p = pipeline();
  p.setDocId('docs/guide.md');
  const html = p.render('<img src="media/logo.png">');
  assert.match(html, /<img src="media\/logo\.png"/);
});

test('img tag: alt and title survive, event handlers do not', () => {
  const html = pipeline().render('<img src="x.png" alt="Logo" title="T" onerror="alert(1)" onclick="bad()">');
  assert.match(html, /alt="Logo"/);
  assert.match(html, /title="T"/);
  assert.doesNotMatch(html, /onerror|onclick|alert/);
});

test('img tag: renders inline mid-paragraph and self-closing', () => {
  const p = pipeline();
  assert.match(p.render('before <img src="a.png" width="20"> after'), /<p[^>]*>before <img [^>]*> after<\/p>/);
  assert.match(p.render('<img src="a.png" />'), /<img /);
});

test('img tag: malformed or src-less tags stay escaped', () => {
  const p = pipeline();
  assert.match(p.render('<img src="x.png"'), /&lt;img/);
  assert.match(p.render('<img width="64">'), /&lt;img/);
});

test('raw html: everything outside the whitelist is still escaped', () => {
  const p = pipeline();
  assert.match(p.render('<script>alert(1)</script>'), /&lt;script&gt;/);
  assert.match(p.render('<iframe src="evil"></iframe>'), /&lt;iframe/);
  assert.match(p.render('<a href="javascript:alert(1)">x</a>'), /&lt;a href/);
  assert.match(p.render('<span onmouseover="bad()">x</span>'), /&lt;span/);
});

test('wrapper: multi-line <p align="center"> centers its image', () => {
  const html = pipeline().render('<p align="center">\n  <img src="logo.png" width="200">\n</p>');
  assert.match(html, /^<div align="center"[^>]*>/);
  assert.match(html, /<img src="logo\.png" width="200"/);
  assert.match(html, /<\/div>\s*$/);
  assert.doesNotMatch(html, /<p align/);
});

test('wrapper: single-line form and headings', () => {
  const p = pipeline();
  assert.match(p.render('<h1 align="center">showmd</h1>'), /<h1 align="center"[^>]*>showmd<\/h1>/);
  assert.match(p.render('<div align="center"><img src="a.png" width="8"></div>'), /<div align="center"[^>]*><img [^>]*><\/div>/);
});

test('wrapper: markdown inside a wrapper is still parsed', () => {
  const html = pipeline().render('<p align="center">\n  **bold** and [[link]]\n</p>');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /wikilink/);
});

test('wrapper: non-whitelisted attrs and tags are dropped or escaped', () => {
  const p = pipeline();
  assert.doesNotMatch(p.render('<p align="center" onclick="bad()">x</p>'), /onclick/);
  assert.match(p.render('<section align="center">x</section>'), /&lt;section/);
});

test('wrapper: unclosed opener stays escaped', () => {
  assert.match(pipeline().render('<p align="center">\n  <img src="a.png">'), /&lt;p align/);
});

test('br tag: <br> becomes a line break', () => {
  assert.match(pipeline().render('a<br>b'), /a<br>\s*b/);
});

test('heading ids: slugified, lowercased, punctuation stripped', () => {
  const html = pipeline().render('# Hello, World!\n\n## Foo Bar_Baz');
  assert.match(html, /<h1 id="hello-world"[^>]*>/);
  assert.match(html, /<h2 id="foo-barbaz"[^>]*>/);
});

test('heading ids: CJK characters preserved', () => {
  const html = pipeline().render('# 你好 世界');
  assert.match(html, /<h1 id="你好-世界"[^>]*>/);
});

test('heading ids: duplicates deduped with -1, -2', () => {
  const html = pipeline().render('# Section\n\n## Section\n\n### Section');
  assert.match(html, /<h1 id="section"[^>]*>/);
  assert.match(html, /<h2 id="section-1"[^>]*>/);
  assert.match(html, /<h3 id="section-2"[^>]*>/);
});

test('heading ids: generated suffixes cannot collide with explicit headings', () => {
  const html = pipeline().render('# X\n\n## X\n\n### X-1');
  assert.match(html, /<h1 id="x"[^>]*>/);
  assert.match(html, /<h2 id="x-1"[^>]*>/);
  assert.match(html, /<h3 id="x-1-1"[^>]*>/);
});

test('heading ids: counter resets per render call', () => {
  const p = pipeline();
  p.render('# Section\n\n## Section');
  const html = p.render('# Section');
  assert.match(html, /<h1 id="section"[^>]*>/);
});

test('top-level blocks carry their body line, nested blocks do not', () => {
  const html = pipeline().render('# T\n\npara\n\n- a\n- b\n\n```js\nx\n```');
  assert.match(html, /<h1[^>]*data-line="0"/);
  assert.match(html, /<p data-line="2">/);
  assert.match(html, /<ul data-line="4">/);
  assert.doesNotMatch(html, /<li data-line/);
  assert.match(html, /<code[^>]*data-line="7"/);
});

const SPACER = '<p class="md-empty-para"></p>';
const spacers = (src) => pipeline().render(src).split(SPACER).length - 1;

test('empty paragraphs: floor(N/2) spacers for N blank lines between blocks', () => {
  assert.equal(spacers('foo\n\nbar'), 0);
  assert.equal(spacers('foo\n\n\nbar'), 1);
  assert.equal(spacers('foo\n\n\n\nbar'), 1);
  assert.equal(spacers('foo\n\n\n\n\nbar'), 2);
  assert.equal(spacers('foo\n \n \t\n\nbar'), 1);
  assert.match(pipeline().render('foo\n\n\nbar'), /<p data-line="0">foo<\/p>\n<p class="md-empty-para"><\/p>\n<p data-line="3">bar<\/p>/);
});

test('empty paragraphs: blank lines inside code, lists, or at the edges add none', () => {
  assert.equal(spacers('```\na\n\n\n\n\nb\n```'), 0);
  assert.equal(spacers('    a\n\n\n\n    b'), 0);
  assert.equal(spacers('\n\n\n\nfoo\n\n\n\n'), 0);
  assert.equal(pipeline().render('- a\n\n\n\n- b'), '<ul data-line="0">\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ul>\n');
});

test('empty paragraphs: count only the blank lines directly before the next block', () => {
  assert.equal(spacers('- a\n\n\n\nbar'), 1);
  assert.equal(spacers('1. a\n\n\nbar'), 1);
  assert.equal(spacers('foo\n- a\n\n\n\n\nbar'), 2);
  assert.equal(spacers('<div>x</div>\n\n\n\nbar'), 1);
  assert.equal(spacers('[x]: http://a\n\n\n\nbar'), 1);
});

test('empty paragraphs: none at the document start, after frontmatter, or at the end', () => {
  assert.equal(spacers('\n\n\n\nbar'), 0);
  assert.equal(spacers(pipeline().parseFrontmatter('---\na: b\n---\n\n\n\nbar').body), 0);
  assert.equal(spacers('bar\n\n\n\n'), 0);
});

test('empty paragraphs: spacers leave data-line of real blocks unchanged', () => {
  const html = pipeline().render('# t\n\n\n\n\npara\n\n\nlast');
  assert.match(html, /<h1 id="t" data-line="0"/);
  assert.match(html, /<p data-line="5">para/);
  assert.match(html, /<p data-line="8">last/);
  assert.equal((html.match(/data-line/g) || []).length, 3);
});

test('render: an escaped dollar in a callout title stays in the title', () => {
  const html = pipeline().render('> [!tip] Costs \\$5\n> body');
  assert.match(html, /class="callout-name">Costs \$5</);
  assert.match(html, /<p>body<\/p>/);
});

test('render: math source survives markdown escapes and emphasis', () => {
  const p = pipeline();
  assert.equal(p.render('$a \\, b$'), '<p data-line="0">$a \\, b$</p>\n');
  assert.equal(p.render('$x_1 + y_1$ and _em_'), '<p data-line="0">$x_1 + y_1$ and <em>em</em></p>\n');
  assert.equal(p.render('$\\{a\\}$'), '<p data-line="0">$\\{a\\}$</p>\n');
  assert.equal(p.render('$$a \\\\ b$$'), '<p data-line="0">$$a \\\\ b$$</p>\n');
});

test('render: code spans and currency are not math', () => {
  const p = pipeline();
  assert.equal(p.render('`$x$`'), '<p data-line="0"><code>$x$</code></p>\n');
  assert.equal(p.render('$3.50 and $4 \\, _x_'), '<p data-line="0">$3.50 and $4 , <em>x</em></p>\n');
});
