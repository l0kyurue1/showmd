// no vendor globals, so both Block Renderer adapters and the markdown-it
// pipeline read the same rules.

export function mathSpans(text) {
  const out = [];
  if (!text.includes('$')) return out;
  const covered = [];
  let m;

  const block = /\$\$([^$]+?)\$\$/g;
  while ((m = block.exec(text))) {
    const to = m.index + m[0].length;
    covered.push([m.index, to]);
    out.push({ from: m.index, to, src: m[1].trim(), display: true });
  }

  const inline = /\$([^\s$][^$\n]*?)\$/g;
  while ((m = inline.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    if (covered.some(([a, b]) => from < b && to > a)) continue;
    // `$3.50 and $4` is currency, not math: a trailing space before the closing
    // `$`, or a digit straight after it, means the reader meant money
    if (/\s$/.test(m[1]) || /\d/.test(text.charAt(to))) continue;
    out.push({ from, to, src: m[1], display: false });
  }

  out.sort((a, b) => a.from - b.from);
  return out;
}

export function markEnd(src, pos) {
  if (src.charCodeAt(pos) !== 0x3D || src.charCodeAt(pos + 1) !== 0x3D) return -1;
  const nl = src.indexOf('\n', pos + 2);
  const limit = nl === -1 ? src.length : nl;
  const end = src.indexOf('==', pos + 2);
  if (end === -1 || end >= limit || end === pos + 2) return -1;
  if (src.charCodeAt(end - 1) === 0x3D) return -1;
  return end;
}

export function markSpans(text) {
  const out = [];
  let i = 0;
  while ((i = text.indexOf('==', i)) !== -1) {
    const end = markEnd(text, i);
    if (end === -1) { i += 2; continue; }
    out.push({ from: i, to: end + 2, inner: text.slice(i + 2, end) });
    i = end + 2;
  }
  return out;
}

export const TASK_CLASS = 'cb';
export const TASK_ITEM_RE = /^\[([ xX])\]\s+/;
export const TASK_MARK_RE = /^\[[ xX]\]$/;

export function toggleTaskMark(line, checked) {
  return line.replace(/\[[ xX]\]/, checked ? '[x]' : '[ ]');
}

// `lineText` is 1-based to match CodeMirror's doc.line(); frontmatter closes
// with `---` or `...`.
export function frontmatterEndLine(lineText, lineCount) {
  if (lineCount < 2 || lineText(1).trim() !== '---') return 0;
  for (let n = 2; n <= lineCount; n++) {
    const t = lineText(n).trim();
    if (t === '---' || t === '...') return n;
  }
  return 0;
}

export function parseWikilink(inner) {
  const pipe = inner.indexOf('|');
  const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const alias = (pipe === -1 ? inner : inner.slice(pipe + 1)).trim();
  return { target, alias };
}
