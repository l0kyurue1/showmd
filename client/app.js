import { createBlockRenderer } from './blocks.js';
import { createPipeline } from './pipeline.js';
import { breadcrumbForDocument, documentIds, keyIntent, metadataForDocument, INITIAL_NAV, nextNav } from './navigation.js';
import { adaptAgentTree, adaptFilesTree, adaptSkillsTree } from './navigation-adapters.js';
import { MODE_CYCLE, createViewState, isSettingsOpen, isLauncherOpen, isSourceView, isVersionOpen } from './view-state.js';
import { startMarquee, stopMarquee, reducedMotion } from './marquee.js';
import { createHistoryView } from './history-view.js';
import { createDocView } from './doc-view.js';
import { createSaveFlow } from './save-flow.js';
import { FONT_PRESETS, createSettingsView } from './settings-view.js';
import { followRestart } from './restart-follow.js';
import { createHomeView, SKILLS_EMPTY_NOTICE, AGENTS_EMPTY_NOTICE } from './home-view.js';
import * as api from './api.js';
import { parseRouteContext, formatRouteContext } from './route.js';

function isMacPlatform(nav) {
  return nav.userAgentData?.platform === 'macOS' || /Mac/i.test(nav.userAgent || '');
}

// Shortcuts accept Meta or Ctrl; only their printed hints are platform-specific.
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

const state = { file: null, tree: [], navigation: { roots: [] }, navigationKind: null };
// browser back/forward index into the files this tab has visited.
// (pushState/back/forward are used below)
let navIdx = 0;
let navMax = 0;
let restoringPopstate = false;
let popstateTransition = Promise.resolve();
// doc-mode only: current root summary (null on a dedicated `showmd skills`
// server, or before a Root Space route resolves)
let rootInfo = null;
// the parsed Route Context this tab is addressing: space/rootKey/scopePath/documentPath.
// Undefined fields mean "not part of the current URL", matching route.js's contract.
let currentRoute = { space: 'home', rootKey: undefined, scopePath: undefined, documentPath: undefined };
// Save targets belong to the buffer, not mutable navigation state.
let saveAddress = null;
let lastVisitedFile = null;

// the document verbs for whichever space the URL currently names
function docs() {
  return api.documentApi(currentRoute);
}
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
const exportBtn = document.getElementById('export-btn');
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
  put: (text) => {
    if (!saveAddress) throw new Error('no document address');
    return api.documentApi(saveAddress.route).putRaw(saveAddress.file, text);
  },
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
  return file ? metadataForDocument(state.navigation, file, 'skill') : null;
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
    await docView.renderDoc(currentContent());
    viewState.dispatch({ type: 'mode', mode });
    if (save.isDirty()) save.flush();
  }
}

// server-emitted routes for virtual documents: the client never turns a
// Skills/Agents provider id back into a URL itself (plan URL contract).
let documentHrefs = new Map();

function collectDocumentHrefs(data) {
  const map = new Map();
  const add = (node) => { if (node && node.id && node.href) map.set(node.id, node.href); };
  for (const scope of data.scopes || []) {
    for (const skill of [...(scope.skills || []), ...(scope.groups || []).flatMap((g) => g.skills || [])]) {
      add(skill);
      for (const file of skill.files || []) add(file);
    }
  }
  for (const group of data.groups || []) {
    for (const file of group.files || []) add(file);
    for (const project of group.projects || []) {
      add(project.memoryDoc);
      for (const file of project.files || []) add(file);
    }
  }
  return map;
}

function applyTreeData(data) {
  const kind = Array.isArray(data) ? 'files' : (data.groups ? 'agents' : 'skills');
  const input = Array.isArray(data) ? { tree: data } : data;
  documentHrefs = kind === 'files' ? new Map() : collectDocumentHrefs(input);
  const adapter = { files: adaptFilesTree, agents: adaptAgentTree, skills: adaptSkillsTree }[kind];
  if (kind !== state.navigationKind) nav = nextNav(nav, { type: 'reset' });
  state.navigationKind = kind;
  state.navigation = adapter(input);
  state.tree = documentIds(state.navigation);
  if (kind === 'skills' && !state.file) document.title = 'SKILLS.md';
  pipeline.setTree(state.tree);
  renderSidebar();
}

// returns why it could not list, so a folder the server is not allowed to read
// stops arriving as an empty one
async function loadTree() {
  const res = await docs().tree({ scope: currentRoute.scopePath });
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

// Refresh whichever tree is visible when SSE reports a file change.
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
  if (currentRoute.space === 'skills' || currentRoute.space === 'agents') return refreshFrom(() => docs().tree());
  await loadTree();
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


// Agent config reuses the folder switcher markup and Back to Home row.
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
  getRootInfo: () => rootInfo,
  getBackLabel: () => (currentRoute.rootKey && rootInfo && rootInfo.name ? rootInfo.name : 'Home'),
  getTreeLength: () => state.tree.length,
  getPanelOpen: () => !panelClosed(), setPanel,
  openSkills, openAgentConfig, openSettings, fetchAgentTree,
  navigateTo,
});

sidebar.append(home.switcherEl, searchEl, agentSwitcherEl, navBody, updateCtaEl, footerEl);

// Skills and Agents are Spaces: entering one is a navigation, so a reload or a
// shared URL lands on the same catalog, and Back leaves it.
function openSkills() {
  return navigateTo(currentRoute.rootKey
    ? { space: 'skills', selection: 'root', rootKey: currentRoute.rootKey }
    : { space: 'skills', selection: 'global' });
}

function openAgentConfig(agentKey = 'claude') {
  return navigateTo(currentRoute.rootKey
    ? { space: 'agents', agentKey, rootKey: currentRoute.rootKey }
    : { space: 'agents', agentKey });
}

// probes an agent's tree without navigating, so the launcher can pick the
// first agent with content before committing to a route
async function fetchAgentTree(agentKey) {
  const route = currentRoute.rootKey
    ? { space: 'agents', agentKey, rootKey: currentRoute.rootKey }
    : { space: 'agents', agentKey };
  try {
    const res = await api.documentApi(route).tree();
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Exit to the current root or Home; fresh tabs may have no browser history.
function homeOrCurrentRoot() {
  return currentRoute.rootKey && findRootSummary(currentRoute.rootKey)
    ? { space: 'root', rootKey: currentRoute.rootKey }
    : { space: 'home' };
}

function leaveSpace() {
  return navigateTo(homeOrCurrentRoot());
}

async function enterSkillsView() {
  if (isSettingsOpen(viewState.view)) exitSettingsView();
  navBody.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'nav-empty';
  loading.textContent = 'Loading skills…';
  navBody.appendChild(loading);
  try {
    const res = await docs().tree();
    if (!res.ok) throw new Error('skills tree failed');
    applyTreeData(await res.json());
    setSource('skills');
    searchInput.placeholder = 'Search skills…';
  } catch {
    loading.textContent = 'Could not load skills.';
    return false;
  }
  // an empty catalog leaves the launcher (if open) untouched, so browseSpace
  // can show its notice without a sidebar flash
  if (state.tree.length) home.hideLauncher();
  home.renderSwitcher();
  return true;
}

// leaves the skills/agent-config tree without landing anywhere: the caller is
// about to put its own screen on top
function leaveSourceView() {
  closeAgentSwitcherMenu();
  setSource('files');
  searchInput.placeholder = 'Search files';
  home.renderSwitcher();
}

const AGENT_CONFIG_DISPLAY_NAMES = { claude: 'Claude', codex: 'Codex' };

function setSource(source) {
  viewState.dispatch({ type: 'source', source });
}

const lastFileBySource = { files: null, skills: null, agents: null };

// Restore each tree's last file, then a preferred or first file.
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
    const name = document.createElement('span');
    name.className = 'agent-switcher-name';
    name.textContent = a.displayName;
    row.appendChild(name);
    row.disabled = !a.detected;
    if (a.key === currentRoute.agentKey) row.classList.add('on');
    if (!a.detected) {
      const notDetected = document.createElement('span');
      notDetected.className = 'agent-switcher-undetected';
      notDetected.textContent = 'not detected';
      row.appendChild(notDetected);
    }
    row.addEventListener('click', () => {
      closeAgentSwitcherMenu();
      if (a.key === currentRoute.agentKey) return;
      nav = nextNav(nav, { type: 'reset' });
      openAgentConfig(a.key);
    });
    const item = document.createElement('div');
    item.className = 'switcher-menu-item';
    item.appendChild(row);
    agentSwitcherMenu.appendChild(item);
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

// returns the file agent config wants open when the route named no document:
// Instructions is what someone opening agent config almost always came for.
async function enterAgentConfigView() {
  if (isSettingsOpen(viewState.view)) exitSettingsView();
  const agentKey = currentRoute.agentKey;
  navBody.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'nav-empty';
  loading.textContent = 'Loading agent config…';
  navBody.appendChild(loading);
  let preferred = null;
  try {
    const res = await docs().tree();
    if (!res.ok) throw new Error('agent tree failed');
    const data = await res.json();
    applyTreeData(data);
    setSource('agents');
    searchInput.placeholder = 'Search agent config…';
    agentSwitcherNameEl.textContent = data.displayName || AGENT_CONFIG_DISPLAY_NAMES[agentKey] || agentKey;
    renderAgentSwitcherMenu(data.agents || []);
    const instructions = data.groups.find((g) => g.name === 'Instructions');
    const firstFile = instructions && instructions.files && instructions.files[0];
    preferred = firstFile ? firstFile.id : null;
  } catch {
    loading.textContent = 'Could not load agent config.';
    return false;
  }
  if (state.tree.length) home.hideLauncher();
  home.renderSwitcher();
  return preferred;
}

async function fetchSettings() {
  try {
    const res = await api.getSettings(currentRoute.rootKey);
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
  getRootKey: () => currentRoute.rootKey,
  onSelectRoot: (key) => navigateTo(key ? { space: 'settings', rootKey: key } : { space: 'settings' }),
  backLabel: () => {
    const root = currentRoute.rootKey ? findRootSummary(currentRoute.rootKey) : null;
    return root ? `← ${root.name}` : '← Home';
  },
  onBack: () => leaveSettings(),
  isSettingsOpen: () => isSettingsOpen(viewState.view),
});

async function reopenSettingsInPlace() {
  const scrollTop = main.scrollTop;
  await settingsView.open();
  main.scrollTop = scrollTop;
}

async function enterSettingsView() {
  if (isSourceView(viewState.view)) leaveSourceView();
  if (isLauncherOpen(viewState.view)) home.hideLauncher();
  if (isSettingsOpen(viewState.view)) { await reopenSettingsInPlace(); return; }
  viewState.dispatch({ type: 'settings-open' });
  lastVisitedFile = state.file;
  stopMarquee(fname);
  fnameTrack.textContent = 'Settings';
  document.title = 'Settings';
  renderSidebar();
  await settingsView.open();
}

function exitSettingsView() {
  viewState.dispatch({ type: 'settings-close' });
  lastVisitedFile = null;
  if (state.file) setFnameForFile(state.file);
  else { stopMarquee(fname); fnameTrack.textContent = ''; document.title = 'showmd'; }
  renderSidebar();
}

function openSettings() {
  return navigateTo(currentRoute.rootKey
    ? { space: 'settings', rootKey: currentRoute.rootKey }
    : { space: 'settings' });
}

function leaveSettings() {
  return navigateTo(homeOrCurrentRoot());
}

settingsFooterBtn.addEventListener('click', () => {
  if (isSettingsOpen(viewState.view)) leaveSettings(); else openSettings();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !isSettingsOpen(viewState.view)) return;
  if (settingsView.menuOpen() || !home.switcherMenu.hidden) return;
  if (/^(input|textarea|select)$/i.test(e.target.tagName)) return;
  leaveSettings();
});

home.switcherBtn.addEventListener('click', () => {
  if (isSourceView(viewState.view)) { leaveSpace(); return; }
  if (home.switcherMenu.hidden) home.openSwitcherMenu(); else home.closeSwitcherMenu();
});
for (const btn of [home.switcherOpenFolderBtn, home.switcherOpenFileBtn]) {
  btn.addEventListener('click', () => home.openTarget(btn.dataset.kind, undefined, btn));
}
home.switcherHomeBtn.addEventListener('click', async () => {
  home.closeSwitcherMenu();
  await navigateTo({ space: 'home' });
});
appLogo.addEventListener('click', () => navigateTo({ space: 'home' }));
appLogo.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  navigateTo({ space: 'home' });
});
skillsFooterBtn.addEventListener('click', () => {
  if (currentRoute.space === 'skills') { leaveSpace(); return; }
  openSkills();
});
agentsFooterBtn.addEventListener('click', () => {
  if (currentRoute.space === 'agents') { leaveSpace(); return; }
  openAgentConfig();
});


function findRootSummary(rootKey) {
  return (bootData.roots || []).find((r) => r.key === rootKey) || null;
}

function prefixWithScope(scopePath, value) {
  if (value === undefined) return scopePath || undefined;
  return scopePath ? `${scopePath}/${value}` : value;
}

// Root promotion rewrites route state without refetching the same document.
async function applyRootPromotion({ newRoot, scope }) {
  const oldRootKey = currentRoute.rootKey;
  if (currentRoute.rootKey !== undefined) {
    bootData.roots = (bootData.roots || []).filter((r) => r.key !== currentRoute.rootKey);
  }
  if (!findRootSummary(newRoot.key)) bootData.roots = [...(bootData.roots || []), newRoot];
  rootInfo = newRoot;

  if (currentRoute.space !== 'root') {
    currentRoute = currentRoute.space === 'settings'
      ? { space: 'settings', rootKey: newRoot.key }
      : { ...currentRoute, rootKey: newRoot.key };
    if (saveAddress && saveAddress.route.rootKey === oldRootKey) {
      saveAddress = { ...saveAddress, route: { ...saveAddress.route, rootKey: newRoot.key } };
    }
    history.replaceState({ idx: navIdx }, '', formatRouteContext(currentRoute));
    home.renderSwitcher();
    if (save.isDirty()) await save.flush();
    if (currentRoute.space === 'settings') {
      await reopenSettingsInPlace();
      return;
    }
    if (currentRoute.space === 'skills' || currentRoute.space === 'agents') {
      const openFile = state.file;
      const entered = await (currentRoute.space === 'skills' ? enterSkillsView() : enterAgentConfigView());
      if (entered === false) return;
      if (openFile && state.tree.includes(openFile)) {
        state.file = openFile;
        saveAddress = { route: { ...currentRoute }, file: openFile };
        pipeline.setDocId(openFile);
        pipeline.setAssetUrl(docs().assetUrl);
        renderSidebar();
      } else {
        openDefaultFile(typeof entered === 'string' ? entered : undefined);
      }
    }
    return;
  }
  currentRoute = {
    ...currentRoute,
    rootKey: newRoot.key,
    scopePath: prefixWithScope(scope.scopePath, currentRoute.scopePath),
    documentPath: prefixWithScope(scope.scopePath, currentRoute.documentPath),
  };
  if (state.file) {
    state.file = prefixWithScope(scope.scopePath, state.file);
    lastFileBySource.files = state.file;
    saveAddress = { route: { ...currentRoute }, file: state.file };
    pipeline.setDocId(state.file);
    pipeline.setAssetUrl(docs().assetUrl);
    setFnameForFile(state.file);
  }
  history.replaceState({ idx: navIdx }, '', formatRouteContext(currentRoute));
  home.renderSwitcher();
  if (save.isDirty()) await save.flush();
  await loadTree();
}

// Render stale root keys as a recoverable Home state.
function renderRootNotOpen() {
  rootInfo = null;
  home.showLauncher();
  home.showLauncherNotice('This root is no longer open.', { sticky: true });
}

async function initRoot() {
  rootInfo = currentRoute.rootKey ? findRootSummary(currentRoute.rootKey) : null;
  if (!rootInfo || rootInfo.dir == null) {
    if (bootData.routeError && bootData.routeError.kind === 'root_not_open') { renderRootNotOpen(); return; }
    home.showLauncher();
    return;
  }
  home.switcherEl.hidden = false;
  footerEl.hidden = false;
  home.renderSwitcher();
  if (bootSettings) settingsView.renderCta(bootSettings);
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
  if (row.labelParts) {
    const { prefix, name } = row.labelParts;
    if (prefix) {
      const prefixEl = document.createElement('span');
      prefixEl.className = 'sec-label-prefix';
      prefixEl.textContent = prefix;
      label.appendChild(prefixEl);
    }
    const nameEl = document.createElement('span');
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
  const inner = document.createElement('span');
  inner.className = 'rowtext';
  const track = document.createElement('span');
  track.className = 'rowtext-track';
  if (labelParts) {
    const dirEl = document.createElement('span');
    dirEl.className = 'rowtext-dir';
    dirEl.textContent = labelParts.dir;
    track.appendChild(dirEl);
    const baseEl = document.createElement('span');
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
  const inner = makeRowText(row.label, row.labelParts);
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

function renderNavEmpty(text) {
  const empty = document.createElement('div');
  empty.className = 'nav-empty';
  empty.textContent = text;
  navBody.appendChild(empty);
}

const EMPTY_CATALOG_NOTICE = { skills: SKILLS_EMPTY_NOTICE, agents: AGENTS_EMPTY_NOTICE };

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
  nav = nextNav(nav, { type: 'sync-rows' }, { model: state.navigation, file: state.file, hideFile: isSettingsOpen(viewState.view) });
  navBody.replaceChildren();
  if (nav.rows.length === 0) {
    if (nav.query) return renderNavEmpty('No matches');
    if (EMPTY_CATALOG_NOTICE[state.navigationKind]) return renderNavEmpty(EMPTY_CATALOG_NOTICE[state.navigationKind]);
  }
  paintRows(nav.rows);
  // selection lives in state, so it survives the markup being thrown away
  const selectedEl = navItemFor(nav.selected);
  if (selectedEl) selectedEl.classList.add('kbd-on');
}

function canGoBack() { return navIdx > 0; }

function updateNavButtons() {
  backBtn.classList.toggle('disabled', navIdx <= 0);
  fwdBtn.classList.toggle('disabled', navIdx >= navMax);
}

// Apply parsed routes identically after pushState and popstate.
async function applyRoute(route) {
  if (route && route.space === 'settings') {
    const alreadyOpen = isSettingsOpen(viewState.view);
    currentRoute = { space: 'settings', rootKey: route.rootKey };
    if (alreadyOpen) await settingsView.refreshRootScope();
    else await enterSettingsView();
    return;
  }
  if (isSettingsOpen(viewState.view)) exitSettingsView();
  if (!route || route.space === 'home') {
    currentRoute = { space: 'home', rootKey: undefined, scopePath: undefined, documentPath: undefined };
    rootInfo = null;
    home.showLauncher();
    return;
  }
  if (route.space === 'skills' || route.space === 'agents') {
    const sameSpace = route.space === currentRoute.space
      && route.selection === currentRoute.selection
      && route.agentKey === currentRoute.agentKey
      && route.rootKey === currentRoute.rootKey
      && route.contextKey === currentRoute.contextKey;
    currentRoute = { ...route };
    const entered = sameSpace ? null : await (route.space === 'skills' ? enterSkillsView() : enterAgentConfigView());
    if (entered === false) return;
    const file = route.documentRoute !== undefined ? route.documentRoute : undefined;
    if (file) await loadFile(file);
    else if (!sameSpace) openDefaultFile(typeof entered === 'string' ? entered : undefined);
    return;
  }
  const leftSpace = isSourceView(viewState.view);
  if (leftSpace) leaveSourceView();
  if (route.space !== 'root') return;
  // reopening the same folder yields the same deterministic rootKey, so a
  // missing rootInfo (launcher / root-not-open state) must count as a switch
  const switchedRoot = route.rootKey !== currentRoute.rootKey || !rootInfo;
  const scopeChanged = route.scopePath !== currentRoute.scopePath;
  currentRoute = { space: 'root', rootKey: route.rootKey, scopePath: route.scopePath, documentPath: route.documentPath };
  if (switchedRoot) {
    rootInfo = findRootSummary(route.rootKey);
    if (!rootInfo || rootInfo.dir == null) { renderRootNotOpen(); return; }
    home.hideLauncher();
    home.switcherEl.hidden = false;
    footerEl.hidden = false;
    home.renderSwitcher();
  }
  if (switchedRoot) lastFileBySource.files = null;
  if (switchedRoot || scopeChanged || leftSpace) await loadTree();
  const file = route.documentPath !== undefined
    ? route.documentPath
    : ((switchedRoot || leftSpace) ? lastFileBySource.files || state.tree[0] : undefined);
  if (file) await loadFile(file);
}

// Flush before changing the URL so failed saves leave navigation untouched.
async function navigateTo(route) {
  if (save.isDirty()) {
    await save.flush();
    if (save.isDirty()) return;
  }
  const url = formatRouteContext(route);
  navIdx += 1;
  navMax = navIdx;
  history.pushState({ idx: navIdx }, '', url);
  updateNavButtons();
  await applyRoute(route);
}

function navigate(file) {
  const href = documentHrefs.get(file);
  if (href) {
    const route = parseRouteContext(href);
    if (route) return navigateTo(route);
  }
  if (isSourceView(viewState.view)) return navigateTo({ ...currentRoute, documentRoute: file });
  return navigateTo({ space: 'root', rootKey: currentRoute.rootKey, scopePath: currentRoute.scopePath, documentPath: file });
}

function setFnameForFile(file) {
  const parts = file.split('/');
  fnameTrack.textContent = breadcrumbForDocument(state.navigation, file);
  document.title = parts[parts.length - 1];
}

async function loadFile(file, preserveScroll) {
  home.hideLauncher();
  lastFileBySource[viewState.view.source] = file;
  if (isSettingsOpen(viewState.view)) exitSettingsView();
  if (save.isDirty()) await save.flush();
  saveAddress = { route: { ...currentRoute }, file };
  if (state.file !== file) docView.resetCollapsedHeadings();
  state.file = file;
  pipeline.setDocId(file);
  pipeline.setAssetUrl(docs().assetUrl);
  pipeline.setDocHref((f) => documentHrefs.get(f) || formatRouteContext({ space: 'root', rootKey: currentRoute.rootKey, scopePath: currentRoute.scopePath, documentPath: f }));
  if (nav.selected !== file) nav = nextNav(nav, { type: 'select', id: null });
  stopMarquee(fname);
  setFnameForFile(file);
  document.body.classList.add('has-file');
  banner.hidden = true;
  save.resolveExternal('keep');
  if (isVersionOpen(viewState.view)) historyView.backToCurrent();
  const scrollTop = preserveScroll ? main.scrollTop : 0;
  const res = await docs().raw(file);
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

// Supply History with the current root at call time, not panel-open time.
const rootScopedHistoryApi = {
  history: (path) => docs().history(path),
  diff: (path, rev, repo) => docs().diff(path, rev, repo),
};

const historyView = createHistoryView({
  panelBtn, panel, verList, restoreBtn, diffTime, diffBody, api: rootScopedHistoryApi,
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
    setSaveState('error', 'Connection lost', bootData.root && bootData.root.launchedFrom === 'app'
      ? 'ShowMD stopped — reopen the ShowMD app'
      : 'showmd stopped — run showmd again in your terminal');
  };
  es.onmessage = async (e) => {
    const data = JSON.parse(e.data);
    // broadcast before the process exits for a restart; carries no rootKey,
    // so it is not caught by the per-root filter below and reaches every tab
    if (data.event === 'server-restarting') {
      setSaveState('saving', 'Restarting…', 'waiting for showmd to come back');
      followRestart(data.port, {
        pathname: window.location.pathname, search: window.location.search, hash: window.location.hash,
      }).then((result) => {
        if (!result.ok) {
          setSaveState('error', 'Connection lost', bootData.root && bootData.root.launchedFrom === 'app'
            ? 'ShowMD stopped — reopen the ShowMD app'
            : 'showmd stopped — run showmd again in your terminal');
        } else if (result.samePort) {
          serverGone = false;
          save.setDirty(save.isDirty());
          refreshTree();
        }
      });
      return;
    }
    // events for a root this tab is not addressing belong to another tab's
    // Root Space — two tabs on two roots must not cross-refresh each other
    if (data.rootKey !== undefined && data.rootKey !== currentRoute.rootKey) return;
    const { path, event } = data;
    // A removed root hides panes but preserves any dirty editor buffer.
    if (event === 'root-removed') { renderRootNotOpen(); return; }
    // Root promotion changes addressing, not the document bytes.
    if (event === 'root-promoted') { await applyRootPromotion(data); return; }
    // content-only edits to the file already open can't reshape the tree;
    // anything else (new file, rename, delete) can
    if (event !== 'change' || path !== state.file) refreshTree();
    if (path !== state.file) return;
    if (!panelClosed()) historyView.load();
    let res = null;
    try {
      res = await docs().raw(path);
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

// Clamp tooltips to both the viewport and the sidebar's clipping boundary.
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
function goBack() { if (canGoBack()) history.back(); }
function goForward() { if (navIdx < navMax) history.forward(); }
backBtn.addEventListener('click', goBack);
fwdBtn.addEventListener('click', goForward);

revealBtn.addEventListener('click', async () => {
  const p = isSettingsOpen(viewState.view) ? api.revealSettings() : (state.file ? docs().reveal(state.file) : null);
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

exportBtn.addEventListener('click', () => exportPdf());
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
    res = await docs().restore(state.file, viewState.view.version.rev, viewState.view.version.repo);
  } catch {
    res = null;
  }
  if (!res || !res.ok) {
    setSaveState('error', 'Restore failed', 'could not restore this version — your file is unchanged');
    return;
  }
  historyView.backToCurrent();
});
// Getting Started shortcuts share launcher row actions even when it is hidden.
function openFileShortcut() {
  if (home.launcherKeyboardActive()) home.activateLauncherRow(document.getElementById('launcher-open-file'));
  else home.openTarget('open-file');
}
function openFolderShortcut() {
  if (home.launcherKeyboardActive()) home.activateLauncherRow(document.getElementById('launcher-open-folder'));
  else home.openTarget('open-folder');
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
  if (e.shiftKey && key === 'h') { e.preventDefault(); navigateTo({ space: 'home' }); return; }
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
  if (key === 'p') {
    e.preventDefault();
    exportPdf();
    return;
  }
  if (cmEditor && editorHost.contains(document.activeElement)) return;
  if (key === 'e') { e.preventDefault(); setMode(MODE_CYCLE[viewState.view.mode]); }
  else if (key === 's' && viewState.view.mode !== 'read') { e.preventDefault(); save.flush(); }
  // shifted backslash arrives as '|' on US layouts
  else if ((key === '\\' || key === '|') && e.shiftKey) { e.preventDefault(); setPanel(panelClosed()); }
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

// Adopt a legacy local theme once when settings have no saved color mode.
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
  else if (viewState.view.mode === 'read' && state.file) blocks.refreshThemeIn(doc);
}
window.showmdSetTheme = setTheme;

let pendingPrintRestore = null;

function finishExportPdf() {
  if (!pendingPrintRestore) return;
  const { prevTitle, prevMode } = pendingPrintRestore;
  pendingPrintRestore = null;
  document.title = prevTitle;
  if (prevMode) setTheme(prevMode, { persist: false });
}
window.addEventListener('afterprint', finishExportPdf);

window.addEventListener('beforeprint', () => {
  for (const a of doc.querySelectorAll('a.wikilink[href]')) {
    a.dataset.printHref = a.getAttribute('href');
    if (a.dataset.file === state.file) a.setAttribute('href', '#doc');
    else a.removeAttribute('href');
  }
});
window.addEventListener('afterprint', () => {
  for (const a of doc.querySelectorAll('a.wikilink[data-print-href]')) {
    a.setAttribute('href', a.dataset.printHref);
    delete a.dataset.printHref;
  }
});

async function exportPdf() {
  await setMode('read');
  await docView.whenRendered();
  const wasDark = resolveTheme(colorMode, THEME_MEDIA.matches) === 'dark';
  const prevMode = wasDark ? colorMode : null;
  if (wasDark) {
    setTheme('light', { persist: false });
    await blocks.refreshThemeIn(doc);
  }
  const prevTitle = document.title;
  if (state.file) document.title = state.file.split('/').pop().replace(/\.(md|markdown)$/i, '');
  pendingPrintRestore = { prevTitle, prevMode };
  window.print();
  finishExportPdf();
}

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
  const bootRoute = bootData.route || { space: 'home' };
  const bootSpace = bootRoute.space === 'skills' || bootRoute.space === 'agents';
  if (bootRoute.space === 'root') {
    currentRoute = { space: 'root', rootKey: bootRoute.rootKey, scopePath: bootRoute.scopePath, documentPath: bootRoute.documentPath };
  } else if (bootRoute.space === 'settings') {
    // Settings sits over a root's tree, so its own key still drives initRoot
    currentRoute = { space: 'settings', rootKey: bootRoute.rootKey };
  } else if (bootSpace) {
    currentRoute = { ...bootRoute };
  }
  // Rootless boots skip tree loading; allSettled still reaches connectEvents.
  const launcherBoot = document.body.classList.contains('launcher');
  // Hand CSS-only boot hiding to the animated JS launcher state before awaits.
  if (launcherBoot) {
    sidebar.classList.add('collapsed');
    headerEl.hidden = true;
    appLogo.hidden = true;
    // Enter through View State so hideLauncher restores rootless boot chrome.
    viewState.dispatch({ type: 'launcher-open' });
    document.body.classList.remove('launcher-boot');
  }
  await Promise.allSettled([initRoot(), (launcherBoot || bootSpace) ? Promise.resolve() : loadTree()]);
  history.replaceState({ idx: 0 }, '', location.pathname + location.search + location.hash);
  if (bootSpace) {
    // a space boots off its own route: the tree and the opened document both
    // come from the URL, so a reload lands exactly where the tab was
    const entered = await (bootRoute.space === 'skills' ? enterSkillsView() : enterAgentConfigView());
    if (entered !== false) {
      if (bootRoute.documentRoute) await loadFile(bootRoute.documentRoute);
      else openDefaultFile(typeof entered === 'string' ? entered : undefined);
      if (settings.openMode === 'edit' && state.file) await setMode('edit');
    }
  } else {
    const file = currentRoute.documentPath || state.tree[0];
    if (file) {
      await loadFile(file);
      if (settings.openMode === 'edit') await setMode('edit');
    }
  }
  if (bootRoute.space === 'settings') await enterSettingsView();
  updateNavButtons();
  historyView.probe();
  connectEvents();
  window.addEventListener('popstate', (e) => {
    const targetIdx = (e.state && typeof e.state.idx === 'number') ? e.state.idx : 0;
    if (restoringPopstate) {
      restoringPopstate = false;
      navIdx = targetIdx;
      navMax = Math.max(navMax, navIdx);
      updateNavButtons();
      return;
    }
    const sourceIdx = navIdx;
    const sourceUrl = formatRouteContext(currentRoute);
    const targetRoute = parseRouteContext(location.href);
    popstateTransition = popstateTransition.then(async () => {
      if (save.isDirty()) {
        await save.flush();
        if (save.isDirty()) {
          const delta = sourceIdx - targetIdx;
          if (delta) {
            restoringPopstate = true;
            history.go(delta);
          } else {
            history.replaceState({ idx: sourceIdx }, '', sourceUrl);
          }
          return;
        }
      }
      navIdx = targetIdx;
      navMax = Math.max(navMax, navIdx);
      updateNavButtons();
      await applyRoute(targetRoute);
    }).catch(() => {});
  });
}

init();
