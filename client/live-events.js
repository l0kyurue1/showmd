export function createServerConnection({ EventSource, followRestart, location, report, lostHint, onReconnected, onEvent }) {
  let serverGone = false;

  function connect() {
    const es = new EventSource('/api/events');
    es.onopen = () => {
      if (!serverGone) return;
      serverGone = false;
      onReconnected();
    };
    es.onerror = () => {
      if (serverGone) return;
      serverGone = true;
      report('error', 'Connection lost', lostHint);
    };
    es.onmessage = async (e) => {
      const data = JSON.parse(e.data);
      // broadcast before the process exits for a restart; carries no rootKey,
      // so it skips the per-root filter in onEvent and reaches every tab
      if (data.event === 'server-restarting') {
        report('saving', 'Restarting…', 'waiting for showmd to come back');
        followRestart(data.port, {
          pathname: location.pathname, search: location.search, hash: location.hash,
        }).then((result) => {
          if (!result.ok) {
            report('error', 'Connection lost', lostHint);
          } else if (result.samePort) {
            serverGone = false;
            onReconnected();
          }
        });
        return;
      }
      await onEvent(data);
    };
  }

  return { connect };
}
