// Dev-only palette workbench: loaded from app.js when the URL has ?lab.
// Lives in a shadow root so page tokens can never restyle the panel itself.

const STORE = 'showmd-theme-lab';

const GROUPS = [
  ['Neutrals', ['bg', 'side', 'card', 'code-bg', 'line', 'faint', 'control-border', 'hover', 'selected', 'shadow-1', 'shadow-2', 'shadow-3']],
  ['Text', ['ink', 'muted', 'on-accent', 'white']],
  ['Accent', ['accent', 'accent-soft']],
  ['Semantic', ['add', 'add-bg', 'del', 'del-bg', 'question', 'question-bg', 'warning', 'warning-bg', 'tooltip-bg', 'tooltip-kbd-bg']],
  ['Marks (dots, 3:1 floor)', ['mark-add', 'mark-warn', 'mark-del']],
  ['Syntax', ['code-kw', 'code-str', 'code-cmt', 'code-num', 'code-type', 'code-fn']],
];

// PAIRS ratios are WCAG minimums. FAMILY/NEUTRALS thresholds below are house
// heuristics tuned to this palette, not standards — see CONTRIBUTING.md.
const PAIRS = [
  ['ink', 'bg', 7], ['muted', 'bg', 4.5], ['muted', 'side', 4.5],
  ['accent', 'bg', 4.5], ['on-accent', 'accent', 4.5],
  ['add', 'bg', 4.5], ['del', 'bg', 4.5], ['question', 'bg', 4.5], ['warning', 'bg', 4.5],
  ['code-kw', 'code-bg', 4.5], ['code-str', 'code-bg', 4.5], ['code-cmt', 'code-bg', 4.5],
  ['code-num', 'code-bg', 4.5], ['code-type', 'code-bg', 4.5], ['code-fn', 'code-bg', 4.5],
  ['control-border', 'bg', 3], ['faint', 'bg', 1.5], ['line', 'bg', 1.1],
];

const FAMILY = ['accent', 'add', 'del', 'question', 'warning'];
const NEUTRALS = ['bg', 'side', 'card', 'code-bg', 'line', 'faint', 'control-border', 'ink', 'muted'];

export function parseHex(h) {
  if (!h) return null;
  let s = h.trim().replace('#', '');
  if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join('');
  if (s.length !== 6 && s.length !== 8) return null;
  const n = parseInt(s.slice(0, 6), 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, s.length === 8 ? parseInt(s.slice(6), 16) / 255 : 1];
}

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance([r, g, b]) {
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export function oklch([r, g, b]) {
  const [R, G, B] = [toLin(r), toLin(g), toLin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, Bb);
  let H = (Math.atan2(Bb, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

const over = (fg, bg) => (fg[3] >= 1 ? fg : [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1));

let tokens = [];
let values = {};
let defaults = {};

const side = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
const rawOf = (name, s = side()) => values[name]?.[s];

function rgbFrom(vals, s, name) {
  const c = parseHex(vals[name]?.[s]);
  if (!c) return null;
  if (c[3] >= 1) return c;
  return over(c, parseHex(vals.bg?.[s]) || [1, 1, 1, 1]);
}

const rgbOf = (name, s = side()) => rgbFrom(values, s, name);

export function parseRoot(css) {
  const block = css.match(/^:root\s*\{([\s\S]*?)\n\}/m);
  if (!block) throw new Error('theme-lab: :root block not found in app.css');
  const names = [];
  const out = {};
  for (const m of block[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1];
    const raw = m[2].trim();
    const ld = raw.match(/^light-dark\(\s*([^,]+),\s*([^)]+)\)$/);
    if (ld) names.push(name), (out[name] = { light: ld[1].trim(), dark: ld[2].trim() });
    else if (parseHex(raw)) names.push(name), (out[name] = { light: raw, dark: raw, single: true });
  }
  return { names, defaults: out };
}

async function loadTokens() {
  const css = await fetch('/assets/app.css').then((r) => r.text());
  const parsed = parseRoot(css);
  tokens = parsed.names;
  defaults = parsed.defaults;
  values = structuredClone(defaults);
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
    for (const [k, v] of Object.entries(saved)) if (values[k]) values[k] = { ...values[k], ...v };
  } catch {}
}

function apply() {
  const root = document.documentElement;
  const diff = {};
  for (const name of tokens) {
    const v = values[name];
    const d = defaults[name];
    if (v.light === d.light && v.dark === d.dark) { root.style.removeProperty('--' + name); continue; }
    diff[name] = { light: v.light, dark: v.dark };
    root.style.setProperty('--' + name, d.single ? v.light : `light-dark(${v.light}, ${v.dark})`);
  }
  localStorage.setItem(STORE, JSON.stringify(diff));
}

function exportCss() {
  return ':root {\n' + tokens.map((n) => {
    const v = values[n];
    return `  --${n}: ${defaults[n].single ? v.light : `light-dark(${v.light}, ${v.dark})`};`;
  }).join('\n') + '\n}';
}

function importCss(text) {
  let n = 0;
  for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;\n]+)/g)) {
    const name = m[1];
    if (!values[name]) continue;
    const raw = m[2].trim();
    const ld = raw.match(/^light-dark\(\s*([^,]+),\s*([^)]+)\)$/);
    if (ld) { values[name] = { ...values[name], light: ld[1].trim(), dark: ld[2].trim() }; n++; }
    else if (parseHex(raw)) { values[name] = { ...values[name], [side()]: raw }; n++; }
  }
  return n;
}

export function audit(vals, s) {
  const rgbOf = (name) => rgbFrom(vals, s, name);
  const out = [];
  for (const [fg, bg, min] of PAIRS) {
    const a = rgbOf(fg);
    const b = rgbOf(bg);
    if (!a || !b) continue;
    const r = contrast(a, b);
    out.push({ ok: r >= min, text: `${fg} / ${bg}`, val: `${r.toFixed(2)}:1`, want: `≥${min}` });
  }

  const fam = FAMILY.map((n) => ({ n, ...oklch(rgbOf(n) || [0, 0, 0, 1]) })).filter((x) => rgbOf(x.n));
  if (fam.length > 1) {
    const dL = Math.max(...fam.map((f) => f.L)) - Math.min(...fam.map((f) => f.L));
    const dC = Math.max(...fam.map((f) => f.C)) - Math.min(...fam.map((f) => f.C));
    out.push({ ok: dL <= 0.07, text: 'family lightness spread ΔL', val: dL.toFixed(3), want: '≤0.07' });
    out.push({ ok: dC <= 0.05, text: 'family chroma spread ΔC', val: dC.toFixed(3), want: '≤0.05' });
    const hues = fam.map((f) => f.H).sort((a, b) => a - b);
    let gap = 360;
    for (let i = 0; i < hues.length; i++) {
      const g = i ? hues[i] - hues[i - 1] : hues[0] + 360 - hues[hues.length - 1];
      if (g < gap) gap = g;
    }
    out.push({ ok: gap >= 25, text: 'min hue gap between roles', val: `${gap.toFixed(0)}°`, want: '≥25°' });
    const flat = fam.filter((f) => f.C < 0.06).map((f) => f.n);
    out.push({ ok: !flat.length, text: 'roles reading as gray (C<0.06)', val: flat.join(', ') || 'none', want: 'none' });
  }

  const tint = NEUTRALS.map((n) => ({ n, ...oklch(rgbOf(n) || [0, 0, 0, 1]) })).filter((x) => rgbOf(x.n));
  const maxC = Math.max(...tint.map((t) => t.C));
  const hueSpread = (() => {
    const h = tint.filter((t) => t.C > 0.004).map((t) => t.H);
    return h.length > 1 ? Math.max(...h) - Math.min(...h) : 0;
  })();
  out.push({ ok: maxC <= 0.015, text: 'neutral tint (max chroma)', val: maxC.toFixed(4), want: '≤0.015 warm-gray, 0 = true black' });
  out.push({ ok: hueSpread <= 30, text: 'neutral hue consistency', val: `${hueSpread.toFixed(0)}°`, want: '≤30°' });

  const ink = rgbOf('ink');
  if (ink) {
    const o = oklch(ink);
    out.push({ ok: true, text: 'ink OKLCH', val: `L ${o.L.toFixed(3)} C ${o.C.toFixed(3)} H ${o.H.toFixed(0)}°`, want: 'black = L 0 C 0' });
  }
  return out;
}

const analyse = () => audit(values, side());

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; font-family: ui-sans-serif, -apple-system, sans-serif; }
.wrap {
  position: fixed; top: 0; right: 0; bottom: 0; width: 380px; z-index: 2147483647;
  background: #17171a; color: #e6e6e8; display: flex; flex-direction: column;
  font-size: 12px; box-shadow: -8px 0 24px #0006; border-left: 1px solid #2c2c31;
}
.wrap.left { right: auto; left: 0; border-left: none; border-right: 1px solid #2c2c31; box-shadow: 8px 0 24px #0006; }
.wrap.min { width: auto; bottom: auto; border-radius: 0 0 0 8px; }
.wrap.min .body, .wrap.min .foot { display: none; }
header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #2c2c31; }
header b { font-size: 12px; font-weight: 600; }
.spacer { margin-left: auto; }
button, select, input, textarea { font: inherit; color: inherit; }
button {
  background: #232329; border: 1px solid #35353c; border-radius: 5px;
  padding: 3px 8px; cursor: pointer;
}
button:hover { background: #2d2d35; }
button.on { background: #3b6fd4; border-color: #3b6fd4; }
.body { flex: 1; overflow: auto; padding: 8px 10px 16px; }
h4 { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: #8d8d99; margin: 14px 0 6px; }
h4:first-child { margin-top: 4px; }
.row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.row label { width: 108px; flex-shrink: 0; color: #b9b9c2; overflow: hidden; text-overflow: ellipsis; }
.row input[type=color] { width: 26px; height: 22px; padding: 0; border: 1px solid #35353c; border-radius: 4px; background: none; cursor: pointer; }
.row input[type=text] {
  width: 84px; background: #0f0f12; border: 1px solid #2c2c31; border-radius: 4px;
  padding: 3px 5px; font-family: ui-monospace, Menlo, monospace; font-size: 11px;
}
.row .lch { color: #6f6f7c; font-family: ui-monospace, Menlo, monospace; font-size: 10px; white-space: nowrap; }
.row.dirty label { color: #ffd479; }
.chk { display: flex; gap: 6px; padding: 2px 0; align-items: baseline; }
.chk .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-top: 4px; }
.chk .t { flex: 1; color: #b9b9c2; }
.chk .v { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
.chk .w { color: #6f6f7c; font-size: 10px; }
.pass .dot { background: #58c98a; } .pass .v { color: #58c98a; }
.fail .dot { background: #e5766d; } .fail .v { color: #e5766d; }
.foot { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #2c2c31; }
textarea {
  width: 100%; height: 220px; background: #0f0f12; border: 1px solid #2c2c31;
  border-radius: 5px; padding: 8px; font-family: ui-monospace, Menlo, monospace; font-size: 11px;
  resize: vertical;
}
.io { padding: 8px 10px; border-top: 1px solid #2c2c31; }
.io.hide { display: none; }
.hint { color: #6f6f7c; margin: 4px 0 6px; }
`;

async function boot() {
  await loadTokens();
  apply();

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  root.appendChild(wrap);

  wrap.innerHTML = `
    <header>
      <b>Theme Lab</b>
      <button id="side"></button>
      <span class="spacer"></span>
      <button id="io">I/O</button>
      <button id="reset">Reset</button>
      <button id="dock" title="Dock left / right">⇄</button>
      <button id="min">–</button>
    </header>
    <div class="body"><div id="checks"></div><div id="rows"></div></div>
    <div class="io hide" id="iobox">
      <div class="hint">Paste a <code>:root</code> block or <code>--token: value</code> lines, then Apply.</div>
      <textarea id="ta" spellcheck="false"></textarea>
      <div class="foot" style="padding:8px 0 0">
        <button id="doimport">Apply paste</button>
        <button id="doexport">Fill with current</button>
        <button id="copy">Copy</button>
      </div>
    </div>`;

  const rowsEl = wrap.querySelector('#rows');
  const checksEl = wrap.querySelector('#checks');
  const sideBtn = wrap.querySelector('#side');
  const ta = wrap.querySelector('#ta');
  const controls = new Map();

  for (const [title, names] of GROUPS) {
    const list = names.filter((n) => values[n]);
    if (!list.length) continue;
    const h = document.createElement('h4');
    h.textContent = title;
    rowsEl.appendChild(h);
    for (const name of list) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<label title="--${name}">${name}</label>
        <input type="color"><input type="text" spellcheck="false"><span class="lch"></span>`;
      const [swatch, text, lch] = [row.querySelector('input[type=color]'), row.querySelector('input[type=text]'), row.querySelector('.lch')];
      swatch.addEventListener('input', () => {
        const cur = rawOf(name) || '#000000';
        const alpha = cur.replace('#', '').length === 8 ? cur.slice(-2) : '';
        set(name, swatch.value + alpha);
      });
      text.addEventListener('change', () => parseHex(text.value) && set(name, text.value.trim()));
      controls.set(name, { row, swatch, text, lch });
      rowsEl.appendChild(row);
    }
  }

  function set(name, hex) {
    values[name] = { ...values[name], [side()]: hex };
    if (defaults[name].single) values[name].dark = hex;
    apply();
    render();
  }

  function render() {
    const s = side();
    sideBtn.textContent = s === 'dark' ? '🌙 dark' : '☀︎ light';
    for (const [name, c] of controls) {
      const raw = rawOf(name) || '';
      c.text.value = raw;
      c.swatch.value = '#' + (parseHex(raw) || [0, 0, 0]).slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
      const rgb = rgbOf(name);
      const o = rgb && oklch(rgb);
      c.lch.textContent = o ? `${o.L.toFixed(2)} ${o.C.toFixed(3)} ${o.H.toFixed(0)}°` : '';
      c.row.classList.toggle('dirty', values[name][s] !== defaults[name][s]);
    }
    checksEl.innerHTML = analyse().map((c) => `
      <div class="chk ${c.ok ? 'pass' : 'fail'}"><span class="dot"></span>
      <span class="t">${c.text}</span><span class="v">${c.val}</span><span class="w">${c.want}</span></div>`).join('');
  }

  sideBtn.addEventListener('click', () => {
    window.showmdSetTheme(side() === 'dark' ? 'light' : 'dark');
    render();
  });
  wrap.querySelector('#min').addEventListener('click', () => wrap.classList.toggle('min'));
  wrap.querySelector('#dock').addEventListener('click', () => {
    localStorage.setItem(STORE + '-dock', wrap.classList.toggle('left') ? 'left' : '');
  });
  if (localStorage.getItem(STORE + '-dock') === 'left') wrap.classList.add('left');
  wrap.querySelector('#io').addEventListener('click', () => wrap.querySelector('#iobox').classList.toggle('hide'));
  wrap.querySelector('#reset').addEventListener('click', () => { values = structuredClone(defaults); apply(); render(); });
  wrap.querySelector('#doexport').addEventListener('click', () => { ta.value = exportCss(); });
  wrap.querySelector('#copy').addEventListener('click', () => navigator.clipboard.writeText(ta.value || exportCss()));
  wrap.querySelector('#doimport').addEventListener('click', () => {
    const n = importCss(ta.value);
    apply();
    render();
    wrap.querySelector('#doimport').textContent = n ? `Applied ${n}` : 'No tokens found';
    setTimeout(() => { wrap.querySelector('#doimport').textContent = 'Apply paste'; }, 1400);
  });

  render();
}

if (typeof document !== 'undefined') boot().catch((e) => console.error('theme-lab:', e));
