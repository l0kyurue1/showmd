const CHANNEL_COMMANDS = { brew: 'brew upgrade showmd', 'npm-global': 'npm i -g showmd-cli@latest' };

// Version-keyed dismissal lets the CTA return for later releases.
export function buildUpdateCta(settings = {}, {
  dismissedVersion, justUpdatedVersion, operation = null, allowDismiss = true,
} = {}) {
  if (justUpdatedVersion) {
    return { state: 'updated', title: `Updated to ${justUpdatedVersion}`, success: true, showDismiss: false };
  }

  if (operation?.state === 'updating') {
    return { state: 'updating', title: 'Updating…', showDismiss: false };
  }
  if (operation?.state === 'finishing') {
    return { state: 'finishing', title: 'Finishing update…', showDismiss: false };
  }
  if (operation?.state === 'failure') {
    return {
      state: 'failure', title: 'Update couldn’t be completed.',
      command: operation.manualCommand || null,
      buttonLabel: 'Try again', buttonWeight: 'primary', action: 'update', showDismiss: false,
    };
  }

  const appMissing = settings.appInstalled && settings.appStale && settings.appStaleReason === 'missing';
  if (appMissing) {
    return {
      state: 'missing',
      title: 'The app points at a showmd that is no longer installed.',
      buttonLabel: 'Repair app', buttonWeight: 'primary',
      showDismiss: false, action: 'install-app',
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
      buttonLabel: 'Update', buttonWeight: 'primary', action: 'update',
      showDismiss: allowDismiss, dismissVersion: version,
    };
  }

  if (showmdPending) {
    const version = settings.latestVersion;
    if (version === dismissedVersion) return null;
    return {
      state: 'showmd',
      title: `There is a new version ${version}`,
      buttonLabel: 'Update', buttonWeight: 'primary', action: 'update',
      showDismiss: allowDismiss, dismissVersion: version,
    };
  }

  const version = settings.showmdVersion;
  if (version === dismissedVersion) return null;
  return {
    state: 'app',
    title: `There is a new version ${version}`,
    buttonLabel: 'Update app', buttonWeight: 'primary',
    action: 'install-app', showDismiss: allowDismiss, dismissVersion: version,
  };
}
