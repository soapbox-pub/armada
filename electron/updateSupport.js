"use strict";

/**
 * Decide whether this package format has a safe, writable self-update path.
 * Keep this independent of Electron so every release format can be tested on
 * the Linux CI runner that produces Armada's installers.
 */
function supportsSelfUpdate({
  isPackaged,
  platform,
  env = {},
  isMas = false,
  isWindowsStore = false,
  macUpdateDisabled = false,
}) {
  if (!isPackaged) return false;

  if (platform === "win32") {
    // Squirrel/NSIS installs have an update owner; portable and Store packages
    // do not. electron-builder supplies these PORTABLE_* variables itself.
    return (
      !isWindowsStore &&
      !env.PORTABLE_EXECUTABLE_FILE &&
      !env.PORTABLE_EXECUTABLE_DIR
    );
  }

  if (platform === "darwin") {
    return !isMas && !macUpdateDisabled;
  }

  if (platform === "linux") {
    // AppImage is the sole edition electron-updater owns on Linux. A deb stays
    // owned by apt and must never have files replaced behind its package
    // manager. A Flatpak is excluded for a different reason: its `/app` is a
    // read-only OSTree mount no process can rewrite in place, and
    // electron-updater has no installer for the format at all. Its web app
    // still updates from the site (main.js, checkForWebUpdate), like every
    // edition's; only its shell waits for `flatpak update`.
    return Boolean(env.APPIMAGE) && !env.FLATPAK_ID;
  }

  return false;
}

function hasDeveloperIdUpdateSignature(signatureDetails) {
  const details = String(signatureDetails || "");
  return (
    !details.includes("Signature=adhoc") &&
    /^Authority=Developer ID Application:/m.test(details)
  );
}

/**
 * Arm electron-updater after `supportsSelfUpdate()` has assigned ownership to
 * this package. An installed NSIS build follows the same policy whether or not
 * it carries Authenticode: signing adds an independent publisher identity, but
 * is not a prerequisite for a user-selected install to update itself.
 */
function configureAutoUpdater(autoUpdater) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  // Differential download needs a .blockmap fetched from a path derived from
  // the payload's URL — `<url>.blockmap` for NSIS, a byte range of the payload
  // itself for AppImage. Neither exists for a content-addressed artifact: a
  // blockmap is different bytes and so a different hash, at an unrelated URL
  // the release event doesn't name. Leaving it on would spend a failed request
  // per check and then full-download anyway.
  autoUpdater.disableDifferentialDownload = true;
  // There is no NSIS web installer in this build, and saying so is what stops
  // electron-updater warning about it on every Windows download.
  autoUpdater.disableWebInstaller = true;
}

module.exports = {
  configureAutoUpdater,
  hasDeveloperIdUpdateSignature,
  supportsSelfUpdate,
};
