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
    reportError: () => {},
  });
}

const blocks = renderer();
const doc = document.getElementById('doc');

test('Block Renderer interface does not expose rendering implementation details', () => {
  for (const detail of [
    'markdown', 'currentTheme', 'mathHTML', 'highlightCodeIn', 'addCopyButtonsIn',
    'renderMathIn', 'mermaidSVG', 'mermaidErrorEl', 'renderMermaidIn', 'enhance',
  ]) {
    assert.equal(blocks[detail], undefined, `${detail} leaked through the interface`);
  }
});
async function renderMath(html) {
  const fresh = createBlockRenderer({
    markdown: (source) => source,
    load: async (name) => ({ hljs, katex, mermaid })[name],
    reportError: () => {},
  });
  await fresh.renderDocumentInto(doc, html);
  return doc;
}

test('renderDocumentInto replaces inline math and keeps the surrounding text', async () => {
  const el = await renderMath('<p>before $a+b$ after</p>');
  assert.equal(el.querySelectorAll('.katex').length, 1);
  assert.equal(el.querySelector('.katex').textContent, 'I:a+b');
  assert.equal(el.textContent, 'before I:a+b after');
});

test('renderDocumentInto renders display math in display mode', async () => {
  const el = await renderMath('<p>$$x = 1$$</p>');
  assert.equal(el.querySelector('.katex').textContent, 'D:x = 1');
});

test('renderDocumentInto leaves currency alone', async () => {
  const el = await renderMath('<p>the widget costs $5 and the case costs $10 total.</p>');
  assert.equal(el.querySelectorAll('.katex').length, 0);
  assert.equal(el.textContent, 'the widget costs $5 and the case costs $10 total.');
});

test('renderDocumentInto skips math inside code and pre', async () => {
  const el = await renderMath('<pre><code>echo "$a$"</code></pre><p>and <code>$b$</code></p>');
  assert.equal(el.querySelectorAll('.katex').length, 0);
});

test('renderDocumentInto handles several math spans in one text node', async () => {
  const el = await renderMath('<p>$a$ then $b$ then done</p>');
  assert.deepEqual([...el.querySelectorAll('.katex')].map((n) => n.textContent), ['I:a', 'I:b']);
  assert.equal(el.textContent, 'I:a then I:b then done');
});

test('renderDocumentInto leaves plain text unchanged', async () => {
  const el = await renderMath('<p>plain text only</p>');
  assert.equal(el.innerHTML, '<p>plain text only</p>');
});

test('renderDocumentInto tags fence languages and highlights code', async () => {
  const fresh = createBlockRenderer({
    markdown: (source) => source,
    load: async () => hljs,
    reportError: () => {},
  });
  const el = document.createElement('div');
  await fresh.renderDocumentInto(el, '<pre><code class="language-js">let a</code></pre><pre><code class="language-py">x=1</code></pre>');
  assert.deepEqual([...el.querySelectorAll('pre')].map((pre) => pre.dataset.lang), ['js', 'py']);
  assert.deepEqual([...el.querySelectorAll('code')].map((code) => code.dataset.highlighted), ['let a', 'x=1']);
});

test('renderDocumentInto does not load the highlighter for Mermaid-only code', async () => {
  const calls = [];
  const fresh = createBlockRenderer({
    markdown: (source) => source,
    load: async (name) => { calls.push(name); return mermaid; },
    reportError: () => {},
  });
  const el = document.createElement('div');
  await fresh.renderDocumentInto(el, '<pre><code class="language-mermaid">graph TD</code></pre>');
  assert.equal(calls.includes('hljs'), false);
});

test('renderDocumentInto adds copy controls to code but not Mermaid', async () => {
  const el = document.createElement('div');
  const fresh = createBlockRenderer({
    markdown: (source) => source,
    load: async (name) => ({ hljs, mermaid })[name],
    reportError: () => {},
  });
  await fresh.renderDocumentInto(el, '<pre><code class="language-js">let a</code></pre><pre><code>plain</code></pre><pre><code class="language-mermaid">graph TD</code></pre>');
  assert.deepEqual(
    [...el.querySelectorAll('pre')].map((pre) => pre.querySelectorAll('.code-copy').length),
    [1, 1],
  );
});

test('renderDocumentInto copy controls copy code and show completion', async () => {
  const el = document.createElement('div');
  const fresh = createBlockRenderer({ markdown: (source) => source, reportError: () => {} });
  const written = [];
  // Node's own globalThis.navigator is getter-only, so it has to be redefined
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: (text) => { written.push(text); return Promise.resolve(); } } },
    configurable: true,
  });
  await fresh.renderDocumentInto(el, '<pre><code>npm test\n</code></pre>');
  const button = el.querySelector('.code-copy');
  button.dispatchEvent(new window.Event('click'));
  assert.deepEqual(written, ['npm test\n']);
  assert.ok(button.classList.contains('done'));
});

test('renderBlockInto caches Mermaid output by theme and source', async () => {
  const fresh = renderer();
  const first = document.createElement('div');
  const second = document.createElement('div');
  await fresh.renderBlockInto(first, { kind: 'mermaid', source: 'graph TD; A-->B' });
  await fresh.renderBlockInto(second, { kind: 'mermaid', source: 'graph TD; A-->B' });
  assert.equal(second.innerHTML, first.innerHTML);
  assert.equal(mermaid.initOpts.theme, 'default');
  assert.equal(mermaid.initOpts.securityLevel, 'strict');
});

test('each vendor loads at most once, and only when a block needs it', async () => {
  const fresh = renderer();
  const before = loaded.length;
  const host = document.createElement('span');
  await fresh.renderBlockInto(host, { kind: 'math', source: 'a', display: false });
  await fresh.renderBlockInto(host, { kind: 'math', source: 'b', display: true });
  assert.deepEqual(loaded.slice(before), ['katex']);
});

test('renderBlockInto renders a markdown block into the adapter-owned host', async () => {
  const fresh = renderer();
  const host = document.createElement('div');
  host.className = 'adapter-owned';
  await fresh.renderBlockInto(host, { kind: 'markdown', source: '# hi' });
  assert.equal(host.className, 'adapter-owned');
  assert.equal(host.innerHTML, '<p>md:# hi</p>');
});

test('renderBlockInto enhances rendered markdown without exposing the highlighter', async () => {
  const fresh = createBlockRenderer({
    markdown: () => '<pre><code class="language-js">let a</code></pre>',
    load: async () => hljs,
    reportError: () => {},
  });
  const host = document.createElement('div');
  await fresh.renderBlockInto(host, { kind: 'markdown', source: '```js\nlet a\n```' });
  assert.equal(host.querySelector('pre').dataset.lang, 'js');
  assert.equal(host.querySelector('code').dataset.highlighted, 'let a');
});

test('renderBlockInto renders math without exposing KaTeX markup to the adapter', async () => {
  const fresh = renderer();
  const host = document.createElement('span');
  await fresh.renderBlockInto(host, { kind: 'math', source: 'a^2', display: true });
  assert.equal(host.innerHTML, '<span class="katex">D:a^2</span>');
});

test('renderBlockInto owns the Mermaid loading state', async () => {
  let finish;
  const waitingMermaid = {
    initialize: () => {},
    render: () => new Promise((resolve) => { finish = () => resolve({ svg: '<svg>done</svg>' }); }),
  };
  const fresh = createBlockRenderer({
    markdown: (source) => source,
    load: async () => waitingMermaid,
    reportError: () => {},
  });
  const host = document.createElement('div');
  const rendering = fresh.renderBlockInto(host, { kind: 'mermaid', source: 'graph Wait' });
  assert.equal(host.textContent, 'Rendering diagram…');
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await rendering;
});

test('renderBlockInto renders Mermaid without exposing SVG to the adapter', async () => {
  const fresh = renderer();
  const host = document.createElement('div');
  await fresh.renderBlockInto(host, { kind: 'mermaid', source: 'graph TD; A-->B' });
  assert.match(host.innerHTML, /^<svg data-id="mmd-\d+">graph TD; A--&gt;B<\/svg>$/);
});

test('renderBlockInto reports Mermaid failures and resolves with a readable fallback', async () => {
  const errors = [];
  const fresh = createBlockRenderer({
    markdown: (source) => source,
    load: async () => mermaid,
    reportError: (message, error) => errors.push({ message, error }),
  });
  const host = document.createElement('div');
  await fresh.renderBlockInto(host, { kind: 'mermaid', source: 'bad diagram' });
  assert.equal(host.querySelector('pre > code').textContent, 'bad diagram');
  assert.equal(host.querySelector('.mermaid-error-msg').textContent, 'Diagram failed to render: parse error');
  assert.equal(errors[0].message, 'showmd: mermaid render failed');
  assert.equal(errors[0].error.message, 'parse error');
});

test('renderBlockInto resolves KaTeX failures with readable source', async () => {
  const fresh = createBlockRenderer({
    markdown: (source) => source,
    load: async () => { throw new Error('offline'); },
    reportError: () => {},
  });
  const host = document.createElement('span');
  await fresh.renderBlockInto(host, { kind: 'math', source: 'a^2', display: false });
  assert.equal(host.textContent, 'a^2');
});

test('renderBlockInto resolves markdown failures with escaped source', async () => {
  const fresh = createBlockRenderer({
    markdown: () => { throw new Error('broken pipeline'); },
    reportError: () => {},
  });
  const host = document.createElement('div');
  await fresh.renderBlockInto(host, { kind: 'markdown', source: '<script>unsafe()</script>' });
  assert.equal(host.innerHTML, '&lt;script&gt;unsafe()&lt;/script&gt;');
});

test('renderBlockInto rejects invalid interface usage', async () => {
  const fresh = renderer();
  const host = document.createElement('div');
  await assert.rejects(fresh.renderBlockInto(null, { kind: 'markdown', source: 'hi' }), /target/);
  await assert.rejects(fresh.renderBlockInto(host, { kind: 'video', source: 'hi' }), /kind/);
  await assert.rejects(fresh.renderBlockInto(host, { kind: 'markdown' }), /source/);
});

test('renderBlockInto prevents an older asynchronous render from overwriting its host', async () => {
  const pending = new Map();
  const deferredMermaid = {
    initialize: () => {},
    render: (id, source) => new Promise((resolve) => pending.set(source, () => resolve({ svg: `<svg>${source}</svg>` }))),
  };
  const fresh = createBlockRenderer({
    markdown: (source) => source,
    load: async () => deferredMermaid,
    reportError: () => {},
  });
  const host = document.createElement('div');
  const older = fresh.renderBlockInto(host, { kind: 'mermaid', source: 'older' });
  const newer = fresh.renderBlockInto(host, { kind: 'mermaid', source: 'newer' });
  await new Promise((resolve) => setImmediate(resolve));
  pending.get('newer')();
  await newer;
  pending.get('older')();
  await older;
  assert.equal(host.textContent, 'newer');
});

test('renderDocumentInto renders and fully enhances a Read Mode document', async () => {
  const fresh = createBlockRenderer({
    markdown: () => '<pre><code class="language-mermaid">graph C</code></pre>'
      + '<pre><code class="language-js">let a</code></pre><p>$a+b$</p>',
    load: async (name) => ({ hljs, katex, mermaid })[name],
    reportError: () => {},
  });
  const host = document.createElement('div');
  await fresh.renderDocumentInto(host, 'source');
  assert.equal(host.querySelectorAll('.mermaid-diagram').length, 1);
  assert.equal(host.querySelector('code.language-js').dataset.highlighted, 'let a');
  assert.equal(host.querySelector('.katex').textContent, 'I:a+b');
  assert.equal(host.querySelectorAll('.code-copy').length, 1);
});

test('refreshThemeIn rebuilds theme-dependent rendering behind the interface', async () => {
  const fresh = renderer();
  const host = document.createElement('div');
  host.innerHTML = '<div class="mermaid-diagram" data-src="graph Theme"></div>';
  document.documentElement.dataset.theme = 'dark';
  await fresh.refreshThemeIn(host);
  assert.equal(mermaid.initOpts.theme, 'dark');
  assert.match(host.querySelector('.mermaid-diagram').innerHTML, /graph Theme/);
  document.documentElement.dataset.theme = 'light';
});

test('renderDocumentInto skips KaTeX discovery when there is no math', async () => {
  const fresh = renderer();
  const el = document.createElement('div');
  const before = loaded.length;
  await fresh.renderDocumentInto(el, 'plain text');
  assert.equal(loaded.slice(before).includes('katex'), false);
});
