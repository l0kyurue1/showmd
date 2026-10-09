import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { forceParsing, syntaxTree } from '@codemirror/language';

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
  paragraphKind,
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
    forceParsing(EditorView.findFromDOM(host), doc.length, 5000);
    editor.jumpToLine(doc.split('\n').length);
    await new Promise((resolve) => requestAnimationFrame(resolve));

    await t.test('nested bullets expose the expected UA shapes per depth', () => {
      assert.deepEqual([...host.querySelectorAll('.cm-lp-bullet')].map((el) => el.className),
        ['cm-lp-bullet cm-lp-bullet-disc', 'cm-lp-bullet cm-lp-bullet-circle']);
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
      assert.equal(mermaidCall.target.style.paddingBottom, '');
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

test('blockGaps adds padding only where no blank line carries the gap', () => {
  const cases = [
    ['heading to paragraph', 'lines', '# Title\nSome text.', ['padding-bottom:max(var(--h1-mb), 0px)']],
    ['heading to paragraph with blank line', 'lines', '# Title\n\nSome text.', []],
    ['same-edge code blocks', 'widgets', '```\ncode1\n```\n```\ncode2\n```', ['var(--block-m)']],
    ['same-edge code blocks with blank line', 'widgets', '```\ncode1\n```\n\n```\ncode2\n```', []],
    ['paragraph to blockquote', 'lines', 'para text\n> quoted', [
      'padding-bottom:max(var(--p-mb), var(--block-m))',
    ]],
    ['paragraph to blockquote with blank line', 'lines', 'para text\n\n> quoted', []],
    ['list to heading keeps a task item bottom padding', 'lines', '- a\n# T', [
      'padding-bottom:calc(max(var(--p-mb), var(--h1-mt)) + var(--tail-pad, 0px))',
    ]],
  ];

  for (const [name, decorationKind, doc, expected] of cases) {
    assert.deepEqual(collectGaps(gapStateFor(doc))[decorationKind], expected, name);
  }
});

test('only a paragraph that is one whole $$ span gets block edges', () => {
  const edges = (doc) => collectGaps(gapStateFor(doc + '\n- a')).lines;
  assert.deepEqual(edges('$$\nx\n$$'), ['padding-bottom:max(var(--block-m), 0px)']);
  assert.deepEqual(edges('$$a$$ and $$b$$'), ['padding-bottom:max(var(--p-mb), 0px)']);
});

test('setext headings get the same line class as ATX headings', () => {
  for (const [doc, cls] of [['Title\n===\n\nx', 'cm-lp-h1'], ['Title\n---\n\nx', 'cm-lp-h2']]) {
    const { editor, view } = editorAt(doc, doc.length);
    try {
      assert.equal(view.dom.querySelector('.cm-line').classList.contains(cls), true, doc);
    } finally {
      editor.destroy();
    }
  }
});

const appCss = readFileSync(new URL('../../../client/app.css', import.meta.url), 'utf8');
const rootVars = new Map(
  [...appCss.match(/^:root\s*\{[\s\S]*?\n\}/m)[0].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
);

function px(expr) {
  let e = expr;
  while (/var\(/.test(e)) e = e.replace(/var\((--[\w-]+)(?:,[^)]*)?\)/g, (_, name) => `(${rootVars.get(name)})`);
  e = e.replace(/(\d*\.?\d+)px/g, '$1').replace(/\bmax\(/g, 'Math.max(').replace(/\bcalc\(/g, '(');
  return Function(`return ${e}`)();
}

function sepHeights(doc) {
  const { editor, view } = editorAt(doc, doc.length, stubBlocks);
  try {
    return [...view.dom.querySelectorAll('.cm-lp-sep')].map((el) => el.getAttribute('style').replace(/^height:/, ''));
  } finally {
    editor.destroy();
  }
}

test('a separator carries the read-mode distance between its neighbours', () => {
  const cases = [
    ['p to p', 'a\n\nb', 'max(var(--p-mb), 0px)', 12],
    ['heading to p', '# T\n\nb', 'max(var(--h1-mb), 0px)', 10],
    ['h3 to p', '### T\n\nb', 'max(var(--h3-mb), 0px)', 8],
    ['block to p', '> q\n\nb', 'max(var(--block-m), 0px)', 14],
    ['p to block', 'a\n\n> q', 'max(var(--p-mb), var(--block-m))', 14],
    ['p to h1', 'a\n\n# T', 'max(var(--p-mb), var(--h1-mt))', 40],
    ['p to h2', 'a\n\n## T', 'max(var(--p-mb), var(--h2-mt))', 32],
    ['p to hr', 'a\n\n---\n\nb', 'max(var(--p-mb), var(--hr-m))', 24],
  ];
  for (const [name, doc, expected, readPx] of cases) {
    const [first] = sepHeights(doc);
    assert.equal(first, expected, name);
    assert.equal(px(first), readPx, `${name} resolved`);
  }
  assert.equal(sepHeights('a\n\n---\n\nb')[1], 'max(var(--hr-m), 0px)');
});

test('an empty paragraph spans the same height as its read-mode p.md-empty-para', () => {
  const lh = px('var(--doc-lh)');
  const readMargin = px(appCss.match(/\.doc p \{ margin-bottom: (var\(--p-mb\)); \}/)[1]);
  assert.ok(/\.doc p\.md-empty-para \{ min-height: 1lh; \}/.test(appCss));

  const [before, after] = sepHeights('a\n\n\n\nb');
  assert.deepEqual([before, after], ['var(--p-mb)', 'max(var(--p-mb), 0px)']);
  assert.equal(px(before) + lh + px(after), readMargin + lh + readMargin);

  const [h1Before, h1After] = sepHeights('# T\n\n\n\n# U');
  assert.equal(px(h1Before) + lh + px(h1After), px('var(--h1-mb)') + lh + px('var(--h1-mt)'));
});

test('an even blank run puts the last gap under the empty paragraph', () => {
  const { editor, view } = editorAt('a\n\n\nb', 0, stubBlocks);
  try {
    assert.deepEqual([...view.dom.querySelectorAll('.cm-lp-sep')].map((el) => el.getAttribute('style')), ['height:var(--p-mb)']);
    const padded = [...view.dom.querySelectorAll('.cm-line')].filter((el) => (el.getAttribute('style') || '').includes('padding-bottom'));
    assert.equal(padded.length, 1);
    assert.equal(padded[0].textContent, '');
    assert.match(padded[0].getAttribute('style'), /padding-bottom: ?max\(var\(--p-mb\), 0px\)/);
  } finally {
    editor.destroy();
  }
});

test('a separator beside a block without a read margin stays one line tall', () => {
  assert.deepEqual(sepHeights('<div>x</div>\n\nb'), ['var(--doc-lh)']);
});

test('hr, task and nested list lines get the classes that carry their read-mode geometry', () => {
  const doc = '---\n\n- [ ] a\n- [ ] b\n\n- c\n  - d\n- e';
  const { editor, view } = editorAt(doc, doc.length, stubBlocks);
  try {
    const classes = [...view.dom.querySelectorAll('.cm-line')].map((el) => el.className);
    assert.ok(classes[0].includes('cm-lp-hr-line'));
    assert.ok(classes[1].includes('cm-lp-task-first') && classes[1].includes('cm-lp-task-last'));
    assert.ok(classes[2].includes('cm-lp-task-first') && classes[2].includes('cm-lp-task-last'));
    assert.deepEqual(classes.map((c) => c.includes('cm-lp-nested-end')), [false, false, false, false, false, true, false]);
  } finally {
    editor.destroy();
  }
});

test('edit decorations catch up when the syntax tree finishes parsing without a doc change', () => {
  const doc = `${`${'x'.repeat(1000)}\n`.repeat(4)}\n- c\n  - d\n- e`;
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const editor = createEditor(host, { doc, onChange() {}, onSave() {}, onToggleMode() {}, blocks: stubBlocks });
  try {
    editor.setEdit(true);
    const view = EditorView.findFromDOM(host);
    const nestedEnds = () => view.dom.querySelectorAll('.cm-lp-nested-end').length;
    view.dispatch({ selection: { anchor: doc.length }, scrollIntoView: true });
    view.measure();
    assert.ok(syntaxTree(view.state).length < doc.length);
    assert.equal(nestedEnds(), 0);
    forceParsing(view, doc.length, 5000);
    assert.equal(syntaxTree(view.state).length, doc.length);
    assert.equal(nestedEnds(), 1);
  } finally {
    editor.destroy();
  }
});

test('hard-wrapped list item lines share the content column', async () => {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const doc = [
    '1. first line of the item',
    '   wrapped continuation',
    'lazy continuation',
    '- [ ] task item',
    '  task continuation',
    '',
    'tail',
  ].join('\n');
  const editor = createEditor(host, { doc, onChange() {}, onSave() {}, onToggleMode() {}, blocks: {} });
  try {
    editor.setEdit(true);
    forceParsing(EditorView.findFromDOM(host), doc.length, 5000);
    editor.jumpToLine(7);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const lines = [...host.querySelectorAll('.cm-line')];
    const hung = lines.slice(0, 5).map((el) => el.style.paddingLeft !== '' && el.style.textIndent !== '');
    assert.deepEqual(hung, [true, true, true, true, true]);
    assert.equal(lines[1].textContent, 'wrapped continuation');
    assert.equal(lines[2].textContent, 'lazy continuation');
    assert.equal(lines[4].textContent, 'task continuation');
    assert.equal(lines[5].style.paddingLeft, '');
  } finally {
    editor.destroy();
  }
});

function pressKey(view, key, shiftKey = false) {
  view.contentDOM.dispatchEvent(new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
}

function editorAt(doc, pos, blocks = {}) {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const editor = createEditor(host, { doc, onChange() {}, onSave() {}, onToggleMode() {}, blocks });
  editor.setEdit(true);
  const view = EditorView.findFromDOM(host);
  forceParsing(view, view.state.doc.length, 5000);
  view.dispatch({ selection: { anchor: pos } });
  view.focus();
  return { editor, view };
}

function editorAtSource(doc, pos, selectionHead = pos) {
  const { editor, view } = editorAt(doc, pos);
  editor.setEdit(false);
  view.dispatch({ selection: { anchor: pos, head: selectionHead } });
  return { editor, view };
}

function typeText(view, text) {
  const { from, to } = view.state.selection.main;
  view.dispatch(view.state.update({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: 'input.type',
  }));
}

test('Enter mid-paragraph splits into a new paragraph and drops the surrounding space', () => {
  const { editor, view } = editorAt('hello world', 5);
  try {
    pressKey(view, 'Enter');
    assert.equal(view.state.doc.toString(), 'hello\n\nworld');
    assert.equal(view.state.selection.main.head, 7);
  } finally {
    editor.destroy();
  }
});

test('Enter at the end of a heading or paragraph opens a blank line and a fresh line', () => {
  for (const doc of ['foo', '# Title']) {
    const { editor, view } = editorAt(doc, doc.length);
    try {
      pressKey(view, 'Enter');
      assert.equal(view.state.doc.toString(), doc + '\n\n');
      assert.equal(view.state.selection.main.head, doc.length + 2);
    } finally {
      editor.destroy();
    }
  }
});

test('Enter in front of a hard break consumes the marker', () => {
  const { editor, view } = editorAt('a  \nb', 1);
  try {
    pressKey(view, 'Enter');
    assert.equal(view.state.doc.toString(), 'a\n\nb');
  } finally {
    editor.destroy();
  }
});

test('Enter at the start of a line after a hard break consumes the marker', () => {
  for (const [doc, pos] of [['foo  \nbar', 6], ['foo\\\nbar', 5], ['foo  \n  bar', 6]]) {
    const { editor, view } = editorAt(doc, pos);
    try {
      pressKey(view, 'Enter');
      assert.equal(view.state.doc.toString(), 'foo\n\nbar', JSON.stringify(doc));
      assert.equal(view.state.selection.main.head, 5);
    } finally {
      editor.destroy();
    }
  }
});

test('Enter with a selection on a blank line replaces it without throwing', () => {
  const { editor, view } = editorAt('a  \n\nb', 0);
  try {
    view.dispatch({ selection: { anchor: 0, head: 4 } });
    pressKey(view, 'Enter');
    assert.equal(view.state.doc.toString(), '\n\nb');
  } finally {
    editor.destroy();
  }
});

test('Enter and Shift-Enter ask the view to scroll the cursor into view', () => {
  const { editor, view } = editorAt('one two', 3);
  try {
    const seen = [];
    view.dispatch({
      effects: StateEffect.appendConfig.of(EditorView.updateListener.of((update) => {
        if (update.docChanged) seen.push(update.transactions.some((t) => t.scrollIntoView));
      })),
    });
    pressKey(view, 'Enter');
    pressKey(view, 'Enter', true);
    assert.deepEqual(seen, [true, true]);
  } finally {
    editor.destroy();
  }
});

test('Shift-Enter writes two trailing spaces and a newline', () => {
  const { editor, view } = editorAt('foo bar', 3);
  try {
    pressKey(view, 'Enter', true);
    assert.equal(view.state.doc.toString(), 'foo  \nbar');
    assert.equal(view.state.selection.main.head, 6);
  } finally {
    editor.destroy();
  }
});

test('Shift-Enter after trailing spaces does not stack a third space', () => {
  const { editor, view } = editorAt('foo  ', 5);
  try {
    pressKey(view, 'Enter', true);
    assert.equal(view.state.doc.toString(), 'foo  \n');
  } finally {
    editor.destroy();
  }
});

test('a space typed in front of a hard break stays visible text', () => {
  const { editor, view } = editorAt('foo  \nbar', 3);
  try {
    typeText(view, ' ');
    assert.equal(view.state.doc.toString(), 'foo   \nbar');
    assert.equal(view.state.selection.main.head, 4);
    typeText(view, 'x');
    assert.equal(view.state.doc.toString(), 'foo x  \nbar');
    assert.equal(view.state.selection.main.head, 5);
  } finally {
    editor.destroy();
  }
});

test('no hard-break glyph is drawn in Edit Mode or Source mode', () => {
  for (const doc of ['foo  \nbar', 'foo\\\nbar']) {
    const edit = editorAt(doc, 0);
    try {
      assert.equal(edit.view.dom.querySelector('.cm-line').textContent, 'foo');
      assert.equal(edit.view.dom.querySelectorAll('.cm-lp-break').length, 0);
      edit.editor.setEdit(false);
      assert.equal(edit.view.dom.querySelector('.cm-line').textContent, doc.split('\n')[0]);
      assert.equal(edit.view.dom.querySelectorAll('.cm-lp-break').length, 0);
    } finally {
      edit.editor.destroy();
    }
  }
});

test('Source mode hides no separator lines', () => {
  const { editor, view } = editorAt('foo\n\nbar', 0);
  try {
    assert.equal(view.dom.querySelectorAll('.cm-lp-sep').length, 1);
    assert.equal(view.dom.querySelectorAll('.cm-line').length, 2);
    editor.setEdit(false);
    assert.equal(view.dom.querySelectorAll('.cm-lp-sep').length, 0);
    assert.equal(view.dom.querySelectorAll('.cm-line').length, 3);
  } finally {
    editor.destroy();
  }
});

test('Backspace and Delete next to a hard break remove marker and newline together', () => {
  assert.equal(docAfter('foo  \nbar', 6, (v) => pressKey(v, 'Backspace')).text, 'foobar');
  assert.equal(docAfter('foo  \nbar', 3, (v) => pressKey(v, 'Delete')).text, 'foobar');
  assert.equal(docAfter('foo\\\nbar', 3, (v) => pressKey(v, 'Delete')).text, 'foobar');
  assert.equal(docAfter('foo\\\nbar', 5, (v) => pressKey(v, 'Backspace')).text, 'foobar');
  const out = docAfter('foo  \nbar', 6, (v) => pressKey(v, 'Backspace'));
  assert.equal(out.head, 3);
});

test('deleting a selection that ends inside the marker takes the whole break', () => {
  const out = docAfter('foo  \nbar', 2, (v) => {
    v.dispatch({ selection: { anchor: 2, head: 4 } });
    pressKey(v, 'Backspace');
  });
  assert.equal(out.text, 'fobar');
  assert.equal(out.head, 2);
  const start = docAfter('foo  \nbar', 4, (v) => {
    v.dispatch({ selection: { anchor: 4, head: 6 } });
    pressKey(v, 'Delete');
  });
  assert.equal(start.text, 'foobar');
});

test('Source mode keeps the default Enter, Shift-Enter and Backspace', () => {
  const enter = editorAtSource('para', 4);
  try {
    pressKey(enter.view, 'Enter');
    assert.equal(enter.view.state.doc.toString(), 'para\n');
  } finally {
    enter.editor.destroy();
  }
  const shift = editorAtSource('para', 4);
  try {
    pressKey(shift.view, 'Enter', true);
    assert.equal(shift.view.state.doc.toString(), 'para\n');
  } finally {
    shift.editor.destroy();
  }
  const back = editorAtSource('foo  \nbar', 5);
  try {
    pressKey(back.view, 'Backspace');
    assert.equal(back.view.state.doc.toString(), 'foo \nbar');
  } finally {
    back.editor.destroy();
  }
});

test('Enter on the visible blank line after a paragraph inserts a single newline', () => {
  const out = docAfter('first\n', 6, (v) => pressKey(v, 'Enter'));
  assert.equal(out.text, 'first\n\n');
  assert.equal(out.head, 7);
});

test('Enter inside a fenced code block inserts a single newline', () => {
  const doc = '```js\nconst x = 1\n```';
  const pos = '```js\nconst x = 1'.length;
  const { editor, view } = editorAt(doc, pos);
  try {
    pressKey(view, 'Enter');
    assert.equal(view.state.doc.toString(), doc.slice(0, pos) + '\n' + doc.slice(pos));
  } finally {
    editor.destroy();
  }
});

test('Enter at end of a list item still continues the list', () => {
  const { editor, view } = editorAt('- item 1', 8);
  try {
    pressKey(view, 'Enter');
    assert.equal(view.state.doc.toString(), '- item 1\n- ');
  } finally {
    editor.destroy();
  }
});

test('Enter at the end of a numbered item continues the numbering', () => {
  const { editor, view } = editorAt('1. a', 4);
  try {
    pressKey(view, 'Enter');
    assert.equal(view.state.doc.toString(), '1. a\n2. ');
  } finally {
    editor.destroy();
  }
});

test('Shift+Enter after plain text inserts a bare hard break', () => {
  const { editor, view } = editorAt('plain', 5);
  try {
    pressKey(view, 'Enter', true);
    assert.equal(view.state.doc.toString(), 'plain  \n');
  } finally {
    editor.destroy();
  }
});

test('Shift+Enter in a list item continues the indent, not the marker', () => {
  const { editor, view } = editorAt('- item', 6);
  try {
    pressKey(view, 'Enter', true);
    assert.equal(view.state.doc.toString(), '- item  \n  ');
  } finally {
    editor.destroy();
  }
});

test('Shift+Enter in a blockquote continues the quote marker', () => {
  const { editor, view } = editorAt('> quote', 7);
  try {
    pressKey(view, 'Enter', true);
    assert.equal(view.state.doc.toString(), '> quote  \n> ');
  } finally {
    editor.destroy();
  }
});

test('Enter on a blank line makes a paragraph and drops the dangling hard break above', () => {
  const { editor, view } = editorAt('a  \n', 4);
  try {
    pressKey(view, 'Enter');
    assert.equal(view.state.doc.toString(), 'a\n\n');
    assert.equal(view.state.selection.main.head, 3);
  } finally {
    editor.destroy();
  }
});

test('arrow keys step over the whole hard-break marker', () => {
  const { editor, view } = editorAt('a  \nb', 4);
  try {
    pressKey(view, 'ArrowLeft');
    assert.equal(view.state.selection.main.head, 1);
    pressKey(view, 'ArrowRight');
    assert.equal(view.state.selection.main.head, 4);
  } finally {
    editor.destroy();
  }
});

const stubBlocks = { renderBlockInto() {} };

function docAfter(doc, pos, run) {
  const { editor, view } = editorAt(doc, pos, stubBlocks);
  try {
    run(view);
    return { text: view.state.doc.toString(), head: view.state.selection.main.head };
  } finally {
    editor.destroy();
  }
}

test('Enter at the end of the line after a hard break does not throw or touch the doc end', () => {
  for (const pos of [9, 7]) {
    const out = docAfter('foo  \nbar', pos, (v) => pressKey(v, 'Enter'));
    assert.equal(out.text.startsWith('foo  \n'), true);
    assert.equal(out.text.includes('\n\n'), true);
  }
  assert.equal(docAfter('foo  \nbar', 9, (v) => pressKey(v, 'Enter')).text, 'foo  \nbar\n\n');
  assert.equal(docAfter('foo  \nbar', 7, (v) => pressKey(v, 'Enter')).text, 'foo  \nb\n\nar');
  const sel = docAfter('foo  \nbar', 2, (v) => {
    v.dispatch({ selection: { anchor: 2, head: 7 } });
    pressKey(v, 'Enter');
  });
  assert.equal(sel.text, 'fo\n\nar');
});

test('typing at the end of a hard-break line lands in front of the marker', () => {
  const end = docAfter('foo  \nbar', 0, (v) => {
    v.dispatch({ selection: { anchor: 5 } });
    typeText(v, 'x');
  });
  assert.equal(end.text, 'foox  \nbar');
  assert.equal(end.head, 4);
});

test('Enter right after a backslash break consumes the marker and its newline', () => {
  const out = docAfter('foo\\\nbar', 4, (v) => pressKey(v, 'Enter'));
  assert.equal(out.text, 'foo\n\nbar');
});

test('Shift-Enter after an existing marker only moves the cursor to the next line start', () => {
  const out = docAfter('foo  \nbar', 5, (v) => pressKey(v, 'Enter', true));
  assert.equal(out.text, 'foo  \nbar');
  assert.equal(out.head, 6);
});

test('Shift-Enter at a paragraph end puts the cursor on a visible continuation line', () => {
  for (const [doc, pos, text, head, typed] of [
    ['abc\n\nnext', 3, 'abc  \n\n\nnext', 6, 'abc  \nx\n\nnext'],
    ['abc  \ndef\n\nnext', 9, 'abc  \ndef  \n\n\nnext', 12, 'abc  \ndef  \nx\n\nnext'],
  ]) {
    const out = docAfter(doc, pos, (v) => pressKey(v, 'Enter', true));
    assert.equal(out.text, text);
    assert.equal(out.head, head);
    const typedOut = docAfter(doc, pos, (v) => { pressKey(v, 'Enter', true); typeText(v, 'x'); });
    assert.equal(typedOut.text, typed);
    const back = docAfter(doc, pos, (v) => { pressKey(v, 'Enter', true); pressKey(v, 'Backspace'); });
    assert.equal(back.text, doc);
    assert.equal(back.head, pos);
  }
});

test('a stray double space before a blank line keeps the normal separator layout', () => {
  const { editor, view } = editorAt('abc  \n\nnext', 0);
  try {
    assert.equal(view.dom.querySelectorAll('.cm-lp-sep').length, 1);
    assert.equal(paragraphKind(view.state, 2).kind, 'sep');
  } finally {
    editor.destroy();
  }
});

test('the cursor leaves an untouched continuation line and never rests on a separator', () => {
  const { editor, view } = editorAt('abc\n\nnext', 3);
  try {
    pressKey(view, 'Enter', true);
    assert.equal(view.state.selection.main.head, 6);
    pressKey(view, 'ArrowUp');
    assert.equal(view.state.doc.lineAt(view.state.selection.main.head).number, 1);
    assert.equal(paragraphKind(view.state, 2).kind, 'sep');
    pressKey(view, 'ArrowDown');
    const down = view.state.doc.lineAt(view.state.selection.main.head).number;
    assert.notEqual(paragraphKind(view.state, down).kind, 'sep');
  } finally {
    editor.destroy();
  }
});

test('Enter on an empty continuation line gives the same doc as Enter at the paragraph end', () => {
  const plain = docAfter('abc\n\nnext', 3, (v) => pressKey(v, 'Enter'));
  const out = docAfter('abc\n\nnext', 3, (v) => { pressKey(v, 'Enter', true); pressKey(v, 'Enter'); });
  assert.equal(out.text, plain.text);
  assert.equal(out.head, plain.head);
});

test('Shift-Enter on an empty continuation line takes the Enter path', () => {
  const viaEnter = docAfter('abc\n\nnext', 3, (v) => { pressKey(v, 'Enter', true); pressKey(v, 'Enter'); });
  const twice = docAfter('abc\n\nnext', 3, (v) => { pressKey(v, 'Enter', true); pressKey(v, 'Enter', true); });
  assert.equal(twice.text, viaEnter.text);
  assert.equal(twice.head, viaEnter.head);
  assert.doesNotMatch(twice.text, /^ +$/m);
});

test('Shift-Enter at the start of a paragraph behaves like Enter', () => {
  const out = docAfter('a\n\nb', 3, (v) => pressKey(v, 'Enter', true));
  assert.equal(out.text, 'a\n\n\n\nb');
  assert.equal(out.head, 5);
});

test('Shift-Enter in a heading splits the paragraph like Enter', () => {
  const out = docAfter('# Ti tle', 4, (v) => pressKey(v, 'Enter', true));
  assert.equal(out.text, '# Ti\n\ntle');
});

function headAfter(doc, pos, keys) {
  return docAfter(doc, pos, (v) => { for (const key of keys) pressKey(v, key); }).head;
}

test('separator lines render as one block widget each and are skipped by the cursor', () => {
  const { editor, view } = editorAt('foo\n\nbar', 0);
  try {
    assert.equal(view.dom.querySelectorAll('.cm-lp-sep').length, 1);
    pressKey(view, 'ArrowDown');
    assert.equal(view.state.selection.main.head, 5);
    pressKey(view, 'ArrowUp');
    assert.equal(view.state.selection.main.head, 0);
  } finally {
    editor.destroy();
  }
  assert.equal(headAfter('foo\n\nbar', 5, ['ArrowLeft']), 3);
  assert.equal(headAfter('foo\n\nbar', 5, ['ArrowUp']), 0);
  assert.equal(headAfter('foo\n\nbar', 3, ['ArrowRight']), 5);
});

test('a click on the gap lands on a neighbouring line', () => {
  const { editor, view } = editorAt('foo\n\nbar', 0);
  try {
    view.dispatch({ selection: { anchor: 4 }, userEvent: 'select.pointer' });
    assert.ok([3, 5].includes(view.state.selection.main.head));
  } finally {
    editor.destroy();
  }
});

test('an odd blank run is one separator, an even run adds an empty paragraph', () => {
  assert.equal(headAfter('foo\n\nbar', 0, ['ArrowDown']), 5);
  const { editor, view } = editorAt('foo\n\n\n\nbar', 0);
  try {
    assert.equal(view.dom.querySelectorAll('.cm-lp-sep').length, 2);
    pressKey(view, 'ArrowDown');
    assert.equal(view.state.selection.main.head, 5);
    pressKey(view, 'ArrowDown');
    assert.equal(view.state.selection.main.head, 7);
  } finally {
    editor.destroy();
  }
});

test('a blank run inside a list or fenced code keeps every line', () => {
  const { editor, view } = editorAt('- a\n\n\n- b\n\n```\nx\n\n\ny\n```', 0, stubBlocks);
  try {
    assert.equal(view.dom.querySelectorAll('.cm-lp-sep').length, 1);
  } finally {
    editor.destroy();
  }
});

test('the last line of the document is never a hidden separator', () => {
  const { editor, view } = editorAt('foo\n', 4);
  try {
    assert.equal(view.dom.querySelectorAll('.cm-lp-sep').length, 0);
    assert.equal(view.state.selection.main.head, 4);
  } finally {
    editor.destroy();
  }
});

test('Enter on an empty paragraph adds a separator and a new empty paragraph', () => {
  const out = docAfter('foo\n\n', 5, (v) => pressKey(v, 'Enter'));
  assert.equal(out.text, 'foo\n\n\n\n');
  assert.equal(out.head, 7);
  const mid = docAfter('foo\n\n\n\nbar', 5, (v) => pressKey(v, 'Enter'));
  assert.equal(mid.text, 'foo\n\n\n\n\n\nbar');
  assert.equal(mid.head, 7);
});

test('Backspace at the start of an empty paragraph removes it with its separator', () => {
  const end = docAfter('foo\n\n', 5, (v) => pressKey(v, 'Backspace'));
  assert.equal(end.text, 'foo');
  assert.equal(end.head, 3);
  const mid = docAfter('foo\n\n\n\nbar', 5, (v) => pressKey(v, 'Backspace'));
  assert.equal(mid.text, 'foo\n\nbar');
  assert.equal(mid.head, 3);
  const two = docAfter('foo\n\n\nbar', 5, (v) => pressKey(v, 'Backspace'));
  assert.equal(two.text, 'foo\n\nbar');
  assert.equal(two.head, 3);
});

test('Backspace and Delete in a non-empty paragraph remove an empty paragraph next to it', () => {
  assert.equal(docAfter('foo\n\n\n\nbar', 7, (v) => pressKey(v, 'Backspace')).text, 'foo\n\nbar');
  assert.equal(docAfter('foo\n\n\nbar', 6, (v) => pressKey(v, 'Backspace')).text, 'foo\n\nbar');
  assert.equal(docAfter('foo\n\n\n\nbar', 3, (v) => pressKey(v, 'Delete')).text, 'foo\n\nbar');
  assert.equal(docAfter('foo\n\n\nbar', 3, (v) => pressKey(v, 'Delete')).text, 'foo\n\nbar');
  assert.equal(docAfter('foo\n\n\n\nbar', 5, (v) => pressKey(v, 'Delete')).text, 'foo\n\nbar');
});

test('removing a neighbouring empty paragraph keeps the cursor in the paragraph it was in', () => {
  const back = docAfter('foo\n\n\n\nbar', 7, (v) => pressKey(v, 'Backspace'));
  assert.equal(back.head, 5);
  const backOne = docAfter('foo\n\n\nbar', 6, (v) => pressKey(v, 'Backspace'));
  assert.equal(backOne.head, 5);
  const fwd = docAfter('foo\n\n\n\nbar', 3, (v) => pressKey(v, 'Delete'));
  assert.equal(fwd.head, 3);
  const fwdOne = docAfter('foo\n\n\nbar', 3, (v) => pressKey(v, 'Delete'));
  assert.equal(fwdOne.head, 3);
  const split = docAfter('## 3. hard\n\n第\n\n第二行 \n\n把游標', 16, (v) => {
    pressKey(v, 'Enter');
    pressKey(v, 'Enter');
    pressKey(v, 'Backspace');
  });
  assert.equal(split.text.slice(split.head), '二行 \n\n把游標');
});

test('Backspace at the start of a paragraph merges it into a paragraph or heading above', () => {
  const out = docAfter('foo\n\nbar', 5, (v) => pressKey(v, 'Backspace'));
  assert.equal(out.text, 'foobar');
  assert.equal(out.head, 3);
  assert.equal(docAfter('# Title\n\nbar', 9, (v) => pressKey(v, 'Backspace')).text, '# Titlebar');
});

test('Delete at the end of a paragraph merges the next paragraph in', () => {
  const out = docAfter('foo\n\nbar', 3, (v) => pressKey(v, 'Delete'));
  assert.equal(out.text, 'foobar');
  assert.equal(out.head, 3);
});

test('joining across a separator only moves the cursor when the other block is not a paragraph', () => {
  for (const above of ['- a\n- b', '```\ncode\n```', '> quote', '| a |\n| - |\n| 1 |', '<div>x</div>', 'Title\n=====']) {
    const doc = above + '\n\nbar';
    const back = docAfter(doc, doc.length - 3, (v) => pressKey(v, 'Backspace'));
    assert.equal(back.text, doc, above);
    assert.equal(back.head, above.length, above);
  }
  const doc = 'foo\n\n- a';
  const forward = docAfter(doc, 3, (v) => pressKey(v, 'Delete'));
  assert.equal(forward.text, doc);
  assert.equal(forward.head, 5);
  const heading = docAfter('foo\n\n# Title', 5, (v) => pressKey(v, 'Backspace'));
  assert.equal(heading.text, 'foo\n\n# Title');
  assert.equal(heading.head, 3);
});

test('existing soft breaks are left untouched on load', () => {
  const { editor, view } = editorAt('foo\nbar', 0);
  try {
    assert.equal(view.state.doc.toString(), 'foo\nbar');
    assert.equal(view.dom.querySelectorAll('.cm-lp-sep').length, 0);
  } finally {
    editor.destroy();
  }
});

test('Enter followed by Undo restores the document in one step', () => {
  const { editor, view } = editorAt('foo', 3);
  try {
    pressKey(view, 'Enter');
    editor.undo();
    assert.equal(view.state.doc.toString(), 'foo');
  } finally {
    editor.destroy();
  }
});

test('the caret next to a separator resolves to a text line, not the widget', () => {
  const inLine = (view, assoc) => {
    const node = view.domAtPos(view.state.selection.main.head, assoc || 1).node;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return Boolean(el.closest('.cm-line')) && !el.closest('.cm-lp-sep');
  };
  const enter = editorAt('P\n\n## H', 1);
  try {
    pressKey(enter.view, 'Enter');
    assert.equal(inLine(enter.view, 0), true);
  } finally {
    enter.editor.destroy();
  }
  const right = editorAt('foo\n\nbar', 3);
  try {
    pressKey(right.view, 'ArrowRight');
    assert.equal(right.view.state.selection.main.head, 5);
    assert.equal(inLine(right.view, -1), true);
    assert.equal(inLine(right.view, 1), true);
  } finally {
    right.editor.destroy();
  }
});

test('blank runs at the document start and after frontmatter stay visible lines', () => {
  const cases = [
    ['at the start', '\n\n\nbar', 4],
    ['after frontmatter', '---\na: b\n---\n\n\n\nbar', 7],
  ];
  for (const [name, doc, lines] of cases) {
    const { editor, view } = editorAt(doc, 0, stubBlocks);
    try {
      assert.equal(view.dom.querySelectorAll('.cm-lp-sep').length, 0, name);
      assert.equal(view.dom.querySelectorAll('.cm-line').length, lines, name);
    } finally {
      editor.destroy();
    }
  }
});

test('a blank run at the document end hides its first line and keeps the last one visible', () => {
  const cases = [
    ['one blank line', 'foo\n', 0, 2],
    ['two blank lines', 'foo\n\n', 1, 2],
    ['four blank lines', 'foo\n\n\n\n', 1, 4],
  ];
  for (const [name, doc, seps, lines] of cases) {
    const { editor, view } = editorAt(doc, doc.length, stubBlocks);
    try {
      assert.equal(view.dom.querySelectorAll('.cm-lp-sep').length, seps, name);
      assert.equal(view.dom.querySelectorAll('.cm-line').length, lines, name);
      const kind = paragraphKind(view.state, view.state.doc.lineAt(view.state.selection.main.head).number);
      assert.notEqual(kind && kind.kind, 'sep', name);
    } finally {
      editor.destroy();
    }
  }
  const typed = editorAt('foo', 3, stubBlocks);
  try {
    pressKey(typed.view, 'Enter');
    assert.equal(typed.view.dom.querySelectorAll('.cm-lp-sep').length, 1);
    assert.equal(px(sepHeights('foo\n\n')[0]), px(sepHeights('foo\n\nbar')[0]));
  } finally {
    typed.editor.destroy();
  }
});

test('a blank run after a list is split into separators the way read mode counts it', () => {
  const { editor, view } = editorAt('- a\n\n\n\nbar', 0, stubBlocks);
  try {
    assert.equal(view.dom.querySelectorAll('.cm-lp-sep').length, 2);
    assert.equal(view.dom.querySelectorAll('.cm-line').length, 3);
  } finally {
    editor.destroy();
  }
});

test('the cursor leaves a hidden separator after undo, redo and a switch from Source mode', async () => {
  const onSeparator = (view) => {
    const kind = paragraphKind(view.state, view.state.doc.lineAt(view.state.selection.main.head).number);
    return Boolean(kind) && kind.kind === 'sep';
  };
  const history = editorAt('foo\n\n\n\nbar', 5);
  try {
    pressKey(history.view, 'Backspace');
    history.editor.undo();
    await Promise.resolve();
    assert.equal(onSeparator(history.view), false);
    history.editor.redo();
    await Promise.resolve();
    assert.equal(history.view.state.doc.toString(), 'foo\n\nbar');
    assert.equal(onSeparator(history.view), false);
  } finally {
    history.editor.destroy();
  }
  const source = editorAtSource('foo\n\nbar', 4);
  try {
    assert.equal(source.view.state.selection.main.head, 4);
    source.editor.setEdit(true);
    await Promise.resolve();
    assert.equal(onSeparator(source.view), false);
  } finally {
    source.editor.destroy();
  }
});

test('hopping a separator keeps the horizontal goal, the hit side and aims at the near row of the target', () => {
  const { editor, view } = editorAt('foo\n\nbar baz', 3);
  try {
    const seen = [];
    let hit = { pos: 9, assoc: -1 };
    view.moveToLineBoundary = (_range, forward) => ({ head: forward ? 3 : 5 });
    view.coordsAtPos = () => ({ left: 40, right: 41, top: 0, bottom: 10 });
    view.lineBlockAt = () => ({ top: 100, bottom: 120 });
    view.posAndSideAtCoords = (coords) => { seen.push(coords); return hit; };
    pressKey(view, 'ArrowDown');
    const left = view.contentDOM.getBoundingClientRect().left;
    assert.equal(seen[0].x - left, 40);
    assert.equal(seen[0].y - view.documentTop, 101);
    let main = view.state.selection.main;
    assert.equal(main.head, 9);
    assert.equal(main.assoc, -1);
    assert.equal(main.goalColumn, 40);
    hit = { pos: 1, assoc: 1 };
    view.coordsAtPos = () => ({ left: 999, right: 1000, top: 0, bottom: 10 });
    pressKey(view, 'ArrowUp');
    main = view.state.selection.main;
    assert.equal(main.head, 1);
    assert.equal(main.assoc, 1);
    assert.equal(seen[1].x - left, 40);
    assert.equal(seen[1].y - view.documentTop, 119);
  } finally {
    editor.destroy();
  }
});

function orderedLabels(doc) {
  const { editor, view } = editorAt(doc, doc.length);
  try {
    return [...view.dom.querySelectorAll('.cm-lp-bullet-number')].map((el) => el.textContent);
  } finally {
    editor.destroy();
  }
}

test('ordered markers number by position from the start number and always end in a period', () => {
  assert.deepEqual(orderedLabels('1. a\n1. b\n1. c\n\ntail'), ['1. ', '2. ', '3. ']);
  assert.deepEqual(orderedLabels('3. a\n7. b\n1. c\n\ntail'), ['3. ', '4. ', '5. ']);
  assert.deepEqual(orderedLabels('1) a\n2) b\n\ntail'), ['1. ', '2. ']);
  assert.deepEqual(orderedLabels('1. a\n   1. x\n   1. y\n1. b\n\ntail'), ['1. ', '1. ', '2. ', '2. ']);
});
