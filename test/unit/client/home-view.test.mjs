import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createHomeView } from '../../../client/home-view.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
dom.window.Element.prototype.scrollIntoView = () => {};

const SVG = { file: '<svg id="f"></svg>', folder: '<svg id="d"></svg>', folderPlus: '<svg id="p"></svg>', home: '<svg id="h"></svg>', close: '<svg id="x"></svg>', arrowLeft: '<svg id="a"></svg>', chevron: '<svg id="c"></svg>' };

function mount({
  recents = [], root = { dir: null, name: null }, recentsOk = true, deleteRecentOk = true, roots = [],
  addRootResult = null, listRootsOk = true, pickFolderResult = null,
  removeRootResult = null, confirmChoice = 'confirm',
  treeLength = 0, fetchAgentTreeImpl = async () => null,
} = {}) {
  document.body.innerHTML = `
    <div id="sidebar"></div>
    <header></header>
    <div class="logo"></div>
    <div class="launcher-view" id="launcher-view" hidden>
      <div class="launcher-row" id="launcher-open-folder" data-kind="open-folder"></div>
      <div class="launcher-row" id="launcher-open-file" data-kind="open-file"></div>
      <div class="launcher-row" id="launcher-browse-skills" data-kind="browse-skills"></div>
      <div class="launcher-row" id="launcher-browse-agent-config" data-kind="browse-agent-config"></div>
      <div class="launcher-row" id="launcher-settings" data-kind="settings"></div>
      <div class="launcher-recent" id="launcher-recent" hidden>
        <div class="launcher-group" id="launcher-recent-group"></div>
      </div>
      <div class="launcher-error" id="launcher-error" hidden></div>
    </div>`;
  const footerEl = document.createElement('div');
  const agentSwitcherEl = document.createElement('div');
  const calls = { applyView: 0, addRoot: [], pickFolder: [], navigateTo: [], enterSkills: 0, enterAgentConfig: 0, enterSettings: 0, removeRoot: [], confirmDialog: [] };
  let view = { overlay: null, source: 'files' };
  const viewState = {
    get view() { return view; },
    dispatch(event) {
      if (event.type === 'launcher-open') view = { ...view, overlay: 'launcher' };
      else if (event.type === 'launcher-close') view = { ...view, overlay: null };
      else if (event.type === 'source') view = { ...view, source: event.source };
      calls.applyView++;
      return view;
    },
  };
  let rootInfo = root;
  let returnTo = 'files';
  let panelOpen = false;
  let recentsList = recents.slice();
  let treeLen = treeLength;
  const openSkills = async () => { view = { ...view, source: 'skills' }; };
  const openAgentConfig = async (agentKey = 'claude') => {
    view = { ...view, source: 'agents' };
    calls.navigateTo.push({ space: 'agents', agentKey });
  };
  const api = {
    recents: async () => (recentsOk ? { ok: true, json: async () => ({ recents: recentsList }) } : { ok: false }),
    deleteRecent: async (path) => {
      if (!deleteRecentOk) return { ok: false };
      recentsList = recentsList.filter((e) => e.path !== path);
      return { ok: true };
    },
    addRoot: async (path) => {
      calls.addRoot.push(path);
      if (addRootResult) return addRootResult;
      return {
        ok: true, status: 200,
        json: async () => ({ root: { key: 'r_AAAAAAAAAAAAAAAAAAAAAA', dir: path, name: 'added', url: `/r/r_AAAAAAAAAAAAAAAAAAAAAA/` }, scope: { rootKey: 'r_AAAAAAAAAAAAAAAAAAAAAA', scopePath: '' }, url: `/r/r_AAAAAAAAAAAAAAAAAAAAAA/` }),
      };
    },
    pickFolder: async (body) => {
      calls.pickFolder.push(body);
      if (pickFolderResult) return pickFolderResult;
      return { ok: true, status: 200, json: async () => ({ path: '/Users/me/picked' }) };
    },
    listRoots: async () => (listRootsOk ? { ok: true, json: async () => ({ roots }) } : { ok: false }),
    removeRoot: async (key) => {
      calls.removeRoot.push(key);
      if (removeRootResult) return removeRootResult;
      // the real server stops listing a removed root, and renderSwitcherRoots
      // re-reads GET /api/roots — a static fixture would keep serving the row
      const at = roots.findIndex((r) => r.key === key);
      if (at !== -1) roots.splice(at, 1);
      return { ok: true, status: 200 };
    },
  };
  const navigateTo = async (route) => { calls.navigateTo.push(route); };
  const confirmDialog = async (id, opts) => { calls.confirmDialog.push({ id, ...opts }); return confirmChoice; };
  const bootData = { roots: roots.slice() };
  const home = createHomeView({
    api, bootData, isMac: true, svg: SVG,
    sidebar: document.getElementById('sidebar'),
    headerEl: document.querySelector('header'),
    appLogo: document.querySelector('.logo'),
    footerEl, agentSwitcherEl,
    launcherView: document.getElementById('launcher-view'),
    launcherRecentWrap: document.getElementById('launcher-recent'),
    launcherRecentGroup: document.getElementById('launcher-recent-group'),
    launcherErrorEl: document.getElementById('launcher-error'),
    launcherOpenFolderBtn: document.getElementById('launcher-open-folder'),
    launcherOpenFileBtn: document.getElementById('launcher-open-file'),
    launcherBrowseSkillsBtn: document.getElementById('launcher-browse-skills'),
    launcherBrowseAgentConfigBtn: document.getElementById('launcher-browse-agent-config'),
    launcherSettingsBtn: document.getElementById('launcher-settings'),
    viewState,
    getRootInfo: () => rootInfo,
    getReturnTo: () => returnTo,
    setReturnTo: (v) => { returnTo = v; },
    getBackLabel: () => 'Home',
    getTreeLength: () => treeLen,
    getPanelOpen: () => panelOpen,
    setPanel: (open) => { panelOpen = open; },
    openSkills, openAgentConfig, openSettings: async () => {},
    fetchAgentTree: (agentKey) => fetchAgentTreeImpl(agentKey),
    enterSkillsView: async () => { calls.enterSkills++; return true; },
    enterAgentConfigView: async () => { calls.enterAgentConfig++; return true; },
    enterSettingsView: async () => { calls.enterSettings++; },
    navigateTo,
    confirmDialog,
  });
  return {
    home, calls, bootData,
    setRootInfo: (r) => { rootInfo = r; },
    getView: () => view,
    setPanelOpen: (v) => { panelOpen = v; },
    getPanelOpen: () => panelOpen,
    setTreeLength: (n) => { treeLen = n; },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Home renders recents and activating a row adds that root, then navigates to the returned url', async () => {
  const { home, calls } = mount({ recents: [{ kind: 'folder', path: '/Users/me/proj' }, { kind: 'file', path: '/Users/me/notes/x.md' }] });
  home.showLauncher();
  await tick();
  const rows = Array.from(document.querySelectorAll('.launcher-row')).filter((r) => r.dataset.kind === 'recent');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.path, '/Users/me/proj');

  home.activateLauncherRow(rows[0]);
  await tick();
  assert.deepEqual(calls.addRoot, ['/Users/me/proj']);
  assert.equal(calls.navigateTo.length, 1);
  assert.equal(calls.navigateTo[0].space, 'root');
  assert.equal(calls.navigateTo[0].rootKey, 'r_AAAAAAAAAAAAAAAAAAAAAA');
});

test('openTarget: folder mode picks a folder then adds and navigates to it', async () => {
  const { home, calls } = mount();
  await home.openTarget('open-folder');
  assert.deepEqual(calls.pickFolder, [{ mode: 'folder', startDir: undefined }]);
  assert.deepEqual(calls.addRoot, ['/Users/me/picked']);
  assert.equal(calls.navigateTo.length, 1);
});

test('Open folder from the root switcher closes the menu after navigation succeeds', async () => {
  const { home, calls } = mount({ root: { key: 'r_current', dir: '/Users/me/current', name: 'current' } });
  home.openSwitcherMenu();

  await home.openTarget('open-folder', undefined, home.switcherOpenFolderBtn);

  assert.equal(calls.navigateTo.length, 1, 'the picked folder is opened');
  assert.equal(home.switcherMenu.hidden, true, 'the menu does not remain over the new root');
});

test('openTarget: a canceled picker adds no root and does not navigate', async () => {
  const { home, calls } = mount({ pickFolderResult: { ok: true, status: 200, json: async () => ({ canceled: true }) } });
  await home.openTarget('open-file');
  assert.deepEqual(calls.addRoot, []);
  assert.deepEqual(calls.navigateTo, []);
});

test('the switcher is Recents-driven: no "Open roots" section, and every row shows exactly one uniform action', async () => {
  const roots = [
    { key: 'r_current', dir: '/Users/me/current', name: 'current', url: '/r/r_current/' },
    { key: 'r_other', dir: '/Users/me/other', name: 'other', url: '/r/r_other/' },
  ];
  const recents = [
    { kind: 'folder', path: '/Users/me/current' },
    { kind: 'folder', path: '/Users/me/other' },
    { kind: 'folder', path: '/Users/me/closed' },
  ];
  const { home } = mount({ root: { key: 'r_current', dir: '/Users/me/current', name: 'current' }, roots, recents });
  home.openSwitcherMenu();
  await tick();

  assert.equal(home.switcherEl.textContent.includes('Open roots'), false);
  assert.equal(home.switcherEl.querySelector('.root-switcher-roots-wrap'), null);

  const rows = Array.from(home.switcherEl.querySelectorAll('.switcher-menu-item'));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.querySelector('.root-switcher-recent-badge'), null, 'the Open badge is gone');
    assert.equal(row.querySelectorAll('.root-switcher-recent-del').length, 1, 'exactly one action button');
  }
  for (const row of rows) {
    assert.equal(row.querySelector('.root-switcher-recent-del').getAttribute('aria-label'), 'Remove from recent', 'live-ness is never labelled, only the confirm dialog carries it');
  }
});

test('X on a Recents row that is a live root: confirms once with the new copy, then DELETEs the root then the recent entry, and re-renders', async () => {
  const roots = [{ key: 'r_other', dir: '/Users/me/other', name: 'other', url: '/r/r_other/' }];
  const recents = [{ kind: 'folder', path: '/Users/me/other' }];
  const { home, calls } = mount({ root: { key: 'r_current', dir: '/Users/me/current', name: 'current' }, roots, recents });
  home.openSwitcherMenu();
  await tick();
  home.switcherEl.querySelector('.root-switcher-recent-del').click();
  await tick();

  assert.equal(calls.confirmDialog.length, 1, 'exactly one confirmation, not the deferred rich preflight');
  assert.equal(calls.confirmDialog[0].title, 'Forget other?');
  assert.equal(calls.confirmDialog[0].body, 'Open tabs showing this folder will close, and edits made outside showmd will stop appearing live.');
  assert.equal(calls.confirmDialog[0].confirmLabel, 'Forget folder');
  assert.deepEqual(calls.removeRoot, ['r_other']);
  assert.deepEqual(calls.navigateTo, [], 'forgetting another root must not navigate this tab away');
  assert.equal(home.switcherEl.querySelectorAll('.switcher-menu-item').length, 0, 'the recent entry is gone too');
});

test('X on a live root: canceling the confirmation makes no DELETE call at all', async () => {
  const roots = [{ key: 'r_other', dir: '/Users/me/other', name: 'other', url: '/r/r_other/' }];
  const recents = [{ kind: 'folder', path: '/Users/me/other' }];
  const { home, calls } = mount({ roots, recents, confirmChoice: 'cancel' });
  home.openSwitcherMenu();
  await tick();
  home.switcherEl.querySelector('.root-switcher-recent-del').click();
  await tick();
  assert.deepEqual(calls.removeRoot, []);
  assert.deepEqual(calls.confirmDialog.length, 1);
});

test('X on a live root: a failed root DELETE notifies instead of dropping the row, and never touches Recents', async () => {
  const roots = [{ key: 'r_other', dir: '/Users/me/other', name: 'other', url: '/r/r_other/' }];
  const recents = [{ kind: 'folder', path: '/Users/me/other' }];
  const { home } = mount({ roots, recents, removeRootResult: { ok: false, status: 500 } });
  home.openSwitcherMenu();
  await tick();
  home.switcherEl.querySelector('.root-switcher-recent-del').click();
  await tick();
  const notice = home.switcherEl.querySelector('.root-switcher-notice');
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, 'Could not forget that folder.');
  assert.equal(home.switcherEl.querySelectorAll('.switcher-menu-item').length, 1, 'the row survives a failed close');
});

test('X on a Recents row that is NOT a live root: deletes immediately, no dialog, no root-removal call', async () => {
  const recents = [{ kind: 'folder', path: '/Users/me/closed' }];
  const { home, calls } = mount({ recents });
  home.openSwitcherMenu();
  await tick();
  home.switcherEl.querySelector('.root-switcher-recent-del').click();
  await tick();

  assert.deepEqual(calls.confirmDialog, [], 'a non-live row never shows the dialog');
  assert.deepEqual(calls.removeRoot, [], 'a non-live row never touches the root-removal endpoint');
  assert.equal(home.switcherEl.querySelectorAll('.switcher-menu-item').length, 0, 'the history entry is gone');
});

test('showLauncher opens the pane and collapses the sidebar, hideLauncher restores it', () => {
  const { home, calls, getView } = mount();
  const sidebar = document.getElementById('sidebar');
  home.showLauncher();
  assert.equal(document.body.classList.contains('launcher'), true);
  assert.equal(sidebar.classList.contains('collapsed'), true);
  assert.ok(calls.applyView > 0);
  assert.equal(getView().overlay, 'launcher');

  home.hideLauncher();
  assert.equal(document.body.classList.contains('launcher'), false);
  assert.equal(getView().overlay, null);
});

test('showLauncher closes an open right panel, hideLauncher restores it', () => {
  const { home, setPanelOpen, getPanelOpen } = mount();
  setPanelOpen(true);
  home.showLauncher();
  assert.equal(getPanelOpen(), false);

  home.hideLauncher();
  assert.equal(getPanelOpen(), true);
});

test('showLauncher leaves a closed right panel closed on hideLauncher', () => {
  const { home, setPanelOpen, getPanelOpen } = mount();
  setPanelOpen(false);
  home.showLauncher();
  assert.equal(getPanelOpen(), false);

  home.hideLauncher();
  assert.equal(getPanelOpen(), false);
});

test('the switcher menu opens, closes, and removes its document listeners on close', () => {
  const { home } = mount({ root: { dir: '/Users/me/proj', name: 'proj' } });
  const addSpy = [];
  const removeSpy = [];
  const origAdd = document.addEventListener.bind(document);
  const origRemove = document.removeEventListener.bind(document);
  document.addEventListener = (type, fn) => { addSpy.push(type); origAdd(type, fn); };
  document.removeEventListener = (type, fn) => { removeSpy.push(type); origRemove(type, fn); };

  home.openSwitcherMenu();
  assert.equal(home.switcherMenu.hidden, false);
  assert.deepEqual(addSpy.sort(), ['click', 'keydown']);

  home.closeSwitcherMenu();
  assert.equal(home.switcherMenu.hidden, true);
  assert.deepEqual(removeSpy.sort(), ['click', 'keydown']);

  document.addEventListener = origAdd;
  document.removeEventListener = origRemove;
});

// --- silent-failure site coverage: apiRecents, deleteRecent ---

test('apiRecents: a failed fetch shows a notice in the launcher and the switcher, not a broken list', async () => {
  const { home } = mount({ root: { dir: '/Users/me/proj', name: 'proj' }, recentsOk: false });
  home.showLauncher();
  await tick();
  const launcherError = document.getElementById('launcher-error');
  assert.equal(launcherError.hidden, false);
  assert.equal(launcherError.textContent, "Couldn't load recent folders.");
  assert.equal(document.getElementById('launcher-recent').hidden, true);

  home.openSwitcherMenu();
  await tick();
  const switcherNotice = home.switcherEl.querySelector('.root-switcher-notice');
  assert.equal(switcherNotice.hidden, false);
  assert.equal(switcherNotice.textContent, "Couldn't load recent folders.");
});

test('apiRecents: a genuinely empty list renders empty with no notice', async () => {
  const { home } = mount({ root: { dir: '/Users/me/proj', name: 'proj' }, recents: [], recentsOk: true });
  home.showLauncher();
  await tick();
  assert.equal(document.getElementById('launcher-error').hidden, true);
  assert.equal(document.getElementById('launcher-recent').hidden, true);

  home.openSwitcherMenu();
  await tick();
  assert.equal(home.switcherEl.querySelector('.root-switcher-notice').hidden, true);
});

test('deleteRecent: a failed delete notifies the user instead of silently vanishing the row', async () => {
  const { home } = mount({ recents: [{ kind: 'folder', path: '/Users/me/proj' }], deleteRecentOk: false });
  home.showLauncher();
  await tick();
  const delBtn = document.querySelector('.launcher-row-delete');
  assert.ok(delBtn, 'the recent row must be rendered before its delete button can be clicked');
  delBtn.click();
  await tick();
  await tick();

  const launcherError = document.getElementById('launcher-error');
  assert.equal(launcherError.hidden, false);
  assert.equal(launcherError.textContent, 'Could not remove that folder.');
  assert.equal(document.querySelectorAll('.launcher-row-delete').length, 1, 'a failed delete must not remove the row');
});

test('deleteRecent: a successful delete removes the row with no notice', async () => {
  const { home } = mount({ recents: [{ kind: 'folder', path: '/Users/me/proj' }] });
  home.showLauncher();
  await tick();
  document.querySelector('.launcher-row-delete').click();
  await tick();
  await tick();

  assert.equal(document.getElementById('launcher-error').hidden, true);
  assert.equal(document.querySelectorAll('.launcher-row-delete').length, 0);
});

// --- empty-catalog notices: neutral tone, no launcher flash ---

test('launcherBrowseSkills: an empty tree leaves the launcher open (no hide/show flash) and shows the info notice', async () => {
  const { home, calls } = mount({ treeLength: 0 });
  home.showLauncher();
  await tick();
  const sidebar = document.getElementById('sidebar');
  assert.equal(sidebar.classList.contains('collapsed'), true);
  const closeCallsBefore = calls.applyView;

  await home.launcherBrowseSkills();

  assert.equal(sidebar.classList.contains('collapsed'), true, 'sidebar stays collapsed the whole time, no flash');
  assert.equal(calls.applyView, closeCallsBefore, 'launcher-close/-open never dispatched for an empty catalog');
  const launcherError = document.getElementById('launcher-error');
  assert.equal(launcherError.hidden, false);
  assert.equal(launcherError.classList.contains('launcher-error--info'), true);
  assert.equal(launcherError.textContent, 'No skills installed yet. Add one under ~/.claude/skills, or run showmd skills <dir> to browse a project.');
});

test('a failure notice shown after an info notice does not carry the info tone', async () => {
  const { home } = mount({ treeLength: 0 });
  home.showLauncher();
  await tick();
  await home.launcherBrowseSkills();
  const launcherError = document.getElementById('launcher-error');
  assert.equal(launcherError.classList.contains('launcher-error--info'), true);

  home.showLauncherNotice('Could not remove that folder.');

  assert.equal(launcherError.classList.contains('launcher-error--info'), false);
  assert.equal(launcherError.textContent, 'Could not remove that folder.');
});

test('launcherBrowseAgentConfig: default agent empty, a later detected agent has content -> navigates there without a flash', async () => {
  const trees = {
    claude: { groups: [], agents: [{ key: 'claude', detected: true }, { key: 'codex', detected: true }] },
    codex: { groups: [{ name: 'Instructions' }] },
  };
  const { home, calls } = mount({ treeLength: 0, fetchAgentTreeImpl: async (key) => trees[key] });
  home.showLauncher();
  await tick();
  const sidebar = document.getElementById('sidebar');

  await home.launcherBrowseAgentConfig();

  assert.deepEqual(calls.navigateTo, [{ space: 'agents', agentKey: 'codex' }]);
  assert.equal(document.getElementById('launcher-error').hidden, true, 'no empty notice once a populated agent is found');
  assert.equal(sidebar.classList.contains('collapsed'), true, 'no intermediate hide/show while probing');
});

test('launcherBrowseAgentConfig: every agent empty -> stays in the launcher and shows the info notice', async () => {
  const trees = {
    claude: { groups: [], agents: [{ key: 'claude', detected: true }, { key: 'codex', detected: true }] },
    codex: { groups: [] },
  };
  const { home, calls } = mount({ treeLength: 0, fetchAgentTreeImpl: async (key) => trees[key] });
  home.showLauncher();
  await tick();

  await home.launcherBrowseAgentConfig();

  assert.deepEqual(calls.navigateTo, []);
  const launcherError = document.getElementById('launcher-error');
  assert.equal(launcherError.hidden, false);
  assert.equal(launcherError.classList.contains('launcher-error--info'), true);
  assert.equal(launcherError.textContent, 'No agent config found. ShowMD looks for ~/.claude/CLAUDE.md, ~/.claude/rules/ and ~/.codex/AGENTS.md.');
});
