'use strict';
const settings = require('./settings.js');
const settingsPlatform = require('./settings-platform.js');
const updateCheck = require('./update-check.js');
const installers = require('./install-app.js');

// appStatusFn/mdHandlerDefaultFn/effectiveSettingsPromise are the same
// test/platform seams createServer already accepted for this route.
async function getSettingsView({ platform, appStatusFn, mdHandlerDefaultFn, effectiveSettingsPromise, cliPath, updateToken }) {
  const detectMdHandlerDefault = mdHandlerDefaultFn
    || (() => settingsPlatform.detectMdHandlerDefault({ platform, bundleId: installers.BUNDLE_ID }));
  const [values, browsers, effective, mdHandlerDefault] = await Promise.all([
    settings.readSettings(), settingsPlatform.detectBrowsers(), effectiveSettingsPromise,
    detectMdHandlerDefault(),
  ]);
  const update = values.updateCheck ? updateCheck.updateInfo() : { updateAvailable: false, latestVersion: null, checkFailed: false };
  const app = (appStatusFn || installers.appStatus)(platform);
  return {
    ...values, browsers, ...update,
    defaults: settings.DEFAULTS,
    settingsPath: settings.settingsFile(),
    effective: { port: effective.port, browser: effective.browser },
    platform,
    appInstalled: app.installed,
    appStale: !!app.stale,
    appStaleReason: app.staleReason || null,
    appVersion: app.appVersion || null,
    appMdRegistered: !!app.appMdRegistered,
    appPath: app.path,
    showmdVersion: require('../package.json').version,
    mdHandlerDefault,
    updateChannel: installers.installChannel(cliPath || process.argv[1] || ''),
    updateToken: updateToken || null,
  };
}

module.exports = { getSettingsView };
