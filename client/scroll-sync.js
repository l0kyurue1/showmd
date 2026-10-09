// blocks: [{ line, top, bottom }] in document order, viewport coordinates
// Inside a block, source lines map to height linearly; the last block has no end line, so it stays at its top.
function spanOf(blocks, index) {
  const b = blocks[index];
  for (let j = index + 1; j < blocks.length; j++) {
    if (blocks[j].bottom > blocks[j].top && blocks[j].line > b.line) return blocks[j].line - b.line;
  }
  return 0;
}

export function anchorBlock(blocks, viewTop) {
  let i = -1;
  for (let k = 0; k < blocks.length; k++) {
    const c = blocks[k];
    if (c.bottom <= c.top || c.bottom <= viewTop) continue;
    if (c.top > viewTop) {
      if (i < 0) i = k;
      break;
    }
    i = k;
  }
  if (i < 0) return null;
  const b = blocks[i];
  const span = spanOf(blocks, i);
  if (b.top >= viewTop || span < 2) return { line: b.line, offset: b.top - viewTop };
  const height = b.bottom - b.top;
  const inner = Math.floor(((viewTop - b.top) / height) * span);
  return { line: b.line + inner, offset: b.top + (inner / span) * height - viewTop };
}

export function blockForLine(blocks, line) {
  let best = null;
  for (const b of blocks) {
    if (b.line > line) break;
    if (b.bottom > b.top) best = b;
  }
  return best;
}

export function lineTop(blocks, line) {
  const block = blockForLine(blocks, line);
  if (!block) return null;
  const span = spanOf(blocks, blocks.indexOf(block));
  if (line <= block.line || span < 2) return block.top;
  return block.top + (Math.min(line - block.line, span) / span) * (block.bottom - block.top);
}

const MARKUP = /[*_~=`[\]()<>|\\#]/;
const LEADING_MARKER = /^(?:\s|>|[-*+]\s|\d+[.)]\s|#{1,6}\s|\[[ xX]\]\s)*/;

// Eight plain characters that read the same in the source and in the rendered text.
// Source text skips list/quote/heading markers and stops at inline markup.
export function snippetAt(text, from, source) {
  let i = source ? Math.max(from, LEADING_MARKER.exec(text)[0].length) : from;
  while (i < text.length && (/\s/.test(text[i]) || (source && MARKUP.test(text[i])))) i++;
  let j = i;
  while (j < text.length && j - i < 8 && !(source && MARKUP.test(text[j]))) j++;
  const sub = text.slice(i, j).trimEnd();
  return sub.length >= 2 ? { text: sub, start: i } : null;
}

// Both modes number a snippet by its occurrence within one block, so repeats (table cells, repeated phrases) resolve identically.
export function countBefore(text, snippet, end) {
  let n = 0;
  for (let i = text.indexOf(snippet); i >= 0 && i < end; i = text.indexOf(snippet, i + 1)) n++;
  return n;
}

export function nthIndex(text, snippet, nth) {
  let i = text.indexOf(snippet);
  for (let k = 0; k < nth && i >= 0; k++) i = text.indexOf(snippet, i + 1);
  return i;
}

export function blockForHint(tops, hintLine) {
  let best = null;
  for (const t of tops) {
    if (t.line > hintLine) break;
    best = t;
  }
  return best;
}

export function hintLines(line, span, total) {
  const first = Math.max(1, Math.min(line, total));
  return { first, last: Math.min(total, first + Math.max(span, 1) - 1) };
}
