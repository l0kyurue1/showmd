import { reducedMotion } from './marquee.js';
import { SAVE_DEBOUNCE_MS as INFO_REFRESH_MS } from './save-flow.js';

export function createInfoPanel({
  panel, panelBtn, tabInfo, tabHistory, paneInfo, paneHistory,
  docStats, docOutline, outlineHeader, agentsHeader, agentsBox, props, propsHeader,
  doc, pipeline, viewState, storage,
  getContent, getEditor, getSkill, onOpen,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
}) {
  function makePropRow(key) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const k = document.createElement('div');
    k.className = 'prop-key';
    k.textContent = key;
    const v = document.createElement('div');
    v.className = 'prop-val';
    row.appendChild(k);
    row.appendChild(v);
    return { row, val: v };
  }

  function renderProperties(meta) {
    props.innerHTML = '';
    if (!meta || Object.keys(meta).length === 0) { props.hidden = true; propsHeader.hidden = true; return; }
    props.hidden = false;
    propsHeader.hidden = false;
    for (const [key, value] of Object.entries(meta)) {
      const { row, val } = makePropRow(key);
      val.innerHTML = pipeline.renderPropValue(value);
      props.appendChild(row);
    }
  }

  function renderStats(text) {
    const body = pipeline.parseFrontmatter(text).body;
    const words = (body.match(/\S+/g) || []).length;
    docStats.innerHTML =
      `<div class="stat-row"><span>Words</span><span>${words}</span></div>` +
      `<div class="stat-row"><span>Characters</span><span>${body.length}</span></div>`;
  }

  function jumpToHeading(item, idx) {
    if (viewState.view.mode === 'read') {
      const headings = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6')];
      const target = headings[idx];
      if (target) target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    } else if (getEditor()) {
      getEditor().jumpToLine(item.line);
    }
  }

  function renderOutline(outline) {
    docOutline.innerHTML = '';
    outlineHeader.hidden = !outline.length;
    outline.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'outline-row';
      row.textContent = item.text;
      row.style.paddingLeft = (item.level - 1) * 24 + 8 + 'px';
      row.addEventListener('click', () => jumpToHeading(item, idx));
      docOutline.appendChild(row);
    });
  }

  function refreshInfo(text) {
    const raw = text !== undefined ? text : getContent();
    renderStats(raw);
    renderOutline(pipeline.computeOutline(raw));
    renderAgents();
  }

  let infoRefreshTimer = null;
  function scheduleInfoRefresh() {
    timers.clear(infoRefreshTimer);
    infoRefreshTimer = timers.set(() => {
      if (!panelClosed()) refreshInfo();
    }, INFO_REFRESH_MS);
  }

  function layoutClampedChips(wrap, chipEls, maxRows) {
    wrap.replaceChildren(...chipEls);
    if (!chipEls.length) return;
    // Hidden chips report offsetTop 0; wait for a visible render to measure.
    if (wrap.offsetParent === null) return;
    if (new Set(chipEls.map((c) => c.offsetTop)).size <= maxRows) return;

    const more = document.createElement('span');
    more.className = 'badge chip badge-more';
    more.textContent = '…';
    more.title = 'Show all';
    more.addEventListener('click', () => wrap.replaceChildren(...chipEls));

    wrap.replaceChildren();
    let shown = 0;
    while (shown < chipEls.length) {
      wrap.appendChild(chipEls[shown]);
      wrap.appendChild(more);
      const rows = new Set([...wrap.children].map((c) => c.offsetTop)).size;
      wrap.removeChild(more);
      if (rows > maxRows) { wrap.removeChild(chipEls[shown]); break; }
      shown++;
    }
    wrap.appendChild(more);
  }

  function formatLockDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  function addProp(label, value) {
    if (!value) return;
    const { row, val } = makePropRow(label);
    val.textContent = value;
    agentsBox.appendChild(row);
  }

  function renderAgents() {
    const skill = getSkill();
    agentsHeader.hidden = agentsBox.hidden = !skill;
    if (!skill) return;
    agentsBox.innerHTML = '';

    const { row: agentsRow, val: agentsVal } = makePropRow('Agents');
    const chips = document.createElement('div');
    chips.className = 'agent-chips';
    agentsVal.appendChild(chips);
    agentsBox.appendChild(agentsRow);
    const chipEls = skill.badges.map((b) => {
      const chip = document.createElement('span');
      chip.className = 'badge chip';
      chip.textContent = b;
      return chip;
    });
    layoutClampedChips(chips, chipEls, 3);

    if (skill.copies) {
      const { row, val } = makePropRow('Copies');
      val.innerHTML = skill.copyPaths.map((p) => `<div>${pipeline.escapeHtml(p)}</div>`).join('');
      agentsBox.appendChild(row);
    }
    addProp('Origin', skill.origin);

    if (skill.source) {
      const { row, val } = makePropRow('Source');
      if (skill.sourceUrl) {
        const a = document.createElement('a');
        a.href = skill.sourceUrl.replace(/\.git$/, '');
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = skill.source;
        val.appendChild(a);
      } else {
        val.textContent = skill.source;
      }
      agentsBox.appendChild(row);
    }

    addProp('Install', skill.install);
    addProp('Installed', formatLockDate(skill.installedAt));
    addProp('Updated', formatLockDate(skill.updatedAt));
  }

  const panelClosed = () => panel.hidden || panel.classList.contains('collapsed');

  function setPanel(open) {
    panel.classList.toggle('collapsed', !open);
    panelBtn.classList.toggle('on', open);
    if (open) { onOpen(); refreshInfo(); }
  }

  function setPanelTab(tab) {
    if (tab !== 'history') tab = 'info';
    tabInfo.classList.toggle('on', tab === 'info');
    tabHistory.classList.toggle('on', tab === 'history');
    tabInfo.setAttribute('aria-selected', String(tab === 'info'));
    tabHistory.setAttribute('aria-selected', String(tab === 'history'));
    paneInfo.hidden = tab !== 'info';
    paneHistory.hidden = tab !== 'history';
    storage.setItem('showmd-panel-tab', tab);
    if (tab === 'info') refreshInfo();
  }

  tabInfo.addEventListener('click', () => setPanelTab('info'));
  tabHistory.addEventListener('click', () => setPanelTab('history'));

  return {
    refresh: refreshInfo,
    scheduleRefresh: scheduleInfoRefresh,
    renderProperties,
    isClosed: panelClosed,
    setOpen: setPanel,
    setTab: setPanelTab,
  };
}
