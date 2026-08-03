import { buildUpdateCta } from './update-cta.js';

export const FONT_PRESETS = {
  default: { label: 'Default', family: 'var(--sans)' },
  serif: { label: 'Serif', family: 'var(--serif)' },
  mono: { label: 'Monospace', family: 'var(--mono)' },
};

const UPDATE_DESC = 'Look for new releases when showmd starts.';
const REGISTER_DESC = 'Add ShowMD to the Open With menu for markdown files.';
const REGISTER_INSTALL_FIRST_DESC = 'Install the app above first.';
const REGISTER_NOT_DEFAULT_DESC = "In Finder's Open With menu. Another app still opens .md files.";
const REGISTER_DEFAULT_DESC = 'ShowMD opens .md files.';
const INSTALL_DESC = 'Open showmd without the terminal.';
const STALE_MISSING_DESC = 'Points at a showmd that is no longer installed.';
const REPO_URL = 'https://github.com/l0kyurue1/showmd';
const ISSUES_URL = 'https://github.com/l0kyurue1/showmd/issues';

export const SETTINGS_GROUPS = [
  {
    title: 'Appearance',
    rows: [
      { key: 'colorMode', label: 'Color mode', desc: 'Match your system, or force light/dark.', control: 'select', options: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] },
      { key: 'fontPreset', label: 'Font', desc: 'Reading and editing font.', control: 'select', options: Object.entries(FONT_PRESETS).map(([k, v]) => [k, v.label]) },
      { key: 'fontSize', label: 'Font size', desc: 'Base text size, in pixels.', control: 'number', min: 10, max: 32, step: 0.5 },
    ],
  },
  {
    title: 'Behavior',
    rows: [
      { key: 'openMode', label: 'Default view', desc: 'Open documents in Read or Edit mode.', control: 'select', options: [['read', 'Read'], ['edit', 'Edit']] },
      { key: 'updateCheck', label: 'Check for updates', desc: UPDATE_DESC, control: 'checkbox' },
      { key: 'installApp', label: 'Install app', desc: INSTALL_DESC, control: 'action', buttonLabel: 'Install' },
      { key: 'registerMarkdown', label: 'Default app for .md files', desc: REGISTER_DESC, control: 'action', buttonLabel: 'Register' },
    ],
  },
  {
    title: 'Server',
    badge: 'Restart required',
    rows: [
      { key: 'browser', label: 'Browser', desc: 'Browser used to open showmd.', control: 'select', options: [['default', 'System default']] },
      { key: 'port', label: 'Port', desc: 'Base port for the local server.', control: 'number', min: 1024, max: 65535, step: 1 },
    ],
  },
  {
    title: 'Maintenance',
    rows: [
      { key: 'prune', label: 'This folder\'s history', desc: 'Remove saved edit history for this folder.', control: 'action', buttonLabel: 'Prune…' },
      { key: 'pruneAll', label: 'All saved histories', desc: 'Remove saved edit history for every folder you\'ve opened in showmd.', control: 'action', buttonLabel: 'Prune all…', danger: true },
      { key: 'resetAll', label: 'Reset all settings', desc: 'Restore every setting on this page to its default.', control: 'action', buttonLabel: 'Reset all' },
    ],
  },
  {
    title: 'About',
    rows: [
      { key: 'repo', label: 'About showmd', desc: 'Read and edit markdown in your browser.', control: 'link', href: REPO_URL, linkLabel: 'GitHub', ariaLabel: 'showmd on GitHub' },
      { key: 'issues', label: 'Report an issue', desc: 'Bugs and feature requests go to GitHub.', control: 'link', href: ISSUES_URL, linkLabel: 'Open', ariaLabel: 'Report an issue on GitHub' },
    ],
  },
];

export function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function rowByKey(key) {
  return SETTINGS_GROUPS.flatMap((g) => g.rows).find((r) => r.key === key);
}

// mutates the SETTINGS_GROUPS row configs with whatever the server just
// reported, and reports whether a restart is needed — shared by the full
// rebuild (open) and the in-place patch (refreshDerived) so the two never
// drift on what counts as "derived"
export function applyDerivedValues(values) {
  if (values.browsers) {
    const browserRow = rowByKey('browser');
    if (browserRow) browserRow.options = values.browsers.map((name) => [name, name === 'default' ? 'System default' : name]);
  }
  const updateRow = rowByKey('updateCheck');
  if (updateRow) {
    const version = `showmd ${values.showmdVersion}`;
    updateRow.desc = !values.updateCheck ? `${version} · checks are off`
      : values.updateAvailable ? `${version} · ${values.latestVersion} available`
      : values.checkFailed ? `${version} · last check failed`
      : `${version} · up to date`;
  }
  const pruneRow = rowByKey('prune');
  if (pruneRow) {
    pruneRow.label = values.historySizeBytes == null ? "This folder's history" : `This folder's history · ${formatBytes(values.historySizeBytes)}`;
    pruneRow.disabled = values.historySizeBytes == null;
  }
  const pruneAllRow = rowByKey('pruneAll');
  if (pruneAllRow) {
    pruneAllRow.label = values.historyTotalBytes == null ? 'All saved histories' : `All saved histories · ${formatBytes(values.historyTotalBytes)}`;
  }
  const installRow = rowByKey('installApp');
  if (installRow) {
    installRow.installed = !!values.appInstalled;
    installRow.stale = !!values.appStale;
    installRow.staleReason = values.appStaleReason || null;
    installRow.appPath = values.appPath;
    if (!installRow.installed) {
      installRow.desc = INSTALL_DESC;
    } else if (installRow.stale && installRow.staleReason === 'version') {
      installRow.desc = `App ${values.appVersion} · ${values.showmdVersion} available`;
    } else if (installRow.stale) {
      installRow.desc = STALE_MISSING_DESC;
    } else {
      installRow.desc = `App ${values.appVersion}`;
    }
  }
  const registerRow = rowByKey('registerMarkdown');
  if (registerRow) {
    registerRow.hidden = values.platform !== 'darwin';
    const installed = !!values.appInstalled;
    const registered = !!values.appMdRegistered;
    // registering adds ShowMD to Finder's Open With menu; becoming the actual
    // default handler is a choice macOS reserves for the user via Get Info
    const isDefault = !!values.mdHandlerDefault;
    registerRow.disabled = !installed || (registered && isDefault);
    registerRow.isDefault = isDefault;
    registerRow.desc = !installed ? REGISTER_INSTALL_FIRST_DESC
      : !registered ? REGISTER_DESC
      : isDefault ? REGISTER_DEFAULT_DESC
      : REGISTER_NOT_DEFAULT_DESC;
    registerRow.buttonLabel = !installed || !registered ? 'Register'
      : isDefault ? 'Registered'
      : 'Set as default';
  }
  return !!values.effective && (values.port !== values.effective.port || values.browser !== values.effective.browser);
}

// a value the server reports but this build has no label for (a browser that
// vanished, a mode from a newer version) shows as itself rather than blank
export function optionLabel(options, value) {
  const found = options.find(([v]) => v === value);
  return found ? found[1] : value;
}

// no wrap-around, and a menu opened with nothing focused (idx -1) lands on the
// first option from either direction
export function nextOptionIndex(key, idx, count) {
  return key === 'ArrowDown' ? Math.min(count - 1, idx + 1) : Math.max(0, idx - 1);
}

const RESET_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 13l-4 -4l4 -4"/><path d="M5 9h7a4 4 0 1 1 0 8h-1"/></svg>';
const EXTERNAL_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"/><path d="M11 13l9 -9"/><path d="M15 4h5v5"/></svg>';
const REFRESH_SVG ='<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>';
const COPY_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8m0 2a2 2 0 0 1 2 -2h9a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-9a2 2 0 0 1 -2 -2z"/><path d="M16 8v-2a2 2 0 0 0 -2 -2h-9a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h2"/></svg>';

const UPDATE_CTA_DISMISS_KEY = 'showmd-update-cta-dismissed-version';

export function createSettingsView({
  root, ctaEl, api, fetchSettings, saveSetting,
  chevronSvg, positionTip,
  setTheme, applyFontPreset, applyFontSize,
  returnsHome, onBack,
}) {
  let justUpdatedVersion = null;
  let restarting = false;
  // set while any settings custom-select menu is open, cleared on close; lets
  // open() close a still-open menu before replaceChildren() orphans its
  // document listeners (e.g. an SSE-triggered rebuild mid-open)
  let closeOpenMenu = null;

  async function installApp(btn, statusEl) {
    btn.disabled = true;
    statusEl.textContent = 'Installing…';
    try {
      const res = await api.installApp();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await refreshDerived();
    } catch (err) {
      statusEl.classList.add('warning');
      statusEl.textContent = `Failed: ${err.message}`;
      btn.textContent = 'Try again';
      btn.disabled = false;
    }
  }

  async function registerMarkdown(btn, statusEl) {
    btn.disabled = true;
    statusEl.textContent = 'Registering…';
    try {
      const res = await api.registerMarkdown();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      statusEl.textContent = body.opened
        ? 'Get Info opened — choose ShowMD, then Change All…'
        : 'Registered — open Get Info on a .md file, choose ShowMD, then Change All…';
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  // first modal in showmd: native <dialog> gives focus trap, Escape-to-cancel and
  // backdrop dimming for free. The dialog itself carries no padding, so its box
  // exactly matches the visible card — a click landing on `dialog` itself (not a
  // descendant) is therefore always a backdrop click.
  function confirmDialogEl(id, { title, body, confirmLabel }) {
    let dialog = document.getElementById(id);
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = id;
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `<form method="dialog" class="confirm-dialog-card">
    <div class="confirm-dialog-title">${title}</div>
    <p class="confirm-dialog-body">${body}</p>
    <div class="confirm-dialog-actions">
      <button type="submit" value="cancel" autofocus>Cancel</button>
      <button type="submit" value="confirm" class="confirm-dialog-danger">${confirmLabel}</button>
    </div>
  </form>`;
    document.body.appendChild(dialog);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close('cancel'); });
    return dialog;
  }

  async function confirmDialog(id, opts) {
    const dialog = confirmDialogEl(id, opts);
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    });
  }

  async function runPrune(btn, statusEl, scope) {
    btn.disabled = true;
    statusEl.textContent = 'Removing…';
    try {
      const res = await api.prune(scope);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshDerived();
    } catch {
      statusEl.textContent = 'Failed to remove history.';
      btn.disabled = false;
    }
  }

  async function confirmPrune(btn, statusEl) {
    const choice = await confirmDialog('prune-dialog', {
      title: 'Remove saved history?',
      body: "This deletes showmd's local edit history for this folder. Anything already committed to this folder's own git repository is unaffected. History restarts from the current state.",
      confirmLabel: 'Remove history',
    });
    if (choice === 'confirm') await runPrune(btn, statusEl, 'root');
  }

  async function confirmPruneAll(btn, statusEl) {
    const choice = await confirmDialog('prune-all-dialog', {
      title: 'Remove ALL saved history?',
      body: "This deletes showmd's local edit history for every folder you've opened, not just this one. Anything already committed to any folder's own git repository is unaffected.",
      confirmLabel: 'Remove all history',
    });
    if (choice === 'confirm') await runPrune(btn, statusEl, 'all');
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // same-origin: a plain fetch can read the response, so success means "up".
  // cross-origin (port changed): the browser still blocks reading the response
  // body, but a resolved no-cors fetch (even an opaque one) still proves the
  // port is accepting connections — good enough for "is it back yet".
  async function pollUntilUp(url, sameOrigin) {
    for (let i = 0; i < 100; i++) {
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

  async function restartServer(chip, values) {
    if (restarting) return;
    restarting = true;
    const label = chip.querySelector('span');
    if (label) label.textContent = 'Restarting…';
    chip.disabled = true;
    try {
      const res = await api.restart();
      if (!res.ok) throw new Error();
    } catch {
      if (label) label.textContent = 'Restart failed';
      chip.disabled = false;
      restarting = false;
      return;
    }
    const samePort = values.port === values.effective.port;
    if (samePort) {
      await pollUntilUp('/api/settings', true);
      restarting = false;
      await open();
    } else {
      const newOrigin = `http://127.0.0.1:${values.port}`;
      await pollUntilUp(`${newOrigin}/api/settings`, false);
      window.location.href = newOrigin + window.location.pathname + window.location.search;
    }
  }

  function renderCta(values) {
    const vm = buildUpdateCta(values, {
      dismissedVersion: localStorage.getItem(UPDATE_CTA_DISMISS_KEY),
      justUpdatedVersion,
    });
    if (!vm) { ctaEl.hidden = true; ctaEl.replaceChildren(); return; }
    ctaEl.hidden = false;
    ctaEl.className = `update-cta update-cta-${vm.state}`;
    ctaEl.innerHTML = `
    <div class="update-cta-head">
      <div class="update-cta-title">${vm.title}</div>
      ${vm.showDismiss ? `<button type="button" class="update-cta-dismiss" aria-label="Dismiss until next version">×</button>` : ''}
    </div>
    ${vm.command ? `<div class="update-cta-command"><code>${vm.command}</code><button type="button" class="update-cta-copy" aria-label="Copy command">${COPY_SVG}</button></div>` : ''}
    ${vm.subline ? `<div class="update-cta-subline">${vm.subline}</div>` : ''}
    ${vm.buttonLabel ? `<button type="button" class="update-cta-btn update-cta-btn-${vm.buttonWeight}">${vm.buttonLabel}</button>` : ''}`;
    ctaEl.querySelector('.update-cta-dismiss')?.addEventListener('click', () => {
      localStorage.setItem(UPDATE_CTA_DISMISS_KEY, vm.dismissVersion);
      renderCta(values);
    });
    ctaEl.querySelector('.update-cta-copy')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(vm.command).catch(() => {});
    });
    ctaEl.querySelector('.update-cta-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await api.installApp();
        if (!res.ok) throw new Error();
        justUpdatedVersion = values.showmdVersion;
        renderCta(values);
        setTimeout(() => {
          justUpdatedVersion = null;
          ctaEl.classList.add('update-cta-collapsing');
          setTimeout(() => fetchSettings().then(renderCta), 300);
        }, 3000);
      } catch {
        btn.disabled = false;
      }
    });
  }

  // theme/font settings apply live outside the settings page too (the ?lab panel,
  // the read/edit doc), so those two keys stay routed through setTheme/applyFont*
  // instead of writing --doc-font/--doc-size only while settings is open
  function applyLiveEffect(key, value) {
    if (key === 'fontPreset') applyFontPreset(value);
    else if (key === 'fontSize') applyFontSize(value);
  }

  // every control change and every per-row reset ends the same way: persist,
  // reapply the live effect if there is one, patch the rows that can have
  // changed (restart chip, history sizes, install/register state) in place —
  // a full rebuild here would recreate every control on the page and drop focus
  async function saveAndRefresh(row, value) {
    if (row.key === 'colorMode') setTheme(value);
    else {
      applyLiveEffect(row.key, value);
      await saveSetting(row.key, value);
    }
    await refreshDerived(row, value);
  }

  function buildFontPreview() {
    const el = document.createElement('div');
    el.className = 'settings-preview';
    el.innerHTML = '<div class="settings-preview-heading">The quick brown fox</div><div class="settings-preview-body">jumps over the lazy dog — this line follows the font and size above.</div>';
    return el;
  }

  // one place owns open/close, outside-click and Escape for every select-backed
  // settings row
  function buildCustomSelect(row, value, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'settings-select';
    wrap.innerHTML = `
    <button type="button" class="settings-select-btn">
      <span class="settings-select-value"></span>
      <span class="chevron settings-select-chevron">${chevronSvg}</span>
    </button>
    <div class="settings-select-menu" hidden></div>`;
    const btn = wrap.querySelector('.settings-select-btn');
    const valueEl = wrap.querySelector('.settings-select-value');
    const chevron = wrap.querySelector('.settings-select-chevron');
    const menu = wrap.querySelector('.settings-select-menu');

    function setValue(v) {
      wrap.dataset.value = v;
      valueEl.textContent = optionLabel(row.options, v);
    }
    function renderOptions() {
      menu.replaceChildren();
      for (const [v, label] of row.options) {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'settings-select-option';
        if (v === wrap.dataset.value) opt.classList.add('selected');
        opt.textContent = label;
        opt.addEventListener('click', () => {
          setValue(v);
          closeMenu();
          btn.focus();
          onChange(v);
        });
        menu.appendChild(opt);
      }
    }
    function onDocClick(e) { if (!wrap.contains(e.target)) closeMenu(); }
    function onKeydown(e) {
      const opts = [...menu.querySelectorAll('.settings-select-option')];
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); btn.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        opts[nextOptionIndex(e.key, opts.indexOf(document.activeElement), opts.length)]?.focus();
      }
    }
    function openMenu() {
      closeOpenMenu?.();
      renderOptions();
      menu.hidden = false;
      chevron.classList.add('open');
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', onKeydown);
      closeOpenMenu = closeMenu;
    }
    function closeMenu() {
      menu.hidden = true;
      chevron.classList.remove('open');
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeydown);
      if (closeOpenMenu === closeMenu) closeOpenMenu = null;
    }
    btn.addEventListener('click', () => { if (menu.hidden) openMenu(); else closeMenu(); });
    btn.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && menu.hidden) {
        e.preventDefault();
        openMenu();
        (menu.querySelector('.settings-select-option.selected') || menu.querySelector('.settings-select-option'))?.focus();
      }
    });
    setValue(value);
    wrap.setValue = setValue;
    return wrap;
  }

  function buildSettingsRow(row, value, defaults) {
    const rowEl = document.createElement('div');
    rowEl.className = 'settings-row';
    rowEl.dataset.key = row.key;
    const textEl = document.createElement('div');
    textEl.className = 'settings-row-text';
    textEl.innerHTML = `<div class="settings-row-head"><div class="settings-row-label">${row.label}</div></div><div class="settings-row-desc">${row.desc}</div>`;
    const controlEl = document.createElement('div');
    controlEl.className = 'settings-row-control';
    if (row.control !== 'action' && row.control !== 'link' && defaults && row.key in defaults) {
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'settings-reset-btn';
      resetBtn.innerHTML = `${RESET_SVG}<span class="tip">Reset to default</span>`;
      resetBtn.setAttribute('aria-label', `Reset ${row.label} to default`);
      resetBtn.addEventListener('mouseenter', () => positionTip(resetBtn));
      resetBtn.addEventListener('click', () => saveAndRefresh(row, defaults[row.key]));
      rowEl.dataset.default = String(defaults[row.key]);
      resetBtn.hidden = String(value) === rowEl.dataset.default;
      textEl.querySelector('.settings-row-head').appendChild(resetBtn);
    }
    if (row.key === 'installApp') controlEl.classList.add('settings-row-control-stacked');
    if (row.control === 'select') {
      controlEl.appendChild(buildCustomSelect(row, value, (v) => saveAndRefresh(row, v)));
    } else if (row.control === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      if (row.min != null) input.min = row.min;
      if (row.max != null) input.max = row.max;
      if (row.step != null) input.step = row.step;
      input.value = value;
      input.addEventListener('change', () => saveAndRefresh(row, Number(input.value)));
      controlEl.appendChild(input);
    } else if (row.control === 'checkbox') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.addEventListener('change', () => saveAndRefresh(row, input.checked));
      controlEl.appendChild(input);
    } else if (row.control === 'link') {
      const link = document.createElement('a');
      link.className = 'settings-row-link';
      link.href = row.href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.setAttribute('aria-label', row.ariaLabel);
      link.innerHTML = `<span>${row.linkLabel}</span>${EXTERNAL_SVG}`;
      controlEl.appendChild(link);
    } else if (row.control === 'action') {
      const btn = document.createElement('button');
      btn.type = 'button';
      const statusEl = document.createElement('span');
      statusEl.className = 'settings-row-status';
      if (row.key === 'installApp' && row.installed) {
        btn.textContent = row.stale ? (row.staleReason === 'missing' ? 'Repair' : 'Update') : 'Installed';
        btn.disabled = !row.stale;
        btn.classList.toggle('primary', row.stale);
        statusEl.textContent = row.appPath || '';
      } else {
        btn.textContent = row.buttonLabel;
        btn.disabled = !!row.disabled;
      }
      if (row.danger) btn.classList.add('danger');
      controlEl.append(btn, statusEl);
      if (row.key === 'installApp') btn.addEventListener('click', () => installApp(btn, statusEl));
      else if (row.key === 'registerMarkdown') btn.addEventListener('click', () => registerMarkdown(btn, statusEl));
      else if (row.key === 'prune') btn.addEventListener('click', () => confirmPrune(btn, statusEl));
      else if (row.key === 'pruneAll') btn.addEventListener('click', () => confirmPruneAll(btn, statusEl));
      else if (row.key === 'resetAll') {
        let armed = false;
        let timer = null;
        btn.addEventListener('click', () => {
          if (!armed) {
            armed = true;
            btn.textContent = 'Sure?';
            timer = setTimeout(() => { armed = false; btn.textContent = row.buttonLabel; }, 3000);
            return;
          }
          clearTimeout(timer);
          resetAllSettings(btn, statusEl, defaults);
        });
      }
    }
    rowEl.append(textEl, controlEl);
    return rowEl;
  }

  async function resetAllSettings(btn, statusEl, defaults) {
    btn.disabled = true;
    statusEl.textContent = 'Resetting…';
    try {
      await api.putSettings(defaults);
      setTheme(defaults.colorMode, { persist: false });
      applyFontPreset(defaults.fontPreset);
      applyFontSize(defaults.fontSize);
      await open();
    } catch {
      statusEl.textContent = 'Failed to reset.';
      btn.disabled = false;
    }
  }

  function setRowControlValue(rowEl, row, value) {
    const controlEl = rowEl.querySelector('.settings-row-control');
    if (!controlEl) return;
    const resetBtn = rowEl.querySelector('.settings-reset-btn');
    if (resetBtn) resetBtn.hidden = String(value) === rowEl.dataset.default;
    if (row.control === 'select') {
      const select = controlEl.querySelector('.settings-select');
      if (select) select.setValue(value);
    } else if (row.control === 'number') {
      const input = controlEl.querySelector('input[type="number"]');
      if (input) input.value = value;
    } else if (row.control === 'checkbox') {
      const input = controlEl.querySelector('input[type="checkbox"]');
      if (input) input.checked = !!value;
    }
  }

  function patchRowText(key) {
    const row = rowByKey(key);
    const rowEl = root.querySelector(`[data-key="${key}"]`);
    if (!row || !rowEl) return;
    rowEl.hidden = !!row.hidden;
    const labelEl = rowEl.querySelector('.settings-row-label');
    if (labelEl) labelEl.textContent = row.label;
    const descEl = rowEl.querySelector('.settings-row-desc');
    if (descEl) descEl.textContent = row.desc;
    const btn = rowEl.querySelector('.settings-row-control button:not(.settings-reset-btn)');
    if (btn) {
      if (key === 'installApp' && row.installed) {
        btn.textContent = row.stale ? (row.staleReason === 'missing' ? 'Repair' : 'Update') : 'Installed';
        btn.disabled = !row.stale;
        btn.classList.toggle('primary', row.stale);
      } else {
        btn.hidden = false;
        btn.disabled = !!row.disabled;
        btn.textContent = row.buttonLabel;
      }
    }
    if (key === 'installApp') {
      const statusEl = rowEl.querySelector('.settings-row-status');
      if (statusEl) {
        statusEl.classList.remove('warning');
        if (row.installed) statusEl.textContent = row.appPath || '';
      }
    }
  }

  function patchRestartChips(restartNeeded, values) {
    for (const group of SETTINGS_GROUPS) {
      if (!group.badge) continue;
      const titleEl = root.querySelector(`[data-group-title="${group.title}"]`);
      if (!titleEl) continue;
      let chip = titleEl.querySelector('.settings-restart-chip');
      if (restartNeeded && !chip) {
        chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'badge chip settings-restart-chip';
        chip.innerHTML = `${REFRESH_SVG}<span>${group.badge}</span>`;
        chip.addEventListener('click', () => restartServer(chip, values));
        titleEl.appendChild(chip);
      } else if (!restartNeeded && chip) {
        chip.remove();
      }
    }
  }

  async function refreshDerived(row, value) {
    const values = await fetchSettings();
    const restartNeeded = applyDerivedValues(values);
    if (row) {
      const rowEl = root.querySelector(`[data-key="${row.key}"]`);
      if (rowEl) setRowControlValue(rowEl, row, value);
    }
    for (const key of ['updateCheck', 'prune', 'pruneAll', 'installApp', 'registerMarkdown']) patchRowText(key);
    patchRestartChips(restartNeeded, values);
    renderCta(values);
  }

  async function open() {
    closeOpenMenu?.();
    root.replaceChildren();
    const back = document.createElement('a');
    back.href = '#';
    back.className = 'settings-back';
    back.textContent = returnsHome() ? '← Back to Home' : '← Back';
    back.addEventListener('click', (e) => { e.preventDefault(); onBack(); });
    root.appendChild(back);
    const values = await fetchSettings();
    const restartNeeded = applyDerivedValues(values);
    renderCta(values);
    for (const group of SETTINGS_GROUPS) {
      const groupEl = document.createElement('div');
      groupEl.className = 'settings-group';
      const titleEl = document.createElement('div');
      titleEl.className = 'settings-group-title';
      titleEl.dataset.groupTitle = group.title;
      const titleText = document.createElement('span');
      titleText.textContent = group.title;
      titleEl.appendChild(titleText);
      if (group.badge && restartNeeded) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'badge chip settings-restart-chip';
        chip.innerHTML = `${REFRESH_SVG}<span>${group.badge}</span>`;
        chip.addEventListener('click', () => restartServer(chip, values));
        titleEl.appendChild(chip);
      }
      groupEl.appendChild(titleEl);
      for (const row of group.rows) {
        if (row.hidden) continue;
        groupEl.appendChild(buildSettingsRow(row, values[row.key], values.defaults));
      }
      if (group.title === 'Appearance') groupEl.appendChild(buildFontPreview());
      root.appendChild(groupEl);
    }
  }

  return { open, renderCta, menuOpen: () => !!closeOpenMenu };
}
