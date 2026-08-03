import { TASK_CLASS, toggleTaskMark, frontmatterEndLine } from './syntax.js';

const DOTS_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/></svg>';

// Read Mode's adapter of the Block Renderer: renders a document to `doc`,
// enhances it (block widgets, task checkboxes, collapsible headings) and
// routes every edit made in place (task toggles) through the Save Flow.
export function createDocView({ doc, pipeline, blocks, save, getEditor, chevronSvg, skillMetaHTML, renderProperties, refreshInfo }) {
  const collapsedHeadings = new Set();
  let currentText = '';

  function currentContent() {
    return currentText;
  }

  function renderDoc(text) {
    currentText = text;
    const { meta, body } = pipeline.parseFrontmatter(text);
    doc.innerHTML = skillMetaHTML(meta) + pipeline.render(body);
    renderProperties(meta);
    enhanceDoc();
    refreshInfo(text);
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

  function enhanceDoc() {
    doc.querySelectorAll(`input.${TASK_CLASS}[data-line]`).forEach((cb) => {
      cb.addEventListener('change', () => toggleTaskAt(+cb.dataset.line, cb.checked));
    });
    blocks.enhance(doc);
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

  return { renderDoc, enhanceDoc, toggleTaskAt, resetCollapsedHeadings, currentContent };
}
