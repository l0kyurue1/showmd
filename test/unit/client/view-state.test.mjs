import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MODE_CYCLE, INITIAL_VIEW, nextView, visiblePane, hashFor, isSettingsOpen, isLauncherOpen, isSourceView, isVersionOpen, createViewState } from '../../../client/view-state.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.history = dom.window.history;
global.location = dom.window.location;

function mountViewState() {
  // mirrors index.html's static markup: doc starts visible, every other pane
  // starts hidden — createViewState never commits until the first dispatch
  const make = (hidden) => { const el = document.createElement('div'); el.hidden = hidden; document.body.appendChild(el); return el; };
  const panes = [['doc', make(false)], ['editor', make(true)], ['diff', make(true)], ['settings', make(true)], ['launcher', make(true)]];
  const toolbar = document.createElement('div');
  const sourceBtn = document.createElement('button');
  const editBtn = document.createElement('button');
  const readBtn = document.createElement('button');
  const settingsFooterBtn = document.createElement('button');
  const skillsFooterBtn = document.createElement('button');
  const agentsFooterBtn = document.createElement('button');
  const viewState = createViewState({ panes, toolbar, sourceBtn, editBtn, readBtn, settingsFooterBtn, skillsFooterBtn, agentsFooterBtn });
  const paneEl = (name) => panes.find(([n]) => n === name)[1];
  return { viewState, paneEl, toolbar, sourceBtn, editBtn, readBtn, settingsFooterBtn, skillsFooterBtn, agentsFooterBtn };
}

const MODES = ['read', 'edit', 'source'];
const SOURCES = ['files', 'skills', 'agents'];
const at = (over) => ({ ...INITIAL_VIEW, ...over });

const EVENTS = [
  ...MODES.map((mode) => ({ type: 'mode', mode })),
  { type: 'version', rev: 'abc1234' },
  { type: 'version', rev: 'def5678', repo: true },
  { type: 'current' },
  { type: 'settings-open' },
  { type: 'settings-close' },
  { type: 'launcher-open' },
  { type: 'launcher-close' },
  ...SOURCES.map((source) => ({ type: 'source', source })),
];

function reachable() {
  const seen = new Map();
  const queue = [INITIAL_VIEW];
  while (queue.length) {
    const view = queue.shift();
    const key = JSON.stringify(view);
    if (seen.has(key)) continue;
    seen.set(key, view);
    for (const event of EVENTS) queue.push(nextView(view, event));
  }
  return [...seen.values()];
}

test('the app opens on the rendered document', () => {
  assert.equal(visiblePane(INITIAL_VIEW), 'doc');
});

test('the mode cycle walks read, edit, source and comes back', () => {
  let view = INITIAL_VIEW;
  const walked = [];
  for (let i = 0; i < 3; i++) {
    view = nextView(view, { type: 'mode', mode: MODE_CYCLE[view.mode] });
    walked.push([view.mode, visiblePane(view)]);
  }
  assert.deepEqual(walked, [['edit', 'editor'], ['source', 'editor'], ['read', 'doc']]);
});

test('asking for the mode already showing changes nothing', () => {
  const view = at({ mode: 'edit' });
  assert.equal(nextView(view, { type: 'mode', mode: 'edit' }), view);
});

test('a version can be opened from every mode, and keeps that mode underneath', () => {
  for (const mode of MODES) {
    const view = nextView(at({ mode }), { type: 'version', rev: 'abc1234' });
    assert.equal(visiblePane(view), 'diff');
    assert.equal(view.mode, mode);
  }
});

test('picking another version stays in the version view', () => {
  const view = nextView(at({ mode: 'source', version: { rev: 'abc1234', repo: false } }), { type: 'version', rev: 'def5678' });
  assert.deepEqual([view.version.rev, visiblePane(view)], ['def5678', 'diff']);
});

test('the rev carries whether it is a repo rev, because that is a fact about the rev', () => {
  assert.deepEqual(nextView(INITIAL_VIEW, { type: 'version', rev: 'abc1234', repo: true }).version, { rev: 'abc1234', repo: true });
  assert.deepEqual(nextView(INITIAL_VIEW, { type: 'version', rev: 'abc1234' }).version, { rev: 'abc1234', repo: false });
});

test('leaving the version view drops the rev and its repo flag together', () => {
  const opened = nextView(INITIAL_VIEW, { type: 'version', rev: 'abc1234', repo: true });
  assert.equal(nextView(opened, { type: 'current' }).version, null);
  assert.equal(nextView(opened, { type: 'mode', mode: 'edit' }).version, null);
});

test('leaving the version view returns to the mode that was active before it', () => {
  for (const mode of MODES) {
    const opened = nextView(at({ mode }), { type: 'version', rev: 'abc1234' });
    const back = nextView(opened, { type: 'current' });
    assert.equal(back.mode, mode);
    assert.equal(visiblePane(back), mode === 'read' ? 'doc' : 'editor');
  }
});

test('switching mode from the version view leaves it', () => {
  const view = nextView(at({ version: { rev: 'abc1234', repo: false } }), { type: 'mode', mode: 'source' });
  assert.deepEqual([view.version, visiblePane(view)], [null, 'editor']);
});

test('the mode button of the mode behind a diff is inert', () => {
  const view = at({ version: { rev: 'abc1234', repo: false } });
  assert.equal(nextView(view, { type: 'mode', mode: 'read' }), view);
});

test('an unknown event is inert', () => {
  const view = at({ mode: 'edit' });
  assert.equal(nextView(view, { type: 'nonsense' }), view);
});

test('settings can be opened from every mode, and keeps that mode underneath', () => {
  for (const mode of MODES) {
    const view = nextView(at({ mode }), { type: 'settings-open' });
    assert.equal(visiblePane(view), 'settings');
    assert.equal(view.mode, mode);
    assert.equal(view.version, null);
  }
});

test('settings can be opened while a version is showing, and keeps it underneath', () => {
  const view = nextView(at({ mode: 'source', version: { rev: 'abc1234', repo: false } }), { type: 'settings-open' });
  assert.equal(visiblePane(view), 'settings');
  assert.equal(view.mode, 'source');
  assert.deepEqual(view.version, { rev: 'abc1234', repo: false });
});

test('closing settings restores the prior mode and version state', () => {
  for (const mode of MODES) {
    const plain = nextView(at({ mode }), { type: 'settings-open' });
    assert.equal(visiblePane(nextView(plain, { type: 'settings-close' })), mode === 'read' ? 'doc' : 'editor');

    const overVersion = nextView(at({ mode, version: { rev: 'abc1234', repo: false } }), { type: 'settings-open' });
    const back = nextView(overVersion, { type: 'settings-close' });
    assert.equal(visiblePane(back), 'diff');
    assert.equal(back.mode, mode);
    assert.deepEqual(back.version, { rev: 'abc1234', repo: false });
  }
});

test('opening settings when already open is inert', () => {
  const view = at({ mode: 'edit', overlay: 'settings' });
  assert.equal(nextView(view, { type: 'settings-open' }), view);
});

test('closing settings when already closed is inert', () => {
  const view = at({ mode: 'edit' });
  assert.equal(nextView(view, { type: 'settings-close' }), view);
});

test('switching mode while settings is open closes settings', () => {
  const view = nextView(INITIAL_VIEW, { type: 'settings-open' });
  const next = nextView(view, { type: 'mode', mode: 'edit' });
  assert.equal(visiblePane(next), 'editor');
  assert.equal(next.overlay, null);
});

test('opening a version while settings is open closes settings', () => {
  const view = nextView(INITIAL_VIEW, { type: 'settings-open' });
  const next = nextView(view, { type: 'version', rev: 'abc1234' });
  assert.equal(visiblePane(next), 'diff');
  assert.equal(next.overlay, null);
});

test('the launcher covers every other pane, settings included', () => {
  for (const view of reachable()) {
    if (view.overlay !== 'launcher') continue;
    assert.equal(visiblePane(view), 'launcher');
  }
});

test('the overlay is one slot: opening Home closes Settings rather than stacking', () => {
  const settings = nextView(INITIAL_VIEW, { type: 'settings-open' });
  const home = nextView(settings, { type: 'launcher-open' });
  assert.equal(home.overlay, 'launcher');
  assert.equal(visiblePane(nextView(home, { type: 'launcher-close' })), 'doc');
});

test('closing the launcher restores the mode and version underneath', () => {
  for (const mode of MODES) {
    for (const version of [null, { rev: 'abc1234', repo: false }]) {
      const under = at({ mode, version });
      const open = nextView(under, { type: 'launcher-open' });
      assert.equal(visiblePane(open), 'launcher');
      assert.equal(visiblePane(nextView(open, { type: 'launcher-close' })), visiblePane(under));
    }
  }
});

test('opening a mode or a version leaves the launcher behind', () => {
  const open = nextView(INITIAL_VIEW, { type: 'launcher-open' });
  assert.equal(nextView(open, { type: 'mode', mode: 'edit' }).overlay, null);
  assert.equal(nextView(open, { type: 'version', rev: 'abc1234' }).overlay, null);
});

test('launcher open and close are inert when already in that state', () => {
  assert.equal(nextView(INITIAL_VIEW, { type: 'launcher-close' }), INITIAL_VIEW);
  const open = nextView(INITIAL_VIEW, { type: 'launcher-open' });
  assert.equal(nextView(open, { type: 'launcher-open' }), open);
});

test('the sidebar source survives every pane change, because it is a separate axis', () => {
  for (const source of SOURCES) {
    const view = nextView(INITIAL_VIEW, { type: 'source', source });
    assert.equal(nextView(view, { type: 'mode', mode: 'edit' }).source, source);
    assert.equal(nextView(view, { type: 'version', rev: 'abc1234' }).source, source);
    assert.equal(nextView(view, { type: 'settings-open' }).source, source);
    assert.equal(nextView(view, { type: 'launcher-open' }).source, source);
  }
});

test('asking for the source already showing is inert', () => {
  const view = nextView(INITIAL_VIEW, { type: 'source', source: 'skills' });
  assert.equal(nextView(view, { type: 'source', source: 'skills' }), view);
});

test('the hash names the view, and only the views worth reopening', () => {
  assert.equal(hashFor(INITIAL_VIEW), '');
  assert.equal(hashFor(nextView(INITIAL_VIEW, { type: 'settings-open' })), '#settings');
  assert.equal(hashFor(nextView(INITIAL_VIEW, { type: 'launcher-open' })), '#home');
  assert.equal(hashFor(nextView(INITIAL_VIEW, { type: 'source', source: 'skills' })), '#skills');
  assert.equal(hashFor(nextView(INITIAL_VIEW, { type: 'source', source: 'agents' })), '#agents');
  assert.equal(hashFor(nextView(INITIAL_VIEW, { type: 'version', rev: 'abc1234' })), '');
});

test('the pane the hash reopens is the pane that wrote it', () => {
  const reopens = { '#settings': 'settings', '#home': 'launcher' };
  for (const view of reachable()) {
    const hash = hashFor(view);
    if (reopens[hash]) assert.equal(visiblePane(view), reopens[hash], JSON.stringify(view));
  }
});

test('every reachable view shows exactly one pane, and it is a real one', () => {
  const panes = ['doc', 'editor', 'diff', 'settings', 'launcher'];
  for (const view of reachable()) {
    assert.ok(panes.includes(visiblePane(view)), JSON.stringify(view));
  }
});

test('isSettingsOpen tracks the settings overlay', () => {
  assert.equal(isSettingsOpen(INITIAL_VIEW), false);
  assert.equal(isSettingsOpen(nextView(INITIAL_VIEW, { type: 'settings-open' })), true);
});

test('isLauncherOpen tracks the launcher overlay', () => {
  assert.equal(isLauncherOpen(INITIAL_VIEW), false);
  assert.equal(isLauncherOpen(nextView(INITIAL_VIEW, { type: 'launcher-open' })), true);
});

test('isSourceView tracks any sidebar source other than files', () => {
  assert.equal(isSourceView(INITIAL_VIEW), false);
  assert.equal(isSourceView(nextView(INITIAL_VIEW, { type: 'source', source: 'skills' })), true);
  assert.equal(isSourceView(nextView(INITIAL_VIEW, { type: 'source', source: 'agents' })), true);
});

test('isVersionOpen tracks whether a version is loaded', () => {
  assert.equal(isVersionOpen(INITIAL_VIEW), false);
  assert.equal(isVersionOpen(nextView(INITIAL_VIEW, { type: 'version', rev: 'abc1234' })), true);
  assert.equal(isVersionOpen(nextView(nextView(INITIAL_VIEW, { type: 'version', rev: 'abc1234' }), { type: 'current' })), false);
});

test('dispatching a transition commits the DOM: exactly one pane is visible, the rest are not', () => {
  const { viewState, paneEl } = mountViewState();
  assert.equal(paneEl('doc').hidden, false);
  for (const name of ['editor', 'diff', 'settings', 'launcher']) assert.equal(paneEl(name).hidden, true);

  viewState.dispatch({ type: 'mode', mode: 'edit' });
  assert.equal(paneEl('editor').hidden, false);
  for (const name of ['doc', 'diff', 'settings', 'launcher']) assert.equal(paneEl(name).hidden, true);

  viewState.dispatch({ type: 'settings-open' });
  assert.equal(paneEl('settings').hidden, false);
  for (const name of ['doc', 'editor', 'diff', 'launcher']) assert.equal(paneEl(name).hidden, true);

  viewState.dispatch({ type: 'launcher-open' });
  assert.equal(paneEl('launcher').hidden, false);
  for (const name of ['doc', 'editor', 'diff', 'settings']) assert.equal(paneEl(name).hidden, true);
});

test('dispatch also commits the mode buttons, footer buttons and toolbar visibility', () => {
  const { viewState, sourceBtn, editBtn, readBtn, toolbar, skillsFooterBtn, settingsFooterBtn } = mountViewState();
  viewState.dispatch({ type: 'mode', mode: 'source' });
  assert.equal(sourceBtn.classList.contains('on'), true);
  assert.equal(editBtn.classList.contains('on'), false);
  assert.equal(readBtn.classList.contains('on'), false);
  assert.equal(toolbar.classList.contains('show'), true);

  viewState.dispatch({ type: 'source', source: 'skills' });
  assert.equal(skillsFooterBtn.classList.contains('active'), true);

  viewState.dispatch({ type: 'settings-open' });
  assert.equal(settingsFooterBtn.classList.contains('active'), true);
  assert.equal(toolbar.classList.contains('show'), false);
});

test('an inert transition does not touch the DOM', () => {
  const { viewState, paneEl } = mountViewState();
  const before = paneEl('doc').hidden;
  const returned = viewState.dispatch({ type: 'mode', mode: 'read' });
  assert.equal(paneEl('doc').hidden, before);
  assert.equal(returned, viewState.view);
});

test('a beforeCommit dispatch updates the record before the pane commits, and commit always runs after', async () => {
  const { viewState, paneEl } = mountViewState();
  let sawHiddenDuringBeforeCommit = null;
  const pending = viewState.dispatch({ type: 'version', rev: 'abc1234' }, {
    beforeCommit: () => {
      sawHiddenDuringBeforeCommit = paneEl('diff').hidden;
      assert.equal(paneEl('doc').hidden, false, 'old pane stays visible until beforeCommit resolves');
    },
  });
  assert.equal(viewState.view.version.rev, 'abc1234', 'the record updates synchronously');

  await pending;
  assert.equal(sawHiddenDuringBeforeCommit, true, 'pane stayed hidden while beforeCommit ran');
  assert.equal(paneEl('diff').hidden, false, 'commit always runs once beforeCommit settles');
  assert.equal(paneEl('doc').hidden, true);
});

test('a beforeCommit dispatch still commits even when beforeCommit throws', async () => {
  const { viewState, paneEl } = mountViewState();
  await assert.rejects(viewState.dispatch({ type: 'version', rev: 'abc1234' }, {
    beforeCommit: () => { throw new Error('boom'); },
  }));
  assert.equal(paneEl('diff').hidden, false, 'commit still ran despite the throw');
});
