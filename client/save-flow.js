export const SAVE_DEBOUNCE_MS = 800;

// browsers require window as `this` on the native timers ("Illegal invocation"),
// so the defaults must wrap, not reference them
export function createSaveFlow({ put, read, onState, delay = SAVE_DEBOUNCE_MS, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) } }) {
  let timer = null;
  const flow = {
    dirty: false,
    savedContent: '',
    pendingExternal: null,
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

    // an SSE change to the open file arrived while the buffer is dirty: it
    // can't be adopted yet without clobbering unsaved edits, so it waits here
    // for the user's banner choice
    stageExternal(text) {
      flow.pendingExternal = text;
    },

    // 'reload' adopts the staged text as saved (caller still repaints the
    // doc/editor with the returned text); 'keep' discards it and relies on
    // the dirty->autosave invariant: the pending debounced save is what
    // overwrites disk with the kept buffer. That invariant needs an attached
    // baseline, so it does not apply while detached — but nothing can stage
    // an external edit while detached either, so 'keep' is unreachable there.
    // Either way clears the stage.
    resolveExternal(action) {
      const text = flow.pendingExternal;
      if (action === 'reload' && text != null) flow.adopt(text);
      flow.pendingExternal = null;
      return text;
    },

    // a failed refetch of the open file must never be treated as content: 'ok'
    // false short-circuits before the saved-copy comparison, so a transient
    // 5xx can't blank the baseline or a dirty buffer's staged text
    decideExternalUpdate({ ok, text, dirty }) {
      if (!ok) return { action: 'error', text: null };
      if (text === flow.savedContent) return { action: 'ignore', text: null };
      return { action: dirty ? 'stage' : 'adopt', text };
    },

    // beforeunload is unreliable and blocks the browser, so flushing rides the
    // events that actually fire when a tab is hidden or torn down; flush() is
    // still async and can be cut off mid-request, so this narrows the loss
    // window, it doesn't close it
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
      await put(text);
      flow.savedContent = text;
    },

    // read() answers null while there is nothing to save from, and an unchanged
    // buffer settles the chip without spending a request; a detached document
    // (failed load) has no baseline to write back to, regardless of read()
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
