export function resolveTheme(colorMode, systemDark) {
  return colorMode === 'system' ? (systemDark ? 'dark' : 'light') : colorMode;
}

// Adopt a legacy local theme once when settings have no saved color mode.
export function initialColorMode(settings, legacy) {
  const mode = settings.colorMode || 'system';
  if (legacy && mode === 'system') return { colorMode: legacy, persist: true };
  return { colorMode: mode, persist: false };
}

export function createTheme({ media, root, storage, persist, onChange, button }) {
  let colorMode = 'system';

  function apply() {
    root.dataset.theme = resolveTheme(colorMode, media.matches);
  }

  // the only writer of the theme: anything else that flips it (the ?lab panel)
  // goes through here, or its diagrams keep the old theme's colors
  function set(next, { persist: save = true } = {}) {
    colorMode = next;
    apply();
    if (save) persist(next);
    onChange();
  }

  function isDark() {
    return resolveTheme(colorMode, media.matches) === 'dark';
  }

  function init(settings) {
    const legacy = storage.getItem('showmd-theme');
    if (legacy) storage.removeItem('showmd-theme');
    const initial = initialColorMode(settings, legacy);
    colorMode = initial.colorMode;
    if (initial.persist) persist(colorMode);
    apply();
    media.addEventListener('change', () => { if (colorMode === 'system') apply(); });
    button.addEventListener('click', () => {
      set(isDark() ? 'light' : 'dark');
    });
  }

  return { init, set, mode: () => colorMode, isDark };
}
