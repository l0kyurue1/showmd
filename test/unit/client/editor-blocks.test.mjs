import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;

const {
  blocksFacet,
  editBlockField,
  scanMath,
  scanMark,
  scanBlockMath,
  frontmatterEnd,
  BulletWidget,
  HRWidget,
  LangWidget,
  TaskWidget,
  MdBlockWidget,
  MathWidget,
  MermaidWidget,
} = await import('../../../client/editor-blocks.js');

const noActiveLine = () => false;
const allActiveLine = () => true;

function stateFor(text) {
  return EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage })] });
}

test('scanMath decorates inline math outside code and skips currency-like text', () => {
  const state = stateFor('inline $a+b$ end, and `$c$` in code.');
  const decos = [];
  scanMath(state, { from: 0, to: state.doc.length }, decos, noActiveLine);
  assert.equal(decos.length, 1);
  const range = decos[0];
  assert.equal(state.doc.sliceString(range.from, range.to), '$a+b$');
});

test('scanMath skips spans on the active (edited) line', () => {
  const state = stateFor('inline $a+b$ end.');
  const decos = [];
  scanMath(state, { from: 0, to: state.doc.length }, decos, allActiveLine);
  assert.equal(decos.length, 0);
});

test('scanMark decorates a ==highlight== with a mark plus two hidden markers', () => {
  const state = stateFor('this is ==highlighted== text');
  const decos = [];
  scanMark(state, { from: 0, to: state.doc.length }, decos, noActiveLine);
  assert.equal(decos.length, 3);
  const markRange = decos[0];
  assert.equal(state.doc.sliceString(markRange.from, markRange.to), 'highlighted');
});

test('scanMark skips a highlight inside a code span', () => {
  const state = stateFor('code: `==not highlight==`');
  const decos = [];
  scanMark(state, { from: 0, to: state.doc.length }, decos, noActiveLine);
  assert.equal(decos.length, 0);
});

test('scanBlockMath decorates a standalone $$ block and ignores inline math', () => {
  const state = stateFor('before\n\n$$\nx = 1\n$$\n\nafter $y$ inline');
  const decos = [];
  scanBlockMath(state, decos, noActiveLine);
  assert.equal(decos.length, 1);
  const range = decos[0];
  assert.equal(state.doc.sliceString(range.from, range.to).trim(), '$$\nx = 1\n$$');
});

test('frontmatterEnd finds the closing --- and returns 0 without frontmatter', () => {
  const withFm = stateFor('---\ntitle: x\n---\nbody text').doc;
  assert.equal(frontmatterEnd(withFm), withFm.line(3).to);

  const withoutFm = stateFor('just a paragraph').doc;
  assert.equal(frontmatterEnd(withoutFm), 0);
});

test('editBlockField renders an initial decoration set for a doc with a fenced code block', () => {
  const blocks = { markdown: (src) => `<pre>${src}</pre>`, highlightCodeIn: async () => {} };
  const doc = '```js\nconst x = 1;\n```\n\nafter';
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [markdown({ base: markdownLanguage }), blocksFacet.of(blocks), editBlockField],
  });
  const decos = state.field(editBlockField);
  let count = 0;
  decos.between(0, state.doc.length, () => { count++; });
  assert.ok(count > 0, 'expected at least one block decoration');
});

test('BulletWidget.eq and toDOM render the glyph', () => {
  const a = new BulletWidget('•');
  const b = new BulletWidget('•');
  const c = new BulletWidget('◦');
  assert.equal(a.eq(b), true);
  assert.equal(a.eq(c), false);
  const el = a.toDOM();
  assert.equal(el.className, 'cm-lp-bullet');
  assert.equal(el.textContent, '•');
});

test('HRWidget always compares equal and renders its marker span', () => {
  const el = new HRWidget().toDOM();
  assert.equal(el.className, 'cm-lp-hr');
  assert.equal(new HRWidget().eq(new HRWidget()), true);
});

test('LangWidget renders the fence language label', () => {
  const el = new LangWidget('js').toDOM();
  assert.equal(el.className, 'cm-lp-lang');
  assert.equal(el.textContent, 'js');
});

test('TaskWidget.toDOM renders a checkbox reflecting checked state', () => {
  const checked = new TaskWidget(true).toDOM({});
  assert.equal(checked.type, 'checkbox');
  assert.equal(checked.checked, true);
  assert.match(checked.className, /\bcb\b/);
  assert.match(checked.className, /\bcm-lp-task\b/);
  const unchecked = new TaskWidget(false).toDOM({});
  assert.equal(unchecked.checked, false);
});

test('MdBlockWidget.toDOM renders the block through the facet-provided renderer', () => {
  const blocks = {
    markdown: (src) => `<p>rendered:${src}</p>`,
    highlightCodeIn: async () => {},
  };
  const fakeView = { state: { facet: (f) => (f === blocksFacet ? blocks : undefined) } };
  const el = new MdBlockWidget('hello', '4px').toDOM(fakeView);
  assert.equal(el.className, 'doc cm-lp-embed');
  assert.equal(el.style.paddingBottom, '4px');
  assert.equal(el.innerHTML, '<p>rendered:hello</p>');
});

test('MathWidget.toDOM renders src as a placeholder then swaps in rendered HTML', async () => {
  const rendered = Promise.resolve('<span class="katex">x+y</span>');
  const blocks = { mathHTML: () => rendered };
  const fakeView = { state: { facet: (f) => (f === blocksFacet ? blocks : undefined) } };
  const el = new MathWidget('x+y', false, false).toDOM(fakeView);
  assert.equal(el.tagName, 'SPAN');
  assert.equal(el.className, 'cm-lp-math');
  assert.equal(el.textContent, 'x+y');
  await rendered;
  await Promise.resolve();
  assert.equal(el.innerHTML, '<span class="katex">x+y</span>');
});

test('MathWidget.toDOM renders a div for block math', () => {
  const blocks = { mathHTML: () => new Promise(() => {}) };
  const fakeView = { state: { facet: () => blocks } };
  const el = new MathWidget('x=1', true, true).toDOM(fakeView);
  assert.equal(el.tagName, 'DIV');
});

test('MathWidget.toDOM leaves the plain src text in place when rendering fails', async () => {
  const failed = Promise.reject(new Error('render error'));
  const blocks = { mathHTML: () => failed };
  const fakeView = { state: { facet: () => blocks } };
  const el = new MathWidget('x+y', false, false).toDOM(fakeView);
  await failed.catch(() => {});
  await Promise.resolve();
  assert.equal(el.textContent, 'x+y');
  assert.equal(el.innerHTML, 'x+y');
});

test('MermaidWidget.toDOM shows a rendering placeholder then swaps in the SVG', async () => {
  const rendered = Promise.resolve('<svg>diagram</svg>');
  const blocks = { mermaidSVG: () => rendered, mermaidErrorEl: () => document.createElement('div') };
  const fakeView = { state: { facet: (f) => (f === blocksFacet ? blocks : undefined) } };
  const el = new MermaidWidget('graph TD; a-->b', '8px', 'light').toDOM(fakeView);
  assert.equal(el.className, 'cm-lp-mermaid');
  assert.equal(el.style.paddingBottom, '8px');
  assert.equal(el.textContent, 'Rendering diagram…');
  await rendered;
  await Promise.resolve();
  assert.equal(el.innerHTML, '<svg>diagram</svg>');
});

test('MermaidWidget.toDOM replaces the placeholder with the error element on failure', async () => {
  const err = new Error('bad diagram');
  const failed = Promise.reject(err);
  let errCall = null;
  const blocks = {
    mermaidSVG: () => failed,
    mermaidErrorEl: (src, e) => { errCall = { src, e }; const d = document.createElement('div'); d.className = 'cm-lp-mermaid-error'; return d; },
  };
  const fakeView = { state: { facet: () => blocks } };
  const el = new MermaidWidget('graph TD; a-->b', null, 'light').toDOM(fakeView);
  await failed.catch(() => {});
  await Promise.resolve();
  assert.equal(errCall.src, 'graph TD; a-->b');
  assert.equal(errCall.e, err);
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0].className, 'cm-lp-mermaid-error');
});

function collectGaps(state) {
  const lines = [];
  const widgets = [];
  state.field(editBlockField).between(0, state.doc.length, (from, to, deco) => {
    if (deco.spec.attributes && deco.spec.attributes.style) lines.push(deco.spec.attributes.style);
    if (deco.spec.widget && deco.spec.widget.gap != null) widgets.push(deco.spec.widget.gap);
  });
  return { lines, widgets };
}

function gapStateFor(doc) {
  return EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [markdown({ base: markdownLanguage }), blocksFacet.of({}), editBlockField],
  });
}

test('blockGaps folds a heading-to-paragraph gap into a max() of the two margins, no blank line', () => {
  const { lines } = collectGaps(gapStateFor('# Title\nSome text.'));
  assert.deepEqual(lines, ['padding-bottom:max(var(--h1-mb), 0px)']);
});

test('blockGaps subtracts a line height when a blank line already separates the blocks', () => {
  const { lines } = collectGaps(gapStateFor('# Title\n\nSome text.'));
  assert.deepEqual(lines, [
    'padding-bottom:max(0px, calc(max(var(--h1-mb), 0px) - var(--doc-lh)))',
  ]);
});

test('blockGaps uses the plain margin with no max() when adjacent blocks share the same edge value', () => {
  const { widgets } = collectGaps(gapStateFor('```\ncode1\n```\n```\ncode2\n```'));
  assert.deepEqual(widgets, ['var(--block-m)']);
});

test('blockGaps subtracts a line height for same-edge blocks separated by a blank line too', () => {
  const { widgets } = collectGaps(gapStateFor('```\ncode1\n```\n\n```\ncode2\n```'));
  assert.deepEqual(widgets, ['max(0px, calc(var(--block-m) - var(--doc-lh)))']);
});

test('blockGaps folds a paragraph-to-blockquote gap using max() of paragraph and block margins', () => {
  const { lines } = collectGaps(gapStateFor('para text\n> quoted'));
  assert.deepEqual(lines, ['padding-bottom:max(var(--p-mb), var(--block-m))']);
});

test('blockGaps applies the blank-line subtraction to a paragraph-to-blockquote gap', () => {
  const { lines } = collectGaps(gapStateFor('para text\n\n> quoted'));
  assert.deepEqual(lines, [
    'padding-bottom:max(0px, calc(max(var(--p-mb), var(--block-m)) - var(--doc-lh)))',
  ]);
});
