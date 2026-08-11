// Replace CodeMirror with an in-memory editor; jsdom cannot provide its layout.
const FAKE_EDITOR_URL = 'fake-editor:main';

const FAKE_EDITOR_SOURCE = `
export function createEditor(host, { doc, onChange, onSave, onToggleMode }) {
  let content = doc || '';
  let editing = false;
  host.dataset.fakeEditor = '1';
  const api = {
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
  // exposed on the host so tests can reach the instance app.js keeps in its
  // own module-scoped cmEditor without a second export path
  host.fakeEditor = api;
  return api;
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
