// Electron main process — owns the BrowserWindow + the runner loop lifecycle.
// Renderer talks to main via IPC (preload.cjs exposes a tiny `runner` API).

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const { startRunnerLoop, stopRunnerLoop, runnerState } = require("./runner-loop.cjs");

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 720,
    height: 560,
    title: "J1m's Bot — Runner",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Open external links (e.g. order confirmation) in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// ── IPC ────────────────────────────────────────────────────────────────────
ipcMain.handle("runner:get-config", () => ({
  controlPlaneUrl: runnerState.controlPlaneUrl,
  deviceToken: runnerState.deviceToken,
  deviceName: runnerState.deviceName,
  status: runnerState.status,
  lastError: runnerState.lastError,
  recent: runnerState.recent.slice(-10),
}));

ipcMain.handle("runner:save-config", (_e, cfg) => {
  runnerState.controlPlaneUrl = String(cfg.controlPlaneUrl || "").replace(/\/$/, "");
  runnerState.deviceName = String(cfg.deviceName || "Runner");
  return true;
});

ipcMain.handle("runner:pair", async (_e, pairingCode) => {
  if (!runnerState.controlPlaneUrl) return { ok: false, error: "Set control plane URL first" };
  try {
    const res = await fetch(`${runnerState.controlPlaneUrl}/api/public/runner/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingCode: String(pairingCode || "").trim().toUpperCase(),
        deviceName: runnerState.deviceName,
      }),
    });
    if (!res.ok) return { ok: false, error: `Pair failed: HTTP ${res.status}` };
    const j = await res.json();
    runnerState.deviceToken = j.deviceToken;
    runnerState.deviceId = j.deviceId;
    return { ok: true, deviceId: j.deviceId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("runner:start", () => {
  if (!runnerState.deviceToken) return { ok: false, error: "Pair the runner first" };
  startRunnerLoop((evt) => win?.webContents.send("runner:event", evt));
  return { ok: true };
});

ipcMain.handle("runner:stop", () => {
  stopRunnerLoop();
  return { ok: true };
});

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  stopRunnerLoop();
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
