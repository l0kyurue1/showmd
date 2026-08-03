import { EditorState, EditorSelection, Annotation, Compartment } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo as histUndo, redo as histRedo } from '@codemirror/commands';
import { autocompletion } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, StreamLanguage } from '@codemirror/language';
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
import { slashCompletions, slashTheme, slashGlide } from './editor-slash.js';
import { blocksFacet, blocksRefresh, editBlockField, buildEditDecos } from './editor-blocks.js';

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
    constructor(view) { this.decorations = buildEditDecos(view); }
    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildEditDecos(update.view);
      }
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
  '.cm-line': { paddingLeft: 0 },
  '.cm-lp-mark': { background: 'var(--accent-soft)', borderRadius: '3px', padding: '0 2px' },
  '.cm-lp-quote': { borderLeft: 'var(--quote-bar) solid var(--accent)', paddingLeft: 'var(--quote-pad)', color: 'var(--muted)', fontStyle: 'italic' },
  '.cm-lp-bullet': { display: 'inline-block', width: 'var(--list-indent)', paddingRight: '5px', textAlign: 'right', color: 'inherit' },
  '.cm-lp-task': { margin: '0 var(--task-gap) 0 0', accentColor: 'var(--accent)', verticalAlign: 'middle' },
  '.cm-lp-hr': { display: 'inline-block', width: '100%', borderTop: '1px solid var(--line)', verticalAlign: 'middle' },
  '.cm-lp-code': { backgroundColor: 'var(--code-bg)', fontFamily: 'var(--mono)', fontSize: 'var(--code-block-size)', padding: '0 16px' },
  '.cm-lp-lang': { color: 'var(--muted)', fontSize: '12.5px', fontFamily: 'var(--mono)' },
  // line-height (and padding, never margin) must match body lines: CodeMirror
  // samples one line for its height estimate, and frontmatter sits at line 1 —
  // a shorter box there desyncs posAtCoords for the whole document
  '.cm-lp-fm': { fontFamily: 'var(--mono)', fontSize: '12.5px', color: 'var(--muted)', lineHeight: 'var(--doc-lh)' },
  '.cm-lp-fm span': { fontSize: 'inherit !important', fontWeight: 'inherit !important', fontFamily: 'inherit !important', letterSpacing: '0 !important' },
  '.cm-lp-fm-end': { borderBottom: '1px solid var(--line)', paddingBottom: '16px' },
  // the blank source line around a block already supplies the gap. Selectors must
  // outrank `.doc .callout` etc: a margin here collapses out through the widget
  // and lands in .cm-content, where CodeMirror cannot measure it — its height map
  // then drifts and posAtCoords sends clicks to the wrong block.
  '.cm-lp-embed': { whiteSpace: 'normal' },
  '.doc.cm-lp-embed > *, .cm-lp-math > *, .cm-lp-mermaid > *': { margin: 0 },
  '.cm-lp-math': { textAlign: 'center', whiteSpace: 'normal' },
  '.cm-lp-mermaid': { textAlign: 'center', padding: '8px 0', color: 'var(--muted)', whiteSpace: 'normal' },
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

const editExtensions = [editPlugin, editBlockField, syntaxHighlighting(editHighlight), editTheme];
const editComp = new Compartment();

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

function createEditor(parent, { doc, onChange, onSave, onToggleMode, blocks }) {
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
        editComp.of([]),
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
  return {
    getContent: () => view.state.doc.toString(),
    setContent: (text) => {
      if (text === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: programmatic.of(true),
      });
    },
    setEdit: (on) => view.dispatch({ effects: editComp.reconfigure(on ? editExtensions : []) }),
    refreshBlocks: () => view.dispatch({ effects: blocksRefresh.of(null) }),
    wrap: (before, after) => wrapSelection(view, before, after),
    toggleBullet: () => toggleLinePrefix(view, '- ', /^[-*+] /),
    toggleNumbered: () => toggleLinePrefix(view, (i) => `${i + 1}. `, /^\d+[.)] /),
    toggleTask: () => toggleLinePrefix(view, '- [ ] ', /^[-*+] \[[ xX]\] /),
    toggleQuote: () => toggleLinePrefix(view, '> ', /^> /),
    undo: () => { histUndo(view); view.focus(); },
    redo: () => { histRedo(view); view.focus(); },
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
  };
}

export { createEditor };
