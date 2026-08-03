import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="doc"></div></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.NodeFilter = dom.window.NodeFilter;
// pins currentTheme() so it never reaches matchMedia, which jsdom does not implement
document.documentElement.dataset.theme = 'light';

const { createBlockRenderer } = await import('../../../client/blocks.js');

const katex = {
  renderToString: (src, opts) => `<span class="katex">${opts.displayMode ? 'D:' : 'I:'}${src}</span>`,
};
const hljs = {
  highlightElement: (el) => { el.dataset.highlighted = el.textContent; },
};
const mermaid = {
  initialize: (opts) => { mermaid.initOpts = opts; },
  render: async (id, src) => {
    if (src.startsWith('bad')) throw new Error('parse error');
    return { svg: `<svg data-id="${id}">${src}</svg>` };
  },
};

const loaded = [];
function renderer() {
  return createBlockRenderer({
    markdown: (src) => `<p>md:${src}</p>`,
    load: async (name) => {
      loaded.push(name);
      return { hljs, katex, mermaid }[name];
    },
  });
}

const blocks = renderer();
const doc = document.getElementById('doc');
async function renderMath(html) {
  doc.innerHTML = html;
  await blocks.renderMathIn(doc);
  return doc;
}

test('renderMathIn replaces inline math and keeps the surrounding text', async () => {
  const el = await renderMath('<p>before $a+b$ after</p>');
  assert.equal(el.querySelectorAll('.katex').length, 1);
  assert.equal(el.querySelector('.katex').textContent, 'I:a+b');
  assert.equal(el.textContent, 'before I:a+b after');
});

test('renderMathIn renders display math in display mode', async () => {
  const el = await renderMath('<p>$$x = 1$$</p>');
  assert.equal(el.querySelector('.katex').textContent, 'D:x = 1');
});

test('renderMathIn leaves currency alone', async () => {
  const el = await renderMath('<p>the widget costs $5 and the case costs $10 total.</p>');
  assert.equal(el.querySelectorAll('.katex').length, 0);
  assert.equal(el.textContent, 'the widget costs $5 and the case costs $10 total.');
});

test('renderMathIn skips code and pre', async () => {
  const el = await renderMath('<pre><code>echo "$a$"</code></pre><p>and <code>$b$</code></p>');
  assert.equal(el.querySelectorAll('.katex').length, 0);
});

test('renderMathIn handles several spans in one text node', async () => {
  const el = await renderMath('<p>$a$ then $b$ then done</p>');
  assert.deepEqual([...el.querySelectorAll('.katex')].map((n) => n.textContent), ['I:a', 'I:b']);
  assert.equal(el.textContent, 'I:a then I:b then done');
});

test('renderMathIn is a no-op when there is no math', async () => {
  const el = await renderMath('<p>plain text only</p>');
  assert.equal(el.innerHTML, '<p>plain text only</p>');
});

test('mathHTML renders inline and display through katex', async () => {
  assert.equal(await blocks.mathHTML('a^2', false), '<span class="katex">I:a^2</span>');
  assert.equal(await blocks.mathHTML('a^2', true), '<span class="katex">D:a^2</span>');
});

test('highlightCodeIn tags the fence language and highlights each block', async () => {
  const el = document.createElement('div');
  el.innerHTML = '<pre><code class="language-js">let a</code></pre><pre><code class="language-py">x=1</code></pre>';
  await blocks.highlightCodeIn(el);
  assert.deepEqual([...el.querySelectorAll('pre')].map((p) => p.dataset.lang), ['js', 'py']);
  assert.deepEqual([...el.querySelectorAll('code')].map((c) => c.dataset.highlighted), ['let a', 'x=1']);
});

test('highlightCodeIn skips mermaid fences and loads nothing when there is no code', async () => {
  const el = document.createElement('div');
  el.innerHTML = '<pre><code class="language-mermaid">graph TD</code></pre>';
  const before = loaded.length;
  await blocks.highlightCodeIn(el);
  assert.equal(el.querySelector('code').dataset.highlighted, undefined);
  assert.equal(loaded.length, before);
});

test('addCopyButtonsIn covers untagged fences, skips mermaid, and never doubles up', () => {
  const el = document.createElement('div');
  el.innerHTML = '<pre><code class="language-js">let a</code></pre><pre><code>plain</code></pre><pre><code class="language-mermaid">graph TD</code></pre>';
  blocks.addCopyButtonsIn(el);
  blocks.addCopyButtonsIn(el);
  assert.deepEqual(
    [...el.querySelectorAll('pre')].map((p) => p.querySelectorAll('.code-copy').length),
    [1, 1, 0],
  );
});

test('addCopyButtonsIn copies the block text and flags the copied state', () => {
  const el = document.createElement('div');
  el.innerHTML = '<pre><code>npm test\n</code></pre>';
  const written = [];
  // Node's own globalThis.navigator is getter-only, so it has to be redefined
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: (t) => { written.push(t); return Promise.resolve(); } } },
    configurable: true,
  });
  blocks.addCopyButtonsIn(el);
  const btn = el.querySelector('.code-copy');
  btn.dispatchEvent(new window.Event('click'));
  assert.deepEqual(written, ['npm test\n']);
  assert.ok(btn.classList.contains('done'));
});

test('mermaidSVG renders and caches by source', async () => {
  const svg = await blocks.mermaidSVG('graph TD; A-->B');
  assert.match(svg, /^<svg data-id="mmd-0">graph TD; A-->B<\/svg>$/);
  assert.equal(await blocks.mermaidSVG('graph TD; A-->B'), svg);
  assert.equal(mermaid.initOpts.theme, 'default');
  assert.equal(mermaid.initOpts.securityLevel, 'strict');
});

test('mermaidSVG rejects on a bad diagram and mermaidErrorEl shows source and message', async () => {
  const src = 'bad diagram';
  const err = await blocks.mermaidSVG(src).then(() => null, (e) => e);
  assert.equal(err.message, 'parse error');
  const el = blocks.mermaidErrorEl(src, err);
  assert.equal(el.className, 'mermaid-error');
  assert.equal(el.querySelector('pre > code').textContent, src);
  assert.equal(el.querySelector('.mermaid-error-msg').textContent, 'Diagram failed to render: parse error');
});

test('each vendor loads at most once, and only when a block needs it', async () => {
  const fresh = renderer();
  const before = loaded.length;
  assert.deepEqual(loaded.slice(before), []);
  await fresh.mathHTML('a', false);
  await fresh.mathHTML('b', true);
  assert.deepEqual(loaded.slice(before), ['katex']);
});

test('markdown is exposed as given', () => {
  assert.equal(blocks.markdown('# hi'), '<p>md:# hi</p>');
});

test('renderMermaidIn discovers fenced and re-render targets and replaces them with the diagram', async () => {
  const fresh = renderer();
  const el = document.createElement('div');
  el.innerHTML = '<pre><code class="language-mermaid">graph A</code></pre>'
    + '<div class="mermaid-diagram" data-src="graph B"></div>'
    + '<div class="mermaid-error" data-src="bad one"></div>';
  await fresh.renderMermaidIn(el);
  const diagrams = [...el.querySelectorAll('.mermaid-diagram')];
  assert.equal(diagrams.length, 2);
  assert.match(diagrams[0].innerHTML, /graph A/);
  assert.equal(diagrams[1].dataset.src, 'graph B');
  const error = el.querySelector('.mermaid-error');
  assert.equal(error.dataset.src, 'bad one');
  assert.equal(error.querySelector('.mermaid-error-msg').textContent, 'Diagram failed to render: parse error');
});

test('enhance orchestrates mermaid, hljs and katex discovery on a container', async () => {
  const fresh = renderer();
  const el = document.createElement('div');
  el.innerHTML = '<pre><code class="language-mermaid">graph C</code></pre>'
    + '<pre><code class="language-js">let a</code></pre>'
    + '<p>$a+b$</p>';
  fresh.enhance(el);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(el.querySelectorAll('.mermaid-diagram').length, 1);
  assert.equal(el.querySelector('code.language-js').dataset.highlighted, 'let a');
  assert.equal(el.querySelector('.katex').textContent, 'I:a+b');
});

test('enhance skips katex discovery when there is no math', async () => {
  const fresh = renderer();
  const el = document.createElement('div');
  el.innerHTML = '<p>plain text</p>';
  const before = loaded.length;
  fresh.enhance(el);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(loaded.slice(before).includes('katex'), false);
});
