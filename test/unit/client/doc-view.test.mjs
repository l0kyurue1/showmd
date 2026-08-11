import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { frontmatterEndLine, TASK_CLASS } from '../../../client/syntax.js';

const dom = new JSDOM('<!doctype html><html><body><div id="doc"></div></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.Event = dom.window.Event;

const { createDocView } = await import('../../../client/doc-view.js');

function fakePipeline() {
  const renderCalls = [];
  return {
    renderCalls,
    parseFrontmatter(text) {
      const lines = text.split('\n');
      const end = frontmatterEndLine((n) => lines[n - 1], lines.length);
      return end ? { meta: {}, body: lines.slice(end).join('\n') } : { meta: null, body: text };
    },
    render(body) {
      renderCalls.push(body);
      return body.split('\n').map((line, i) => {
        const m = /^-\s+\[([ xX])\]\s+(.*)$/.exec(line);
        if (!m) return line ? `<p>${line}</p>` : '';
        const checked = m[1] !== ' ' ? ' checked' : '';
        return `<p><input type="checkbox" class="${TASK_CLASS}" data-line="${i}"${checked}> ${m[2]}</p>`;
      }).join('\n');
    },
  };
}

function mount() {
  document.getElementById('doc').innerHTML = '';
  const doc = document.getElementById('doc');
  const pipeline = fakePipeline();
  const blockRenderCalls = [];
  const blocks = {
    renderDocumentInto: async (el, source) => {
      blockRenderCalls.push({ el, source });
      el.innerHTML = pipeline.render(source);
    },
  };
  const scheduleCalls = [];
  const save = { schedule: () => scheduleCalls.push(true) };
  const docView = createDocView({
    doc, pipeline, blocks, save,
    getEditor: () => null,
    chevronSvg: '<svg class="chevron"></svg>',
    skillMetaHTML: () => '',
    renderProperties: () => {},
    refreshInfo: () => {},
  });
  return { doc, docView, blockRenderCalls, scheduleCalls };
}

test('toggleTaskAt computes the right line in a document with frontmatter', () => {
  const { docView } = mount();
  const text = '---\ntitle: x\n---\n- [ ] task one\n- [ ] task two';
  docView.renderDoc(text);
  docView.toggleTaskAt(1, true);
  const lines = docView.currentContent().split('\n');
  assert.equal(lines[3], '- [ ] task one');
  assert.equal(lines[4], '- [x] task two');
});

test('toggleTaskAt computes the right line in a document without frontmatter', () => {
  const { docView } = mount();
  const text = '- [ ] task one\n- [ ] task two';
  docView.renderDoc(text);
  docView.toggleTaskAt(0, true);
  const lines = docView.currentContent().split('\n');
  assert.equal(lines[0], '- [x] task one');
  assert.equal(lines[1], '- [ ] task two');
});

test('toggleTaskAt schedules a save through the Save Flow instead of writing directly', () => {
  const { docView, scheduleCalls } = mount();
  docView.renderDoc('- [ ] task one');
  docView.toggleTaskAt(0, true);
  assert.equal(scheduleCalls.length, 1);
});

test('two headings with identical text collapse independently', () => {
  const { doc, docView } = mount();
  doc.innerHTML = '<h2>Same</h2><p id="p1">one</p><h2>Same</h2><p id="p2">two</p>';
  docView.enhanceDoc();
  const toggles = doc.querySelectorAll('.h-toggle');
  assert.equal(toggles.length, 2);
  toggles[0].dispatchEvent(new Event('click', { bubbles: true }));
  assert.equal(document.getElementById('p1').hidden, true);
  assert.equal(document.getElementById('p2').hidden, false);
});

test('collapse state survives a re-render of the same document', () => {
  const { doc, docView } = mount();
  const render = () => { doc.innerHTML = '<h1>One</h1><p>body one</p><h1>Two</h1><p>body two</p>'; docView.enhanceDoc(); };
  render();
  const firstToggle = doc.querySelectorAll('.h-toggle')[0];
  firstToggle.dispatchEvent(new Event('click', { bubbles: true }));
  const headings = doc.querySelectorAll('h1');
  assert.equal(headings[0].classList.contains('h-collapsed'), true);

  render();
  const headingsAfter = doc.querySelectorAll('h1');
  assert.equal(headingsAfter[0].classList.contains('h-collapsed'), true);
});

test('Read Mode delegates document rendering through the Block Renderer interface', () => {
  const { doc, docView, blockRenderCalls } = mount();
  docView.renderDoc('plain text');
  assert.equal(blockRenderCalls.length, 1);
  assert.deepEqual(blockRenderCalls[0], { el: doc, source: 'plain text' });
});
