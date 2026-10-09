import { keyIntent, INITIAL_NAV, nextNav } from './navigation.js';
import { isSettingsOpen } from './view-state.js';
import { startMarquee, stopMarquee, reducedMotion } from './marquee.js';
import { SKILLS_EMPTY_NOTICE, AGENTS_EMPTY_NOTICE } from './home-view.js';

const MAGNIFIER_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>';

const EMPTY_CATALOG_NOTICE = { skills: SKILLS_EMPTY_NOTICE, agents: AGENTS_EMPTY_NOTICE };

const HEADER_VARIANT = { scope: 'sec-scope', group: 'sec-group', dir: undefined };

const NAV_OPEN_DEBOUNCE_MS = 120;

export function createSidebarTree({
  doc, sidebar, chevronSvg, searchShortcut, viewState, getModel, navigate, isEditorFocused,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
}) {
  let nav = INITIAL_NAV;
  let navOpenTimer = null;

  const searchEl = doc.createElement('div');
  searchEl.className = 'nav-search';
  searchEl.innerHTML = `<div class="nav-search-box"><span class="nav-search-icon">${MAGNIFIER_SVG}</span><input type="text" placeholder="Search files"><span class="nav-search-slot"><kbd>${searchShortcut}</kbd><button type="button" class="nav-search-clear" aria-label="Clear search">×</button></span></div>`;
  const searchInput = searchEl.querySelector('input');
  const searchClearBtn = searchEl.querySelector('.nav-search-clear');
  const navBody = doc.createElement('div');
  navBody.className = 'nav-body';

  function appendGlideList(items) {
    const list = doc.createElement('div');
    list.className = 'list';
    const glide = doc.createElement('div');
    glide.className = 'glide';
    list.appendChild(glide);
    for (const { el: li, contentEl, onClick } of items) {
      li.addEventListener('click', onClick);
      li.addEventListener('mouseenter', () => {
        glide.style.opacity = li.classList.contains('on') ? '0' : '1';
        startMarquee(li, contentEl);
        const indent = getComputedStyle(li).getPropertyValue('--indent').trim() || '10px';
        // breathing room: keep the pill's edge off the text's clip edge so the
        // row doesn't look flush-cut against it
        glide.style.left = `calc(${indent} - 6px)`;
        glide.style.transform = `translateY(${li.offsetTop}px)`;
      });
      li.addEventListener('mouseleave', () => stopMarquee(li));
      list.appendChild(li);
    }
    list.addEventListener('mouseleave', () => (glide.style.opacity = '0'));
    return list;
  }

  function applyQuery(q) {
    nav = nextNav(nav, { type: 'query', query: q });
    searchEl.classList.toggle('has-query', q.length > 0);
    renderSidebar();
  }

  searchInput.addEventListener('input', () => applyQuery(searchInput.value));
  searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    applyQuery('');
    searchInput.focus();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (nav.query) { searchInput.value = ''; applyQuery(''); }
      else searchInput.blur();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    const first = nav.rows[0];
    if (!first) return;
    e.preventDefault();
    if (e.key === 'Enter') applyIntent(first.collapsible ? { type: 'toggle', row: first } : { type: 'open', row: first });
    else setNavSelected(first.id);
  });

  function toggleAndRender(nodeId) {
    nav = nextNav(nav, { type: 'toggle', nodeId });
    renderSidebar();
  }

  function isLastVisited(row) {
    return isSettingsOpen(viewState.view) && row.id === getModel().file;
  }

  function makeDisclosureHeader(row, variant) {
    const header = doc.createElement('div');
    header.className = ['sec', 'disclosure', variant, row.collapsed ? 'collapsed' : ''].filter(Boolean).join(' ');
    header.dataset.navId = row.id;
    header.dataset.navDepth = String(row.depth);
    const chevron = doc.createElement('span');
    chevron.className = 'chevron';
    chevron.innerHTML = chevronSvg;
    header.appendChild(chevron);
    const label = doc.createElement('span');
    label.className = 'sec-label';
    if (row.labelParts) {
      const { prefix, name } = row.labelParts;
      if (prefix) {
        const prefixEl = doc.createElement('span');
        prefixEl.className = 'sec-label-prefix';
        prefixEl.textContent = prefix;
        label.appendChild(prefixEl);
      }
      const nameEl = doc.createElement('span');
      nameEl.className = 'sec-label-name';
      nameEl.textContent = name;
      label.appendChild(nameEl);
    } else {
      label.textContent = row.label;
    }
    header.appendChild(label);
    header.addEventListener('click', () => toggleAndRender(row.nodeId));
    return header;
  }

  function makeRowText(text, labelParts) {
    const inner = doc.createElement('span');
    inner.className = 'rowtext';
    const track = doc.createElement('span');
    track.className = 'rowtext-track';
    if (labelParts) {
      const dirEl = doc.createElement('span');
      dirEl.className = 'rowtext-dir';
      dirEl.textContent = labelParts.dir;
      track.appendChild(dirEl);
      const baseEl = doc.createElement('span');
      baseEl.className = 'rowtext-base';
      baseEl.textContent = labelParts.base;
      track.appendChild(baseEl);
    } else {
      track.textContent = text;
    }
    inner.appendChild(track);
    return inner;
  }

  function makeSkillItem(row) {
    const skill = row.skill;
    const li = doc.createElement('li');
    li.className = 'skill-row';
    li.dataset.navId = row.id;
    li.dataset.navDepth = String(row.depth);
    if (row.current) li.classList.add('on');
    else if (isLastVisited(row)) li.classList.add('last-visited');
    const chevron = doc.createElement('span');
    if (row.collapsible) {
      chevron.className = 'chevron row-chevron' + (row.collapsed ? ' collapsed' : '');
      chevron.innerHTML = chevronSvg;
      chevron.addEventListener('click', (e) => { e.stopPropagation(); toggleAndRender(row.nodeId); });
    } else {
      chevron.className = 'chevron-spacer';
    }
    li.appendChild(chevron);
    const inner = makeRowText(skill.name);
    li.appendChild(inner);
    if (skill.copies) {
      const marker = doc.createElement('span');
      marker.className = 'skill-badge skill-copies';
      marker.textContent = `\u00d7${skill.copies}`;
      li.appendChild(marker);
    } else if (skill.origin) {
      const marker = doc.createElement('span');
      marker.className = 'skill-badge skill-origin';
      marker.textContent = `\u00b7 ${skill.origin}`;
      li.appendChild(marker);
      const dot = doc.createElement('span');
      dot.className = 'skill-dupe-dot';
      dot.title = 'duplicate copies with different content';
      li.appendChild(dot);
    }
    return { el: li, contentEl: inner.firstElementChild, onClick: () => navigate(row.id) };
  }

  function makeFileItem(row) {
    const li = doc.createElement('li');
    const classes = [];
    if (row.nested) classes.push('nav-nested');
    if (row.underSkill) classes.push('skill-file-row');
    li.className = classes.join(' ');
    li.dataset.navId = row.id;
    li.dataset.navDepth = String(row.depth);
    const inner = makeRowText(row.label, row.labelParts);
    li.appendChild(inner);
    if (reducedMotion()) li.title = row.label;
    if (row.current) li.classList.add('on');
    else if (isLastVisited(row)) li.classList.add('last-visited');
    return { el: li, contentEl: inner.firstElementChild, onClick: () => navigate(row.id) };
  }

  function makeAgentProjectItem(row) {
    const li = doc.createElement('li');
    li.className = 'skill-row';
    li.dataset.navId = row.id;
    li.dataset.navDepth = String(row.depth);
    if (row.title) li.title = row.title;
    if (row.current) li.classList.add('on');
    else if (isLastVisited(row)) li.classList.add('last-visited');
    const chevron = doc.createElement('span');
    if (row.collapsible) {
      chevron.className = 'chevron row-chevron' + (row.collapsed ? ' collapsed' : '');
      chevron.innerHTML = chevronSvg;
      chevron.addEventListener('click', (e) => { e.stopPropagation(); toggleAndRender(row.nodeId); });
    } else {
      chevron.className = 'chevron-spacer';
    }
    li.appendChild(chevron);
    const inner = makeRowText(row.label);
    li.appendChild(inner);
    return { el: li, contentEl: inner.firstElementChild, onClick: () => navigate(row.id) };
  }

  function renderNavEmpty(text) {
    const empty = doc.createElement('div');
    empty.className = 'nav-empty';
    empty.textContent = text;
    navBody.appendChild(empty);
    return empty;
  }

  const ITEM_MAKER = { skill: makeSkillItem, project: makeAgentProjectItem };

  function paintRows(rows) {
    let batch = [];
    let batchKey = null;
    const flush = () => {
      if (batch.length) navBody.appendChild(appendGlideList(batch));
      batch = [];
      batchKey = null;
    };
    for (const row of rows) {
      if (row.kind in HEADER_VARIANT) {
        flush();
        navBody.appendChild(makeDisclosureHeader(row, HEADER_VARIANT[row.kind]));
        continue;
      }
      if (row.listKey !== batchKey) flush();
      batchKey = row.listKey;
      batch.push((ITEM_MAKER[row.kind] || makeFileItem)(row));
    }
    flush();
  }

  function renderSidebar() {
    const { model, file, kind } = getModel();
    nav = nextNav(nav, { type: 'sync-rows' }, { model, file, hideFile: isSettingsOpen(viewState.view) });
    navBody.replaceChildren();
    if (nav.rows.length === 0) {
      if (nav.query) { renderNavEmpty('No matches'); return; }
      if (EMPTY_CATALOG_NOTICE[kind]) { renderNavEmpty(EMPTY_CATALOG_NOTICE[kind]); return; }
    }
    paintRows(nav.rows);
    // selection lives in state, so it survives the markup being thrown away
    const selectedEl = navItemFor(nav.selected);
    if (selectedEl) selectedEl.classList.add('kbd-on');
  }

  function navItemFor(id) {
    return id == null ? null : sidebar.querySelector(`[data-nav-id="${CSS.escape(id)}"]`);
  }

  function setNavSelected(id) {
    const prev = navItemFor(nav.selected);
    if (prev) prev.classList.remove('kbd-on');
    timers.clear(navOpenTimer);
    nav = nextNav(nav, { type: 'select', id });
    const el = navItemFor(id);
    if (el) {
      el.classList.add('kbd-on');
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  // arrowing onto a file opens it after a short pause, so holding the key to
  // skim past several rows doesn't load every intermediate file
  function applyIntent(intent) {
    timers.clear(navOpenTimer);
    if (intent.type === 'toggle') {
      nav = nextNav(nav, { type: 'toggle', nodeId: intent.row.nodeId, selected: intent.row.id });
      renderSidebar();
      return;
    }
    if (intent.type === 'open') {
      setNavSelected(intent.row.id);
      navigate(intent.row.id);
      return;
    }
    setNavSelected(intent.row.id);
    if (intent.autoOpen) navOpenTimer = timers.set(() => navigate(intent.row.id), NAV_OPEN_DEBOUNCE_MS);
  }

  function focusBlocksSidebarNav() {
    const el = doc.activeElement;
    if (!el || el === doc.body) return false;
    if (isEditorFocused(el)) return true;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
    return el.isContentEditable;
  }

  doc.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(e.key)) return;
    if (sidebar.classList.contains('collapsed') || focusBlocksSidebarNav()) return;
    const intent = keyIntent(nav.rows, e.key, { selected: nav.selected, file: getModel().file });
    if (!intent) return;
    e.preventDefault();
    applyIntent(intent);
  });

  return {
    searchEl,
    navBody,
    render: renderSidebar,
    reset() { nav = nextNav(nav, { type: 'reset' }); },
    deselectUnless(file) {
      if (nav.selected !== file) nav = nextNav(nav, { type: 'select', id: null });
    },
    setPlaceholder(text) { searchInput.placeholder = text; },
    focusSearch() {
      searchInput.focus();
      searchInput.select();
    },
    showNotice(text) {
      navBody.replaceChildren();
      return renderNavEmpty(text);
    },
  };
}
