// Module hook (registered by boot-app.mjs) that swaps app.js's dynamic
// import('./dist/editor.js') for an in-memory stand-in. The real bundle is
// CodeMirror 6, which needs real layout/measurement the jsdom environment
// cannot provide (see the "delayedAndroidKey" crash from its rAF measure
// loop) — booting it is not what these tests are for. app.js's own
// mode-switch wiring is.
const FAKE_EDITOR_URL = 'fake-editor:main';

const FAKE_EDITOR_SOURCE = `
export function createEditor(host, { doc, onChange, onSave, onToggleMode }) {
  let content = doc || '';
  let editing = false;
  host.dataset.fakeEditor = '1';
  return {
    getContent: () => content,
    setContent: (text) => { content = text; },
    setEdit: (value) => { editing = value; },
    focus: () => {},
    jumpToLine: () => {},
    wrap: () => {},
    insertLink: () => {},
    toggleBullet: () => {},
    toggleNumbered: () => {},
    toggleTask: () => {},
    toggleQuote: () => {},
    undo: () => {},
    redo: () => {},
    refreshBlocks: () => {},
    _isEditing: () => editing,
    _fireChange: (text) => { content = text; onChange(); },
    _fireSave: () => onSave(),
    _fireToggleMode: () => onToggleMode(),
  };
}
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('client/dist/editor.js') || specifier === './dist/editor.js') {
    return { url: FAKE_EDITOR_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === FAKE_EDITOR_URL) {
    return { format: 'module', source: FAKE_EDITOR_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
