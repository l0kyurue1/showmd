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
export function createBlockRenderer({ markdown, load = (name) => VENDOR[name]() }) {
  const pending = new Map();
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

  // deliberately not folded into highlightCodeIn: that one waits on a lazy
  // network fetch and only matches language-tagged fences, and a plain ``` block
  // is just as worth copying
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
        el.innerHTML = katex.renderToString(span.src, { displayMode: span.display, throwOnError: false });
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
        holder.innerHTML = svg;
      } catch (err) {
        holder = mermaidErrorEl(source, err);
      }
      holder.dataset.src = source;
      el.replaceWith(holder);
    }
  }

  return {
    markdown,
    currentTheme,

    async mathHTML(src, display) {
      const katex = await vendor('katex');
      return katex.renderToString(src, { displayMode: display, throwOnError: false });
    },

    highlightCodeIn,
    addCopyButtonsIn,
    renderMathIn,
    mermaidSVG,
    mermaidErrorEl,
    renderMermaidIn,

    enhance(rootEl) {
      renderMermaidIn(rootEl).catch((err) => console.error('showmd: mermaid enhance failed', err));
      highlightCodeIn(rootEl).catch((err) => console.error('showmd: hljs enhance failed', err));
      addCopyButtonsIn(rootEl);
      // `$` pre-check is a heuristic: a lone currency `$` costs one wasted katex load, nothing more
      if (rootEl.textContent.includes('$')) {
        renderMathIn(rootEl).catch((err) => console.error('showmd: katex enhance failed', err));
      }
    },
  };
}
