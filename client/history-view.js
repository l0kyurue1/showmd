import { isVersionOpen } from './view-state.js';

export function relTime(ts, now = Date.now()) {
  const mins = Math.floor(Math.max(0, now - ts * 1000) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

export function sourceLabel(source) {
  if (source === 'external') return '✦ agent';
  if (source === 'restore') return 'restored';
  return 'you';
}

// a repo commit carries its own subject and shows the short rev beside the age;
// a showmd save has no subject, so the short rev becomes the title instead
export function timelineEntries(history, currentRev, now = Date.now()) {
  return history.map((v) => {
    const short = v.rev.slice(0, 7);
    return {
      version: v,
      repo: !!v.repo,
      current: v.rev === currentRev,
      title: v.repo ? v.subject : `${short} · ${sourceLabel(v.source)}`,
      age: v.repo ? `${relTime(v.ts, now)} · ${short}` : relTime(v.ts, now),
      adds: v.adds,
      dels: v.dels,
    };
  });
}

// everything before the first hunk header is the file header, which the diff
// pane never shows; a blank context line still needs a space to keep its height
export function diffRows(text) {
  const rows = [];
  let started = false;
  for (const line of text.split('\n')) {
    if (!started) {
      if (!line.startsWith('@@')) continue;
      started = true;
    }
    const kind = line.startsWith('@@') ? 'hunk'
      : line.startsWith('+') ? 'add'
        : line.startsWith('-') ? 'del' : 'ctx';
    rows.push({ kind, text: line || ' ' });
  }
  return rows;
}

export function createHistoryView({ panelBtn, panel, verList, restoreBtn, diffTime, diffBody, api, getFile, viewState }) {
  let fileHistory = [];
  let historyLoadFailed = false;
  let historyGlide = null;
  verList.addEventListener('mouseleave', () => { if (historyGlide) historyGlide.style.opacity = '0'; });

  async function probe() {
    if (!getFile()) return;
    try {
      const res = await api.history(getFile());
      if (res.status === 503) panelBtn.hidden = true;
    } catch {
      panelBtn.hidden = true;
    }
  }

  async function load() {
    if (!getFile()) return;
    const res = await api.history(getFile());
    if (res.status === 503) {
      panelBtn.hidden = true;
      panel.hidden = true;
      return;
    }
    historyLoadFailed = !res.ok;
    fileHistory = historyLoadFailed ? [] : await res.json();
    render();
  }

  function render() {
    const view = viewState.view;
    verList.innerHTML = '';
    historyGlide = null;
    if (historyLoadFailed) {
      const err = document.createElement('div');
      err.className = 'hist-empty hist-error';
      err.textContent = "Couldn't load history";
      verList.appendChild(err);
      restoreBtn.disabled = true;
      return;
    }
    if (fileHistory.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hist-empty';
      empty.textContent = 'No versions yet';
      verList.appendChild(empty);
      restoreBtn.disabled = true;
      return;
    }
    const glide = document.createElement('div');
    glide.className = 'glide';
    verList.appendChild(glide);
    historyGlide = glide;
    for (const entry of timelineEntries(fileHistory, isVersionOpen(view) ? view.version.rev : null)) {
      const row = document.createElement('div');
      row.className = 'ver' + (entry.repo ? ' commit' : '') + (entry.current ? ' on' : '');
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = entry.title;
      const m = document.createElement('div');
      m.className = 'm';
      const age = document.createElement('span');
      age.textContent = entry.age;
      m.appendChild(age);
      if (entry.adds || entry.dels) {
        const chips = document.createElement('span');
        chips.className = 'chips';
        if (entry.adds) {
          const a = document.createElement('span');
          a.className = 'a';
          a.textContent = '+' + entry.adds;
          chips.appendChild(a);
        }
        if (entry.dels) {
          const d = document.createElement('span');
          d.className = 'd';
          d.textContent = '−' + entry.dels;
          chips.appendChild(d);
        }
        m.appendChild(chips);
      }
      row.appendChild(t);
      row.appendChild(m);
      row.addEventListener('click', () => showVersion(entry.version));
      row.addEventListener('mouseenter', () => {
        glide.style.opacity = row.classList.contains('on') ? '0' : '1';
        glide.style.height = row.offsetHeight + 'px';
        glide.style.transform = `translateY(${row.offsetTop}px)`;
      });
      verList.appendChild(row);
    }
    restoreBtn.disabled = !isVersionOpen(view);
  }

  function renderDiff(text) {
    diffBody.innerHTML = '';
    for (const { kind, text: line } of diffRows(text)) {
      const row = document.createElement('div');
      row.className = 'dl ' + kind;
      row.textContent = line;
      diffBody.appendChild(row);
    }
  }

  // beforeCommit: the diff pane only becomes visible once diffBody already
  // holds the new diff, so switching versions never flashes the old one.
  // A failed diff fetch must never render as an empty diff (that reads as
  // "no changes"), so any non-ok response backs out of the Version View
  // instead; a 503 additionally means History itself is unavailable, so it
  // gets retracted from the UI the same way the list load already does.
  async function showVersion(v) {
    await viewState.dispatch({ type: 'version', rev: v.rev, repo: v.repo }, {
      beforeCommit: async () => {
        render();
        const res = await api.diff(getFile(), v.rev, v.repo);
        if (res.status === 503) {
          panelBtn.hidden = true;
          panel.hidden = true;
        }
        if (!res.ok) {
          viewState.dispatch({ type: 'current' });
          render();
          return;
        }
        renderDiff(await res.text());
        diffTime.textContent = relTime(v.ts);
      },
    });
  }

  function backToCurrent() {
    viewState.dispatch({ type: 'current' });
    render();
  }

  return { probe, load, showVersion, backToCurrent };
}
