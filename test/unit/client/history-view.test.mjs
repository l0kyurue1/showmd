import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { relTime, sourceLabel, timelineEntries, diffRows, createHistoryView } from '../../../client/history-view.js';

const NOW = 1_700_000_000_000;
const secsAgo = (s) => (NOW - s * 1000) / 1000;

test('ages read in the largest unit that still fits', () => {
  assert.equal(relTime(secsAgo(20), NOW), 'just now');
  assert.equal(relTime(secsAgo(59), NOW), 'just now');
  assert.equal(relTime(secsAgo(60), NOW), '1m ago');
  assert.equal(relTime(secsAgo(59 * 60), NOW), '59m ago');
  assert.equal(relTime(secsAgo(60 * 60), NOW), '1h ago');
  assert.equal(relTime(secsAgo(47 * 3600), NOW), '1d ago');
});

test('a clock skewed into the future still reads as just now', () => {
  assert.equal(relTime(secsAgo(-600), NOW), 'just now');
});

test('each source has its own label, anything unknown reads as you', () => {
  assert.equal(sourceLabel('external'), '✦ agent');
  assert.equal(sourceLabel('restore'), 'restored');
  assert.equal(sourceLabel('user'), 'you');
  assert.equal(sourceLabel(undefined), 'you');
});

test('a showmd save is titled by its short rev and source', () => {
  const [entry] = timelineEntries([{ rev: 'abcdef1234567', ts: secsAgo(120), source: 'external', adds: 3, dels: 1 }], null, NOW);
  assert.equal(entry.title, 'abcdef1 · ✦ agent');
  assert.equal(entry.age, '2m ago');
  assert.equal(entry.repo, false);
  assert.equal(entry.current, false);
  assert.deepEqual([entry.adds, entry.dels], [3, 1]);
});

test('a repo commit is titled by its subject and shows the rev beside the age', () => {
  const [entry] = timelineEntries([{ rev: 'fedcba9876543', ts: secsAgo(3600), source: 'user', repo: true, subject: 'fix the thing' }], null, NOW);
  assert.equal(entry.title, 'fix the thing');
  assert.equal(entry.age, '1h ago · fedcba9');
  assert.equal(entry.repo, true);
});

test('exactly the open version is marked current, and the original entry rides along', () => {
  const history = [{ rev: 'aaa1111', ts: secsAgo(60) }, { rev: 'bbb2222', ts: secsAgo(60) }];
  const entries = timelineEntries(history, 'bbb2222', NOW);
  assert.deepEqual(entries.map((e) => e.current), [false, true]);
  assert.equal(entries[1].version, history[1]);
});

test('an empty history shapes to no rows', () => {
  assert.deepEqual(timelineEntries([], null, NOW), []);
});

const DIFF = `diff --git a/x.md b/x.md
index 1111111..2222222 100644
--- a/x.md
+++ b/x.md
@@ -1,3 +1,3 @@
 kept

-gone
+added`;

test('the file header is dropped and every line after the hunk is classified', () => {
  assert.deepEqual(diffRows(DIFF), [
    { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
    { kind: 'ctx', text: ' kept' },
    { kind: 'ctx', text: ' ' },
    { kind: 'del', text: '-gone' },
    { kind: 'add', text: '+added' },
  ]);
});

test('a diff with no hunk at all paints nothing', () => {
  assert.deepEqual(diffRows(''), []);
  assert.deepEqual(diffRows('diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md'), []);
});

test('a second hunk header is a hunk row, not a header to skip', () => {
  const rows = diffRows('@@ -1 +1 @@\n one\n@@ -9 +9 @@\n nine');
  assert.deepEqual(rows.map((r) => r.kind), ['hunk', 'ctx', 'hunk', 'ctx']);
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

function mount(historyEntries, { historyResponse, diffResponse } = {}) {
  document.body.innerHTML = `
    <button id="panel-btn"></button>
    <div id="panel"></div>
    <div id="ver-list"></div>
    <button id="restore-btn"></button>
    <span id="diff-time"></span>
    <div id="diff-body"></div>
  `;
  const calls = { applyView: 0, diff: [] };
  let view = { mode: 'read', version: null };
  const nextView = (v, event) => {
    if (event.type === 'version') return { ...v, version: { rev: event.rev, repo: !!event.repo } };
    if (event.type === 'current') return v.version === null ? v : { ...v, version: null };
    return v;
  };
  const viewState = {
    get view() { return view; },
    dispatch(event, { beforeCommit } = {}) {
      const next = nextView(view, event);
      if (next === view) return view;
      view = next;
      if (!beforeCommit) {
        calls.applyView++;
        return view;
      }
      return (async () => {
        try {
          await beforeCommit();
        } finally {
          calls.applyView++;
        }
        return view;
      })();
    },
  };
  const api = {
    history: async () => historyResponse || { ok: true, status: 200, json: async () => historyEntries },
    diff: async (file, rev, repo) => {
      calls.diff.push([file, rev, repo]);
      return diffResponse || { ok: true, status: 200, text: async () => '@@ -1 +1 @@\n-old\n+new' };
    },
  };
  const historyView = createHistoryView({
    panelBtn: document.getElementById('panel-btn'),
    panel: document.getElementById('panel'),
    verList: document.getElementById('ver-list'),
    restoreBtn: document.getElementById('restore-btn'),
    diffTime: document.getElementById('diff-time'),
    diffBody: document.getElementById('diff-body'),
    api,
    getFile: () => 'note.md',
    viewState,
  });
  return {
    historyView, calls,
    getView: () => view,
    panelBtn: document.getElementById('panel-btn'),
    panel: document.getElementById('panel'),
    verList: document.getElementById('ver-list'),
    diffBody: document.getElementById('diff-body'),
    restoreBtn: document.getElementById('restore-btn'),
  };
}

test('loading history renders a timeline row per entry', async () => {
  const ui = mount([{ rev: 'aaa1111', ts: secsAgo(60), source: 'user' }]);
  await ui.historyView.load();
  const rows = ui.verList.querySelectorAll('.ver');
  assert.equal(rows.length, 1);
  assert.equal(ui.restoreBtn.disabled, true);
});

test('showing a version enters the Version View and renders its diff', async () => {
  const ui = mount([{ rev: 'aaa1111', ts: secsAgo(60), source: 'user' }]);
  await ui.historyView.load();
  const row = ui.verList.querySelector('.ver');
  row.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.getView().version.rev, 'aaa1111');
  assert.equal(ui.calls.applyView, 1);
  assert.equal(ui.calls.diff.length, 1);
  assert.deepEqual(ui.calls.diff[0], ['note.md', 'aaa1111', undefined]);
  assert.ok(ui.diffBody.querySelector('.dl.hunk'));
});

test('going back to current exits the Version View', async () => {
  const ui = mount([{ rev: 'aaa1111', ts: secsAgo(60), source: 'user' }]);
  await ui.historyView.load();
  await ui.historyView.showVersion({ rev: 'aaa1111', ts: secsAgo(60) });
  assert.ok(ui.getView().version);
  ui.historyView.backToCurrent();
  assert.equal(ui.getView().version, null);
  assert.equal(ui.calls.applyView, 2);
});

test('an unavailable history list hides the panel button, not an empty timeline', async () => {
  const ui = mount([], { historyResponse: { ok: false, status: 503, json: async () => ({ error: 'history unavailable' }) } });
  await ui.historyView.load();
  assert.equal(ui.panelBtn.hidden, true);
  assert.equal(ui.panel.hidden, true);
});

test('a failed history list (e.g. a 500) reports a load failure, not an empty timeline', async () => {
  const ui = mount([], { historyResponse: { ok: false, status: 500, json: async () => ({ error: 'boom' }) } });
  await ui.historyView.load();
  assert.equal(ui.panelBtn.hidden, false);
  assert.equal(ui.panel.hidden, false);
  const err = ui.verList.querySelector('.hist-error');
  assert.ok(err);
  assert.notEqual(err.textContent, 'No versions yet');
  assert.equal(ui.restoreBtn.disabled, true);
});

test('a genuinely empty history (200, no entries) still renders No versions yet', async () => {
  const ui = mount([], { historyResponse: { ok: true, status: 200, json: async () => [] } });
  await ui.historyView.load();
  assert.equal(ui.verList.querySelector('.hist-error'), null);
  const empty = ui.verList.querySelector('.hist-empty');
  assert.ok(empty);
  assert.equal(empty.textContent, 'No versions yet');
});

test('an unavailable diff does not render as an empty diff and retracts History from the UI', async () => {
  const ui = mount([{ rev: 'aaa1111', ts: secsAgo(60), source: 'user' }], {
    diffResponse: { ok: false, status: 503, text: async () => '' },
  });
  await ui.historyView.load();
  await ui.historyView.showVersion({ rev: 'aaa1111', ts: secsAgo(60) });
  assert.equal(ui.getView().version, null);
  assert.equal(ui.panelBtn.hidden, true);
  assert.equal(ui.panel.hidden, true);
  assert.equal(ui.diffBody.children.length, 0);
});

test('a diff failure that is not unavailable (e.g. a 404 for a stale rev) backs out without hiding History', async () => {
  const ui = mount([{ rev: 'aaa1111', ts: secsAgo(60), source: 'user' }], {
    diffResponse: { ok: false, status: 404, text: async () => '' },
  });
  await ui.historyView.load();
  await ui.historyView.showVersion({ rev: 'aaa1111', ts: secsAgo(60) });
  assert.equal(ui.getView().version, null);
  assert.equal(ui.panelBtn.hidden, false);
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.diffBody.children.length, 0);
});

test('a genuinely empty diff (200, no changes) still renders as empty and is not mistaken for unavailable', async () => {
  const ui = mount([{ rev: 'aaa1111', ts: secsAgo(60), source: 'user' }], {
    diffResponse: { ok: true, status: 200, text: async () => '' },
  });
  await ui.historyView.load();
  await ui.historyView.showVersion({ rev: 'aaa1111', ts: secsAgo(60) });
  assert.equal(ui.getView().version.rev, 'aaa1111');
  assert.equal(ui.panelBtn.hidden, false);
  assert.equal(ui.diffBody.children.length, 0);
});
