import { EditorView, ViewPlugin } from '@codemirror/view';

const SLASH_ITEMS = [
  { label: 'Heading 1', insert: '# ' },
  { label: 'Heading 2', insert: '## ' },
  { label: 'Heading 3', insert: '### ' },
  { label: 'Heading 4', insert: '#### ' },
  { label: 'Bullet list', insert: '- ' },
  { label: 'Numbered list', insert: '1. ' },
  { label: 'Check list', insert: '- [ ] ' },
  { label: 'Quote', insert: '> ' },
  { label: 'Callout', insert: '> [!note] ' },
  { label: 'Code block', insert: '```\n\n```', cursor: 4 },
  { label: 'Table', insert: '| Column | Column |\n| --- | --- |\n|  |  |\n', cursor: 2 },
  { label: 'Divider', insert: '---\n' },
];

function slashCompletions(context) {
  const line = context.state.doc.lineAt(context.pos);
  const before = context.state.doc.sliceString(line.from, context.pos);
  const m = /^(\s*)\/([\w ]*)$/.exec(before);
  if (!m) return null;
  const start = line.from + m[1].length;
  return {
    from: start + 1,
    options: SLASH_ITEMS.map((item) => ({
      label: item.label,
      apply: (view, _completion, _from, to) => {
        view.dispatch({
          changes: { from: start, to, insert: item.insert },
          selection: { anchor: start + (item.cursor ?? item.insert.length) },
        });
      },
    })),
  };
}

const slashTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: '12px',
    boxShadow: '0 4px 16px var(--shadow-3)',
    padding: '4px',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--sans)',
    minWidth: '180px',
    maxHeight: '304px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    position: 'relative',
    zIndex: '1',
    display: 'flex',
    alignItems: 'center',
    height: '32px',
    padding: '0 12px',
    borderRadius: '8px',
    marginBottom: '2px',
    fontSize: '13px',
    color: 'var(--muted)',
    backgroundColor: 'transparent',
    transition: 'color 80ms ease-out, font-weight 80ms ease-out',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li:last-child': {
    marginBottom: '0',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'transparent',
    color: 'var(--ink)',
    fontWeight: '550',
  },
  '.cm-slash-glide': {
    position: 'absolute',
    left: '0',
    right: '0',
    top: '0',
    height: '32px',
    borderRadius: '8px',
    backgroundColor: 'var(--accent-soft)',
    opacity: '0',
    pointerEvents: 'none',
    zIndex: '0',
    transition: 'transform 90ms ease-out, height 90ms ease-out, opacity 90ms ease-out',
  },
});

const slashGlide = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.glide = null;
    this.raf = 0;
    this.hovering = false;
    this.onMove = (e) => {
      const li = this.nearest(e.clientY);
      if (li) { this.hovering = true; this.moveTo(li); }
    };
    this.onLeave = () => { this.hovering = false; this.followSelection(); };
  }
  update() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.sync(); });
  }
  ul() {
    return this.view.dom.querySelector('.cm-tooltip-autocomplete > ul');
  }
  sync() {
    const ul = this.ul();
    if (!ul) { this.glide = null; this.hovering = false; return; }
    if (!this.glide || this.glide.parentNode !== ul) {
      ul.style.position = 'relative';
      this.glide = ul.appendChild(document.createElement('div'));
      this.glide.className = 'cm-slash-glide';
      this.hovering = false;
      ul.addEventListener('pointermove', this.onMove);
      ul.addEventListener('pointerleave', this.onLeave);
    }
    if (!this.hovering) this.followSelection();
  }
  followSelection() {
    const ul = this.ul();
    const sel = ul && ul.querySelector('li[aria-selected]');
    if (sel) this.moveTo(sel);
  }
  nearest(y) {
    const ul = this.ul();
    if (!ul) return null;
    let best = null;
    let dist = Infinity;
    for (const li of ul.children) {
      if (li.tagName !== 'LI') continue;
      const r = li.getBoundingClientRect();
      const d = Math.abs(y - (r.top + r.height / 2));
      if (d < dist) { dist = d; best = li; }
    }
    return best;
  }
  moveTo(li) {
    this.glide.style.transform = `translateY(${li.offsetTop}px)`;
    this.glide.style.height = li.offsetHeight + 'px';
    this.glide.style.opacity = '1';
  }
  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
  }
});

export { slashCompletions, slashTheme, slashGlide };
