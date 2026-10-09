import { EditorState, EditorSelection, Annotation, Compartment, Prec } from '@codemirror/state';
import { EditorView, Decoration, keymap, ViewPlugin, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo as histUndo, redo as histRedo } from '@codemirror/commands';
import { autocompletion } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, StreamLanguage, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { javascript, json, typescript } from '@codemirror/legacy-modes/mode/javascript';
import { python } from '@codemirror/legacy-modes/mode/python';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { css } from '@codemirror/legacy-modes/mode/css';
import { xml, html } from '@codemirror/legacy-modes/mode/xml';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { go } from '@codemirror/legacy-modes/mode/go';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { snippetAt, countBefore, nthIndex, hintLines } from './scroll-sync.js';
import { slashCompletions, slashTheme, slashGlide } from './editor-slash.js';
import { blocksFacet, blocksRefresh, editBlockField, buildEditDecos, separatorField, paragraphKind, hardBreakAround, hardBreakAtoms, frontmatterEnd } from './editor-blocks.js';

const codeLanguageMap = (() => {
  const langs = {};
  const add = (names, parser) => {
    const lang = StreamLanguage.define(parser);
    for (const n of names) langs[n] = lang;
  };
  add(['js', 'javascript', 'jsx', 'mjs', 'cjs'], javascript);
  add(['ts', 'typescript', 'tsx'], typescript);
  add(['json', 'jsonc'], json);
  add(['py', 'python'], python);
  add(['sh', 'bash', 'zsh', 'shell'], shell);
  add(['yaml', 'yml'], yaml);
  add(['css'], css);
  add(['html'], html);
  add(['xml', 'svg'], xml);
  add(['sql'], standardSQL);
  add(['go'], go);
  add(['rust', 'rs'], rust);
  add(['swift'], swift);
  add(['toml'], toml);
  return langs;
})();

const codeLanguages = (info) => codeLanguageMap[info.trim().toLowerCase()] || null;

const programmatic = Annotation.define();

const highlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold', textDecoration: 'none' },
  { tag: tags.emphasis, fontStyle: 'italic', textDecoration: 'none' },
  { tag: tags.strong, fontWeight: 'bold', textDecoration: 'none' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: 'var(--mono)', textDecoration: 'none' },
  { tag: [tags.link, tags.url], color: 'var(--accent)', textDecoration: 'none' },
  { tag: [tags.keyword, tags.operator], color: 'var(--code-kw)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--code-str)' },
  { tag: [tags.comment, tags.meta, tags.docComment], color: 'var(--code-cmt)' },
  { tag: [tags.number, tags.bool, tags.atom, tags.null], color: 'var(--code-num)' },
  { tag: [tags.typeName, tags.className, tags.tagName, tags.standard(tags.variableName)], color: 'var(--code-type)' },
  { tag: [tags.propertyName, tags.attributeName, tags.function(tags.variableName), tags.definition(tags.variableName), tags.labelName, tags.macroName], color: 'var(--code-fn)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-content': { fontFamily: 'var(--mono)', padding: 0, caretColor: 'var(--accent)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeft: '2px solid var(--accent)' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-selectionBackground': { backgroundColor: 'var(--accent-soft) !important' },
});

const editPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildEditDecos(view);
      this.atoms = hardBreakAtoms(view);
    }
    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = buildEditDecos(update.view);
      }
      if (update.docChanged || update.viewportChanged) this.atoms = hardBreakAtoms(update.view);
    }
  },
  { decorations: (v) => v.decorations }
);

const editHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: 'var(--h1-size)', fontWeight: 'var(--h1-weight)', letterSpacing: 'var(--h1-tracking)', lineHeight: 'var(--heading-line)' },
  { tag: tags.heading2, fontSize: 'var(--h2-size)', fontWeight: 'var(--h2-weight)', lineHeight: 'var(--heading-line)' },
  { tag: tags.heading3, fontSize: 'var(--h3-size)', fontWeight: 'var(--h3-weight)', lineHeight: 'var(--heading-line)' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontSize: 'var(--h456-size)', fontWeight: 'var(--h456-weight)', lineHeight: 'var(--heading-line)' },
  { tag: tags.monospace, fontFamily: 'var(--mono)', fontSize: 'var(--code-inline-size)', backgroundColor: 'var(--code-bg)', borderRadius: 'var(--code-inline-radius)', padding: 'var(--code-inline-pad)' },
]);

const editTheme = EditorView.theme({
  '&': { fontSize: 'var(--doc-size)' },
  '.cm-content': { fontFamily: 'var(--doc-font)' },
  '.cm-scroller': { fontFamily: 'var(--doc-font)', lineHeight: 'var(--doc-line)' },
  '.cm-line': { padding: 0 },
  '.cm-lp-h1': { fontSize: 'var(--h1-size)', letterSpacing: 'var(--h1-tracking)', lineHeight: 'var(--heading-line)' },
  '.cm-lp-h2': { fontSize: 'var(--h2-size)', lineHeight: 'var(--heading-line)' },
  '.cm-lp-h3': { fontSize: 'var(--h3-size)', lineHeight: 'var(--heading-line)' },
  '.cm-lp-h4': { fontSize: 'var(--h456-size)', lineHeight: 'var(--heading-line)' },
  '.cm-lp-h1 > span': { fontWeight: 'var(--h1-weight)' },
  '.cm-lp-h2 > span': { fontWeight: 'var(--h2-weight)' },
  '.cm-lp-h3 > span': { fontWeight: 'var(--h3-weight)' },
  '.cm-lp-h4 > span': { fontWeight: 'var(--h456-weight)' },
  '.cm-lp-mark': { background: 'var(--accent-soft)', borderRadius: '3px', padding: '0 2px' },
  '.cm-lp-quote': { borderLeft: 'var(--quote-bar) solid var(--accent)', paddingLeft: 'var(--quote-pad)', color: 'var(--muted)', fontStyle: 'italic' },
  '.cm-lp-bullet': { display: 'inline-block', position: 'relative', width: 'var(--list-indent)', textIndent: 0, color: 'inherit' },
  '.cm-lp-bullet-number': { direction: 'rtl', whiteSpace: 'pre', fontVariantNumeric: 'tabular-nums' },
  '.cm-lp-bullet-number > span': { direction: 'ltr', unicodeBidi: 'isolate', display: 'inline-block' },
  '.cm-lp-bullet-disc, .cm-lp-bullet-circle, .cm-lp-bullet-square': { height: '1em' },
  '.cm-lp-bullet-disc::before, .cm-lp-bullet-circle::before, .cm-lp-bullet-square::before': {
    content: '""', position: 'absolute', right: 'var(--bullet-gap)', bottom: 'var(--bullet-lift)',
    width: 'var(--bullet-size)', height: 'var(--bullet-size)', boxSizing: 'border-box',
  },
  '.cm-lp-bullet-disc::before': { background: 'currentColor', borderRadius: '50%' },
  '.cm-lp-bullet-circle::before': { border: '1px solid currentColor', borderRadius: '50%' },
  '.cm-lp-bullet-square::before': { background: 'currentColor' },
  '.cm-lp-task': { margin: '0 var(--task-gap) 0 0', accentColor: 'var(--accent)', position: 'relative', top: 'var(--task-top)' },
  '.cm-lp-hr-line': { boxSizing: 'border-box', height: 'var(--hr-w)', lineHeight: 0, overflow: 'hidden', borderTop: 'var(--hr-w) solid var(--line)' },
  '.cm-lp-task-done': { color: 'var(--muted)', textDecoration: 'line-through', textDecorationColor: 'var(--faint)' },
  '.cm-lp-task-first': { paddingTop: 'var(--task-pad)' },
  '.cm-lp-task-last': { paddingBottom: 'var(--task-pad)', '--tail-pad': 'var(--task-pad)' },
  '.cm-lp-nested-end': { paddingBottom: 'calc(var(--p-mb) + var(--tail-pad, 0px))' },
  '.cm-lp-code': { backgroundColor: 'var(--code-bg)', fontFamily: 'var(--mono)', fontSize: 'var(--code-block-size)', padding: '0 16px' },
  '.cm-lp-lang': { color: 'var(--muted)', fontSize: '12.5px', fontFamily: 'var(--mono)' },
  // Frontmatter line height must match body lines to preserve CodeMirror geometry.
  '.cm-lp-fm': { fontFamily: 'var(--mono)', fontSize: '12.5px', color: 'var(--muted)', lineHeight: 'var(--doc-lh)' },
  '.cm-lp-fm span': { fontSize: 'inherit !important', fontWeight: 'inherit !important', fontFamily: 'inherit !important', letterSpacing: '0 !important' },
  '.cm-lp-fm-end': { borderBottom: '1px solid var(--line)', paddingBottom: '16px' },
  // Avoid margins: they escape widgets and corrupt CodeMirror's height map.
  '.cm-lp-embed': { whiteSpace: 'normal' },
  '.doc.cm-lp-embed > *, .cm-lp-math > *, .cm-lp-mermaid > *': { margin: 0 },
  '.cm-lp-math': { textAlign: 'center', whiteSpace: 'normal' },
  '.cm-lp-mermaid': { display: 'flex', justifyContent: 'center', color: 'var(--muted)', whiteSpace: 'normal' },
});

// a rendered block occupies no visible lines, so vertical motion jumps clean over
// it; land the cursor inside instead, which un-renders it for editing
function enterRenderedBlock(view, forward) {
  const range = view.state.selection.main;
  const set = view.state.field(editBlockField, false);
  if (!range.empty || !set) return false;
  const doc = view.state.doc;
  const n = doc.lineAt(range.head).number + (forward ? 1 : -1);
  if (n < 1 || n > doc.lines) return false;
  const probe = doc.line(n);
  let hit = null;
  set.between(probe.from, probe.to, (from, to, value) => {
    if (value.spec && value.spec.block === true && from <= probe.from && to >= probe.to) {
      hit = { from, to };
      return false;
    }
  });
  if (!hit) return false;
  view.dispatch({ selection: { anchor: forward ? hit.from : hit.to }, scrollIntoView: true });
  return true;
}

// lang-markdown's Prec.high Enter binding is earlier in the extension list and
// handles list and quote continuation first; these bindings only see what it declines.
const editKeymap = Prec.high(keymap.of([
  { key: 'Enter', run: insertLineBreak },
  { key: 'Shift-Enter', run: insertHardBreak },
  { key: 'ArrowDown', run: (v) => hopSeparator(v, true) },
  { key: 'ArrowUp', run: (v) => hopSeparator(v, false) },
  { key: 'Backspace', run: joinBackward },
  { key: 'Delete', run: joinForward },
]));

const typingBeforeBreak = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input.type')) return tr;
  let single = null;
  let count = 0;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    count++;
    single = { pos: fromA, empty: fromA === toA, inserted };
  });
  if (count !== 1 || !single.empty) return tr;
  const marker = hardBreakAround(tr.startState, single.pos);
  if (!marker || single.pos <= marker.from || single.pos !== tr.startState.doc.lineAt(single.pos).to) return tr;
  const insert = single.inserted.toString();
  return {
    changes: { from: marker.from, insert },
    selection: EditorSelection.cursor(marker.from + insert.length),
    scrollIntoView: tr.scrollIntoView,
    userEvent: 'input.type',
  };
});

const avoidSeparators = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged && !tr.selection) return tr;
  const state = tr.state;
  const info = state.field(separatorField, false);
  if (!info || info.kinds.size === 0) return tr;
  const doc = state.doc;
  const previous = tr.startState.selection.main.head;
  let moved = false;
  const clear = (pos) => {
    const line = doc.lineAt(pos);
    const kind = info.kinds.get(line.number);
    if (!kind || kind.kind !== 'sep') return pos;
    moved = true;
    return !tr.docChanged && pos > previous ? line.to + 1 : line.from - 1;
  };
  const ranges = state.selection.ranges.map((r) => EditorSelection.range(clear(r.anchor), clear(r.head)));
  if (!moved) return tr;
  return {
    changes: tr.changes,
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    effects: tr.effects,
    annotations: tr.annotations,
    scrollIntoView: tr.scrollIntoView,
  };
});

// history pops skip transaction filters and a reconfigure carries no selection, so
// those paths are corrected here after the update settles
const keepOffSeparators = ViewPlugin.fromClass(class {
  constructor(view) { this.view = view; this.check(); }
  update(update) {
    if (update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.reconfigured)) this.check();
  }
  destroy() { this.dead = true; }
  check() {
    queueMicrotask(() => {
      if (this.dead) return;
      const { state } = this.view;
      const info = state.field(separatorField, false);
      if (!info || info.kinds.size === 0) return;
      const onSeparator = (pos) => {
        const kind = info.kinds.get(state.doc.lineAt(pos).number);
        return kind && kind.kind === 'sep';
      };
      if (state.selection.ranges.some((r) => onSeparator(r.anchor) || onSeparator(r.head))) {
        this.view.dispatch({ selection: state.selection });
      }
    });
  }
});

const wholeHardBreakDeletion = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('delete') || tr.startState.selection.ranges.length !== 1) return tr;
  let count = 0;
  let edit = null;
  tr.changes.iterChanges((from, to, fromB, toB, inserted) => {
    count++;
    edit = { from, to, pure: inserted.length === 0 };
  });
  if (count !== 1 || !edit.pure) return tr;
  const doc = tr.startState.doc;
  let { from, to } = edit;
  for (const pos of [edit.from, edit.to]) {
    const line = doc.lineAt(pos);
    const marker = hardBreakAround(tr.startState, line.from);
    if (marker && edit.from < line.to + 1 && edit.to > marker.from) {
      from = Math.min(from, marker.from);
      to = Math.max(to, Math.min(line.to + 1, doc.length));
    }
  }
  if (from === edit.from && to === edit.to) return tr;
  return {
    changes: { from, to },
    selection: EditorSelection.cursor(from),
    annotations: tr.annotations,
    scrollIntoView: tr.scrollIntoView,
  };
});

const editExtensions = [
  editPlugin,
  editBlockField,
  separatorField,
  syntaxHighlighting(editHighlight),
  editTheme,
  editKeymap,
  typingBeforeBreak,
  avoidSeparators,
  keepOffSeparators,
  wholeHardBreakDeletion,
  EditorView.atomicRanges.of((v) => v.plugin(editPlugin)?.atoms ?? Decoration.none),
];
const sourceExtensions = [];
const editComp = new Compartment();

function inVerbatimBlock(state, pos) {
  if (pos < frontmatterEnd(state.doc)) return true;
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'Table' || n.name === 'HTMLBlock') return true;
  }
  return false;
}

function continuationPrefix(state, pos) {
  const line = state.doc.lineAt(pos);
  const marks = [];
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.name === 'ListMark' || node.name === 'QuoteMark') marks.push({ from: node.from, to: node.to, list: node.name === 'ListMark' });
    },
  });
  let contentEnd;
  if (marks.length) {
    marks.sort((a, b) => a.from - b.from);
    contentEnd = marks[marks.length - 1].to;
    while (state.doc.sliceString(contentEnd, contentEnd + 1) === ' ') contentEnd++;
  } else {
    contentEnd = line.from + (line.text.length - line.text.trimStart().length);
  }
  const chars = line.text.slice(0, contentEnd - line.from).split('');
  for (const m of marks) {
    if (!m.list) continue;
    for (let i = m.from - line.from; i < m.to - line.from; i++) chars[i] = ' ';
  }
  return chars.join('');
}

function inListOrQuote(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'ListItem' || n.name === 'Blockquote') return true;
  }
  return false;
}

function editTransaction(state, fn) {
  return state.update(state.changeByRange(fn), { scrollIntoView: true, userEvent: 'input' });
}

function trailingBlank(text) {
  return text.length - text.trimEnd().length;
}

function splitParagraph(state, range) {
  const fromLine = state.doc.lineAt(range.from);
  const toLine = state.doc.lineAt(range.to);
  let from = range.from - trailingBlank(state.doc.sliceString(fromLine.from, range.from));
  const rest = state.doc.sliceString(range.to, toLine.to);
  let to = range.to + (rest.length - rest.trimStart().length);
  const marker = hardBreakAround(state, range.to);
  if (marker && to >= marker.from) {
    from = Math.min(from, marker.from);
    to = toLine.to + 1;
  } else if (from === fromLine.from && fromLine.number > 1) {
    const before = hardBreakAround(state, from - 1);
    if (before) from = before.from;
  }
  return { changes: { from, to, insert: '\n\n' }, range: EditorSelection.cursor(from + 2) };
}

function insertLineBreak(view) {
  const { state } = view;
  const head = state.selection.main.head;
  if (inVerbatimBlock(state, head) || inListOrQuote(state, head)) return false;
  view.dispatch(editTransaction(state, (range) => {
    const line = state.doc.lineAt(range.head);
    if (line.text.trim() !== '') return splitParagraph(state, range);
    const kind = paragraphKind(state, line.number);
    if (kind && kind.kind === 'empty' && range.empty) {
      return { changes: { from: range.from, insert: '\n\n' }, range: EditorSelection.cursor(range.from + 2) };
    }
    const prev = line.number > 1 ? state.doc.line(line.number - 1) : null;
    const trailing = range.empty && prev ? prev.text.length - prev.text.trimEnd().length : 0;
    const changes = [{ from: range.from, to: range.to, insert: '\n' }];
    if (trailing) changes.unshift({ from: prev.to - trailing, to: prev.to });
    return { changes, range: EditorSelection.cursor(range.from + 1 - trailing) };
  }));
  return true;
}

function inHeading(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (/^(ATX|Setext)Heading/.test(n.name)) return true;
  }
  return false;
}

function insertHardBreak(view) {
  const { state } = view;
  const main = state.selection.main;
  if (inVerbatimBlock(state, main.head)) return false;
  const mainLine = state.doc.lineAt(main.head);
  const mainMarker = hardBreakAround(state, main.head);
  const kind = state.selection.ranges.length === 1 && main.empty && mainLine.text === '' ? paragraphKind(state, mainLine.number) : null;
  if (kind && kind.kind === 'continuation') return insertLineBreak(view);
  if (state.selection.ranges.length === 1 && main.empty && mainMarker && main.head >= mainMarker.from && mainLine.number < state.doc.lines) {
    view.dispatch({ selection: EditorSelection.cursor(mainLine.to + 1), scrollIntoView: true, userEvent: 'select' });
    return true;
  }
  view.dispatch(editTransaction(state, (range) => {
    if (inHeading(state, range.head)) return splitParagraph(state, range);
    const line = state.doc.lineAt(range.from);
    if (range.empty && range.from === line.from && line.text.trim() !== '' && !inListOrQuote(state, range.head)) {
      return splitParagraph(state, range);
    }
    const from = range.from - trailingBlank(state.doc.sliceString(line.from, range.from));
    const rest = state.doc.sliceString(range.to, state.doc.lineAt(range.to).to);
    const to = range.to + (rest.length - rest.trimStart().length);
    const insert = '  \n' + continuationPrefix(state, range.head);
    return { changes: { from, to, insert }, range: EditorSelection.cursor(from + insert.length) };
  }));
  return true;
}

const MERGES_INTO = /^(Paragraph|ATXHeading\d)$/;

function topBlock(state, pos, side) {
  let n = syntaxTree(state).resolveInner(pos, side);
  while (n.parent && n.parent.name !== 'Document') n = n.parent;
  return n.name === 'Document' ? null : n;
}

function removeEmptyParagraph(state, line) {
  const doc = state.doc;
  const prev = doc.line(line.number - 1);
  if (line.number === doc.lines) return { from: prev.from - 1, to: line.to };
  if (line.number === paragraphKind(state, line.number).run.end) return { from: line.from, to: line.to + 1 };
  return { from: prev.from, to: line.to + 1 };
}

function dispatchDelete(view, change, cursor, forward) {
  view.dispatch({
    changes: change,
    selection: EditorSelection.cursor(cursor),
    scrollIntoView: true,
    userEvent: forward ? 'delete.forward' : 'delete.backward',
  });
  return true;
}

function moveCursor(view, pos, goalColumn, assoc = 0) {
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(pos, assoc, undefined, goalColumn)]), scrollIntoView: true, userEvent: 'select' });
  return true;
}

function hopSeparator(view, forward) {
  const { state } = view;
  const doc = state.doc;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const line = doc.lineAt(range.head);
  const sepNumber = line.number + (forward ? 1 : -1);
  const kind = sepNumber >= 1 && sepNumber <= doc.lines ? paragraphKind(state, sepNumber) : null;
  if (!kind || kind.kind !== 'sep') return false;
  if (view.moveToLineBoundary(range, forward, true).head !== (forward ? line.to : line.from)) return false;
  const target = doc.line(sepNumber + (forward ? 1 : -1));
  const rect = view.contentDOM.getBoundingClientRect();
  const coords = view.coordsAtPos(range.head, range.assoc || 1);
  const goal = range.goalColumn ?? (coords ? coords.left - rect.left : Math.min(rect.width, view.defaultCharacterWidth * (range.head - line.from)));
  const block = view.lineBlockAt(forward ? target.from : target.to);
  const y = view.documentTop + (forward ? block.top + 1 : block.bottom - 1);
  const hit = view.posAndSideAtCoords({ x: rect.left + goal, y }, false);
  let pos = hit.pos;
  let assoc = hit.assoc;
  if (!(pos >= target.from && pos <= target.to)) {
    pos = Math.min(target.from + (range.head - line.from), target.to);
    assoc = 1;
  }
  const marker = hardBreakAround(state, target.from);
  if (marker && pos > marker.from) {
    pos = marker.from;
    assoc = -1;
  }
  return moveCursor(view, pos, goal, assoc);
}

function joinBackward(view) {
  const { state } = view;
  const doc = state.doc;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const line = doc.lineAt(range.head);
  if (range.head !== line.from || line.number < 2) return false;
  const kind = paragraphKind(state, line.number);
  if (kind && kind.kind === 'empty') {
    return dispatchDelete(view, removeEmptyParagraph(state, line), doc.line(line.number - 1).from - 1, false);
  }
  if (kind && kind.kind === 'continuation') {
    const prev = doc.line(line.number - 1);
    const from = prev.to - (prev.text.length - prev.text.trimEnd().length);
    return dispatchDelete(view, { from, to: line.from }, from, false);
  }
  if (line.text.trim() === '') return false;
  const above = paragraphKind(state, line.number - 1);
  if (!above) return false;
  let empty = null;
  if (above.kind === 'empty') empty = doc.line(line.number - 1);
  else if (above.kind === 'sep') {
    const further = paragraphKind(state, line.number - 2);
    if (further && further.kind === 'empty') empty = doc.line(line.number - 2);
  }
  if (empty) {
    const change = removeEmptyParagraph(state, empty);
    return dispatchDelete(view, change, line.from - (change.to - change.from), false);
  }
  if (above.kind !== 'sep') return false;
  const end = doc.line(line.number - 2).to;
  const before = topBlock(state, end, -1);
  const after = topBlock(state, line.from, 1);
  if (before && after && MERGES_INTO.test(before.name) && after.name === 'Paragraph') {
    return dispatchDelete(view, { from: end, to: line.from }, end, false);
  }
  return moveCursor(view, before ? Math.min(before.to, end) : end);
}

function joinForward(view) {
  const { state } = view;
  const doc = state.doc;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const line = doc.lineAt(range.head);
  if (range.head !== line.to || line.number === doc.lines) return false;
  const kind = paragraphKind(state, line.number);
  const next = doc.line(line.number + 1);
  const nextKind = paragraphKind(state, line.number + 1);
  if (kind && kind.kind === 'empty') {
    const to = nextKind && nextKind.kind === 'sep' ? next.to + 1 : line.to + 1;
    return dispatchDelete(view, { from: line.from, to }, line.from, true);
  }
  if (line.text.trim() === '' || !nextKind || nextKind.kind !== 'sep') return false;
  const after = doc.line(line.number + 2);
  const afterKind = paragraphKind(state, line.number + 2);
  if (afterKind && afterKind.kind === 'empty') {
    return dispatchDelete(view, removeEmptyParagraph(state, after), line.to, true);
  }
  const before = topBlock(state, line.to, -1);
  const block = topBlock(state, after.from, 1);
  if (before && block && MERGES_INTO.test(before.name) && block.name === 'Paragraph') {
    return dispatchDelete(view, { from: line.to, to: after.from }, line.to, true);
  }
  return moveCursor(view, block ? block.from : after.from);
}

function toggleLinePrefix(view, prefix, pattern) {
  const { state } = view;
  const nums = new Set();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) nums.add(n);
  }
  const lines = [...nums].map((n) => state.doc.line(n));
  const has = lines.every((l) => pattern.test(l.text));
  const changes = lines.map((l, i) => has
    ? { from: l.from, to: l.from + l.text.match(pattern)[0].length }
    : { from: l.from, insert: typeof prefix === 'function' ? prefix(i) : prefix });
  view.dispatch({ changes });
  view.focus();
  return true;
}

function wrapSelection(view, before, after = before) {
  view.dispatch(view.state.changeByRange((range) => ({
    changes: [{ from: range.from, insert: before }, { from: range.to, insert: after }],
    range: EditorSelection.range(range.from + before.length, range.to + before.length),
  })));
  view.focus();
  return true;
}

function insertLink(view) {
  view.dispatch(view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to) || 'text';
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}](url)` },
      range: EditorSelection.range(range.from + text.length + 3, range.from + text.length + 6),
    };
  }));
  view.focus();
  return true;
}

const BLOCK_BREAK = /^\s*(?:#{1,6}\s|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const FENCE_LINE = /^\s*(?:>\s*)*(?:`{3,}|~{3,}|\$\$)/;
const QUOTE_PREFIX = /^(?:\s*>)*\s?/;

function createEditor(parent, { doc, onChange, onSave, onToggleMode, blocks, scroller: scrollerOption }) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        blocksFacet.of(blocks),
        history(),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { onSave(); return true; } },
          { key: 'Mod-e', preventDefault: true, run: () => { onToggleMode(); return true; } },
          { key: 'Mod-b', preventDefault: true, run: (v) => wrapSelection(v, '**') },
          { key: 'Mod-i', preventDefault: true, run: (v) => wrapSelection(v, '*') },
          { key: 'ArrowDown', run: (v) => enterRenderedBlock(v, true) },
          { key: 'ArrowUp', run: (v) => enterRenderedBlock(v, false) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        markdown({ base: markdownLanguage, codeLanguages }),
        drawSelection(),
        syntaxHighlighting(highlightStyle),
        autocompletion({ override: [slashCompletions], icons: false }),
        slashTheme,
        slashGlide,
        editComp.of(sourceExtensions),
        EditorView.lineWrapping,
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(programmatic))) {
            onChange(update.state.doc.toString());
          }
        }),
      ],
    }),
  });
  const scroller = scrollerOption || view.scrollDOM;
  let settleToken = 0;

  function textHint(viewTop, x) {
    const limit = viewTop + scroller.clientHeight;
    for (const dy of [1, 12, 28, 56, 100]) {
      const pos = view.posAtCoords({ x, y: viewTop + dy }, false);
      const line = view.state.doc.lineAt(pos);
      if (FENCE_LINE.test(line.text)) continue;
      const code = view.domAtPos(line.from).node.parentElement?.closest('.cm-line')?.classList.contains('cm-lp-code');
      const snip = snippetAt(line.text, code ? Math.max(pos - line.from, QUOTE_PREFIX.exec(line.text)[0].length) : pos - line.from, !code);
      const rect = snip && view.coordsAtPos(line.from + snip.start);
      if (!rect || rect.bottom <= viewTop || rect.top >= limit) continue;
      const startPos = line.from + snip.start;
      let chunkFrom = line.from;
      if (!BLOCK_BREAK.test(line.text)) {
        for (let n = line.number - 1; n >= 1 && n > line.number - 200; n--) {
          const above = view.state.doc.line(n);
          if (!above.text.trim() || BLOCK_BREAK.test(above.text)) break;
          chunkFrom = above.from;
        }
      }
      const nth = countBefore(view.state.doc.sliceString(chunkFrom, startPos + snip.text.length), snip.text, startPos - chunkFrom);
      return { text: snip.text, offset: rect.top - viewTop, line: line.number, nth };
    }
    return null;
  }
  return {
    getContent: () => view.state.doc.toString(),
    setContent: (text) => {
      settleToken++;
      if (text === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: programmatic.of(true),
      });
    },
    setEdit: (on) => {
      settleToken++;
      view.dispatch({ effects: editComp.reconfigure(on ? editExtensions : sourceExtensions) });
    },
    refreshBlocks: () => view.dispatch({ effects: blocksRefresh.of(null) }),
    wrap: (before, after) => wrapSelection(view, before, after),
    toggleBullet: () => toggleLinePrefix(view, '- ', /^[-*+] /),
    toggleNumbered: () => toggleLinePrefix(view, (i) => `${i + 1}. `, /^\d+[.)] /),
    toggleTask: () => toggleLinePrefix(view, '- [ ] ', /^[-*+] \[[ xX]\] /),
    toggleQuote: () => toggleLinePrefix(view, '> ', /^> /),
    undo: () => { histUndo(view); view.focus(); },
    redo: () => { histRedo(view); view.focus(); },
    destroy: () => { settleToken++; view.destroy(); },
    insertLink: () => insertLink(view),
    jumpToLine: (n) => {
      const line = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      });
      view.focus();
    },
    focus: () => view.focus(),
    viewportAnchor: (viewTop) => {
      const left = view.contentDOM.getBoundingClientRect().left;
      const pos = view.posAtCoords({ x: left + 1, y: viewTop + 1 }, false);
      const block = view.lineBlockAt(pos);
      const anchor = { line: view.state.doc.lineAt(block.from).number, offset: block.top + view.documentTop - viewTop };
      const hint = textHint(viewTop, left + 1);
      if (hint) anchor.hint = hint;
      return anchor;
    },
    scrollToLine: (n, offset, hint) => {
      const docState = view.state.doc;
      let pos = docState.line(Math.max(1, Math.min(n, docState.lines))).from;
      let glyph = false;
      if (hint) {
        const lines = hintLines(hint.line, hint.span, docState.lines);
        const from = docState.line(lines.first).from;
        const to = docState.line(lines.last).to;
        const index = nthIndex(docState.sliceString(from, to), hint.text, hint.nth);
        if (index >= 0) {
          pos = from + index;
          glyph = true;
        }
      }
      const want = glyph ? hint.offset : offset;
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: want }) });
      // heights of lines never drawn are estimates; re-aim until the measured layout stops moving
      const token = ++settleToken;
      const stop = () => { settleToken++; };
      scroller.addEventListener('wheel', stop, { once: true, passive: true });
      scroller.addEventListener('keydown', stop, { once: true });
      scroller.addEventListener('pointerdown', stop, { once: true });
      let stable = 0;
      const settle = (left) => {
        const live = token === settleToken && view.dom.offsetParent !== null && pos <= view.state.doc.length;
        if (live) {
          const top = glyph ? view.coordsAtPos(pos)?.top : view.lineBlockAt(pos).top + view.documentTop;
          const delta = top == null ? null : top - scroller.getBoundingClientRect().top - want;
          if (delta !== null && Math.abs(delta) <= 0.5) stable++;
          else {
            stable = 0;
            if (delta !== null) scroller.scrollTop += delta;
          }
          if (stable < 2 && left > 0) {
            requestAnimationFrame(() => settle(left - 1));
            return;
          }
        }
        scroller.removeEventListener('wheel', stop);
        scroller.removeEventListener('keydown', stop);
        scroller.removeEventListener('pointerdown', stop);
      };
      settle(8);
    },
  };
}

export { createEditor };
