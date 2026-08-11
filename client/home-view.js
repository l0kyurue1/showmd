import { isLauncherOpen, isSourceView } from './view-state.js';
import { parseRouteContext } from './route.js';
import { confirmDialog as defaultConfirmDialog } from './confirm-dialog.js';

const RECENT_MAX = 5;

export function createHomeView({
  api, bootData, isMac, svg,
  sidebar, headerEl, appLogo, footerEl, agentSwitcherEl,
  launcherView, launcherRecentWrap, launcherRecentGroup, launcherErrorEl,
  launcherOpenFolderBtn, launcherOpenFileBtn, launcherBrowseSkillsBtn, launcherBrowseAgentConfigBtn, launcherSettingsBtn,
  viewState,
  getRootInfo, getBackLabel, getTreeLength,
  getPanelOpen, setPanel,
  openSkills, openAgentConfig, openSettings,
  navigateTo,
  confirmDialog = defaultConfirmDialog,
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
    <button type="button" class="root-switcher-open" data-kind="open-folder">${svg.folderPlus}<span>Open folder</span></button>
    <button type="button" class="root-switcher-open" data-kind="open-file">${svg.file}<span>Open file</span></button>
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
  const switcherOpenFolderBtn = switcherEl.querySelector('.root-switcher-open[data-kind="open-folder"]');
  const switcherOpenFileBtn = switcherEl.querySelector('.root-switcher-open[data-kind="open-file"]');
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

  // Recents are server-side because localStorage is isolated by port.
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
    const list = foldersOnly ? all.filter((e) => e.kind === 'folder') : all;
    return { list: list.slice(0, RECENT_MAX), failed };
  }

  // Merge fresh roots into the client cache so other tabs' roots are addressable.
  async function liveRoots() {
    let roots = bootData.roots || [];
    try {
      const res = await api.listRoots();
      if (res.ok) {
        roots = (await res.json()).roots;
        for (const r of roots) {
          if (!bootData.roots.some((x) => x.key === r.key)) bootData.roots.push(r);
        }
      }
    } catch {}
    return roots;
  }

  async function renderRecentRows() {
    const [{ list, failed }, roots] = await Promise.all([recentEntries({ foldersOnly: true }), liveRoots()]);
    switcherRecentEl.replaceChildren();
    switcherRecentWrap.hidden = list.length === 0;
    if (failed) showSwitcherNotice("Couldn't load recent folders.");
    for (const { path: dir } of list) {
      const liveRoot = roots.find((r) => r.dir === dir);
      const item = document.createElement('div');
      item.className = 'root-switcher-recent-item';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'root-switcher-recent-row';
      row.textContent = dir.split('/').filter(Boolean).pop() || dir;
      row.title = dir;
      row.addEventListener('click', () => addRootAndNavigate(dir));
      item.appendChild(row);
      const actions = document.createElement('div');
      actions.className = 'root-switcher-recent-actions';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'root-switcher-recent-del';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Remove from recent');
      del.title = 'Remove from recent';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        forgetRecent(dir, liveRoot).then((ok) => { if (ok) renderRecentRows(); });
      });
      actions.appendChild(del);
      item.appendChild(actions);
      switcherRecentEl.appendChild(item);
    }
  }

  // Live roots require confirmation; SSE tells every tab about the removal.
  // Non-live rows only remove the Recents entry.
  async function forgetRecent(dir, liveRoot) {
    if (liveRoot) {
      const choice = await confirmDialog('forget-folder-dialog', {
        title: `Forget ${liveRoot.name}?`,
        body: 'Open tabs showing this folder will close, and edits made outside showmd will stop appearing live.',
        confirmLabel: 'Forget folder',
      });
      if (choice !== 'confirm') return false;
      try {
        const res = await api.removeRoot(liveRoot.key);
        if (!res.ok && res.status !== 404) { showSwitcherNotice('Could not forget that folder.'); return false; }
      } catch {
        showSwitcherNotice('Could not forget that folder.');
        return false;
      }
      bootData.roots = (bootData.roots || []).filter((x) => x.key !== liveRoot.key);
    }
    return deleteRecent(dir);
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
    switcherNameEl.textContent = backMode ? `Back to ${getBackLabel()}` : rootInfo.name;
    switcherChevronEl.hidden = backMode;
    agentSwitcherEl.hidden = view.source !== 'agents';
    renderNavFooterNarrow();
  }

  // On narrow source views, collapse only the inactive footer button.
  function renderNavFooterNarrow() {
    const narrow = sidebar.getBoundingClientRect().width < 200;
    footerEl.classList.toggle('narrow', narrow && isSourceView(viewState.view));
  }

  // addRoot registers a target and returns its document or root URL.
  async function addRootAndNavigate(targetPath, notify = showSwitcherNotice, busyEl = null) {
    const openLabel = busyEl && busyEl.querySelector('span');
    const restoreLabel = openLabel && openLabel.textContent;
    try {
      const res = await api.addRoot(targetPath);
      if (res.status === 400) {
        await deleteRecent(targetPath);
        renderRecentRows();
        notify('That folder is no longer available.');
        return;
      }
      if (!res.ok) { notify('Could not open folder.'); return; }
      const data = await res.json();
      if (!bootData.roots.some((r) => r.key === data.root.key)) bootData.roots.push(data.root);
      const route = parseRouteContext(data.url);
      if (route) {
        closeSwitcherMenu();
        await navigateTo(route);
      }
    } catch {
      notify('Could not open folder.');
    } finally {
      if (busyEl) {
        busyEl.disabled = false;
        if (openLabel) openLabel.textContent = restoreLabel;
      }
    }
  }

  async function openTarget(kind, notify = showSwitcherNotice, busyEl = null) {
    const mode = kind === 'open-file' ? 'file' : 'folder';
    const openLabel = busyEl && busyEl.querySelector('span');
    const restoreLabel = openLabel && openLabel.textContent;
    if (busyEl) {
      // native dialog takes ~1-2s to spawn (osascript + AppKit load); show it
      busyEl.disabled = true;
      if (openLabel) openLabel.textContent = 'Opening…';
    }
    // addRootAndNavigate owns clearing busyEl on its own paths; this function
    // only clears it on the picker paths that never reach that call.
    const clearBusy = () => {
      if (!busyEl) return;
      busyEl.disabled = false;
      if (openLabel) openLabel.textContent = restoreLabel;
    };
    try {
      const res = await api.pickFolder({ mode, startDir: mode === 'folder' ? (blockedDir || undefined) : undefined });
      if (!res.ok) { notify('Could not open the file picker.'); clearBusy(); return; }
      const data = await res.json();
      if (data.canceled) { clearBusy(); return; }
      return addRootAndNavigate(data.path, notify, busyEl);
    } catch {
      notify('Could not open the file picker.');
      clearBusy();
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

  // the space reports its own load failure in the sidebar; an empty catalog is
  // the case only the launcher can explain
  function browseSpace(open, source, emptyNotice) {
    launcherSidebarWasCollapsed = false;
    return open().then(() => {
      if (!getTreeLength() && viewState.view.source === source) { showLauncher(); showLauncherNotice(emptyNotice, { sticky: true }); }
    });
  }

  function launcherBrowseSkills() {
    return browseSpace(openSkills, 'skills', 'No skills found.');
  }

  function launcherBrowseAgentConfig() {
    return browseSpace(openAgentConfig, 'agents', 'No agent config found.');
  }

  function activateLauncherRow(el) {
    const kind = el.dataset.kind;
    clearLauncherNotice();
    if (kind === 'open-folder' || kind === 'open-file') openTarget(kind, stickyLauncherNotice);
    else if (kind === 'browse-skills') launcherBrowseSkills();
    else if (kind === 'browse-agent-config') launcherBrowseAgentConfig();
    else if (kind === 'settings') openSettings();
    else if (kind === 'recent') addRootAndNavigate(el.dataset.path, stickyLauncherNotice);
  }

  function showLauncher() {
    document.body.classList.add('launcher');
    // Re-entry preserves captured chrome but always redraws Recents.
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
    // Off-Mac uses bare digits because Ctrl+1..5 switches browser tabs.
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
    switcherEl, switcherBtn, switcherOpenFolderBtn, switcherOpenFileBtn, switcherHomeBtn, switcherMenu,
    openTarget, renderSwitcher, renderNavFooterNarrow,
    openSwitcherMenu, closeSwitcherMenu,
    showLauncherNotice,
    launcherBrowseSkills, launcherBrowseAgentConfig, activateLauncherRow,
    showLauncher, hideLauncher, launcherKeyboardActive,
    setBlockedDir: (dir) => { blockedDir = dir; },
  };
}
