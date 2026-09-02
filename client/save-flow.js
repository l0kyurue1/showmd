export const SAVE_DEBOUNCE_MS = 800;

// browsers require window as `this` on the native timers ("Illegal invocation"),
// so the defaults must wrap, not reference them
export function createSaveFlow({ put, read, onState, delay = SAVE_DEBOUNCE_MS, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) } }) {
  let timer = null;
  const flow = {
    dirty: false,
    savedContent: '',
    pendingExternal: null,
    inflight: [],
    attached: true,

    setDirty(d) {
      flow.dirty = d;
      if (d) onState('saving', 'Saving…', '');
      else onState('saved', 'Saved', '');
    },

    isDirty() {
      return flow.dirty;
    },

    matchesSaved(text) {
      return text === flow.savedContent;
    },

    saved() {
      return flow.savedContent;
    },

    // content the server already has (a fresh load, an external edit, a kept
    // banner): the saved copy moves, nothing is written back
    adopt(text) {
      flow.savedContent = text;
      flow.attached = true;
    },

    // a load failed: there is no server baseline for the open document, so
    // schedule()/flush() must not turn the rendered placeholder into a write
    detach() {
      flow.attached = false;
      flow.dirty = false;
      timers.clear(timer);
      onState('error', 'Not saved', 'load failed — nothing to save');
    },

    // Stage external changes while dirty until the user chooses a resolution.
    stageExternal(text) {
      flow.pendingExternal = text;
    },

    // Reload adopts staged text; keep lets the pending autosave overwrite it.
    // External edits cannot be staged while detached.
    resolveExternal(action) {
      const text = flow.pendingExternal;
      if (action === 'reload' && text != null) flow.adopt(text);
      flow.pendingExternal = null;
      return text;
    },

    // Reject failed refetches before they can replace saved or staged text.
    decideExternalUpdate({ ok, text, dirty }) {
      if (!ok) return { action: 'error', text: null };
      if (text === flow.savedContent || flow.inflight.includes(text)) return { action: 'ignore', text: null };
      return { action: dirty ? 'stage' : 'adopt', text };
    },

    // Flush on hide/pagehide; async requests can still be interrupted.
    bindUnloadFlush(doc, win) {
      const onHide = () => (flow.dirty ? flow.flush() : undefined);
      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'hidden') onHide();
      });
      win.addEventListener('pagehide', onHide);
    },

    schedule() {
      if (!flow.attached) return;
      flow.setDirty(true);
      timers.clear(timer);
      timer = timers.set(() => flow.flush(), delay);
    },

    async write(text) {
      flow.inflight.push(text);
      try {
        await put(text);
        flow.savedContent = text;
      } finally {
        flow.inflight.splice(flow.inflight.indexOf(text), 1);
      }
    },

    // Detached or empty reads cannot save; unchanged buffers skip the request.
    async flush() {
      timers.clear(timer);
      if (!flow.attached) return;
      try {
        const text = read();
        if (text == null) return;
        if (text === flow.savedContent) { flow.setDirty(false); return; }
        await flow.write(text);
        flow.setDirty(false);
      } catch (err) {
        flow.dirty = true;
        onState('error', 'Save failed', 'save failed — ' + err.message);
      }
    },
  };
  return flow;
}
