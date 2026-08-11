'use strict';
const path = require('node:path');
const { createDocumentStore, isMarkdownFile } = require('./documents.js');
const { identityPath } = require('./root-identity.js');

const FILES_RELATIVE = Object.freeze({ addressing: 'relative' });

function defaultCreateWatchers({ root, store, onDocument, onSkillsChange, onError }) {
  const chokidar = require('chokidar');
  const watcher = chokidar.watch(root.dir, {
    ignored: (filePath) => store.ignorePath(root.dir, filePath),
    ignoreInitial: true,
  });
  watcher.on('all', onDocument);
  watcher.on('error', (err) => onError(err, root.dir));

  // Skill directories are excluded from the document watcher by design. This
  // second watcher owns only cache invalidation and is closed with the runtime.
  const skillPaths = ['.agents/skills', '.claude/skills'].map((rel) => path.join(root.dir, rel));
  const skillsWatcher = chokidar.watch(skillPaths, { ignoreInitial: false });
  skillsWatcher.on('all', onSkillsChange);
  skillsWatcher.on('error', (err) => onError(err, path.join(root.dir, '.*/skills')));
  return [watcher, skillsWatcher];
}

/**
 * Own the mutable resources for exactly one canonical Root. The manager may
 * remove registry visibility only after close() resolves.
 * @param {import('../types/showmd').Root} root
 * @param {object} [options]
 */
function createRootRuntime(root, options = {}) {
  const makeStore = options.createStore || createDocumentStore;
  const store = makeStore(
    [{ key: null, dir: root.dir, label: null }],
    FILES_RELATIVE,
  );
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
  const debounceMs = options.debounceMs ?? 100;
  const onChange = options.onChange || (() => {});
  const onRootRemoved = options.onRootRemoved || (() => {});
  const onSkillsChange = options.onSkillsChange || (() => {
    require('./skills.js').invalidate();
  });
  const onError = options.onError || ((err, dir) => {
    console.error(`showmd: stopped watching ${dir}: ${err.message}`);
  });
  const makeWatchers = options.createWatchers || defaultCreateWatchers;
  const pendingTimers = new Map();
  let closing = false;
  let closePromise = null;

  function onDocument(event, filePath) {
    if (closing) return;
    if (event === 'unlinkDir' && identityPath(filePath) === identityPath(root.dir)) {
      onRootRemoved(root);
      return;
    }
    if (!isMarkdownFile(filePath)) return;
    const id = store.idFor(root, filePath);
    const previous = pendingTimers.get(id);
    if (previous !== undefined) clearTimer(previous);
    const timer = setTimer(async () => {
      pendingTimers.delete(id);
      if (closing) return;
      try {
        await onChange({ root, path: id, event });
        if (closing) return;
        await store.recordIfExternal(id);
      } catch (err) {
        onError(err, root.dir);
      }
    }, debounceMs);
    pendingTimers.set(id, timer);
  }

  function handleSkillsChange(...args) {
    if (!closing) return onSkillsChange(...args);
  }

  const watchers = makeWatchers({ root, store, onDocument, onSkillsChange: handleSkillsChange, onError }) || [];

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    store.beginClose();
    for (const timer of pendingTimers.values()) clearTimer(timer);
    pendingTimers.clear();

    closePromise = Promise.all([
      ...watchers.map((watcher) => Promise.resolve().then(() => watcher.close())),
      store.drain(),
    ]).then(() => undefined);
    return closePromise;
  }

  return { root, store, close };
}

module.exports = { createRootRuntime };
