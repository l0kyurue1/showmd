// "exactly one pane is visible" is a property of this record, not a rule every
// caller has to remember when it flips .hidden.

export const MODE_CYCLE = { read: 'edit', edit: 'source', source: 'read' };

// One overlay slot prevents Settings and Home from stacking.
// Sidebar source remains independent, so overlays preserve its tree.
export const INITIAL_VIEW = { mode: 'read', version: null, overlay: null, source: 'files' };

export function nextView(view, event) {
  switch (event.type) {
    // asking for the mode you are already in is inert, and stays inert while a
    // version is open: the diff does not close behind an unchanged mode
    case 'mode': return event.mode === view.mode ? view : { ...view, mode: event.mode, version: null, overlay: null };
    // repo travels with the version it names — a diff/restore against a repo
    // rev vs. showmd's own history is a fact about that rev, not the session
    case 'version': return { ...view, version: { rev: event.rev, repo: !!event.repo }, overlay: null };
    case 'current': return view.version === null ? view : { ...view, version: null, overlay: null };
    // Settings preserves the mode and version beneath its overlay.
    case 'settings-open': return view.overlay === 'settings' ? view : { ...view, overlay: 'settings' };
    case 'settings-close': return view.overlay === 'settings' ? { ...view, overlay: null } : view;
    // Home replaces any existing overlay instead of stacking.
    case 'launcher-open': return view.overlay === 'launcher' ? view : { ...view, overlay: 'launcher' };
    case 'launcher-close': return view.overlay === 'launcher' ? { ...view, overlay: null } : view;
    case 'source': return view.source === event.source ? view : { ...view, source: event.source };
    default: return view;
  }
}

export function visiblePane(view) {
  if (view.overlay) return view.overlay;
  if (view.version) return 'diff';
  return view.mode === 'read' ? 'doc' : 'editor';
}

export function isSettingsOpen(view) {
  return view.overlay === 'settings';
}

export function isLauncherOpen(view) {
  return view.overlay === 'launcher';
}

export function isSourceView(view) {
  return view.source !== 'files';
}

export function isVersionOpen(view) {
  return view.version !== null;
}

// Hashes persist Skills/Agents across reloads; Home and Settings use paths.
export function hashFor(view) {
  if (view.source !== 'files') return `#${view.source}`;
  return '';
}

// Dispatch is the single writer for both the view record and visible panes.
export function createViewState({ panes, toolbar, sourceBtn, editBtn, readBtn, settingsFooterBtn, skillsFooterBtn, agentsFooterBtn }) {
  let view = INITIAL_VIEW;

  function commit() {
    const pane = visiblePane(view);
    for (const [name, el] of panes) el.hidden = pane !== name;
    toolbar.classList.toggle('show', pane === 'editor');
    sourceBtn.classList.toggle('on', view.mode === 'source');
    editBtn.classList.toggle('on', view.mode === 'edit');
    readBtn.classList.toggle('on', view.mode === 'read');
    settingsFooterBtn.classList.toggle('active', pane === 'settings');
    skillsFooterBtn.classList.toggle('active', view.source === 'skills');
    agentsFooterBtn.classList.toggle('active', view.source === 'agents');
    // replaceState, never push: the hash is a reload token, not a history entry
    history.replaceState(history.state, '', location.pathname + location.search + hashFor(view));
  }

  // beforeCommit prepares async pane content before the mandatory commit.
  // Dispatch stays synchronous when no hook is supplied.
  function dispatch(event, { beforeCommit } = {}) {
    const next = nextView(view, event);
    if (next === view) return view;
    view = next;
    if (!beforeCommit) {
      commit();
      return view;
    }
    return (async () => {
      try {
        await beforeCommit();
      } finally {
        commit();
      }
      return view;
    })();
  }

  return {
    get view() { return view; },
    dispatch,
  };
}
