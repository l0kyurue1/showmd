import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Window: dom.window.Window,
  MutationObserver: dom.window.MutationObserver,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
})) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({
  left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0,
});

const {
  blocksFacet,
  editBlockField,
  scanMath,
  scanMark,
  scanBlockMath,
  frontmatterEnd,
} = await import('../../../client/editor-blocks.js');
const { createEditor } = await import('../../../client/editor-src.js');

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
  const blocks = { renderBlockInto: async () => {} };
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

test('editBlockField builds Mermaid widgets without reading renderer theme details', () => {
  const blocks = { renderBlockInto: async () => {} };
  const doc = '```mermaid\ngraph TD; A-->B\n```\n\nafter';
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [markdown({ base: markdownLanguage }), blocksFacet.of(blocks), editBlockField],
  });
  assert.ok(state.field(editBlockField).size > 0);
});

test('the public editor extension renders block widgets and refreshes theme-dependent output', async (t) => {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const calls = [];
  const doc = [
    '- first',
    '  - nested',
    '- [x] done',
    '',
    '---',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '> quoted',
    '',
    'inline $x+y$',
    '',
    '$$',
    'z=1',
    '$$',
    '',
    '```mermaid',
    'graph TD; A-->B',
    '```',
    '',
    'tail',
  ].join('\n');
  const editor = createEditor(host, {
    doc,
    onChange() {},
    onSave() {},
    onToggleMode() {},
    blocks: {
      renderBlockInto(target, request) {
        calls.push({ target, request });
        target.textContent = `rendered:${request.kind}`;
      },
    },
  });

  try {
    editor.setEdit(true);
    editor.jumpToLine(doc.split('\n').length);
    await new Promise((resolve) => requestAnimationFrame(resolve));

    await t.test('nested bullets expose the expected public glyphs', () => {
      assert.deepEqual([...host.querySelectorAll('.cm-lp-bullet')].map((el) => el.textContent), ['•', '◦']);
    });
    await t.test('horizontal rules expose their marker host', () => {
      assert.ok(host.querySelector('.cm-lp-hr'));
    });
    await t.test('task markers expose a checked checkbox', () => {
      const task = host.querySelector('input.cb.cm-lp-task');
      assert.equal(task.type, 'checkbox');
      assert.equal(task.checked, true);
    });
    await t.test('markdown blocks delegate source through a document host', () => {
      const codeCall = calls.find(({ request }) => request.kind === 'markdown' && request.source.startsWith('```js'));
      assert.ok(codeCall);
      assert.match(codeCall.target.className, /\bdoc cm-lp-embed\b/);
      assert.equal(codeCall.target.textContent, 'rendered:markdown');
    });
    await t.test('inline math delegates through a span host', () => {
      const mathCall = calls.find(({ request }) => request.kind === 'math' && request.display === false);
      assert.deepEqual(mathCall.request, { kind: 'math', source: 'x+y', display: false });
      assert.equal(mathCall.target.tagName, 'SPAN');
      assert.equal(mathCall.target.className, 'cm-lp-math');
    });
    await t.test('display math delegates through a block host', () => {
      const mathCall = calls.find(({ request }) => request.kind === 'math' && request.display === true);
      assert.deepEqual(mathCall.request, { kind: 'math', source: 'z=1', display: true });
      assert.equal(mathCall.target.tagName, 'DIV');
      assert.equal(mathCall.target.className, 'cm-lp-math');
    });
    await t.test('Mermaid delegates source through its placement host', () => {
      const mermaidCall = calls.find(({ request }) => request.kind === 'mermaid');
      assert.deepEqual(mermaidCall.request, { kind: 'mermaid', source: 'graph TD; A-->B' });
      assert.equal(mermaidCall.target.className, 'cm-lp-mermaid');
      assert.notEqual(mermaidCall.target.style.paddingBottom, '');
    });
    await t.test('refreshBlocks replaces and rerenders Mermaid output', () => {
      const beforeCalls = calls.filter(({ request }) => request.kind === 'mermaid');
      const beforeHost = beforeCalls.at(-1).target;
      editor.refreshBlocks();
      const afterCalls = calls.filter(({ request }) => request.kind === 'mermaid');
      assert.equal(afterCalls.length, beforeCalls.length + 1);
      assert.notStrictEqual(afterCalls.at(-1).target, beforeHost);
      assert.equal(afterCalls.at(-1).target.textContent, 'rendered:mermaid');
    });
  } finally {
    editor.destroy();
    host.remove();
  }
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

test('blockGaps applies the margin contract across edge combinations and blank-line spacing', () => {
  const cases = [
    ['heading to paragraph', 'lines', '# Title\nSome text.', ['padding-bottom:max(var(--h1-mb), 0px)']],
    ['heading to paragraph with blank line', 'lines', '# Title\n\nSome text.', [
      'padding-bottom:max(0px, calc(max(var(--h1-mb), 0px) - var(--doc-lh)))',
    ]],
    ['same-edge code blocks', 'widgets', '```\ncode1\n```\n```\ncode2\n```', ['var(--block-m)']],
    ['same-edge code blocks with blank line', 'widgets', '```\ncode1\n```\n\n```\ncode2\n```', [
      'max(0px, calc(var(--block-m) - var(--doc-lh)))',
    ]],
    ['paragraph to blockquote', 'lines', 'para text\n> quoted', [
      'padding-bottom:max(var(--p-mb), var(--block-m))',
    ]],
    ['paragraph to blockquote with blank line', 'lines', 'para text\n\n> quoted', [
      'padding-bottom:max(0px, calc(max(var(--p-mb), var(--block-m)) - var(--doc-lh)))',
    ]],
  ];

  for (const [name, decorationKind, doc, expected] of cases) {
    assert.deepEqual(collectGaps(gapStateFor(doc))[decorationKind], expected, name);
  }
});
