import { createBlockRenderer } from './blocks.js';
import { createPipeline } from './pipeline.js';
import { keyIntent, INITIAL_NAV, nextNav } from './navigation.js';
import { MODE_CYCLE, createViewState, isSettingsOpen, isLauncherOpen, isSourceView, isVersionOpen } from './view-state.js';
import { startMarquee, stopMarquee, reducedMotion } from './marquee.js';
import { createHistoryView } from './history-view.js';
import { createDocView } from './doc-view.js';
import { createSaveFlow } from './save-flow.js';
import { FONT_PRESETS, createSettingsView } from './settings-view.js';
import { createHomeView } from './home-view.js';
import * as api from './api.js';

function isMacPlatform(nav) {
  return nav.userAgentData?.platform === 'macOS' || /Mac/i.test(nav.userAgent || '');
}

// Handlers accept metaKey || ctrlKey everywhere, so only the printed hints are
// platform-specific. Mac keeps the glyphs; everywhere else spells the modifiers
// out, because ⇧/⌥ read as nothing to a Windows or Linux user.
const SHORTCUT_GLYPHS = { '⌘': 'Ctrl', '⇧': 'Shift', '⌥': 'Alt', '⌃': 'Ctrl' };

function shortcutLabel(label, mac) {
  if (mac) return label;
  const parts = [];
  let rest = label;
  while (rest && SHORTCUT_GLYPHS[rest[0]]) {
    parts.push(SHORTCUT_GLYPHS[rest[0]]);
    rest = rest.slice(1);
  }
  if (parts.length === 0) return label;
  // ⇧⌘O prints modifiers in Mac order; Windows convention leads with Ctrl
  parts.sort((a, b) => (a === 'Ctrl' ? -1 : b === 'Ctrl' ? 1 : 0));
  return [...parts, rest].filter(Boolean).join('+');
}

function revealLabel(platform) {
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Show in File Explorer';
  return 'Show in file manager';
}

const IS_MAC = isMacPlatform(navigator);
const kbdLabel = (label) => shortcutLabel(label, IS_MAC);
if (!IS_MAC) {
  for (const el of document.querySelectorAll('kbd')) el.textContent = kbdLabel(el.textContent);
}

const pipeline = createPipeline(window.markdownit);
const blocks = createBlockRenderer({ markdown: (src) => pipeline.render(src) });

const state = { file: null, tree: [], skillsTree: null, agentTree: null };
// browser back/forward index into the files this tab has visited.
// (pushState/back/forward are used below)
let navIdx = 0;
let navMax = 0;
// doc-mode only: current root (null on a dedicated `showmd skills` server, where
// GET /api/root 404s)
let rootInfo = null;
let currentAgentKey = 'claude';
// where exiting Settings / the skills / agent-config view lands. One slot,
// because those three are mutually exclusive on screen.
let returnTo = 'files';
let lastVisitedFile = null;
const sidebar = document.getElementById('sidebar');
const sidebarBtn = document.getElementById('sidebar-btn');
const sidebarTip = document.getElementById('sidebar-tip');
const sidebarResize = document.getElementById('sidebar-resize');
const backBtn = document.getElementById('back-btn');
const fwdBtn = document.getElementById('fwd-btn');
const doc = document.getElementById('doc');
const main = document.getElementById('main');
const fname = document.getElementById('fname');
const fnameTrack = fname.firstElementChild;
const fnameSymlink = document.getElementById('fname-symlink');
const revealBtn = document.getElementById('reveal-btn');
const saveChip = document.getElementById('save-chip');
const saveChipDot = document.getElementById('save-chip-dot');
const saveChipText = document.getElementById('save-chip-text');
const saveChipTip = document.getElementById('save-chip-tip');
const props = document.getElementById('props');
const propsHeader = document.getElementById('props-header');
const editorHost = document.getElementById('editor-host');
const sourceBtn = document.getElementById('source-btn');
const editBtn = document.getElementById('edit-btn');
const readBtn = document.getElementById('read-btn');
const banner = document.getElementById('banner');
const bannerReload = document.getElementById('banner-reload');
const bannerKeep = document.getElementById('banner-keep');
const panel = document.getElementById('panel');
const panelBtn = document.getElementById('panel-btn');
const verList = document.getElementById('ver-list');
const restoreBtn = document.getElementById('restore-btn');
const diffView = document.getElementById('diff-view');
const diffTime = document.getElementById('diff-time');
const diffBody = document.getElementById('diff-body');
const diffBack = document.getElementById('diff-back');
const panelTabInfo = document.getElementById('tab-info');
const panelTabHistory = document.getElementById('tab-history');
const paneInfo = document.getElementById('pane-info');
const paneHistory = document.getElementById('pane-history');
const docStats = document.getElementById('doc-stats');
const docOutline = document.getElementById('doc-outline');
const outlineHeader = document.getElementById('outline-header');
const agentsHeader = document.getElementById('agents-header');
const agentsBox = document.getElementById('agents');
const toolbar = document.getElementById('toolbar');
const tbBold = document.getElementById('tb-bold');
const tbItalic = document.getElementById('tb-italic');
const tbStrike = document.getElementById('tb-strike');
const tbCode = document.getElementById('tb-code');
const tbLink = document.getElementById('tb-link');
const tbMark = document.getElementById('tb-mark');
const tbList = document.getElementById('tb-list');
const tbOlist = document.getElementById('tb-olist');
const tbTask = document.getElementById('tb-task');
const tbQuote = document.getElementById('tb-quote');
const tbUndo = document.getElementById('tb-undo');
const tbRedo = document.getElementById('tb-redo');
let cmEditor = null;

function setSaveState(kind, text, title) {
  saveChipDot.className = 'chip-dot ' + kind;
  saveChipText.textContent = text;
  saveChipTip.textContent = title || '';
}

const save = createSaveFlow({
  put: (text) => api.putRaw(state.file, text),
  read: () => (state.file ? currentContent() : null),
  onState: setSaveState,
});

function currentContent() {
  return cmEditor ? cmEditor.getContent() : docView.currentContent();
}

function skillMetaHTML(meta) {
  if (!meta || !/(^|\/)SKILL\.md$/.test(state.file || '')) return '';
  const rows = ['name', 'description']
    .filter((k) => meta[k] != null && meta[k] !== '')
    .map((k) => `<tr><th>${k}</th><td>${pipeline.renderPropValue(meta[k])}</td></tr>`)
    .join('');
  return rows ? `<table class="skill-meta"><tbody>${rows}</tbody></table>` : '';
}

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
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (cmEditor) {
    cmEditor.jumpToLine(item.line);
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
  const raw = text !== undefined ? text : currentContent();
  renderStats(raw);
  renderOutline(pipeline.computeOutline(raw));
  renderAgents();
}

function findSkillForFile(file) {
  if (!state.skillsTree || !file) return null;
  for (const scope of state.skillsTree.scopes) {
    for (const group of scope.groups) {
      for (const skill of group.skills) {
        if (skill.id === file || skill.files.some((f) => f.id === file)) return skill;
      }
    }
    for (const skill of scope.skills) {
      if (skill.id === file || skill.files.some((f) => f.id === file)) return skill;
    }
  }
  return null;
}

function layoutClampedChips(wrap, chipEls, maxRows) {
  wrap.replaceChildren(...chipEls);
  if (!chipEls.length) return;
  // not laid out (e.g. panel/tab hidden): offsetTop reads 0 for every chip,
  // which would falsely read as "fits, no overflow" — bail and let the next
  // render, once visible, measure for real
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
  const skill = findSkillForFile(state.file);
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

const CHEVRON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6l6 -6"/></svg>';
const MAGNIFIER_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>';
const FOLDER_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/></svg>';
const FOLDER_PLUS_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19h-7a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v4"/><path d="M16 19h6"/><path d="M19 16v6"/></svg>';
const ARROW_LEFT_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l14 0"/><path d="M5 12l6 6"/><path d="M5 12l6 -6"/></svg>';
const SPARKLES_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6"/></svg>';
const AGENTS_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16"/><path d="M17 4v16"/><path d="M3 8h4"/><path d="M3 16h4"/><path d="M17 8h4"/><path d="M17 16h4"/><path d="M10 12h4"/></svg>';
const SWITCH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l4 -4l4 4"/><path d="M16 15l-4 4l-4 -4"/></svg>';
const GEAR_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/></svg>';
const FILE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/></svg>';
const HOME_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14l-4 -4l4 -4"/><path d="M5 10h11a4 4 0 1 1 0 8h-1"/></svg>';

const docView = createDocView({
  doc, pipeline, blocks, save,
  getEditor: () => cmEditor,
  chevronSvg: CHEVRON_SVG,
  skillMetaHTML,
  renderProperties,
  refreshInfo,
});

let editorModule = null;
let editorCreating = null;
function ensureEditorModule() {
  if (!editorModule) editorModule = import('./dist/editor.js');
  return editorModule;
}

async function setMode(mode) {
  if (mode === viewState.view.mode) return;
  if (mode === 'source' || mode === 'edit') {
    if (!cmEditor) {
      try {
        if (!editorCreating) {
          editorCreating = ensureEditorModule().then(({ createEditor }) => createEditor(editorHost, {
            doc: currentContent(),
            onChange: () => save.schedule(),
            onSave: () => save.flush(),
            onToggleMode: () => setMode(MODE_CYCLE[viewState.view.mode]),
            blocks,
          }));
        }
        cmEditor = await editorCreating;
      } catch (err) {
        editorCreating = null;
        editorModule = null;
        setSaveState('error', 'Editor failed to load', String((err && err.message) || err));
        return;
      }
    }
    // unhide before setEdit: edit decorations only cover the editor's visible
    // ranges, which are empty while the host is display:none
    viewState.dispatch({ type: 'mode', mode });
    cmEditor.setEdit(mode === 'edit');
    cmEditor.focus();
  } else {
    docView.renderDoc(currentContent());
    viewState.dispatch({ type: 'mode', mode });
    if (save.isDirty()) save.flush();
  }
}

function currentFileFromLocation() {
  const p = decodeURIComponent(location.pathname).replace(/^\//, '');
  return p.endsWith('.md') ? p : null;
}

function applyTreeData(data) {
  if (Array.isArray(data)) {
    state.tree = data;
    state.skillsTree = null;
    state.agentTree = null;
  } else if (data.groups) {
    state.agentTree = data;
    state.skillsTree = null;
    state.tree = flattenAgentConfigTree(data);
  } else {
    state.skillsTree = data;
    state.agentTree = null;
    state.tree = flattenSkillsTree(data);
    if (!state.file) document.title = 'SKILLS.md';
  }
  pipeline.setTree(state.tree);
  renderSidebar();
}

// macOS gates Documents, Desktop and Downloads per app. The grant is per item:
// confirming a folder in the app's own open panel records it (com.apple.macl)
// and it covers that folder's whole subtree, so a blocked root recovers with
// one pick — the launcher's Open Folder button re-opens the panel already
// inside it. Only paths that never went through the panel (CLI arg, recents,
// a hash route) can land here. Terminal launches read as the terminal's own
// identity, which the app's panel cannot grant, so those still go to Privacy.
function rootFailureText(failure, root) {
  if (failure === 'blocked') {
    return root.launchedFrom === 'app'
      ? `macOS has not granted ShowMD access to ${root.name} yet. Choose Open Folder below and confirm ${root.name} to allow it.`
      : `Not allowed to read ${root.name}. Grant your terminal access to that folder, then try again.`;
  }
  if (failure === 'unreadable') return `Could not read ${root.name}.`;
  if (failure) return `Could not open ${root.name}.`;
  return `No markdown files in ${root.name}.`;
}

// returns why it could not list, so a folder the server is not allowed to read
// stops arriving as an empty one
async function loadTree() {
  const res = await api.tree();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body.error !== 'unreadable_root') return 'failed';
    // EPERM on a folder with ordinary permissions is macOS privacy, not unix:
    // the app-launched server has no Files and Folders grant for this path
    return body.code === 'EPERM' ? 'blocked' : 'unreadable';
  }
  applyTreeData(await res.json());
  return null;
}

// SSE-driven refresh: a doc-mode server watching its own root fires file events
// while the sidebar is showing the skills or agent-config view too, so the
// refresh has to ask for whichever tree is currently on screen, not always
// the plain file tree
async function refreshTree() {
  async function refreshFrom(fetcher) {
    let res;
    try {
      res = await fetcher();
    } catch {
      res = null;
    }
    if (!res || !res.ok) {
      setSaveState('error', 'Refresh failed', 'could not refresh the file list — showing the last known list');
      return;
    }
    applyTreeData(await res.json());
  }
  if (viewState.view.source === 'agents') return refreshFrom(() => api.treeAgents(currentAgentKey));
  if (viewState.view.source === 'skills') return refreshFrom(() => api.treeSkills());
  await loadTree();
}

function flattenSkillsTree(data) {
  const out = [];
  for (const scope of data.scopes) {
    for (const group of scope.groups) {
      for (const skill of group.skills) {
        out.push(skill.id);
        for (const f of skill.files) out.push(f.id);
      }
    }
    for (const skill of scope.skills) {
      out.push(skill.id);
      for (const f of skill.files) out.push(f.id);
    }
  }
  return out;
}

function flattenAgentConfigTree(data) {
  const out = [];
  for (const group of data.groups) {
    if (group.files) for (const f of group.files) out.push(f.id);
    if (group.projects) for (const proj of group.projects) {
      if (proj.memoryDoc) out.push(proj.memoryDoc.id);
      for (const f of proj.files) out.push(f.id);
    }
  }
  return out;
}

fname.addEventListener('mouseenter', () => startMarquee(fname, fnameTrack));
fname.addEventListener('mouseleave', () => stopMarquee(fname));

function appendGlideList(items) {
  const list = document.createElement('div');
  list.className = 'list';
  const glide = document.createElement('div');
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

let nav = INITIAL_NAV;


// agent-config view only: picks which agent's Instructions/Memories the tree
// below is showing. Same markup as the folder switcher (switcherEl) so it needs
// no CSS of its own — switcherEl still supplies the "Back to Home" row.
const agentSwitcherEl = document.createElement('div');
agentSwitcherEl.className = 'root-switcher agent-switcher';
agentSwitcherEl.hidden = true;
agentSwitcherEl.innerHTML = `
  <div class="root-switcher-row">
    <button type="button" class="root-switcher-switch-btn" aria-label="Switch agent"><span class="root-switcher-name"></span>${SWITCH_SVG}</button>
  </div>
  <div class="root-switcher-menu" hidden></div>`;
const agentSwitcherBtn = agentSwitcherEl.querySelector('.root-switcher-switch-btn');
const agentSwitcherNameEl = agentSwitcherEl.querySelector('.root-switcher-name');
const agentSwitcherMenu = agentSwitcherEl.querySelector('.root-switcher-menu');

const footerEl = document.createElement('div');
footerEl.className = 'nav-footer';
footerEl.hidden = true;
footerEl.innerHTML = `<span class="nav-footer-left"><button type="button" class="nav-footer-agents">${AGENTS_SVG}<span class="lbl">Agents</span><span class="tip">Agents</span></button><span class="nav-footer-divider"></span><button type="button" class="nav-footer-skills">${SPARKLES_SVG}<span class="lbl">Skills</span><span class="tip">Skills</span></button></span><button type="button" class="nav-footer-gear" aria-label="Settings">${GEAR_SVG}<span class="tip">Settings</span></button>`;
const agentsFooterBtn = footerEl.querySelector('.nav-footer-agents');
const skillsFooterBtn = footerEl.querySelector('.nav-footer-skills');
const settingsFooterBtn = footerEl.querySelector('.nav-footer-gear');
const settingsEl = document.getElementById('settings-view');

const searchEl = document.createElement('div');
searchEl.className = 'nav-search';
searchEl.innerHTML = `<div class="nav-search-box"><span class="nav-search-icon">${MAGNIFIER_SVG}</span><input type="text" placeholder="Search files"><span class="nav-search-slot"><kbd>${kbdLabel('⌘K')}</kbd><button type="button" class="nav-search-clear" aria-label="Clear search">×</button></span></div>`;
const searchInput = searchEl.querySelector('input');
const searchClearBtn = searchEl.querySelector('.nav-search-clear');
const navBody = document.createElement('div');
navBody.className = 'nav-body';
const updateCtaEl = document.createElement('div');
updateCtaEl.className = 'update-cta';
updateCtaEl.hidden = true;
const launcherView = document.getElementById('launcher-view');
// names match visiblePane's return values
const PANES = [['doc', doc], ['editor', editorHost], ['diff', diffView], ['settings', settingsEl], ['launcher', launcherView]];
const launcherRecentWrap = document.getElementById('launcher-recent');
const launcherRecentGroup = document.getElementById('launcher-recent-group');
const launcherErrorEl = document.getElementById('launcher-error');
const appLogo = document.querySelector('.logo');
const headerEl = document.querySelector('header');

const viewState = createViewState({
  panes: PANES, toolbar, sourceBtn, editBtn, readBtn,
  settingsFooterBtn, skillsFooterBtn, agentsFooterBtn,
});

// server-injected boot payload (settings/recents/root) — consumed once at
// init so first paint needs no API round trips; later refreshes always fetch
const bootDataEl = document.getElementById('boot-data');
const bootData = bootDataEl ? JSON.parse(bootDataEl.textContent) : {};

const home = createHomeView({
  api, bootData, isMac: IS_MAC,
  svg: { file: FILE_SVG, folder: FOLDER_SVG, folderPlus: FOLDER_PLUS_SVG, home: HOME_SVG, arrowLeft: ARROW_LEFT_SVG, chevron: CHEVRON_SVG },
  sidebar, headerEl, appLogo, footerEl, agentSwitcherEl,
  launcherView, launcherRecentWrap, launcherRecentGroup, launcherErrorEl,
  launcherOpenFolderBtn: document.getElementById('launcher-open-folder'),
  launcherOpenFileBtn: document.getElementById('launcher-open-file'),
  launcherBrowseSkillsBtn: document.getElementById('launcher-browse-skills'),
  launcherBrowseAgentConfigBtn: document.getElementById('launcher-browse-agent-config'),
  launcherSettingsBtn: document.getElementById('launcher-settings'),
  viewState,
  getRootInfo: () => rootInfo, getReturnTo: () => returnTo, setReturnTo: (v) => { returnTo = v; },
  getPanelOpen: () => !panelClosed(), setPanel,
  enterSkillsView, enterAgentConfigView, enterSettingsView,
});

sidebar.append(home.switcherEl, searchEl, agentSwitcherEl, navBody, updateCtaEl, footerEl);

async function enterSkillsView() {
  if (isSettingsOpen(viewState.view)) exitSettingsView();
  navBody.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'nav-empty';
  loading.textContent = 'Loading skills…';
  navBody.appendChild(loading);
  try {
    const res = await api.treeSkills();
    applyTreeData(await res.json());
    setSource('skills');
    searchInput.placeholder = 'Search skills…';
  } catch {
    loading.textContent = 'Could not load skills.';
    return;
  }
  home.renderSwitcher();
  return openDefaultFile();
}

// leaves the skills/agent-config tree without landing anywhere: the caller is
// about to put its own screen on top
async function leaveSourceView() {
  closeAgentSwitcherMenu();
  setSource('files');
  searchInput.placeholder = 'Search files';
  home.renderSwitcher();
  if (!(rootInfo && rootInfo.dir)) return;
  await loadTree();
  openDefaultFile();
}

// the "Back to …" exit: leaves the tree and lands where returnTo says
async function exitSourceView() {
  const goHome = returnTo === 'home' || !(rootInfo && rootInfo.dir);
  returnTo = 'files';
  await leaveSourceView();
  if (goHome) home.showLauncher();
}

const AGENT_CONFIG_DISPLAY_NAMES = { claude: 'Claude', codex: 'Codex' };

function setSource(source) {
  viewState.dispatch({ type: 'source', source });
}

const lastFileBySource = { files: null, skills: null, agents: null };

// switching trees lands on the file you last had open in that tree, falling
// back to a caller-supplied preference and then its first file — never on the
// previous tree's file, which is not in this one
function openDefaultFile(preferred) {
  const remembered = lastFileBySource[viewState.view.source];
  const file = [remembered, preferred, state.tree[0]].find((f) => f && state.tree.includes(f));
  if (file) loadFile(file);
  return !!file;
}

function renderAgentSwitcherMenu(agents) {
  agentSwitcherMenu.replaceChildren();
  for (const a of agents) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'root-switcher-recent-row agent-switcher-row';
    row.textContent = a.displayName;
    row.disabled = !a.detected;
    if (a.key === currentAgentKey) row.classList.add('on');
    if (!a.detected) { row.title = `${a.displayName} not detected on this machine`; row.classList.add('dim'); }
    row.addEventListener('click', () => {
      closeAgentSwitcherMenu();
      if (a.key === currentAgentKey) return;
      currentAgentKey = a.key;
      nav = nextNav(nav, { type: 'reset-agent-seed' });
      enterAgentConfigView();
    });
    agentSwitcherMenu.appendChild(row);
  }
}

function onAgentSwitcherDocClick(e) {
  if (!agentSwitcherEl.contains(e.target)) closeAgentSwitcherMenu();
}
function openAgentSwitcherMenu() {
  agentSwitcherMenu.hidden = false;
  document.addEventListener('click', onAgentSwitcherDocClick);
}
function closeAgentSwitcherMenu() {
  agentSwitcherMenu.hidden = true;
  document.removeEventListener('click', onAgentSwitcherDocClick);
}
agentSwitcherBtn.addEventListener('click', () => {
  if (agentSwitcherMenu.hidden) openAgentSwitcherMenu(); else closeAgentSwitcherMenu();
});

async function enterAgentConfigView() {
  if (isSettingsOpen(viewState.view)) exitSettingsView();
  let opened = false;
  navBody.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'nav-empty';
  loading.textContent = 'Loading agent config…';
  navBody.appendChild(loading);
  try {
    const res = await api.treeAgents(currentAgentKey);
    const data = await res.json();
    applyTreeData(data);
    setSource('agents');
    searchInput.placeholder = 'Search agent config…';
    agentSwitcherNameEl.textContent = data.displayName || AGENT_CONFIG_DISPLAY_NAMES[currentAgentKey] || currentAgentKey;
    renderAgentSwitcherMenu(data.agents || []);
    // Instructions is the entry point when nothing is remembered: it is the
    // file someone opening agent config almost always came for
    const instructions = data.groups.find((g) => g.name === 'Instructions');
    const firstFile = instructions && instructions.files && instructions.files[0];
    opened = openDefaultFile(firstFile && firstFile.id);
  } catch {
    loading.textContent = 'Could not load agent config.';
    return;
  }
  home.renderSwitcher();
  return opened;
}

async function fetchSettings() {
  try {
    const res = await api.getSettings();
    if (!res.ok) {
      setSaveState('error', 'Settings unavailable', 'could not load settings — showing defaults');
      return {};
    }
    return await res.json();
  } catch {
    setSaveState('error', 'Settings unavailable', 'could not load settings — showing defaults');
    return {};
  }
}

async function saveSetting(key, value) {
  try {
    await api.putSettings({ [key]: value });
  } catch {}
}

const settingsView = createSettingsView({
  root: settingsEl,
  ctaEl: updateCtaEl,
  api,
  fetchSettings,
  saveSetting,
  chevronSvg: CHEVRON_SVG,
  positionTip,
  setTheme,
  applyFontPreset,
  applyFontSize,
  returnsHome: () => returnTo === 'home',
  onBack: () => exitSettingsView(true),
});

async function enterSettingsView() {
  if (isSourceView(viewState.view)) await leaveSourceView();
  if (isLauncherOpen(viewState.view)) { returnTo = 'home'; home.hideLauncher(); }
  viewState.dispatch({ type: 'settings-open' });
  lastVisitedFile = state.file;
  stopMarquee(fname);
  fnameTrack.textContent = 'Settings';
  document.title = 'Settings';
  renderSidebar();
  await settingsView.open();
}

function exitSettingsView(goHome) {
  viewState.dispatch({ type: 'settings-close' });
  lastVisitedFile = null;
  if (state.file) setFnameForFile(state.file);
  else { stopMarquee(fname); fnameTrack.textContent = ''; document.title = 'showmd'; }
  renderSidebar();
  const returnHome = goHome && returnTo === 'home';
  returnTo = 'files';
  if (returnHome) home.showLauncher();
}

settingsFooterBtn.addEventListener('click', () => {
  if (isSettingsOpen(viewState.view)) exitSettingsView(true); else enterSettingsView();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !isSettingsOpen(viewState.view)) return;
  if (settingsView.menuOpen() || !home.switcherMenu.hidden) return;
  if (/^(input|textarea|select)$/i.test(e.target.tagName)) return;
  exitSettingsView(true);
});

home.switcherBtn.addEventListener('click', () => {
  if (isSourceView(viewState.view)) { exitSourceView(); return; }
  if (home.switcherMenu.hidden) home.openSwitcherMenu(); else home.closeSwitcherMenu();
});
home.switcherOpenBtn.addEventListener('click', () => home.pickRoot({}));
home.switcherHomeBtn.addEventListener('click', async () => {
  home.closeSwitcherMenu();
  if (isSourceView(viewState.view)) await leaveSourceView();
  if (isSettingsOpen(viewState.view)) exitSettingsView();
  home.showLauncher();
});
skillsFooterBtn.addEventListener('click', () => {
  if (viewState.view.source === 'skills') { exitSourceView(); return; }
  returnTo = 'files';
  enterSkillsView();
});
agentsFooterBtn.addEventListener('click', () => {
  if (viewState.view.source === 'agents') { exitSourceView(); return; }
  returnTo = 'files';
  enterAgentConfigView();
});


async function initRoot() {
  if (bootData.root) {
    rootInfo = bootData.root;
  } else {
    try {
      const res = await api.root();
      if (!res.ok) return; // dedicated `showmd skills` server: no switcher, no footer
      rootInfo = await res.json();
    } catch {
      return;
    }
  }
  if (rootInfo.dir == null) {
    if (bootData.view === 'agents') { home.launcherBrowseAgentConfig(); return; }
    home.showLauncher();
    return;
  }
  home.switcherEl.hidden = false;
  footerEl.hidden = false;
  home.renderSwitcher();
  if (bootSettings) settingsView.renderCta(bootSettings);
}

// SSE root-changed: the server already swapped roots and started watching the
// new one — this only catches the client up (Recent, switcher, tree, the
// initial doc), mirroring init()'s own "pick the first file" selection. A
// `doc` field means a single .md file was picked (its parent dir became root,
// same as `showmd file.md`) — open that file instead of the default first one.
async function handleRootChanged(newRoot, doc) {
  rootInfo = newRoot;
  returnTo = 'files';
  setSource('files');
  searchInput.placeholder = 'Search files';
  home.closeSwitcherMenu();
  home.renderSwitcher();
  state.file = null;
  const failure = await loadTree();
  // the tree still on screen belongs to the root we just left. A root we could
  // not read has no tree, and keeping the old one makes its files look
  // openable — they resolve against the new root and come back "not found"
  if (failure) applyTreeData([]);
  home.setBlockedDir(failure === 'blocked' ? newRoot.dir : null);
  const file = failure ? null : doc || state.tree[0];
  // the launcher is deliberately still up here: hiding it before the tree is
  // known makes a failed pick collapse and re-expand the sidebar for nothing.
  // Nothing to open is a dead end with no way back, so say why and stay put
  if (!file) {
    home.showLauncher();
    home.showLauncherNotice(rootFailureText(failure, newRoot), { sticky: true });
    return;
  }
  home.hideLauncher();
  history.replaceState({ idx: navIdx }, '', '/');
  await loadFile(file);
  if (isSettingsOpen(viewState.view)) await settingsView.open();
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

function makeDisclosureHeader(row, variant) {
  const header = document.createElement('div');
  header.className = ['sec', 'disclosure', variant, row.collapsed ? 'collapsed' : ''].filter(Boolean).join(' ');
  header.dataset.navId = row.id;
  header.dataset.navDepth = String(row.depth);
  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.innerHTML = CHEVRON_SVG;
  header.appendChild(chevron);
  const label = document.createElement('span');
  label.className = 'sec-label';
  label.textContent = row.label;
  header.appendChild(label);
  header.addEventListener('click', () => toggleAndRender(row.nodeId));
  return header;
}

function makeRowText(text) {
  const inner = document.createElement('span');
  inner.className = 'rowtext';
  const track = document.createElement('span');
  track.className = 'rowtext-track';
  track.textContent = text;
  inner.appendChild(track);
  return inner;
}

function makeSkillItem(row) {
  const skill = row.skill;
  const li = document.createElement('li');
  li.className = 'skill-row';
  li.dataset.navId = row.id;
  li.dataset.navDepth = String(row.depth);
  if (row.current) li.classList.add('on');
  else if (isSettingsOpen(viewState.view) && row.id === lastVisitedFile) li.classList.add('last-visited');
  const chevron = document.createElement('span');
  if (row.collapsible) {
    chevron.className = 'chevron row-chevron' + (row.collapsed ? ' collapsed' : '');
    chevron.innerHTML = CHEVRON_SVG;
    chevron.addEventListener('click', (e) => { e.stopPropagation(); toggleAndRender(row.nodeId); });
  } else {
    chevron.className = 'chevron-spacer';
  }
  li.appendChild(chevron);
  const inner = makeRowText(skill.name);
  li.appendChild(inner);
  if (skill.copies) {
    const marker = document.createElement('span');
    marker.className = 'skill-badge skill-copies';
    marker.textContent = `\u00d7${skill.copies}`;
    li.appendChild(marker);
  } else if (skill.origin) {
    const marker = document.createElement('span');
    marker.className = 'skill-badge skill-origin';
    marker.textContent = `\u00b7 ${skill.origin}`;
    li.appendChild(marker);
    const dot = document.createElement('span');
    dot.className = 'skill-dupe-dot';
    dot.title = 'duplicate copies with different content';
    li.appendChild(dot);
  }
  return { el: li, contentEl: inner.firstElementChild, onClick: () => navigate(row.id) };
}

function makeFileItem(row) {
  const li = document.createElement('li');
  const classes = [];
  if (row.nested) classes.push('nav-nested');
  if (row.underSkill) classes.push('skill-file-row');
  li.className = classes.join(' ');
  li.dataset.navId = row.id;
  li.dataset.navDepth = String(row.depth);
  const inner = makeRowText(row.label);
  li.appendChild(inner);
  if (reducedMotion()) li.title = row.label;
  if (row.current) li.classList.add('on');
  else if (isSettingsOpen(viewState.view) && row.id === lastVisitedFile) li.classList.add('last-visited');
  return { el: li, contentEl: inner.firstElementChild, onClick: () => navigate(row.id) };
}

function makeAgentProjectItem(row) {
  const li = document.createElement('li');
  li.className = 'skill-row';
  li.dataset.navId = row.id;
  li.dataset.navDepth = String(row.depth);
  if (row.title) li.title = row.title;
  if (row.current) li.classList.add('on');
  else if (isSettingsOpen(viewState.view) && row.id === lastVisitedFile) li.classList.add('last-visited');
  const chevron = document.createElement('span');
  if (row.collapsible) {
    chevron.className = 'chevron row-chevron' + (row.collapsed ? ' collapsed' : '');
    chevron.innerHTML = CHEVRON_SVG;
    chevron.addEventListener('click', (e) => { e.stopPropagation(); toggleAndRender(row.nodeId); });
  } else {
    chevron.className = 'chevron-spacer';
  }
  li.appendChild(chevron);
  const inner = makeRowText(row.label);
  li.appendChild(inner);
  return { el: li, contentEl: inner.firstElementChild, onClick: () => navigate(row.id) };
}

function renderNoMatches() {
  const empty = document.createElement('div');
  empty.className = 'nav-empty';
  empty.textContent = 'No matches';
  navBody.appendChild(empty);
}

const HEADER_VARIANT = { scope: 'sec-scope', group: 'sec-group', dir: undefined };
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
  nav = nextNav(nav, { type: 'sync-rows' }, { state, hideFile: isSettingsOpen(viewState.view) });
  navBody.replaceChildren();
  if (nav.query && nav.rows.length === 0) return renderNoMatches();
  paintRows(nav.rows);
  // selection lives in state, so it survives the markup being thrown away
  const selectedEl = navItemFor(nav.selected);
  if (selectedEl) selectedEl.classList.add('kbd-on');
}

function updateNavButtons() {
  backBtn.classList.toggle('disabled', navIdx <= 0);
  fwdBtn.classList.toggle('disabled', navIdx >= navMax);
}

function navigate(file) {
  navIdx += 1;
  navMax = navIdx;
  history.pushState({ idx: navIdx }, '', '/' + file.split('/').map(encodeURIComponent).join('/'));
  updateNavButtons();
  loadFile(file);
}

// mirrors the skills breadcrumb's "skill / file" shape: a friendly label
// instead of the raw internal doc id (e.g. `claude-memory--Users-.../x.md`)
function agentConfigBreadcrumb(agentTree, file) {
  for (const group of agentTree.groups) {
    const f = group.files && group.files.find((x) => x.id === file);
    if (f) return f.label;
    for (const proj of group.projects || []) {
      if (proj.memoryDoc && proj.memoryDoc.id === file) return `${proj.label} / ${proj.memoryDoc.label}`;
      const pf = proj.files.find((x) => x.id === file);
      if (pf) return `${proj.label} / ${pf.label}`;
    }
  }
  return file;
}

function setFnameForFile(file) {
  const parts = file.split('/');
  if (state.agentTree) fnameTrack.textContent = agentConfigBreadcrumb(state.agentTree, file);
  else fnameTrack.textContent = state.skillsTree && parts.length >= 3 ? `${parts[1]} / ${parts[parts.length - 1]}` : file;
  document.title = parts[parts.length - 1];
}

async function loadFile(file, preserveScroll) {
  home.hideLauncher();
  lastFileBySource[viewState.view.source] = file;
  if (isSettingsOpen(viewState.view)) exitSettingsView();
  if (save.isDirty()) await save.flush();
  if (state.file !== file) docView.resetCollapsedHeadings();
  state.file = file;
  pipeline.setDocId(file);
  if (nav.selected !== file) nav = nextNav(nav, { type: 'select', id: null });
  stopMarquee(fname);
  setFnameForFile(file);
  document.body.classList.add('has-file');
  banner.hidden = true;
  save.resolveExternal('keep');
  if (isVersionOpen(viewState.view)) historyView.backToCurrent();
  const scrollTop = preserveScroll ? main.scrollTop : 0;
  const res = await api.raw(file);
  let text;
  if (res.ok) text = await res.text();
  else if (res.status === 404) text = '# not found';
  else text = `# ${(await res.json().catch(() => ({}))).error || 'not found'}`;
  const symlinkTarget = res.headers.get('X-Showmd-Symlink-Target');
  const symlinkDoc = res.headers.get('X-Showmd-Symlink-Doc');
  fnameSymlink.hidden = !symlinkTarget;
  fnameSymlink.title = symlinkTarget ? `symlinked → ${decodeURIComponent(symlinkTarget)}` : '';
  fnameSymlink.disabled = !symlinkDoc;
  fnameSymlink.dataset.docId = symlinkDoc ? decodeURIComponent(symlinkDoc) : '';
  if (res.ok) {
    save.adopt(text);
    save.setDirty(false);
  } else {
    save.detach();
  }
  docView.renderDoc(text);
  if (cmEditor) cmEditor.setContent(text);
  renderSidebar();
  if (preserveScroll) main.scrollTop = scrollTop;
  if (!panelClosed()) historyView.load();
}

const historyView = createHistoryView({
  panelBtn, panel, verList, restoreBtn, diffTime, diffBody, api,
  getFile: () => state.file,
  viewState,
});

function setSidebarCollapsed(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed);
  sidebarBtn.classList.toggle('on', !collapsed);
  sidebarTip.innerHTML = (collapsed ? 'Expand sidebar' : 'Collapse sidebar') + ` <kbd>${kbdLabel('⌘\\')}</kbd>`;
  localStorage.setItem('showmd-sidebar-collapsed', collapsed ? '1' : '');
}
function toggleSidebar() { setSidebarCollapsed(!sidebar.classList.contains('collapsed')); }

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 240;

function setSidebarWidth(px) {
  sidebar.style.setProperty('--sidebar-w', `${Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px))}px`);
  home.renderNavFooterNarrow();
}

sidebarResize.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sidebarResize.setPointerCapture(e.pointerId);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  const startX = e.clientX;
  const startWidth = sidebar.getBoundingClientRect().width;
  function onMove(ev) { setSidebarWidth(startWidth + (ev.clientX - startX)); }
  function onUp() {
    sidebarResize.removeEventListener('pointermove', onMove);
    sidebarResize.removeEventListener('pointerup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('showmd-sidebar-width', sidebar.getBoundingClientRect().width);
  }
  sidebarResize.addEventListener('pointermove', onMove);
  sidebarResize.addEventListener('pointerup', onUp);
});
sidebarResize.addEventListener('dblclick', () => {
  setSidebarWidth(SIDEBAR_DEFAULT);
  localStorage.setItem('showmd-sidebar-width', SIDEBAR_DEFAULT);
});

const panelClosed = () => panel.hidden || panel.classList.contains('collapsed');

function setPanel(open) {
  panel.classList.toggle('collapsed', !open);
  panelBtn.classList.toggle('on', open);
  if (open) { historyView.load(); refreshInfo(); }
}

function setPanelTab(tab) {
  if (tab !== 'history') tab = 'info';
  panelTabInfo.classList.toggle('on', tab === 'info');
  panelTabHistory.classList.toggle('on', tab === 'history');
  paneInfo.hidden = tab !== 'info';
  paneHistory.hidden = tab !== 'history';
  localStorage.setItem('showmd-panel-tab', tab);
  if (tab === 'info') refreshInfo();
}

let serverGone = false;

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    if (!serverGone) return;
    serverGone = false;
    save.setDirty(save.isDirty());
    refreshTree();
  };
  es.onerror = () => {
    if (serverGone) return;
    serverGone = true;
    setSaveState('error', 'Connection lost', rootInfo && rootInfo.launchedFrom === 'app'
      ? 'ShowMD stopped — reopen the ShowMD app'
      : 'showmd stopped — run showmd again in your terminal');
  };
  es.onmessage = async (e) => {
    const data = JSON.parse(e.data);
    if (data.event === 'root-changed') return handleRootChanged(data.root, data.doc);
    const { path, event } = data;
    // content-only edits to the file already open can't reshape the tree;
    // anything else (new file, rename, delete) can
    if (event !== 'change' || path !== state.file) refreshTree();
    if (path !== state.file) return;
    if (!panelClosed()) historyView.load();
    let res = null;
    try {
      res = await api.raw(path);
    } catch {
      res = null;
    }
    const text = res && res.ok ? await res.text() : null;
    const outcome = save.decideExternalUpdate({ ok: !!(res && res.ok), text, dirty: save.isDirty() });
    if (outcome.action === 'error') {
      setSaveState('error', 'Refresh failed', 'could not load the latest change — your open copy is unaffected');
    } else if (outcome.action === 'adopt') {
      save.adopt(outcome.text);
      docView.renderDoc(outcome.text);
      if (cmEditor) cmEditor.setContent(outcome.text);
    } else if (outcome.action === 'stage') {
      save.stageExternal(outcome.text);
      banner.hidden = false;
    }
  };
}

bannerReload.addEventListener('click', () => {
  const text = save.resolveExternal('reload');
  if (text != null) {
    docView.renderDoc(text);
    if (cmEditor) cmEditor.setContent(text);
    save.setDirty(false);
  }
  banner.hidden = true;
});
bannerKeep.addEventListener('click', () => {
  save.resolveExternal('keep');
  banner.hidden = true;
});

save.bindUnloadFlush(document, window);

document.addEventListener('click', (e) => {
  const a = e.target.closest('a.wikilink');
  if (!a) return;
  e.preventDefault();
  navigate(a.dataset.file);
});

// clamps against the viewport AND the nearest overflow:hidden ancestor (the
// collapsible sidebar `nav`) — a tooltip near nav's right edge was clipped by
// that overflow:hidden even though it had plenty of room against the viewport
function positionTip(btn) {
  const tip = btn.querySelector('.tip');
  if (!tip) return;
  tip.style.setProperty('--shift', '0px');
  tip.style.setProperty('--arrow-x', '50%');
  const margin = 8;
  const btnRect = btn.getBoundingClientRect();
  const half = tip.getBoundingClientRect().width / 2;
  const center = btnRect.left + btnRect.width / 2;
  let minX = margin;
  let maxX = window.innerWidth - margin;
  const clipper = btn.closest('nav');
  if (clipper) {
    const clipRect = clipper.getBoundingClientRect();
    minX = Math.max(minX, clipRect.left + margin);
    maxX = Math.min(maxX, clipRect.right - margin);
  }
  let shift = 0;
  if (center - half < minX) shift = minX - (center - half);
  else if (center + half > maxX) shift = maxX - (center + half);
  tip.style.setProperty('--shift', shift + 'px');
  tip.style.setProperty('--arrow-x', `calc(50% - ${shift}px)`);
}
document.querySelectorAll('.icon-btn, .theme-btn, .nav-footer-gear').forEach((btn) => {
  btn.addEventListener('mouseenter', () => positionTip(btn));
});

fnameSymlink.addEventListener('click', () => {
  if (fnameSymlink.dataset.docId) navigate(fnameSymlink.dataset.docId);
});

// `disabled` here is a CSS class, not the attribute — the click still fires at
// the ends of the stack, so the guard has to be explicit
function goBack() { if (navIdx > 0) history.back(); }
function goForward() { if (navIdx < navMax) history.forward(); }
backBtn.addEventListener('click', goBack);
fwdBtn.addEventListener('click', goForward);

revealBtn.addEventListener('click', async () => {
  const p = api.reveal(isSettingsOpen(viewState.view) ? { settings: true } : { path: state.file });
  if (!p) return;
  try {
    const res = await p;
    if (!res.ok) throw new Error('reveal failed: ' + res.status);
  } catch (err) {
    console.error('showmd: reveal failed', err);
    setSaveState('error', 'Reveal failed', 'could not open in file manager');
    setTimeout(() => save.setDirty(save.isDirty()), 2500);
  }
});
sourceBtn.addEventListener('click', () => setMode('source'));
editBtn.addEventListener('click', () => setMode('edit'));
readBtn.addEventListener('click', () => setMode('read'));
panelBtn.addEventListener('click', () => setPanel(panelClosed()));
panelTabInfo.addEventListener('click', () => setPanelTab('info'));
panelTabHistory.addEventListener('click', () => setPanelTab('history'));

function bindToolbarBtn(btn, action) {
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => { if (cmEditor && !isVersionOpen(viewState.view)) action(); });
}
bindToolbarBtn(tbBold, () => cmEditor.wrap('**'));
bindToolbarBtn(tbItalic, () => cmEditor.wrap('*'));
bindToolbarBtn(tbStrike, () => cmEditor.wrap('~~'));
bindToolbarBtn(tbCode, () => cmEditor.wrap('`'));
bindToolbarBtn(tbLink, () => cmEditor.insertLink());
bindToolbarBtn(tbMark, () => cmEditor.wrap('=='));
bindToolbarBtn(tbList, () => cmEditor.toggleBullet());
bindToolbarBtn(tbOlist, () => cmEditor.toggleNumbered());
bindToolbarBtn(tbTask, () => cmEditor.toggleTask());
bindToolbarBtn(tbQuote, () => cmEditor.toggleQuote());
bindToolbarBtn(tbUndo, () => cmEditor.undo());
bindToolbarBtn(tbRedo, () => cmEditor.redo());
sidebarBtn.addEventListener('click', toggleSidebar);
backBtn.addEventListener('click', () => history.back());
fwdBtn.addEventListener('click', () => history.forward());
diffBack.addEventListener('click', (e) => { e.preventDefault(); historyView.backToCurrent(); });
restoreBtn.addEventListener('click', async () => {
  if (!isVersionOpen(viewState.view) || !state.file) return;
  let res;
  try {
    res = await api.restore(state.file, viewState.view.version.rev, viewState.view.version.repo);
  } catch {
    res = null;
  }
  if (!res || !res.ok) {
    setSaveState('error', 'Restore failed', 'could not restore this version — your file is unchanged');
    return;
  }
  historyView.backToCurrent();
});
// Getting Started shortcuts: work everywhere, launcher visible or not, so
// they route through the same activateLauncherRow the launcher's own rows
// use when it's showing, and fall back to the equivalent action otherwise.
function openFileShortcut() {
  if (home.launcherKeyboardActive()) home.activateLauncherRow(document.getElementById('launcher-open-file'));
  else home.pickRoot({ mode: 'file' });
}
function openFolderShortcut() {
  if (home.launcherKeyboardActive()) home.activateLauncherRow(document.getElementById('launcher-open-folder'));
  else home.pickRoot({ mode: 'folder' });
}
function browseSkillsShortcut() {
  if (home.launcherKeyboardActive()) home.launcherBrowseSkills();
  else skillsFooterBtn.click();
}
function browseAgentConfigShortcut() {
  if (home.launcherKeyboardActive()) home.launcherBrowseAgentConfig();
  else agentsFooterBtn.click();
}

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (e.shiftKey && key === 'o') { e.preventDefault(); openFolderShortcut(); return; }
  if (e.shiftKey && key === 's') { e.preventDefault(); browseSkillsShortcut(); return; }
  if (e.shiftKey && key === 'a') { e.preventDefault(); browseAgentConfigShortcut(); return; }
  if (key === 'o') { e.preventDefault(); openFileShortcut(); return; }
  if (home.launcherKeyboardActive()) return;
  if (key === '[') { e.preventDefault(); goBack(); return; }
  if (key === ']') { e.preventDefault(); goForward(); return; }
  if (key === 'k') {
    e.preventDefault();
    if (sidebar.classList.contains('collapsed')) setSidebarCollapsed(false);
    searchInput.focus();
    searchInput.select();
    return;
  }
  // read mode first, so ⌘P from the editor prints the rendered doc and not a
  // blank page — the print stylesheet hides the editor surface
  if (key === 'p') {
    e.preventDefault();
    setMode('read').then(() => window.print());
    return;
  }
  if (cmEditor && editorHost.contains(document.activeElement)) return;
  if (key === 'e') { e.preventDefault(); setMode(MODE_CYCLE[viewState.view.mode]); }
  else if (key === 's' && viewState.view.mode !== 'read') { e.preventDefault(); save.flush(); }
  else if (key === 'h' && e.shiftKey) { e.preventDefault(); setPanel(panelClosed()); }
  else if (key === '\\') { e.preventDefault(); toggleSidebar(); }
});

function navItemFor(id) {
  return id == null ? null : sidebar.querySelector(`[data-nav-id="${CSS.escape(id)}"]`);
}

let navOpenTimer = null;
const NAV_OPEN_DEBOUNCE_MS = 120;

function setNavSelected(id) {
  const prev = navItemFor(nav.selected);
  if (prev) prev.classList.remove('kbd-on');
  clearTimeout(navOpenTimer);
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
  clearTimeout(navOpenTimer);
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
  if (intent.autoOpen) navOpenTimer = setTimeout(() => navigate(intent.row.id), NAV_OPEN_DEBOUNCE_MS);
}

function focusBlocksSidebarNav() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (cmEditor && editorHost.contains(el)) return true;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  return el.isContentEditable;
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(e.key)) return;
  if (sidebar.classList.contains('collapsed') || focusBlocksSidebarNav()) return;
  const intent = keyIntent(nav.rows, e.key, { selected: nav.selected, file: state.file });
  if (!intent) return;
  e.preventDefault();
  applyIntent(intent);
});

function resolveTheme(colorMode, systemDark) {
  return colorMode === 'system' ? (systemDark ? 'dark' : 'light') : colorMode;
}

// pre-settings builds only ever wrote 'light'/'dark' to localStorage, and
// settings.json is now the source of truth: a legacy value is adopted once, and
// only when the stored settings have no opinion of their own.
function initialColorMode(settings, legacy) {
  const mode = settings.colorMode || 'system';
  if (legacy && mode === 'system') return { colorMode: legacy, persist: true };
  return { colorMode: mode, persist: false };
}

const THEME_MEDIA = matchMedia('(prefers-color-scheme: dark)');
let colorMode = 'system';

function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme(colorMode, THEME_MEDIA.matches);
}

// the only writer of the theme: anything else that flips it (the ?lab panel)
// goes through here, or its diagrams keep the old theme's colors
function setTheme(next, { persist = true } = {}) {
  colorMode = next;
  applyTheme();
  if (persist) saveSetting('colorMode', next);
  if (viewState.view.mode === 'edit' && cmEditor) cmEditor.refreshBlocks();
  else if (viewState.view.mode === 'read' && state.file) blocks.renderMermaidIn(doc).catch((err) => console.error('showmd: mermaid enhance failed', err));
}
window.showmdSetTheme = setTheme;

function applyFontPreset(preset) {
  document.documentElement.style.setProperty('--doc-font', (FONT_PRESETS[preset] || FONT_PRESETS.default).family);
}

function applyFontSize(size) {
  if (typeof size === 'number' && Number.isFinite(size)) document.documentElement.style.setProperty('--doc-size', `${size}px`);
}

function initTheme(settings) {
  const legacy = localStorage.getItem('showmd-theme');
  if (legacy) localStorage.removeItem('showmd-theme');
  const initial = initialColorMode(settings, legacy);
  colorMode = initial.colorMode;
  if (initial.persist) saveSetting('colorMode', colorMode);
  applyTheme();
  THEME_MEDIA.addEventListener('change', () => { if (colorMode === 'system') applyTheme(); });
  document.getElementById('theme-btn').addEventListener('click', () => {
    setTheme(resolveTheme(colorMode, THEME_MEDIA.matches) === 'dark' ? 'light' : 'dark');
  });
}

// what a reload onto a hash reopens. Only Settings sits over a file, so only
// Settings restores one: skills/agents files live outside the root and are not
// recoverable from the pathname, and Home is not about a file at all.
const BOOT_VIEWS = {
  '#settings': { restoresFile: true, enter: enterSettingsView },
  '#skills': { restoresFile: false, enter: home.launcherBrowseSkills },
  '#agents': { restoresFile: false, enter: home.launcherBrowseAgentConfig },
  '#home': { restoresFile: false, enter: home.showLauncher },
};

let bootSettings = null;

async function init() {
  const settings = bootData.settings || await fetchSettings();
  bootSettings = settings;
  if (settings.platform) revealBtn.querySelector('.tip').textContent = revealLabel(settings.platform);
  initTheme(settings);
  applyFontPreset(settings.fontPreset);
  applyFontSize(settings.fontSize);
  if (new URLSearchParams(location.search).has('lab')) import('./theme-lab.js');
  setSidebarCollapsed(localStorage.getItem('showmd-sidebar-collapsed') === '1');
  const savedWidth = parseInt(localStorage.getItem('showmd-sidebar-width'), 10);
  if (savedWidth) setSidebarWidth(savedWidth);
  setPanelTab(localStorage.getItem('showmd-panel-tab') || 'info');
  // server-marked launcher boot: skip the doomed /api/tree request outright.
  // allSettled either way, so a rejected initRoot/loadTree can never strand
  // connectEvents() below unconnected — that SSE is how pickRoot's success
  // (root-changed) reaches this page in launcher mode
  const launcherBoot = document.body.classList.contains('launcher');
  // hands first-paint hiding off from the CSS-only body.launcher-boot marker
  // (display:none, can't animate) to the same JS-driven state showLauncher()
  // uses (nav.collapsed, header/.logo hidden) — synchronous and before the
  // await below, so the swap never paints an intermediate frame
  if (launcherBoot) {
    sidebar.classList.add('collapsed');
    headerEl.hidden = true;
    appLogo.hidden = true;
    // through the pane record, not launcherView.hidden directly: hideLauncher
    // keys off the overlay, so a boot that skipped it would strand the header
    // hidden on the way out (bootView 'agents' takes exactly that path)
    viewState.dispatch({ type: 'launcher-open' });
    document.body.classList.remove('launcher-boot');
  }
  await Promise.allSettled([initRoot(), launcherBoot ? Promise.resolve() : loadTree()]);
  const boot = BOOT_VIEWS[location.hash];
  const file = !boot || boot.restoresFile ? currentFileFromLocation() || state.tree[0] : null;
  history.replaceState({ idx: 0 }, '', location.pathname + location.hash);
  if (file) {
    await loadFile(file);
    if (settings.openMode === 'edit') await setMode('edit');
  }
  if (boot) {
    // a reload is not a launcher click: exiting lands on the open root's tree
    // when there is one, and only falls back to Home when there is not
    returnTo = rootInfo && rootInfo.dir ? 'files' : 'home';
    await boot.enter();
  }
  updateNavButtons();
  historyView.probe();
  connectEvents();
  window.addEventListener('popstate', (e) => {
    navIdx = (e.state && typeof e.state.idx === 'number') ? e.state.idx : 0;
    navMax = Math.max(navMax, navIdx);
    updateNavButtons();
    const f = currentFileFromLocation();
    if (f) loadFile(f);
  });
}

init();
