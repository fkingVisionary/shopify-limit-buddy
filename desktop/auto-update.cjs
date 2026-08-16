/**
 * Auto-update for packaged Vanta Beta (NSIS) via GitHub Releases.
 * No-op in `npm start` / unpackaged builds.
 */

const { app } = require("electron");

let updater = null;
let lastStatus = {
  supported: false,
  checking: false,
  available: false,
  version: null,
  error: null,
  downloaded: false,
};

function isPackaged() {
  return Boolean(app?.isPackaged);
}

function getUpdateStatus() {
  return { ...lastStatus, currentVersion: app.getVersion() };
}

/**
 * @param {{ send?: (msg: object) => void }} hooks
 */
function initAutoUpdater(hooks = {}) {
  const send = typeof hooks.send === "function" ? hooks.send : () => {};
  if (!isPackaged()) {
    lastStatus = { ...lastStatus, supported: false, error: null };
    return { ok: true, skipped: true, reason: "unpackaged" };
  }

  try {
    // Lazy require so unpackaged/dev never needs the module graph for tests.
    updater = require("electron-updater").autoUpdater;
  } catch (e) {
    lastStatus.error = e?.message || String(e);
    return { ok: false, error: lastStatus.error };
  }

  lastStatus.supported = true;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  // GitHub releases: latest.yml next to Vanta-Beta-Setup.exe
  try {
    updater.setFeedURL({
      provider: "github",
      owner: process.env.VANTA_GITHUB_OWNER || "fkingVisionary",
      repo: process.env.VANTA_GITHUB_REPO_NAME || "shopify-limit-buddy",
    });
  } catch {
    /* electron-updater also reads publish config from app-update.yml baked by electron-builder */
  }

  updater.on("checking-for-update", () => {
    lastStatus.checking = true;
    send({ type: "job", phase: "log", level: "info", message: "Checking for Vanta Beta updates…" });
  });
  updater.on("update-available", (info) => {
    lastStatus.checking = false;
    lastStatus.available = true;
    lastStatus.version = info?.version || null;
    send({
      type: "job",
      phase: "log",
      level: "info",
      message: `Update ${info?.version || ""} available — downloading…`,
    });
  });
  updater.on("update-not-available", () => {
    lastStatus.checking = false;
    lastStatus.available = false;
    send({ type: "job", phase: "log", level: "info", message: "Vanta Beta is up to date" });
  });
  updater.on("error", (err) => {
    lastStatus.checking = false;
    lastStatus.error = err?.message || String(err);
    send({
      type: "job",
      phase: "log",
      level: "warn",
      message: `Updater: ${lastStatus.error}`,
    });
  });
  updater.on("update-downloaded", (info) => {
    lastStatus.downloaded = true;
    lastStatus.version = info?.version || lastStatus.version;
    send({
      type: "job",
      phase: "log",
      level: "ok",
      message: `Update ${lastStatus.version || ""} ready — will install on quit (or restart now from Settings)`,
    });
  });

  // Delay so window + engine settle
  setTimeout(() => {
    void checkForUpdates();
  }, 8_000);

  return { ok: true };
}

async function checkForUpdates() {
  if (!updater || !isPackaged()) {
    return { ok: false, error: "Updater only runs in the installed app" };
  }
  try {
    lastStatus.checking = true;
    lastStatus.error = null;
    const result = await updater.checkForUpdates();
    return { ok: true, updateInfo: result?.updateInfo || null, status: getUpdateStatus() };
  } catch (e) {
    lastStatus.checking = false;
    lastStatus.error = e?.message || String(e);
    return { ok: false, error: lastStatus.error, status: getUpdateStatus() };
  }
}

function quitAndInstall() {
  if (!updater || !lastStatus.downloaded) {
    return { ok: false, error: "No downloaded update ready" };
  }
  try {
    updater.quitAndInstall(false, true);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

module.exports = {
  initAutoUpdater,
  checkForUpdates,
  quitAndInstall,
  getUpdateStatus,
};
