import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function openSSE(url, { until = () => false, timeoutMs = 8000, graceMs = 0 } = {}) {
  const controller = new AbortController();
  const collected = [];
  let resolveReady;
  let rejectReady;
  let readySettled = false;
  let graceTimer = null;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const settleReady = (err) => {
    if (readySettled) return;
    readySettled = true;
    if (err) rejectReady(err);
    else resolveReady();
  };

  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events = (async () => {
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`SSE connection failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.split('\n').some((line) => line === ': connected')) settleReady();
          const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice('data: '.length));
          collected.push(event);
          if (!until(event, collected)) continue;
          if (graceMs && !graceTimer) graceTimer = setTimeout(() => controller.abort(), graceMs);
          else if (!graceMs) controller.abort();
        }
      }
      if (!readySettled) throw new Error('SSE stream closed before the connected signal');
    } catch (err) {
      if (!readySettled) settleReady(err);
      if (err?.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(timeout);
      clearTimeout(graceTimer);
    }
    return collected;
  })();

  return {
    ready,
    events,
    close: () => controller.abort(),
  };
}

export async function awaitWatcherLive(base, dirs, timeoutMs = 8000) {
  const files = dirs.map((dir, i) => path.join(dir, `watch-probe-${i}.md`));
  const names = files.map((file) => path.basename(file));
  const unseen = new Set(names);
  const unlinked = new Set(names);
  const changes = new Map();
  let live;
  const liveSeen = new Promise((resolve) => { live = resolve; });
  const probe = openSSE(`${base}/api/events`, {
    until: (event) => {
      if (event.event === 'unlink') {
        if (unseen.size === 0) unlinked.delete(event.path);
      } else if (names.includes(event.path)) {
        unseen.delete(event.path);
        const seen = changes.get(event.path) || { rootKey: event.rootKey, count: 0 };
        seen.count += 1;
        changes.set(event.path, seen);
        if (unseen.size === 0) live();
      }
      return unlinked.size === 0;
    },
    timeoutMs,
  });
  await probe.ready;
  // Interval must exceed the server's 100ms debounce plus chokidar's 50ms throttle.
  const timer = setInterval(() => files.forEach((file) => writeFileSync(file, String(Date.now()))), 300);
  try {
    await Promise.race([liveSeen, probe.events]);
    clearInterval(timer);
    const deadline = Date.now() + timeoutMs;
    for (const [name, { rootKey, count }] of changes) {
      // Each change event queues one history commit; deleting the file before it lands fails the commit.
      const url = `${base}/api/roots/${rootKey}/history?path=${encodeURIComponent(name)}`;
      for (;;) {
        const entries = await (await fetch(url)).json().catch(() => null);
        if (!Array.isArray(entries) || entries.length >= count || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  } finally {
    clearInterval(timer);
    files.forEach((file) => rmSync(file, { force: true }));
  }
  await probe.events;
  if (unseen.size || unlinked.size) throw new Error('file watcher never reported the probe write and delete');
}
