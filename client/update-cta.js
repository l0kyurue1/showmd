const CHANNEL_COMMANDS = { brew: 'brew upgrade showmd', 'npm-global': 'npm i -g showmd-cli@latest' };

// dismissal is keyed by "the version being dismissed" rather than a bare
// on/off flag, so a later release makes the CTA reappear on its own; the
// showmd and app-only states share this one key since they're both spelled
// "There is a new version X" for the same X (see below)
export function buildUpdateCta(settings = {}, { dismissedVersion, justUpdatedVersion } = {}) {
  if (justUpdatedVersion) {
    return { state: 'updated', title: `App updated to ${justUpdatedVersion}`, success: true, showDismiss: false };
  }

  const appMissing = settings.appInstalled && settings.appStale && settings.appStaleReason === 'missing';
  if (appMissing) {
    return {
      state: 'missing',
      title: 'The app points at a showmd that is no longer installed.',
      buttonLabel: 'Repair app', buttonWeight: 'primary',
      showDismiss: false,
    };
  }

  const showmdPending = !!settings.updateAvailable && !!CHANNEL_COMMANDS[settings.updateChannel];
  const appBehind = !!(settings.appInstalled && settings.appStale && settings.appStaleReason === 'version');
  if (!showmdPending && !appBehind) return null;

  if (showmdPending && appBehind) {
    const version = settings.latestVersion;
    if (version === dismissedVersion) return null;
    return {
      state: 'both',
      title: `There is a new version ${version}`,
      command: CHANNEL_COMMANDS[settings.updateChannel],
      subline: 'Update the app after that.',
      buttonLabel: 'Update app', buttonWeight: 'secondary',
      showDismiss: true, dismissVersion: version,
    };
  }

  if (showmdPending) {
    const version = settings.latestVersion;
    if (version === dismissedVersion) return null;
    return {
      state: 'showmd',
      title: `There is a new version ${version}`,
      command: CHANNEL_COMMANDS[settings.updateChannel],
      showDismiss: true, dismissVersion: version,
    };
  }

  const version = settings.showmdVersion;
  if (version === dismissedVersion) return null;
  return {
    state: 'app',
    title: `There is a new version ${version}`,
    buttonLabel: 'Update app', buttonWeight: 'primary',
    showDismiss: true, dismissVersion: version,
  };
}
