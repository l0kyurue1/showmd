import { markEnd, TASK_CLASS, TASK_ITEM_RE, parseWikilink, frontmatterEndLine } from './syntax.js';

const PENCIL_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/></svg>';
const INFO_CIRCLE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 9h.01"/><path d="M11 12h1v4h1"/></svg>';
const HELP_CIRCLE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 16v.01"/><path d="M12 13a2 2 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483"/></svg>';
const BULB_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h1m8 -9v1m8 8h1m-15.4 -6.4l.7 .7m12.1 -.7l-.7 .7"/><path d="M9 16a5 5 0 1 1 6 0a3.5 3.5 0 0 0 -1 3a2 2 0 0 1 -4 0a3.5 3.5 0 0 0 -1 -3"/><path d="M9.7 17l4.6 0"/></svg>';
const ALERT_TRIANGLE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0"/><path d="M12 16h.01"/></svg>';
const ALERT_OCTAGON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12.802 2.165l5.575 2.389c.48 .206 .863 .589 1.07 1.07l2.388 5.574c.22 .512 .22 1.092 0 1.604l-2.389 5.575c-.206 .48 -.589 .863 -1.07 1.07l-5.574 2.388c-.512 .22 -1.092 .22 -1.604 0l-5.575 -2.389a2.036 2.036 0 0 1 -1.07 -1.07l-2.388 -5.574a2.036 2.036 0 0 1 0 -1.604l2.389 -5.575c.206 -.48 .589 -.863 1.07 -1.07l5.574 -2.388a2.036 2.036 0 0 1 1.604 0"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';

const IMG_TAG_RE = /^<img\s+([^>]*?)\/?>/i;
const ATTR_RE = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const IMG_ATTRS = new Set(['src', 'alt', 'title', 'width', 'height', 'align']);
const WRAPPER_OPEN_RE = /^<(p|div|h[1-6])((?:\s+[a-zA-Z][a-zA-Z0-9-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*)\s*>/i;
const WRAPPER_ATTRS = new Set(['align']);

function pickAttrs(raw, allowed) {
  const attrs = [];
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw))) {
    const name = m[1].toLowerCase();
    if (allowed.has(name)) attrs.push([name, m[2] ?? m[3] ?? m[4]]);
  }
  return attrs;
}

const CALLOUT_META = {
  note: PENCIL_SVG, info: INFO_CIRCLE_SVG, question: HELP_CIRCLE_SVG, tip: BULB_SVG, warning: ALERT_TRIANGLE_SVG, danger: ALERT_OCTAGON_SVG,
};

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFrontmatter(text) {
  const lines = text.split('\n');
  const endLine = frontmatterEndLine((n) => lines[n - 1], lines.length);
  if (!endLine) return { meta: null, body: text };
  const end = endLine - 1;
  const meta = {};
  let currentKey = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      meta[currentKey].push(unquote(listItem[1]));
      continue;
    }
    const kv = /^([^:\s][^:]*):\s*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1].trim();
      const value = kv[2];
      if (value.trim() === '') {
        meta[key] = [];
        currentKey = key;
      } else {
        meta[key] = unquote(value);
        currentKey = null;
      }
    }
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

function headingText(token) {
  if (!token.children) return token.content;
  return token.children.map((c) => headingText(c)).join('');
}

function slugifyHeading(text) {
  return text.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function computeOutline(text) {
  const outline = [];
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    if (/^(```|~~~)/.test(line.trim())) { inFence = !inFence; return; }
    if (inFence) return;
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) outline.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
  });
  return outline;
}

export function createPipeline(markdownit) {
  const md = markdownit({ html: false, linkify: true });

  md.core.ruler.push('task_lists', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'list_item_open') continue;
      let inline = null;
      for (let j = i + 1; j < tokens.length && tokens[j].type !== 'list_item_close'; j++) {
        if (tokens[j].type === 'inline') { inline = tokens[j]; break; }
      }
      const first = inline && inline.children[0];
      if (!first || first.type !== 'text') continue;
      const match = TASK_ITEM_RE.exec(first.content);
      if (!match) continue;
      const checked = match[1].toLowerCase() === 'x';
      first.content = first.content.slice(match[0].length);
      const checkbox = new state.Token('html_inline', '', 0);
      const line = tokens[i].map ? ` data-line="${tokens[i].map[0]}"` : ' disabled';
      checkbox.content = `<input type="checkbox" class="${TASK_CLASS}"${line}${checked ? ' checked' : ''}>`;
      inline.children.unshift(checkbox);
      tokens[i].attrJoin('class', 'task-item' + (checked ? ' done-t' : ''));
    }
  });

  md.core.ruler.push('callouts', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open') continue;
      if (!tokens[i + 1] || tokens[i + 1].type !== 'paragraph_open') continue;
      const inline = tokens[i + 2];
      if (!inline || inline.type !== 'inline') continue;
      const first = inline.children[0];
      if (!first || first.type !== 'text') continue;
      const match = /^\[!([a-zA-Z][\w-]*)\]([ \t]*)(.*)$/.exec(first.content);
      if (!match) continue;

      let depth = 0, closeIdx = -1;
      for (let j = i; j < tokens.length; j++) {
        if (tokens[j].type === 'blockquote_open') depth++;
        else if (tokens[j].type === 'blockquote_close' && --depth === 0) { closeIdx = j; break; }
      }
      if (closeIdx === -1) continue;

      const type = match[1].toLowerCase();
      const known = Object.prototype.hasOwnProperty.call(CALLOUT_META, type);
      const customTitle = match[3].trim();
      const title = customTitle || (type.charAt(0).toUpperCase() + type.slice(1));

      tokens[i].tag = 'div';
      tokens[i].attrJoin('class', 'callout callout-' + (known ? type : 'note'));
      tokens[closeIdx].tag = 'div';

      if (inline.children[1] && inline.children[1].type === 'softbreak') inline.children.splice(0, 2);
      else inline.children.splice(0, 1);
      if (inline.children.length === 0) tokens.splice(i + 1, 3);

      const titleToken = new state.Token('html_block', '', 0);
      titleToken.block = true;
      titleToken.content = `<div class="callout-title"><span class="callout-icon">${known ? CALLOUT_META[type] : CALLOUT_META.note}</span><span class="callout-name">${md.utils.escapeHtml(title)}</span></div>\n`;
      tokens.splice(i + 1, 0, titleToken);
    }
  });

  md.inline.ruler.push('mark', (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    const end = markEnd(src, pos);
    if (end === -1) return false;
    if (!silent) {
      state.push('mark_open', 'mark', 1);
      const text = state.push('text', '', 0);
      text.content = src.slice(pos + 2, end);
      state.push('mark_close', 'mark', -1);
    }
    state.pos = end + 2;
    return true;
  });

  md.inline.ruler.push('wikilink', (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    if (src.charCodeAt(pos) !== 0x5B || src.charCodeAt(pos + 1) !== 0x5B) return false;
    const end = src.indexOf(']]', pos + 2);
    if (end === -1) return false;
    const inner = src.slice(pos + 2, end);
    if (!inner || inner.includes('[[')) return false;
    if (!silent) {
      const { target, alias } = parseWikilink(inner);
      const token = state.push('wikilink', '', 0);
      token.meta = { target, alias };
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.wikilink = (tokens, idx) => wikilinkHTML(tokens[idx].meta.target, tokens[idx].meta.alias);

  md.core.ruler.push('heading_ids', (state) => {
    const used = new Set();
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'heading_open') continue;
      const inline = tokens[i + 1];
      if (!inline || inline.type !== 'inline') continue;
      const base = slugifyHeading(headingText(inline)) || 'section';
      let slug = base;
      let suffix = 1;
      while (used.has(slug)) slug = `${base}-${suffix++}`;
      used.add(slug);
      tokens[i].attrSet('id', slug);
    }
  });

  md.inline.ruler.before('html_inline', 'img_tag', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x3C) return false;
    const m = IMG_TAG_RE.exec(state.src.slice(state.pos));
    if (!m) return false;
    const attrs = pickAttrs(m[1], IMG_ATTRS);
    if (!attrs.some(([name]) => name === 'src')) return false;
    if (!silent) {
      const altIndex = attrs.findIndex(([name]) => name === 'alt');
      if (altIndex === -1) attrs.push(['alt', '']);
      const token = state.push('image', 'img', 0);
      token.attrs = attrs;
      // the stock image renderer rebuilds alt from children, so mirror it there
      const alt = new state.Token('text', '', 0);
      alt.content = altIndex === -1 ? '' : attrs[altIndex][1];
      token.children = [alt];
      token.content = alt.content;
    }
    state.pos += m[0].length;
    return true;
  });

  md.inline.ruler.before('html_inline', 'br_tag', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x3C) return false;
    const m = /^<br\s*\/?>/i.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) state.push('hardbreak', 'br', 0);
    state.pos += m[0].length;
    return true;
  });

  // Accept only standalone one-line or three-line centered paragraphs.
  md.block.ruler.before('html_block', 'html_wrapper', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    const open = WRAPPER_OPEN_RE.exec(line);
    if (!open) return false;
    const tag = open[1].toLowerCase();
    const closeTag = '</' + tag + '>';
    const rest = line.slice(open[0].length);
    const restLower = rest.toLowerCase();

    const inlineEnd = restLower.lastIndexOf(closeTag);
    const singleLine = inlineEnd !== -1 && rest.slice(inlineEnd + closeTag.length).trim() === '';
    let contentEnd = startLine + 1;
    if (!singleLine) {
      if (rest.trim() !== '') return false;
      let depth = 1;
      contentEnd = -1;
      for (let l = startLine + 1; l < endLine; l++) {
        const text = state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]).trim().toLowerCase();
        if (text === closeTag && --depth === 0) { contentEnd = l; break; }
        if (WRAPPER_OPEN_RE.test(text) && WRAPPER_OPEN_RE.exec(text)[1].toLowerCase() === tag) depth++;
      }
      if (contentEnd === -1) return false;
    }
    if (silent) return true;

    // a multi-line wrapper holds block children, and <p><p> is illegal — the
    // browser would close the outer tag and drop its alignment
    const outTag = !singleLine && tag === 'p' ? 'div' : tag;
    const openToken = state.push('wrapper_open', outTag, 1);
    openToken.attrs = pickAttrs(open[2], WRAPPER_ATTRS);
    openToken.block = true;
    openToken.map = [startLine, contentEnd + 1];

    if (singleLine) {
      const inline = state.push('inline', '', 0);
      inline.content = rest.slice(0, inlineEnd).trim();
      inline.children = [];
      inline.map = [startLine, startLine + 1];
      state.line = startLine + 1;
    } else {
      const oldParent = state.parentType;
      state.parentType = 'html_wrapper';
      state.md.block.tokenize(state, startLine + 1, contentEnd);
      state.parentType = oldParent;
      state.line = contentEnd + 1;
    }

    state.push('wrapper_close', outTag, -1).block = true;
    return true;
  });

  let tree = [];
  function setTree(newTree) { tree = newTree; }

  let docId = null;
  function setDocId(id) { docId = id; }

  let assetUrl = null;
  function setAssetUrl(fn) { assetUrl = fn; }

  let docHref = null;
  function setDocHref(fn) { docHref = fn; }

  function resolveAssetSrc(src) {
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(src) || src.startsWith('data:') || src.startsWith('/')) return src;
    if (!docId || !assetUrl) return src;
    const dir = docId.includes('/') ? docId.slice(0, docId.lastIndexOf('/')) : '';
    const parts = [];
    for (const part of (dir ? dir + '/' + src : src).split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return assetUrl(parts.join('/'));
  }

  const renderImage = md.renderer.rules.image || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const srcIndex = token.attrIndex('src');
    if (srcIndex >= 0) token.attrs[srcIndex][1] = resolveAssetSrc(token.attrs[srcIndex][1]);
    return renderImage(tokens, idx, options, env, self);
  };

  function resolveWikilink(target) {
    const clean = target.trim().replace(/^\.?\/+/, '');
    if (!clean) return null;
    const withMd = clean.endsWith('.md') ? clean : clean + '.md';
    const withoutMd = clean.endsWith('.md') ? clean.slice(0, -3) : clean;
    const exact = tree.find((f) => f === withMd || f === withoutMd);
    if (exact) return exact;
    const slash = clean.lastIndexOf('/');
    const baseName = slash === -1 ? clean : clean.slice(slash + 1);
    const wantBase = (baseName.endsWith('.md') ? baseName : baseName + '.md').toLowerCase();
    const matches = tree.filter((f) => {
      const fslash = f.lastIndexOf('/');
      return (fslash === -1 ? f : f.slice(fslash + 1)).toLowerCase() === wantBase;
    });
    matches.sort();
    return matches[0] || null;
  }

  function wikilinkHTML(target, alias) {
    const resolved = resolveWikilink(target);
    const text = md.utils.escapeHtml(alias);
    if (!resolved) return `<span class="wikilink-unresolved">${text}</span>`;
    const href = (docHref && docHref(resolved)) || '#';
    return `<a href="${md.utils.escapeHtml(href)}" class="wikilink" data-file="${md.utils.escapeHtml(resolved)}">${text}</a>`;
  }

  function propValueHTML(v) {
    const m = /^\[\[(.+)\]\]$/.exec(String(v).trim());
    if (!m) return md.utils.escapeHtml(String(v));
    const { target, alias } = parseWikilink(m[1]);
    return wikilinkHTML(target, alias);
  }

  function renderPropValue(value) {
    return Array.isArray(value)
      ? value.map((item) => `<div>${propValueHTML(item)}</div>`).join('')
      : propValueHTML(value);
  }

  return {
    render: (src) => md.render(src),
    parseFrontmatter,
    resolveWikilink,
    wikilinkHTML,
    renderPropValue,
    computeOutline,
    setTree,
    setDocId,
    setAssetUrl,
    setDocHref,
    escapeHtml: (s) => md.utils.escapeHtml(s),
  };
}
