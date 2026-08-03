// "exactly one pane is visible" is a property of this record, not a rule every
// caller has to remember when it flips .hidden.

export const MODE_CYCLE = { read: 'edit', edit: 'source', source: 'read' };

// overlay is one slot, not a boolean per screen: Settings and Home both cover
// whatever is showing and only ever one at a time, so the pair that used to be
// able to set each other is now unrepresentable.
// source names which tree the sidebar lists, and is orthogonal to the pane —
// the skills tree with Settings open is a reachable state.
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
    // Settings overlays whatever is showing, like the Version View overlays a
    // mode: mode and version are left untouched underneath, so closing it
    // restores exactly what was there before.
    case 'settings-open': return view.overlay === 'settings' ? view : { ...view, overlay: 'settings' };
    case 'settings-close': return view.overlay === 'settings' ? { ...view, overlay: null } : view;
    // Home covers everything, Settings included: it is the one screen that is
    // not "about" the open file. One slot means opening it closes Settings
    // rather than stacking on it, which is what every caller already does.
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

// the view's serialization format, never an input to it: a hash survives reload
// without needing a server route, and leaves the file in the pathname for the
// view to fall back to on close
export function hashFor(view) {
  if (view.overlay === 'settings') return '#settings';
  if (view.overlay === 'launcher') return '#home';
  if (view.source !== 'files') return `#${view.source}`;
  return '';
}

// the single writer of the View State: every transition is a dispatch, and a
// dispatch that changes the record always commits it to these panes in the
// same call — the two can no longer drift apart, which was the bug class this
// module replaces (a setter with no forced follow-up commit).
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
    history.replaceState(history.state, '', location.pathname + hashFor(view));
  }

  // beforeCommit lets a caller finish preparing what the new pane will show
  // (e.g. loading a diff body) before it becomes visible: the record updates
  // first, then beforeCommit runs, then commit() always runs after — a caller
  // can prepare content but can never skip the commit. Only a beforeCommit
  // call makes dispatch return a promise; every other dispatch stays sync.
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
