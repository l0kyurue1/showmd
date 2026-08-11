import * as api from './api.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same-origin polls verify status; opaque cross-origin responses verify reachability.
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

// Share one replacement poll across every tab handling the restart broadcast.
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
