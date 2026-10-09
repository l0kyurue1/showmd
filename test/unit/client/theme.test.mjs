import test from 'node:test';
import assert from 'node:assert/strict';
import { createTheme } from '../../../client/theme.js';

test('system mode follows a runtime media change; an explicit mode ignores it', () => {
  let changeListener = null;
  const media = { matches: false, addEventListener: (type, fn) => { if (type === 'change') changeListener = fn; } };
  const root = { dataset: {} };
  const storage = { getItem: () => null, removeItem: () => {} };
  const button = { addEventListener: () => {} };
  const theme = createTheme({ media, root, storage, persist: () => {}, onChange: () => {}, button });

  theme.init({});
  assert.equal(root.dataset.theme, 'light');

  media.matches = true;
  changeListener();
  assert.equal(root.dataset.theme, 'dark');

  theme.set('light');
  media.matches = false;
  changeListener();
  media.matches = true;
  changeListener();
  assert.equal(root.dataset.theme, 'light');
});
