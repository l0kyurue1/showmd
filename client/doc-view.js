import { TASK_CLASS, toggleTaskMark, frontmatterEndLine } from './syntax.js';
import { anchorBlock, blockForHint, lineTop, snippetAt, countBefore, nthIndex } from './scroll-sync.js';

const DOTS_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/></svg>';

// Render and enhance Read Mode, routing in-place edits through Save Flow.
export function createDocView({ doc, pipeline, blocks, save, getEditor, scroller, chevronSvg, skillMetaHTML, renderProperties, refreshInfo }) {
  const collapsedHeadings = new Set();
  let currentText = '';
  let rendering = Promise.resolve();

  function currentContent() {
    return currentText;
  }

  function renderDoc(text) {
    currentText = text;
    const { meta, body } = pipeline.parseFrontmatter(text);
    rendering = blocks.renderDocumentInto(doc, body);
    doc.insertAdjacentHTML('afterbegin', skillMetaHTML(meta));
    renderProperties(meta);
    enhanceDoc();
    refreshInfo(text);
    return rendering;
  }

  function whenRendered() {
    return rendering;
  }

  function toggleTaskAt(bodyLine, checked) {
    const lines = currentText.split('\n');
    const fmEnd = frontmatterEndLine((n) => lines[n - 1], lines.length);
    const i = bodyLine + fmEnd;
    if (lines[i] == null) return;
    lines[i] = toggleTaskMark(lines[i], checked);
    const next = lines.join('\n');
    const editor = getEditor();
    if (editor) editor.setContent(next);
    renderDoc(next);
    save.schedule();
  }

  function frontmatterLines() {
    const lines = currentText.split('\n');
    return frontmatterEndLine((n) => lines[n - 1], lines.length);
  }

  function lineBlocks() {
    // task checkboxes carry data-line too; a fence stamps its inner code, so measure the pre
    return [...doc.querySelectorAll('[data-line]:not(input)')].map((el) => {
      const rect = (el.closest('pre') || el).getBoundingClientRect();
      return { line: +el.dataset.line, top: rect.top, bottom: rect.bottom };
    });
  }

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p && { node: p.offsetNode, offset: p.offset };
    }
    const r = document.caretRangeFromPoint?.(x, y);
    return r && { node: r.startContainer, offset: r.startOffset };
  }

  function glyphTop(node, index) {
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    return range.getBoundingClientRect();
  }

  function topBlocks() {
    const out = [];
    for (const el of doc.children) {
      if (el.hidden) continue;
      const stamped = el.matches('[data-line]:not(input)') ? el : el.querySelector('[data-line]:not(input)');
      if (stamped) out.push({ el, line: +stamped.dataset.line });
    }
    return out;
  }

  function textMap(el) {
    const parts = [];
    let text = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      parts.push({ node: walker.currentNode, start: text.length });
      text += walker.currentNode.data;
    }
    return { text, parts };
  }

  function nodeAt(map, index) {
    let part = map.parts[0];
    for (const p of map.parts) if (p.start <= index) part = p;
    return part && { node: part.node, offset: index - part.start };
  }

  // A visible text line near the view top: aligning it is exact even where line counts differ between modes
  function textHint(viewTop) {
    const left = doc.getBoundingClientRect().left + 120;
    const limit = viewTop + scroller.clientHeight;
    const tops = topBlocks();
    for (const dy of [1, 12, 28, 56, 100]) {
      const c = caretAt(left, viewTop + dy);
      if (!c || c.node.nodeType !== 3 || !doc.contains(c.node)) continue;
      let top = c.node.parentElement;
      while (top && top.parentElement !== doc) top = top.parentElement;
      const index = tops.findIndex((t) => t.el === top);
      if (index < 0) continue;
      const map = textMap(top);
      const base = map.parts.find((p) => p.node === c.node).start;
      const inCode = !!c.node.parentElement.closest('pre');
      for (const from of [c.offset, Math.max(0, c.offset - 8), 0]) {
        const snip = inCode ? snippetAt(map.text, base + from, false) : snippetAt(c.node.data, from, false);
        if (!snip) continue;
        const start = inCode ? snip.start : base + snip.start;
        const at = nodeAt(map, start);
        const rect = glyphTop(at.node, at.offset);
        if (rect.height === 0 || rect.bottom <= viewTop || rect.top >= limit) continue;
        const line = tops[index].line;
        const next = tops[index + 1];
        return { text: snip.text, offset: rect.top - viewTop, line, span: next ? next.line - line : 60, nth: countBefore(map.text, snip.text, start) };
      }
    }
    return null;
  }

  // line numbers cross this boundary as 1-based full-text lines, the editor's unit
  function viewportAnchor(viewTop) {
    const blocks = lineBlocks();
    const anchor = anchorBlock(blocks, viewTop);
    if (!anchor) return null;
    const fm = frontmatterLines() + 1;
    const hint = textHint(viewTop);
    const mapped = { line: anchor.line + fm, offset: anchor.offset };
    if (hint) mapped.hint = { ...hint, line: hint.line + fm };
    return mapped;
  }

  function scrollToLine(line, offset, hint) {
    const bodyLine = line - frontmatterLines() - 1;
    const hintLine = hint ? hint.line - frontmatterLines() - 1 : bodyLine;
    const blocks = lineBlocks();
    const viewTop = scroller.getBoundingClientRect().top;
    if (hint) {
      const top = blockForHint(topBlocks(), hintLine);
      const map = top && textMap(top.el);
      const index = map ? nthIndex(map.text, hint.text, hint.nth) : -1;
      const at = index >= 0 && nodeAt(map, index);
      const rect = at && glyphTop(at.node, at.offset);
      if (rect && rect.height > 0) {
        scroller.scrollTop += rect.top - viewTop - hint.offset;
        return;
      }
    }
    if (bodyLine < 0) { scroller.scrollTop = 0; return; }
    const top = lineTop(blocks, bodyLine);
    if (top === null) { scroller.scrollTop = 0; return; }
    scroller.scrollTop += top - viewTop - offset;
  }

  function enhanceDoc() {
    doc.querySelectorAll(`input.${TASK_CLASS}[data-line]`).forEach((cb) => {
      cb.addEventListener('change', () => toggleTaskAt(+cb.dataset.line, cb.checked));
    });
    enhanceHeadings();
  }

  function collapseSiblings(heading, collapsed) {
    const level = Number(heading.tagName[1]);
    let sib = heading.nextElementSibling;
    while (sib && !(/^H[1-6]$/.test(sib.tagName) && Number(sib.tagName[1]) <= level)) {
      sib.hidden = collapsed;
      sib = sib.nextElementSibling;
    }
    heading.classList.toggle('h-collapsed', collapsed);
  }

  function toggleHeading(heading, key) {
    const collapsed = !heading.classList.contains('h-collapsed');
    if (collapsed) collapsedHeadings.add(key);
    else collapsedHeadings.delete(key);
    collapseSiblings(heading, collapsed);
  }

  function enhanceHeadings() {
    const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach((heading, index) => {
      const key = `#${index}`;
      const toggle = document.createElement('span');
      toggle.className = 'h-toggle';
      toggle.innerHTML = chevronSvg;
      toggle.addEventListener('click', (e) => { e.stopPropagation(); toggleHeading(heading, key); });
      heading.prepend(toggle);

      const pill = document.createElement('span');
      pill.className = 'h-pill';
      pill.innerHTML = DOTS_SVG;
      pill.addEventListener('click', (e) => { e.stopPropagation(); toggleHeading(heading, key); });
      heading.appendChild(pill);

      if (collapsedHeadings.has(key)) collapseSiblings(heading, true);
    });
  }

  function resetCollapsedHeadings() {
    collapsedHeadings.clear();
  }

  return { renderDoc, whenRendered, enhanceDoc, toggleTaskAt, resetCollapsedHeadings, currentContent, viewportAnchor, scrollToLine };
}
