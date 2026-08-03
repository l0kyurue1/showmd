import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createHomeView } from '../../../client/home-view.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
dom.window.Element.prototype.scrollIntoView = () => {};

const SVG = { file: '<svg id="f"></svg>', folder: '<svg id="d"></svg>', folderPlus: '<svg id="p"></svg>', home: '<svg id="h"></svg>', arrowLeft: '<svg id="a"></svg>', chevron: '<svg id="c"></svg>' };

function mount({ recents = [], root = { dir: null, name: null }, recentsOk = true, deleteRecentOk = true } = {}) {
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
  const calls = { applyView: 0, pickRoot: [], enterSkills: 0, enterAgentConfig: 0, enterSettings: 0 };
  let view = { overlay: null, source: 'files' };
  const viewState = {
    get view() { return view; },
    dispatch(event) {
      if (event.type === 'launcher-open') view = { ...view, overlay: 'launcher' };
      else if (event.type === 'launcher-close') view = { ...view, overlay: null };
      calls.applyView++;
      return view;
    },
  };
  let rootInfo = root;
  let returnTo = 'files';
  let panelOpen = false;
  let recentsList = recents.slice();
  const api = {
    recents: async () => (recentsOk ? { ok: true, json: async () => ({ recents: recentsList }) } : { ok: false }),
    deleteRecent: async (path) => {
      if (!deleteRecentOk) return { ok: false };
      recentsList = recentsList.filter((e) => e.path !== path);
      return { ok: true };
    },
    pickRoot: async (body) => { calls.pickRoot.push(body); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
  };
  const home = createHomeView({
    api, bootData: {}, isMac: true, svg: SVG,
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
    getPanelOpen: () => panelOpen,
    setPanel: (open) => { panelOpen = open; },
    enterSkillsView: async () => { calls.enterSkills++; return true; },
    enterAgentConfigView: async () => { calls.enterAgentConfig++; return true; },
    enterSettingsView: async () => { calls.enterSettings++; },
  });
  return {
    home, calls,
    setRootInfo: (r) => { rootInfo = r; },
    getView: () => view,
    setPanelOpen: (v) => { panelOpen = v; },
    getPanelOpen: () => panelOpen,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Home renders recents and activating a row picks that root', async () => {
  const { home, calls } = mount({ recents: [{ kind: 'folder', path: '/Users/me/proj' }, { kind: 'file', path: '/Users/me/notes/x.md' }] });
  home.showLauncher();
  await tick();
  const rows = Array.from(document.querySelectorAll('.launcher-row')).filter((r) => r.dataset.kind === 'recent');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.path, '/Users/me/proj');

  home.activateLauncherRow(rows[0]);
  await tick();
  assert.deepEqual(calls.pickRoot, [{ dir: '/Users/me/proj' }]);
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
