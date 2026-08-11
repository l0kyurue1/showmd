import { mathSpans } from './syntax.js';

const COPY_ICONS = '<svg class="code-copy-clip" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z"/><path d="M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2"/></svg><svg class="code-copy-check" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5l9 -9"/></svg>';
const copyTimers = new WeakMap();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

function loadCSS(href) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

const VENDOR = {
  hljs: () => loadScript('/assets/dist/hljs.js').then(() => window.hljs),
  katex: () => {
    loadCSS('/assets/vendor/katex/katex.min.css');
    return loadScript('/assets/vendor/katex/katex.min.js').then(() => window.katex);
  },
  mermaid: () => loadScript('/assets/vendor/mermaid/mermaid.min.js').then(() => window.mermaid),
};

function currentTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

// `load` yields a vendor lib, it is not the lib: katex and mermaid are several
// hundred KB each and must not be fetched until a block actually needs one.
export function createBlockRenderer({
  markdown,
  load = (name) => VENDOR[name](),
  reportError = (message, error) => console.error(message, error),
}) {
  const pending = new Map();
  const renderRequests = new WeakMap();
  const vendor = (name) => {
    if (!pending.has(name)) pending.set(name, load(name));
    return pending.get(name);
  };

  let mermaidTheme = null;
  let mermaidSeq = 0;
  const mermaidCache = new Map();

  async function ensureMermaid() {
    const mermaid = await vendor('mermaid');
    const theme = currentTheme() === 'dark' ? 'dark' : 'default';
    if (theme !== mermaidTheme) {
      mermaidTheme = theme;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
    }
    return mermaid;
  }

  async function highlightCodeIn(rootEl) {
    const codeBlocks = rootEl.querySelectorAll('pre > code[class*="language-"]:not(.language-mermaid)');
    if (codeBlocks.length === 0) return;
    const hljs = await vendor('hljs');
    for (const block of codeBlocks) {
      const lang = /language-(\S+)/.exec(block.className);
      if (lang) block.parentElement.dataset.lang = lang[1];
      hljs.highlightElement(block);
    }
  }

  // Add copy buttons immediately, including for untagged code fences.
  function addCopyButtonsIn(rootEl) {
    for (const code of rootEl.querySelectorAll('pre > code:not(.language-mermaid)')) {
      const pre = code.parentElement;
      if (pre.querySelector('.code-copy')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy';
      btn.setAttribute('aria-label', 'Copy code');
      btn.innerHTML = COPY_ICONS;
      btn.addEventListener('click', () => {
        navigator.clipboard?.writeText(code.textContent).catch(() => {});
        btn.classList.add('done');
        clearTimeout(copyTimers.get(btn));
        copyTimers.set(btn, setTimeout(() => btn.classList.remove('done'), 1200));
      });
      pre.appendChild(btn);
    }
  }

  async function mermaidSVG(src) {
    const mermaid = await ensureMermaid();
    const key = mermaidTheme + '\n' + src;
    if (mermaidCache.has(key)) return mermaidCache.get(key);
    const { svg } = await mermaid.render('mmd-' + (mermaidSeq++), src);
    mermaidCache.set(key, svg);
    return svg;
  }

  function parseMermaidSVG(svg) {
    const parsed = new window.DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = parsed.documentElement;
    if (root.localName !== 'svg'
      || root.namespaceURI !== 'http://www.w3.org/2000/svg'
      || parsed.querySelector('parsererror')) {
      throw new Error('Mermaid returned invalid SVG');
    }
    if (root.querySelector('script, iframe, object, embed')) {
      throw new Error('Mermaid returned unsafe SVG');
    }
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const attr of el.attributes) {
        const value = attr.value.trim();
        if (/^on/i.test(attr.name)
          || (/^(?:href|xlink:href)$/i.test(attr.name) && /^javascript:/i.test(value))) {
          throw new Error('Mermaid returned unsafe SVG');
        }
      }
    }
    return document.importNode(root, true);
  }

  function mermaidErrorEl(src, err) {
    const holder = document.createElement('div');
    holder.className = 'mermaid-error';
    const fence = document.createElement('pre');
    const fenceCode = document.createElement('code');
    fenceCode.textContent = src;
    fence.appendChild(fenceCode);
    const msg = document.createElement('div');
    msg.className = 'mermaid-error-msg';
    msg.textContent = 'Diagram failed to render: ' + ((err && err.message) || err);
    holder.appendChild(fence);
    holder.appendChild(msg);
    return holder;
  }

  async function renderMathIn(rootEl) {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    const targets = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest('code, pre, .katex')) continue;
      const spans = mathSpans(node.nodeValue);
      if (spans.length) targets.push([node, spans]);
    }
    if (targets.length === 0) return;
    const katex = await vendor('katex');
    for (const [node, spans] of targets) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const span of spans) {
        if (span.from > at) frag.appendChild(document.createTextNode(text.slice(at, span.from)));
        const el = document.createElement('span');
        katex.render(span.src, el, { displayMode: span.display, throwOnError: false });
        frag.appendChild(el);
        at = span.to;
      }
      if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));
      node.replaceWith(frag);
    }
  }

  async function renderMermaidIn(rootEl) {
    const targets = [
      ...[...rootEl.querySelectorAll('pre > code.language-mermaid')].map((code) => ({ source: code.textContent, el: code.parentElement })),
      ...[...rootEl.querySelectorAll('.mermaid-diagram[data-src], .mermaid-error[data-src]')].map((el) => ({ source: el.dataset.src, el })),
    ];
    for (const { source, el } of targets) {
      let holder;
      try {
        const svg = await mermaidSVG(source);
        holder = document.createElement('div');
        holder.className = 'mermaid-diagram';
        holder.replaceChildren(parseMermaidSVG(svg));
      } catch (err) {
        reportError('showmd: mermaid render failed', err);
        holder = mermaidErrorEl(source, err);
      }
      holder.dataset.src = source;
      el.replaceWith(holder);
    }
  }

  // Install the initial DOM synchronously so adapters can attach their own
  // interactions before the returned enhancement promise settles.
  async function renderDocumentInto(target, source) {
    if (!target || target.nodeType !== 1) throw new TypeError('Block Renderer target must be an element');
    if (typeof source !== 'string') throw new TypeError('Block Renderer source must be a string');

    try {
      target.innerHTML = markdown(source);
    } catch (error) {
      reportError('showmd: markdown render failed', error);
      target.textContent = source;
      return;
    }

    const attempt = (message, operation) => operation.catch((error) => reportError(message, error));
    const enhancements = [
      attempt('showmd: mermaid render failed', renderMermaidIn(target)),
      attempt('showmd: code highlight failed', highlightCodeIn(target)),
    ];
    addCopyButtonsIn(target);
    if (target.textContent.includes('$')) {
      enhancements.push(attempt('showmd: math render failed', renderMathIn(target)));
    }
    await Promise.all(enhancements);
  }

  async function refreshThemeIn(target) {
    if (!target || target.nodeType !== 1) throw new TypeError('Block Renderer target must be an element');
    try {
      await renderMermaidIn(target);
    } catch (error) {
      reportError('showmd: mermaid theme refresh failed', error);
    }
  }

  async function renderBlockInto(target, request) {
    if (!target || target.nodeType !== 1) throw new TypeError('Block Renderer target must be an element');
    if (!request || !['markdown', 'math', 'mermaid'].includes(request.kind)) {
      throw new TypeError('Block Renderer request has an unknown kind');
    }
    if (typeof request.source !== 'string') throw new TypeError('Block Renderer request source must be a string');

    const token = {};
    renderRequests.set(target, token);
    const isCurrent = () => renderRequests.get(target) === token;

    if (request.kind === 'markdown') {
      try {
        target.innerHTML = markdown(request.source);
      } catch (error) {
        reportError('showmd: markdown render failed', error);
        target.textContent = request.source;
        return;
      }
      try {
        await highlightCodeIn(target);
      } catch (error) {
        if (isCurrent()) reportError('showmd: code highlight failed', error);
      }
    } else if (request.kind === 'math') {
      target.textContent = request.source;
      try {
        const katex = await vendor('katex');
        const rendered = document.createElement('span');
        katex.render(request.source, rendered, {
          displayMode: Boolean(request.display),
          throwOnError: false,
        });
        if (isCurrent()) target.replaceChildren(...rendered.childNodes);
      } catch (error) {
        if (isCurrent()) reportError('showmd: math render failed', error);
      }
    } else if (request.kind === 'mermaid') {
      target.textContent = 'Rendering diagram…';
      try {
        const svg = await mermaidSVG(request.source);
        const rendered = parseMermaidSVG(svg);
        if (isCurrent()) target.replaceChildren(rendered);
      } catch (error) {
        if (isCurrent()) {
          reportError('showmd: mermaid render failed', error);
          target.replaceChildren(mermaidErrorEl(request.source, error));
        }
      }
    }
  }

  return { renderDocumentInto, renderBlockInto, refreshThemeIn };
}
