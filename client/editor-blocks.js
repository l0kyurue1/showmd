import { StateField, StateEffect, Facet, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { mathSpans, markSpans, TASK_CLASS, toggleTaskMark, frontmatterEndLine } from './syntax.js';

const blocksRefresh = StateEffect.define();
const blocksFacet = Facet.define({ combine: (values) => values[values.length - 1] });
const blockRefreshes = new WeakMap();

// matches the UA default list-style-type chain read mode inherits: disc, circle,
// square, square...
const BULLETS = ['disc', 'circle', 'square'];

// read mode numbers by position from the list's start number and always shows "."
function orderedNumber(doc, item) {
  let index = 0;
  let first = item;
  for (let s = item.prevSibling; s; s = s.prevSibling) {
    if (s.name === 'ListItem') { index++; first = s; }
  }
  const m = /^\d+/.exec(doc.sliceString(first.from, first.to));
  return (m ? parseInt(m[0], 10) : 1) + index;
}

class BulletWidget extends WidgetType {
  constructor(shape, number) { super(); this.shape = shape; this.number = number; }
  eq(other) { return other.shape === this.shape && other.number === this.number; }
  toDOM() {
    const s = document.createElement('span');
    s.className = this.shape ? `cm-lp-bullet cm-lp-bullet-${this.shape}` : 'cm-lp-bullet cm-lp-bullet-number';
    if (!this.shape) {
      const n = document.createElement('span');
      n.textContent = `${this.number}. `;
      s.append(n);
    }
    return s;
  }
}

class SeparatorWidget extends WidgetType {
  constructor(height) { super(); this.height = height; }
  eq(other) { return other.height === this.height; }
  toDOM() {
    const d = document.createElement('div');
    d.className = 'cm-lp-sep';
    d.setAttribute('style', `height:${this.height}`);
    return d;
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

class SoftBreakWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.textContent = ' ';
    return s;
  }
  ignoreEvent() { return false; }
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

// .doc max-width (42rem at 16px); only seeds the height estimate of an unrendered diagram
const DOC_WIDTH = 672;

class MermaidWidget extends WidgetType {
  constructor(src, gap, refresh, blocks) {
    super();
    this.src = src;
    this.gap = gap;
    this.refresh = refresh;
    this.blocks = blocks;
  }
  get estimatedHeight() { return this.blocks.mermaidHeight ? this.blocks.mermaidHeight(this.src, DOC_WIDTH) : -1; }
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

function topLevelParagraph(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.name === 'Blockquote' || p.name === 'ListItem') return false;
  }
  return true;
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

const collapse = (a, b) => (a === b ? a : `max(${a}, ${b})`);
const LISTS = new Set(['BulletList', 'OrderedList']);

function blockEdge(node, fmEnd, doc) {
  if (node.from < fmEnd) return null;
  if (doc && node.name === 'Paragraph') {
    const text = doc.sliceString(node.from, node.to);
    const spans = text.includes('$$') ? mathSpans(text) : [];
    if (spans.length === 1 && spans[0].display && spans[0].from === 0 && spans[0].to === text.length) return BLOCK;
  }
  return BLOCK_EDGE[node.name] || null;
}

// Blocks split by blank lines get their gap from separator widgets instead.
// --tail-pad is a task item's bottom padding, which read mode stacks under the list margin.
function blockGaps(tree, doc, fmEnd) {
  const gaps = new Map();
  let prev = null;
  for (let n = tree.topNode.firstChild; n; n = n.nextSibling) {
    const edge = blockEdge(n, fmEnd, doc);
    if (!edge) { prev = null; continue; }
    if (prev && !hasBlankBetween(doc, prev.to, n.from)) {
      const raw = collapse(prev.bottom, edge[0]);
      const gap = prev.list ? `calc(${raw} + var(--tail-pad, 0px))` : raw;
      gaps.set(prev.from, { gap, line: doc.lineAt(prev.to).from });
    }
    prev = { from: n.from, to: n.to, bottom: edge[1], list: LISTS.has(n.name) };
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
  const joinedHeads = new Map();
  const joinSoftBreaks = (node) => {
    const hard = new Set();
    tree.iterate({ from: node.from, to: node.to, enter: (n) => { if (n.name === 'HardBreak') hard.add(n.to - 1); } });
    const last = doc.lineAt(node.to).number;
    for (let n = doc.lineAt(node.from).number; n < last; n++) {
      const line = doc.line(n);
      if (hard.has(line.to)) continue;
      decos.push(Decoration.replace({ widget: new SoftBreakWidget() }).range(line.to, line.to + 1));
      joinedHeads.set(line.to + 1, joinedHeads.get(line.from) ?? line.from);
    }
  };
  tree.iterate({
    enter: (node) => {
      if (node.name === 'Paragraph') {
        if (node.from >= fmEnd && !onActiveLine(node.from, node.to) && topLevelParagraph(node.node)) joinSoftBreaks(node);
        return false;
      }
      if (node.name === 'FencedCode') {
        if (!onActiveLine(node.from, node.to) && doc.lineAt(node.from).from === node.from) {
          const infoNode = node.node.getChild('CodeInfo');
          const lang = infoNode ? doc.sliceString(infoNode.from, infoNode.to).trim() : '';
          const to = doc.lineAt(node.to).to;
          if (lang === 'mermaid') {
            const codeText = node.node.getChild('CodeText');
            const src = codeText ? doc.sliceString(codeText.from, codeText.to) : '';
            replaceBlock(node.from, to, new MermaidWidget(src, takeGap(node.from), refresh, blocks));
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
    decos.push(Decoration.line({ attributes: { style: `padding-bottom:${entry.gap}` } }).range(joinedHeads.get(entry.line) ?? entry.line));
  }
  scanBlockMath(state, decos, onActiveLine);
  return Decoration.set(decos, true);
}

const editBlockField = StateField.define({
  create: buildBlockDecos,
  update: (value, tr) => {
    const refresh = tr.effects.some((effect) => effect.is(blocksRefresh));
    if (refresh) blockRefreshes.set(tr.state.facet(blocksFacet), {});
    return tr.docChanged || tr.selection || refresh || syntaxTree(tr.state) !== syntaxTree(tr.startState) ?buildBlockDecos(tr.state) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function frontmatterEnd(doc) {
  const n = frontmatterEndLine((i) => doc.line(i).text, doc.lines);
  return n ? doc.line(n).to : 0;
}

function hardBreakMarker(doc, node) {
  if (doc.sliceString(node.from, node.from + 1) === '\\') return { from: node.from, to: node.from + 1, spaces: false };
  return { from: node.to - 3, to: node.to - 1, spaces: true };
}

function hardBreakAround(state, pos) {
  const line = state.doc.lineAt(pos);
  let found = null;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to + 1,
    enter: (node) => {
      if (node.name === 'HardBreak' && node.from >= line.from && node.from <= line.to) found = hardBreakMarker(state.doc, node);
    },
  });
  return found;
}

function forEachHardBreak(view, fn) {
  for (const range of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: range.from,
      to: range.to,
      enter: (node) => { if (node.name === 'HardBreak') fn(hardBreakMarker(view.state.doc, node)); },
    });
  }
}

function hardBreakAtoms(view) {
  const builder = new RangeSetBuilder();
  forEachHardBreak(view, (m) => {
    builder.add(m.from, Math.min(view.state.doc.length, view.state.doc.lineAt(m.from).to + 1), Decoration.mark({}));
  });
  return builder.finish();
}

// Read mode collapses margins around floor(N/2) empty paragraphs; an even run's last gap
// sits under its empty paragraph. Neighbours without a read margin keep a full line.
function separatorHeights(run, prevEdge, nextEdge) {
  const count = Math.ceil(run.size / 2);
  if (!prevEdge || !nextEdge) return { heights: Array(count).fill('var(--doc-lh)'), pad: null };
  const lastGap = collapse('var(--p-mb)', nextEdge[0]);
  const odd = run.size % 2 === 1;
  const heights = [];
  for (let j = 0; j < count; j++) {
    const first = j === 0;
    const last = odd && j === count - 1;
    if (first && last) heights.push(collapse(prevEdge[1], nextEdge[0]));
    else if (first) heights.push(prevEdge[1]);
    else if (last) heights.push(lastGap);
    else heights.push('var(--p-mb)');
  }
  return { heights, pad: odd ? null : lastGap };
}

function continuationLine(state) {
  const { main } = state.selection;
  if (!main.empty) return 0;
  const line = state.doc.lineAt(main.head);
  if (line.number < 2 || line.text.trim() !== '') return 0;
  return / {2}$/.test(state.doc.line(line.number - 1).text) ? line.number : 0;
}

function buildSeparators(state, continuation = 0) {
  const doc = state.doc;
  const fmEnd = frontmatterEnd(doc);
  const kinds = new Map();
  const decos = [];
  const atoms = [];
  const addRun = (before, after) => {
    let start = doc.lineAt(Math.max(before.from, before.to - 1)).number + 1;
    const end = after ? doc.lineAt(after.from).number - 1 : doc.lines;
    if (end < start || before.from < fmEnd || (!after && end === start)) return;
    for (let n = start; n <= end; n++) if (doc.line(n).text.trim() !== '') return;
    if (start === continuation && before.name === 'Paragraph' && / {2}$/.test(doc.line(start - 1).text)) {
      kinds.set(start, { kind: 'continuation' });
      start++;
      if (end < start || (!after && end === start)) return;
    }
    const run = { size: end - start + 1, start, end };
    const edge = blockEdge(before, fmEnd, doc);
    const { heights, pad } = after
      ? separatorHeights(run, edge, blockEdge(after, fmEnd, doc))
      : { heights: [edge ? edge[1] : 'var(--doc-lh)'], pad: null };
    if (pad) decos.push(Decoration.line({ attributes: { style: `padding-bottom:${pad}` } }).range(doc.line(end).from));
    for (let i = start; i <= end; i++) {
      if (!after) {
        if (i === end && run.size === 2) kinds.set(i, { kind: 'empty', run });
        if (i > start) continue;
      } else if ((i - start) % 2 === 1) { kinds.set(i, { kind: 'empty', run }); continue; }
      kinds.set(i, { kind: 'sep', run });
      const line = doc.line(i);
      decos.push(Decoration.replace({ widget: new SeparatorWidget(heights[(i - start) / 2]), block: true }).range(line.from, line.to));
      atoms.push(Decoration.mark({}).range(line.from - 1, line.to + 1));
    }
  };
  let before = null;
  for (let c = syntaxTree(state).topNode.firstChild; c; c = c.nextSibling) {
    if (before) addRun(before, c);
    before = c;
  }
  if (before) addRun(before, null);
  return { kinds, continuation, decos: Decoration.set(decos, true), atoms: Decoration.set(atoms, true) };
}

const separatorField = StateField.define({
  create: (state) => buildSeparators(state),
  update: (value, tr) => {
    const structural = tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState);
    const continuation = tr.docChanged ? continuationLine(tr.state) : value.continuation && continuationLine(tr.state) === value.continuation ? value.continuation : 0;
    return structural || continuation !== value.continuation ? buildSeparators(tr.state, continuation) : value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (value) => value.decos),
    EditorView.atomicRanges.from(f, (value) => () => value.atoms),
  ],
});

function paragraphKind(state, lineNumber) {
  const info = state.field(separatorField, false);
  return (info && info.kinds.get(lineNumber)) || null;
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
            const hangLine = Decoration.line({
              attributes: { style: `padding-left:${pad};text-indent:calc(-1 * ${hang})` },
            });
            decos.push(hangLine.range(line.from));
            if (isTask) {
              decos.push(Decoration.line({ class: 'cm-lp-task-first' }).range(line.from));
              const itemEnd = doc.lineAt(node.node.parent.to).from;
              decos.push(Decoration.line({ class: 'cm-lp-task-last' }).range(itemEnd));
            }
            hide(line.from, node.from);
            // a task item's text parses as Task, not Paragraph
            for (let c = node.node.parent && node.node.parent.firstChild; c; c = c.nextSibling) {
              if (c.name !== 'Paragraph' && c.name !== 'Task') continue;
              for (let n = doc.lineAt(c.from).number; n <= doc.lineAt(c.to).number; n++) {
                const l = doc.line(n);
                if (l.from === line.from) continue;
                decos.push(hangLine.range(l.from));
                hide(l.from, l.from + spaceAfter(l.from));
              }
            }
            if (onActiveLine(node.from, node.to)) break;
            if (isTask) { hide(node.from, node.to + spaceAfter(node.to)); break; }
            const mark = doc.sliceString(node.from, node.to);
            const shape = /^[-*+]$/.test(mark) ? BULLETS[Math.min(depth, BULLETS.length) - 1] : null;
            decos.push(Decoration.replace({ widget: new BulletWidget(shape, shape ? mark : orderedNumber(doc, node.node.parent)) })
              .range(node.from, node.to + spaceAfter(node.to)));
            break;
          }
          case 'TaskMarker': {
            if (onActiveLine(node.from, node.to)) break;
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            if (checked) {
              const item = node.node.parent.parent;
              for (let n = doc.lineAt(item.from).number; n <= doc.lineAt(item.to).number; n++) {
                decos.push(Decoration.line({ class: 'cm-lp-task-done' }).range(doc.line(n).from));
              }
            }
            decos.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(node.from, node.to + spaceAfter(node.to)));
            break;
          }
          case 'HardBreak': {
            const marker = hardBreakMarker(doc, node);
            decos.push(Decoration.replace({}).range(marker.from, marker.to));
            break;
          }
          case 'ATXHeading1':
          case 'ATXHeading2':
          case 'ATXHeading3':
          case 'ATXHeading4':
          case 'ATXHeading5':
          case 'ATXHeading6':
          case 'SetextHeading1':
          case 'SetextHeading2': {
            const level = Math.min(Number(node.name.slice(-1)), 4);
            decos.push(Decoration.line({ class: `cm-lp-h${level}` }).range(doc.lineAt(node.from).from));
            if (node.name.startsWith('Setext') && !onActiveLine(node.from, node.to)) {
              decos.push(Decoration.line({ class: 'cm-lp-setext-rule' }).range(doc.lineAt(node.to).from));
            }
            break;
          }
          case 'HorizontalRule':
            if (!onActiveLine(node.from, node.to)) {
              decos.push(Decoration.line({ class: 'cm-lp-hr-line' }).range(doc.lineAt(node.from).from));
              decos.push(Decoration.replace({ widget: new HRWidget() }).range(node.from, node.to));
            }
            break;
          case 'BulletList':
          case 'OrderedList': {
            const item = node.node.parent;
            if (item && item.name === 'ListItem' && item.nextSibling && item.nextSibling.name === 'ListItem') {
              decos.push(Decoration.line({ class: 'cm-lp-nested-end' }).range(doc.lineAt(node.to).from));
            }
            break;
          }
          case 'FencedCode': {
            const first = doc.lineAt(node.from);
            const last = doc.lineAt(node.to);
            for (let n = first.number; n <= last.number; n++) {
              decos.push(Decoration.line({ class: 'cm-lp-code' }).range(doc.line(n).from));
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
  separatorField,
  paragraphKind,
  hardBreakAround,
  hardBreakAtoms,
  scanMath,
  scanMark,
  scanBlockMath,
  frontmatterEnd,
};
