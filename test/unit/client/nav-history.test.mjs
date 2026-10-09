import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavHistory } from '../../../client/nav-history.js';

function fakeButton() {
  return {
    classList: { toggle() {} },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
  };
}

test('a popstate whose flush leaves the buffer dirty at the same index replaces the URL instead of moving', async () => {
  const calls = [];
  const listeners = {};
  const history = {
    go: (n) => calls.push(['go', n]),
    back: () => calls.push(['back']),
    forward: () => calls.push(['forward']),
    pushState: () => calls.push(['pushState']),
    replaceState: (state, title, url) => calls.push(['replaceState', state, url]),
  };
  const nav = createNavHistory({
    history,
    location: { href: 'http://localhost/r/k/b.md' },
    backBtn: fakeButton(),
    fwdBtn: fakeButton(),
    win: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    save: { isDirty: () => true, flush: async () => {} },
    applyRoute: async () => calls.push(['applyRoute']),
    currentUrl: () => '/r/k/a.md',
    report: () => {},
  });
  nav.listen();
  listeners.popstate({ state: { idx: 0 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['replaceState', { idx: 0 }, '/r/k/a.md']]);
});
