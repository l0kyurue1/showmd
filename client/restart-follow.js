import * as api from './api.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// same-origin: a plain fetch can read the response, so success means "up".
// cross-origin (port changed): the browser still blocks reading the response
// body, but a resolved no-cors fetch (even an opaque one) still proves the
// port is accepting connections — good enough for "is it back yet".
export async function pollUntilUp(url, sameOrigin, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    await wait(200);
    try {
      if (sameOrigin) {
        const res = await api.ping(url, { cache: 'no-store' });
        if (res.ok) return true;
      } else {
        await api.ping(url, { mode: 'no-cors', cache: 'no-store' });
        return true;
      }
    } catch {}
  }
  return false;
}

function currentPort() {
  if (window.location.port) return Number(window.location.port);
  return window.location.protocol === 'https:' ? 443 : 80;
}

let inFlight = null;

// the tab that clicked Restart and every other tab (via the server's
// broadcast) call this for the same restart; sharing one poll loop avoids
// two overlapping fetch loops racing against the same replacement origin
export function followRestart(port, target, attempts = 100) {
  if (inFlight) return inFlight;
  const samePort = Number(port) === currentPort();
  inFlight = (async () => {
    if (samePort) return { ok: await pollUntilUp('/api/settings', true, attempts), samePort: true };
    const newOrigin = `${window.location.protocol}//${window.location.hostname}:${port}`;
    const ok = await pollUntilUp(`${newOrigin}/api/settings`, false, attempts);
    if (ok) window.location.href = `${newOrigin}${target.pathname}${target.search}${target.hash}`;
    return { ok, samePort: false };
  })();
  inFlight.finally(() => { inFlight = null; });
  return inFlight;
}
