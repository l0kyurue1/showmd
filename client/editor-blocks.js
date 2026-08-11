import { StateField, StateEffect, Facet } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { mathSpans, markSpans, TASK_CLASS, toggleTaskMark, frontmatterEndLine } from './syntax.js';

const blocksRefresh = StateEffect.define();
const blocksFacet = Facet.define({ combine: (values) => values[values.length - 1] });
const blockRefreshes = new WeakMap();

// matches the UA default list-style-type chain read mode inherits: disc, circle,
// square, square...
const BULLETS = ['•', '◦', '▪'];

class BulletWidget extends WidgetType {
  constructor(mark) { super(); this.mark = mark; }
  eq(other) { return other.mark === this.mark; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-lp-bullet';
    s.textContent = this.mark;
    return s;
  }
}

class TaskWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(other) { return other.checked === this.checked; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = TASK_CLASS + ' cm-lp-task';
    box.addEventListener('click', () => {
      const pos = view.posAtDOM(box);
      const line = view.state.doc.lineAt(pos);
      const next = toggleTaskMark(line.text, !this.checked);
      if (next === line.text) return;
      let a = 0;
      while (next[a] === line.text[a]) a++;
      let b = 0;
      while (next[next.length - 1 - b] === line.text[line.text.length - 1 - b]) b++;
      view.dispatch({ changes: { from: line.from + a, to: line.to - b, insert: next.slice(a, next.length - b) } });
    });
    return box;
  }
}

class HRWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-lp-hr';
    return s;
  }
}

class LangWidget extends WidgetType {
  constructor(lang) { super(); this.lang = lang; }
  eq(other) { return other.lang === this.lang; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-lp-lang';
    s.textContent = this.lang;
    return s;
  }
}

class MdBlockWidget extends WidgetType {
  constructor(src, gap) { super(); this.src = src; this.gap = gap; }
  eq(other) { return other.src === this.src && other.gap === this.gap; }
  toDOM(view) {
    const blocks = view.state.facet(blocksFacet);
    const div = document.createElement('div');
    div.className = 'doc cm-lp-embed';
    if (this.gap) div.style.paddingBottom = this.gap;
    blocks.renderBlockInto(div, { kind: 'markdown', source: this.src });
    return div;
  }
  ignoreEvent() { return false; }
}

class MathWidget extends WidgetType {
  constructor(src, display, asBlock) { super(); this.src = src; this.display = display; this.asBlock = asBlock; }
  eq(other) { return other.src === this.src && other.display === this.display && other.asBlock === this.asBlock; }
  toDOM(view) {
    const blocks = view.state.facet(blocksFacet);
    const el = document.createElement(this.asBlock ? 'div' : 'span');
    el.className = 'cm-lp-math';
    blocks.renderBlockInto(el, { kind: 'math', source: this.src, display: this.display });
    return el;
  }
  ignoreEvent() { return false; }
}

class MermaidWidget extends WidgetType {
  constructor(src, gap, refresh) {
    super();
    this.src = src;
    this.gap = gap;
    this.refresh = refresh;
  }
  eq(other) { return other.src === this.src && other.refresh === this.refresh && other.gap === this.gap; }
  toDOM(view) {
    const blocks = view.state.facet(blocksFacet);
    const div = document.createElement('div');
    div.className = 'cm-lp-mermaid';
    if (this.gap) div.style.paddingBottom = this.gap;
    blocks.renderBlockInto(div, { kind: 'mermaid', source: this.src });
    return div;
  }
  ignoreEvent() { return false; }
}

function selectionLines(state) {
  const active = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) active.add(n);
  }
  return active;
}

function makeOnActiveLine(state) {
  const active = selectionLines(state);
  return (from, to) => {
    const a = state.doc.lineAt(from).number;
    const b = state.doc.lineAt(to).number;
    for (let n = a; n <= b; n++) if (active.has(n)) return true;
    return false;
  };
}

function inCodeAt(tree, pos) {
  for (let n = tree.resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'InlineCode' || n.name === 'CodeBlock' || n.name === 'CodeText') return true;
  }
  return false;
}

function scanMath(state, range, decos, onActiveLine) {
  const doc = state.doc;
  const text = doc.sliceString(range.from, range.to);
  const spans = mathSpans(text);
  if (spans.length === 0) return;
  const tree = syntaxTree(state);
  for (const span of spans) {
    const from = range.from + span.from;
    const to = range.from + span.to;
    if (span.display) {
      // a `$$…$$` that owns its whole line, or spans several, is block math —
      // scanBlockMath places those
      if (text.slice(span.from, span.to).includes('\n')) continue;
      const line = doc.lineAt(from);
      if (line.from === from && line.to === to) continue;
    }
    if (onActiveLine(from, to) || inCodeAt(tree, from)) continue;
    decos.push(Decoration.replace({ widget: new MathWidget(span.src, span.display, false) }).range(from, to));
  }
}

// lezer-markdown has no ==highlight== rule
function scanMark(state, range, decos, onActiveLine) {
  const text = state.doc.sliceString(range.from, range.to);
  const spans = markSpans(text);
  if (spans.length === 0) return;
  const tree = syntaxTree(state);
  for (const span of spans) {
    const from = range.from + span.from;
    const to = range.from + span.to;
    if (inCodeAt(tree, from)) continue;
    decos.push(Decoration.mark({ class: 'cm-lp-mark' }).range(from + 2, to - 2));
    if (onActiveLine(from, to)) continue;
    decos.push(Decoration.replace({}).range(from, from + 2));
    decos.push(Decoration.replace({}).range(to - 2, to));
  }
}

function scanBlockMath(state, decos, onActiveLine) {
  const doc = state.doc;
  const text = doc.toString();
  if (!text.includes('$$')) return;
  const tree = syntaxTree(state);
  for (const span of mathSpans(text)) {
    if (!span.display) continue;
    const { from, to } = span;
    const fullLines = doc.lineAt(from).from === from && doc.lineAt(to).to === to;
    if (!text.slice(from, to).includes('\n') && !fullLines) continue;
    if (onActiveLine(from, to) || inCodeAt(tree, from)) continue;
    decos.push(Decoration.replace({ widget: new MathWidget(span.src, true, fullLines), block: fullLines }).range(from, to));
  }
}

const H1 = ['var(--h1-mt)', 'var(--h1-mb)'];
const H2 = ['var(--h2-mt)', 'var(--h2-mb)'];
const BLOCK = ['var(--block-m)', 'var(--block-m)'];
const FLOW = ['0px', 'var(--p-mb)'];
const BLOCK_EDGE = {
  ATXHeading1: H1, SetextHeading1: H1,
  ATXHeading2: H2, SetextHeading2: H2,
  ATXHeading3: ['var(--h3-mt)', 'var(--h3-mb)'],
  ATXHeading4: ['var(--h456-mt)', 'var(--h456-mb)'],
  ATXHeading5: ['var(--h456-mt)', 'var(--h456-mb)'],
  ATXHeading6: ['var(--h456-mt)', 'var(--h456-mb)'],
  Paragraph: FLOW, BulletList: FLOW, OrderedList: FLOW,
  Blockquote: BLOCK, FencedCode: BLOCK, CodeBlock: BLOCK, Table: BLOCK,
  HorizontalRule: ['var(--hr-m)', 'var(--hr-m)'],
};

function hasBlankBetween(doc, from, to) {
  for (let n = doc.lineAt(from).number + 1, last = doc.lineAt(to).number - 1; n <= last; n++) {
    if (doc.line(n).text.trim() === '') return true;
  }
  return false;
}

// read mode's adjacent margins collapse to max(); edit mode has no collapse, so
// fold each pair into one gap. It hangs off the bottom of the earlier block, so
// clicking the space under a heading lands on the heading, not the block below.
// A blank line between the two already contributes its own height.
function blockGaps(tree, doc, fmEnd) {
  const gaps = new Map();
  let prev = null;
  for (let n = tree.topNode.firstChild; n; n = n.nextSibling) {
    const edge = n.from < fmEnd ? null : BLOCK_EDGE[n.name];
    if (!edge) { prev = null; continue; }
    if (prev) {
      const raw = prev.bottom === edge[0] ? prev.bottom : `max(${prev.bottom}, ${edge[0]})`;
      const gap = hasBlankBetween(doc, prev.to, n.from) ? `max(0px, calc(${raw} - var(--doc-lh)))` : raw;
      gaps.set(prev.from, { gap, line: doc.lineAt(prev.to).from });
    }
    prev = { from: n.from, to: n.to, bottom: edge[1] };
  }
  return gaps;
}

function buildBlockDecos(state) {
  const doc = state.doc;
  const blocks = state.facet(blocksFacet);
  const refresh = blockRefreshes.get(blocks);
  const onActiveLine = makeOnActiveLine(state);
  const decos = [];
  const tree = syntaxTree(state);
  const fmEnd = frontmatterEnd(doc);
  const gaps = blockGaps(tree, doc, fmEnd);
  const takeGap = (pos) => {
    const entry = gaps.get(pos);
    gaps.delete(pos);
    return entry && entry.gap;
  };
  const replaceBlock = (from, to, widget) => {
    decos.push(Decoration.replace({ widget, block: true }).range(from, to));
  };
  tree.iterate({
    enter: (node) => {
      if (node.name === 'FencedCode') {
        if (!onActiveLine(node.from, node.to) && doc.lineAt(node.from).from === node.from) {
          const infoNode = node.node.getChild('CodeInfo');
          const lang = infoNode ? doc.sliceString(infoNode.from, infoNode.to).trim() : '';
          const to = doc.lineAt(node.to).to;
          if (lang === 'mermaid') {
            const codeText = node.node.getChild('CodeText');
            const src = codeText ? doc.sliceString(codeText.from, codeText.to) : '';
            replaceBlock(node.from, to, new MermaidWidget(src, takeGap(node.from), refresh));
          } else {
            replaceBlock(node.from, to, new MdBlockWidget(doc.sliceString(node.from, to), takeGap(node.from)));
          }
        }
        return false;
      }
      if (node.name === 'Table') {
        if (!onActiveLine(node.from, node.to) && doc.lineAt(node.from).from === node.from) {
          replaceBlock(node.from, doc.lineAt(node.to).to, new MdBlockWidget(doc.sliceString(node.from, node.to), takeGap(node.from)));
        }
        return false;
      }
      if (node.name === 'Blockquote') {
        if (!onActiveLine(node.from, node.to) && doc.lineAt(node.from).from === node.from) {
          replaceBlock(node.from, doc.lineAt(node.to).to, new MdBlockWidget(doc.sliceString(node.from, node.to), takeGap(node.from)));
          return false;
        }
      }
    },
  });
  for (const entry of gaps.values()) {
    decos.push(Decoration.line({ attributes: { style: `padding-bottom:${entry.gap}` } }).range(entry.line));
  }
  scanBlockMath(state, decos, onActiveLine);
  return Decoration.set(decos, true);
}

const editBlockField = StateField.define({
  create: buildBlockDecos,
  update: (value, tr) => {
    const refresh = tr.effects.some((effect) => effect.is(blocksRefresh));
    if (refresh) blockRefreshes.set(tr.state.facet(blocksFacet), {});
    return tr.docChanged || tr.selection || refresh ? buildBlockDecos(tr.state) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function frontmatterEnd(doc) {
  const n = frontmatterEndLine((i) => doc.line(i).text, doc.lines);
  return n ? doc.line(n).to : 0;
}

function buildEditDecos(view) {
  const { state } = view;
  const doc = state.doc;
  const onActiveLine = makeOnActiveLine(state);
  const decos = [];
  const fmEnd = frontmatterEnd(doc);
  if (fmEnd) {
    const endLine = doc.lineAt(fmEnd).number;
    for (let n = 1; n <= endLine; n++) {
      decos.push(Decoration.line({ class: 'cm-lp-fm' + (n === endLine ? ' cm-lp-fm-end' : '') }).range(doc.line(n).from));
    }
  }
  const hide = (from, to) => {
    if (from < to && !onActiveLine(from, to)) decos.push(Decoration.replace({}).range(from, to));
  };
  const spaceAfter = (pos) => {
    let n = 0;
    while (doc.sliceString(pos + n, pos + n + 1) === ' ') n++;
    return n;
  };
  for (const range of view.visibleRanges) {
    scanMath(state, range, decos, onActiveLine);
    scanMark(state, range, decos, onActiveLine);
    syntaxTree(state).iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        // skips any non-root node overlapping frontmatter, including ones straddling
        // its end (e.g. a fence crossing the boundary) — their tail renders plain
        if (fmEnd && node.from < fmEnd && node.name !== 'Document') return false;
        switch (node.name) {
          case 'HeaderMark':
          case 'QuoteMark':
            hide(node.from, node.to + spaceAfter(node.to));
            break;
          case 'EmphasisMark':
          case 'StrikethroughMark':
          case 'LinkMark':
            hide(node.from, node.to);
            break;
          case 'CodeMark':
            if (node.node.parent && node.node.parent.name === 'InlineCode') hide(node.from, node.to);
            break;
          case 'URL': {
            const p = node.node.parent;
            if (p && (p.name === 'Link' || p.name === 'Image')) hide(node.from, node.to);
            break;
          }
          case 'ListMark': {
            const line = doc.lineAt(node.from);
            const sib = node.node.nextSibling;
            const isTask = sib && sib.name === 'Task';
            let depth = 0;
            for (let p = node.node.parent; p; p = p.parent) {
              if (p.name === 'BulletList' || p.name === 'OrderedList') depth++;
            }
            // marker hangs in the indent, so wrapped lines align with the text —
            // same geometry as read mode's ::marker inside `ul { padding-left }`
            const hang = isTask ? 'var(--task-hang)' : 'var(--list-indent)';
            const pad = `calc(var(--list-indent) * ${depth - 1} + ${hang})`;
            decos.push(Decoration.line({
              attributes: { style: `padding-left:${pad};text-indent:calc(-1 * ${hang})` },
            }).range(line.from));
            hide(line.from, node.from);
            if (onActiveLine(node.from, node.to)) break;
            if (isTask) { hide(node.from, node.to + spaceAfter(node.to)); break; }
            const mark = doc.sliceString(node.from, node.to);
            const glyph = /^[-*+]$/.test(mark) ? BULLETS[Math.min(depth, BULLETS.length) - 1] : mark;
            decos.push(Decoration.replace({ widget: new BulletWidget(glyph) })
              .range(node.from, node.to + spaceAfter(node.to)));
            break;
          }
          case 'TaskMarker': {
            if (onActiveLine(node.from, node.to)) break;
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            decos.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(node.from, node.to + spaceAfter(node.to)));
            break;
          }
          case 'HorizontalRule':
            if (!onActiveLine(node.from, node.to)) {
              decos.push(Decoration.replace({ widget: new HRWidget() }).range(node.from, node.to));
            }
            break;
          case 'FencedCode': {
            const revealed = onActiveLine(node.from, node.to);
            const infoNode = node.node.getChild('CodeInfo');
            const lang = infoNode ? doc.sliceString(infoNode.from, infoNode.to).trim() : '';
            const first = doc.lineAt(node.from);
            const last = doc.lineAt(node.to);
            for (let n = first.number; n <= last.number; n++) {
              decos.push(Decoration.line({ class: 'cm-lp-code' }).range(doc.line(n).from));
            }
            if (!revealed) {
              decos.push(Decoration.replace({ widget: new LangWidget(lang) }).range(first.from, first.to));
              if (/^(`{3,}|~{3,})\s*$/.test(last.text)) decos.push(Decoration.replace({}).range(last.from, last.to));
            }
            return false;
          }
          case 'Blockquote': {
            const a = doc.lineAt(Math.max(node.from, range.from)).number;
            const b = doc.lineAt(Math.min(node.to, range.to)).number;
            for (let n = a; n <= b; n++) {
              decos.push(Decoration.line({ class: 'cm-lp-quote' }).range(doc.line(n).from));
            }
            break;
          }
        }
      },
    });
  }
  return Decoration.set(decos, true);
}

export {
  blocksFacet,
  blocksRefresh,
  editBlockField,
  buildEditDecos,
  scanMath,
  scanMark,
  scanBlockMath,
  frontmatterEnd,
  BulletWidget,
  TaskWidget,
  HRWidget,
  LangWidget,
  MdBlockWidget,
  MathWidget,
  MermaidWidget,
};
