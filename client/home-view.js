import { isLauncherOpen, isSourceView } from './view-state.js';

const RECENT_MAX = 5;

export function createHomeView({
  api, bootData, isMac, svg,
  sidebar, headerEl, appLogo, footerEl, agentSwitcherEl,
  launcherView, launcherRecentWrap, launcherRecentGroup, launcherErrorEl,
  launcherOpenFolderBtn, launcherOpenFileBtn, launcherBrowseSkillsBtn, launcherBrowseAgentConfigBtn, launcherSettingsBtn,
  viewState,
  getRootInfo, getReturnTo, setReturnTo,
  getPanelOpen, setPanel,
  enterSkillsView, enterAgentConfigView, enterSettingsView,
}) {
  const switcherEl = document.createElement('div');
  switcherEl.className = 'root-switcher';
  switcherEl.hidden = true;
  switcherEl.innerHTML = `
  <button type="button" class="root-switcher-btn">
    <span class="root-switcher-icon">${svg.folder}</span>
    <span class="root-switcher-name"></span>
    <span class="chevron root-switcher-chevron collapsed">${svg.chevron}</span>
  </button>
  <div class="root-switcher-menu" hidden>
    <div class="root-switcher-path"></div>
    <button type="button" class="root-switcher-open">${svg.folderPlus}<span>Open…</span></button>
    <button type="button" class="root-switcher-home">${svg.home}<span>Back to home</span></button>
    <div class="root-switcher-notice" hidden></div>
    <div class="root-switcher-recent-wrap" hidden>
      <div class="root-switcher-recent-label">Recent</div>
      <div class="root-switcher-recent"></div>
    </div>
  </div>`;
  const switcherBtn = switcherEl.querySelector('.root-switcher-btn');
  const switcherIconEl = switcherEl.querySelector('.root-switcher-icon');
  const switcherNameEl = switcherEl.querySelector('.root-switcher-name');
  const switcherChevronEl = switcherEl.querySelector('.root-switcher-chevron');
  const switcherMenu = switcherEl.querySelector('.root-switcher-menu');
  const switcherPathEl = switcherEl.querySelector('.root-switcher-path');
  const switcherOpenBtn = switcherEl.querySelector('.root-switcher-open');
  const switcherHomeBtn = switcherEl.querySelector('.root-switcher-home');
  const switcherNoticeEl = switcherEl.querySelector('.root-switcher-notice');
  const switcherRecentWrap = switcherEl.querySelector('.root-switcher-recent-wrap');
  const switcherRecentEl = switcherEl.querySelector('.root-switcher-recent');

  let launcherSidebarWasCollapsed = false;
  let launcherPanelWasOpen = false;
  let launcherSelIdx = 0;
  let launcherNoticeTimer = null;
  let switcherNoticeTimer = null;
  let blockedDir = null;

  // server-side store (server/recents.js) is the single source of truth: every
  // client process is a potential different port, so localStorage (per-origin,
  // thus per-port) can never persist these across Helper relaunches
  async function apiRecents() {
    if (bootData.recents) {
      const entries = bootData.recents;
      bootData.recents = null;
      return { list: entries, failed: false };
    }
    try {
      const res = await api.recents();
      if (!res.ok) return { list: [], failed: true };
      return { list: (await res.json()).recents, failed: false };
    } catch {
      return { list: [], failed: true };
    }
  }

  async function deleteRecent(path, notify = showSwitcherNotice) {
    try {
      const res = await api.deleteRecent(path);
      if (!res.ok) { notify('Could not remove that folder.'); return false; }
      return true;
    } catch {
      notify('Could not remove that folder.');
      return false;
    }
  }

  async function recentEntries({ foldersOnly = false } = {}) {
    const { list: all, failed } = await apiRecents();
    const rootInfo = getRootInfo();
    const list = foldersOnly
      ? all.filter((e) => e.kind === 'folder' && e.path !== (rootInfo && rootInfo.dir))
      : all;
    return { list: list.slice(0, RECENT_MAX), failed };
  }

  async function renderRecentRows() {
    const { list, failed } = await recentEntries({ foldersOnly: true });
    switcherRecentEl.replaceChildren();
    switcherRecentWrap.hidden = list.length === 0;
    if (failed) showSwitcherNotice("Couldn't load recent folders.");
    for (const { path: dir } of list) {
      const item = document.createElement('div');
      item.className = 'root-switcher-recent-item';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'root-switcher-recent-row';
      row.textContent = dir.split('/').filter(Boolean).pop() || dir;
      row.title = dir;
      row.addEventListener('click', () => pickRoot({ dir }));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'root-switcher-recent-del';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Remove from recent');
      del.title = 'Remove from recent';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteRecent(dir).then(renderRecentRows);
      });
      item.append(row, del);
      switcherRecentEl.appendChild(item);
    }
  }

  function showSwitcherNotice(text) {
    clearTimeout(switcherNoticeTimer);
    switcherNoticeEl.textContent = text;
    switcherNoticeEl.hidden = false;
    switcherNoticeTimer = setTimeout(() => { switcherNoticeEl.hidden = true; }, 3000);
  }

  function onSwitcherDocClick(e) {
    if (!switcherEl.contains(e.target)) closeSwitcherMenu();
  }
  function onSwitcherKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeSwitcherMenu(); }
  }
  function openSwitcherMenu() {
    const rootInfo = getRootInfo();
    switcherPathEl.textContent = rootInfo.name;
    switcherPathEl.title = rootInfo.dir;
    switcherNoticeEl.hidden = true;
    renderRecentRows();
    switcherMenu.hidden = false;
    switcherChevronEl.classList.remove('collapsed');
    document.addEventListener('click', onSwitcherDocClick);
    document.addEventListener('keydown', onSwitcherKeydown);
  }
  function closeSwitcherMenu() {
    switcherMenu.hidden = true;
    switcherChevronEl.classList.add('collapsed');
    document.removeEventListener('click', onSwitcherDocClick);
    document.removeEventListener('keydown', onSwitcherKeydown);
  }

  function renderSwitcher() {
    const rootInfo = getRootInfo();
    const view = viewState.view;
    const rootless = !(rootInfo && rootInfo.dir);
    const backMode = isSourceView(view);
    switcherEl.hidden = rootless && !backMode;
    switcherEl.classList.toggle('back-mode', backMode);
    switcherIconEl.innerHTML = backMode ? svg.arrowLeft : svg.folder;
    switcherNameEl.textContent = backMode ? `Back to ${rootless || getReturnTo() === 'home' ? 'Home' : rootInfo.name}` : rootInfo.name;
    switcherChevronEl.hidden = backMode;
    agentSwitcherEl.hidden = view.source !== 'agents';
    renderNavFooterNarrow();
  }

  // only the inactive button collapses to its icon, and only once the sidebar
  // drops under ~200px — and only when one button IS active (Files view, neither
  // active, keeps both labels: two icon+label pairs still fit, and losing both
  // names at once reads as broken rather than compact)
  function renderNavFooterNarrow() {
    const narrow = sidebar.getBoundingClientRect().width < 200;
    footerEl.classList.toggle('narrow', narrow && isSourceView(viewState.view));
  }

  async function pickRoot(body, notify = showSwitcherNotice) {
    const openLabel = switcherOpenBtn.querySelector('span');
    if (!body.dir) {
      // native dialog takes ~1-2s to spawn (osascript + AppKit load); show it
      switcherOpenBtn.disabled = true;
      openLabel.textContent = 'Opening…';
    }
    try {
      const res = await api.pickRoot(body);
      if (res.status === 400) {
        if (body.dir) { await deleteRecent(body.dir); renderRecentRows(); }
        notify('That folder is no longer available.');
        return;
      }
      if (!res.ok) { notify('Could not open folder.'); return; }
      const data = await res.json();
      // {ok:true} lands here too; the tree/switcher refresh happens off the
      // SSE root-changed event so every client watching this root stays in sync
      if (data.canceled) return;
    } catch {
      notify('Could not open folder.');
    } finally {
      switcherOpenBtn.disabled = false;
      openLabel.textContent = 'Open…';
    }
  }

  function showLauncherNotice(text, { sticky = false } = {}) {
    clearTimeout(launcherNoticeTimer);
    launcherErrorEl.textContent = text;
    launcherErrorEl.hidden = false;
    if (!sticky) launcherNoticeTimer = setTimeout(() => { launcherErrorEl.hidden = true; }, 3000);
  }

  const stickyLauncherNotice = (text) => showLauncherNotice(text, { sticky: true });

  function clearLauncherNotice() {
    clearTimeout(launcherNoticeTimer);
    launcherErrorEl.hidden = true;
  }

  function launcherRowEls() {
    return Array.from(launcherView.querySelectorAll('.launcher-row'));
  }

  function setLauncherSelection(idx) {
    const rows = launcherRowEls();
    if (!rows.length) return;
    launcherSelIdx = Math.max(0, Math.min(rows.length - 1, idx));
    rows.forEach((r, i) => r.classList.toggle('sel', i === launcherSelIdx));
    rows[launcherSelIdx].scrollIntoView({ block: 'nearest' });
  }

  async function renderLauncherRecent() {
    const { list: entries, failed } = await recentEntries();
    launcherRecentWrap.hidden = entries.length === 0;
    launcherRecentGroup.replaceChildren();
    if (failed) showLauncherNotice("Couldn't load recent folders.");
    entries.forEach((entry, i) => {
      const parts = entry.path.split('/').filter(Boolean);
      const name = parts[parts.length - 1] || entry.path;
      const row = document.createElement('div');
      row.className = 'launcher-row';
      row.dataset.kind = 'recent';
      row.dataset.path = entry.path;
      const icon = document.createElement('span');
      icon.innerHTML = entry.kind === 'file' ? svg.file : svg.folder;
      row.appendChild(icon.firstElementChild);
      const label = document.createElement('span');
      label.className = 'grow';
      label.append(name);
      const dimText = entry.kind === 'file' ? parts[parts.length - 2] : 'folder';
      if (dimText) {
        const dim = document.createElement('span');
        dim.className = 'dim';
        dim.textContent = ' — ' + dimText;
        label.appendChild(dim);
      }
      row.appendChild(label);
      const kbd = document.createElement('kbd');
      kbd.textContent = isMac ? '⌘' + (i + 1) : String(i + 1);
      row.appendChild(kbd);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'launcher-row-delete';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Remove from recent');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteRecent(entry.path, showLauncherNotice).then(renderLauncherRecent);
      });
      row.appendChild(del);
      row.addEventListener('click', () => activateLauncherRow(row));
      launcherRecentGroup.appendChild(row);
    });
  }

  function launcherBrowseSkills() {
    launcherSidebarWasCollapsed = false;
    hideLauncher();
    // enterSkillsView reports its own load failure in the sidebar and returns
    // whether it landed on a file; a clean entry with nothing in it is the case
    // the launcher has to explain
    return enterSkillsView().then((opened) => {
      if (!opened && viewState.view.source === 'skills') { showLauncher(); showLauncherNotice('No skills found.', { sticky: true }); }
    });
  }

  function launcherBrowseAgentConfig() {
    launcherSidebarWasCollapsed = false;
    hideLauncher();
    return enterAgentConfigView().then((opened) => {
      if (!opened && viewState.view.source === 'agents') { showLauncher(); showLauncherNotice('No agent config found.', { sticky: true }); }
    });
  }

  function activateLauncherRow(el) {
    const kind = el.dataset.kind;
    clearLauncherNotice();
    if (kind === 'open-folder') pickRoot({ mode: 'folder', startDir: blockedDir || undefined }, stickyLauncherNotice);
    else if (kind === 'open-file') pickRoot({ mode: 'file' }, stickyLauncherNotice);
    else if (kind === 'browse-skills') { setReturnTo('home'); launcherBrowseSkills(); }
    else if (kind === 'browse-agent-config') { setReturnTo('home'); launcherBrowseAgentConfig(); }
    else if (kind === 'settings') enterSettingsView();
    else if (kind === 'recent') pickRoot({ dir: el.dataset.path }, stickyLauncherNotice);
  }

  function showLauncher() {
    document.body.classList.add('launcher');
    // re-entrant: boot opens the pane before this runs, and the switcher's Home
    // row can fire while it is already showing — only the chrome capture and the
    // state change are once-only, the recents list always redraws
    if (!isLauncherOpen(viewState.view)) {
      launcherSidebarWasCollapsed = sidebar.classList.contains('collapsed');
      sidebar.classList.add('collapsed');
      launcherPanelWasOpen = getPanelOpen();
      setPanel(false);
      headerEl.hidden = true;
      appLogo.hidden = true;
      viewState.dispatch({ type: 'launcher-open' });
    }
    renderLauncherRecent();
    setLauncherSelection(0);
  }

  function hideLauncher() {
    document.body.classList.remove('launcher');
    if (!isLauncherOpen(viewState.view)) return;
    viewState.dispatch({ type: 'launcher-close' });
    headerEl.hidden = false;
    appLogo.hidden = false;
    sidebar.classList.toggle('collapsed', launcherSidebarWasCollapsed);
    setPanel(launcherPanelWasOpen);
  }

  function launcherKeyboardActive() {
    return isLauncherOpen(viewState.view) && sidebar.classList.contains('collapsed');
  }

  launcherOpenFolderBtn.addEventListener('click', (e) => activateLauncherRow(e.currentTarget));
  launcherOpenFileBtn.addEventListener('click', (e) => activateLauncherRow(e.currentTarget));
  launcherBrowseSkillsBtn.addEventListener('click', (e) => activateLauncherRow(e.currentTarget));
  launcherBrowseAgentConfigBtn.addEventListener('click', (e) => activateLauncherRow(e.currentTarget));
  launcherSettingsBtn.addEventListener('click', (e) => activateLauncherRow(e.currentTarget));

  document.addEventListener('keydown', (e) => {
    if (!launcherKeyboardActive()) return;
    const mod = e.metaKey || e.ctrlKey;
    // Ctrl+1..5 is browser tab switching and cannot be preventDefault'd, so
    // off-Mac the launcher takes the bare digits instead — nothing on this
    // screen accepts text, so they are free
    if ((isMac ? mod : !mod && !e.altKey) && /^[1-5]$/.test(e.key)) {
      const row = launcherRowEls().filter((r) => r.dataset.kind === 'recent')[Number(e.key) - 1];
      if (row) { e.preventDefault(); activateLauncherRow(row); }
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setLauncherSelection(launcherSelIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setLauncherSelection(launcherSelIdx - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); activateLauncherRow(launcherRowEls()[launcherSelIdx]); }
  });

  return {
    switcherEl, switcherBtn, switcherOpenBtn, switcherHomeBtn, switcherMenu,
    pickRoot, renderSwitcher, renderNavFooterNarrow,
    openSwitcherMenu, closeSwitcherMenu,
    showLauncherNotice,
    launcherBrowseSkills, launcherBrowseAgentConfig, activateLauncherRow,
    showLauncher, hideLauncher, launcherKeyboardActive,
    setBlockedDir: (dir) => { blockedDir = dir; },
  };
}
