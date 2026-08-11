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
