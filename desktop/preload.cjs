const { contextBridge, ipcRenderer } = require("electron");

// Sandboxed preload may only require electron/built-ins — do NOT require local
// modules here (e.g. harvest-bank-status.cjs). That kills window.desktop entirely.
// Harvest bank strip formatting lives in renderer/app.js instead.

contextBridge.exposeInMainWorld("desktop", {
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  saveSettings: (patch) => ipcRenderer.invoke("desktop:save-settings", patch),
  validateLicense: () => ipcRenderer.invoke("desktop:validate-license"),
  startEngine: () => ipcRenderer.invoke("desktop:start-engine"),
  stopEngine: () => ipcRenderer.invoke("desktop:stop-engine"),
  upsertProfile: (p) => ipcRenderer.invoke("desktop:upsert-profile", p),
  deleteProfile: (id) => ipcRenderer.invoke("desktop:delete-profile", id),
  upsertProxyGroup: (g) => ipcRenderer.invoke("desktop:upsert-proxy-group", g),
  deleteProxyGroup: (id) => ipcRenderer.invoke("desktop:delete-proxy-group", id),
  upsertTask: (t) => ipcRenderer.invoke("desktop:upsert-task", t),
  deleteTask: (id) => ipcRenderer.invoke("desktop:delete-task", id),
  runTasks: (ids, opts) => ipcRenderer.invoke("desktop:run-tasks", ids, opts || {}),
  dropReady: () => ipcRenderer.invoke("desktop:drop-ready"),
  dropScheduleArm: (opts) => ipcRenderer.invoke("desktop:drop-schedule-arm", opts || {}),
  dropScheduleCancel: () => ipcRenderer.invoke("desktop:drop-schedule-cancel"),
  dropModeArm: (opts) => ipcRenderer.invoke("desktop:drop-mode-arm", opts || {}),
  bandaiVaultLoginCheck: (opts) => ipcRenderer.invoke("desktop:bandai-vault-login-check", opts || {}),
  upsertAccount: (a) => ipcRenderer.invoke("desktop:upsert-account", a || {}),
  importAccounts: (raw, opts) => ipcRenderer.invoke("desktop:import-accounts", raw, opts || {}),
  exportAccounts: (opts) => ipcRenderer.invoke("desktop:export-accounts", opts || {}),
  deleteAccount: (id) => ipcRenderer.invoke("desktop:delete-account", id),
  clearAccounts: (storeId) => ipcRenderer.invoke("desktop:clear-accounts", storeId),
  // Toymate CF + spam harvest
  harvestStatus: () => ipcRenderer.invoke("desktop:harvest-status"),
  harvestConfigure: (patch) => ipcRenderer.invoke("desktop:harvest-configure", patch),
  harvestStart: (opts) => ipcRenderer.invoke("desktop:harvest-start", opts),
  harvestStop: () => ipcRenderer.invoke("desktop:harvest-stop"),
  harvestClear: () => ipcRenderer.invoke("desktop:harvest-clear"),
  harvestOnce: (opts) => ipcRenderer.invoke("desktop:harvest-once", opts),
  // Bandai F5 harvest
  bandaiHarvestStatus: () => ipcRenderer.invoke("desktop:bandai-harvest-status"),
  bandaiHarvestConfigure: (patch) => ipcRenderer.invoke("desktop:bandai-harvest-configure", patch),
  bandaiHarvestStart: (opts) => ipcRenderer.invoke("desktop:bandai-harvest-start", opts),
  bandaiHarvestStop: () => ipcRenderer.invoke("desktop:bandai-harvest-stop"),
  bandaiHarvestClear: () => ipcRenderer.invoke("desktop:bandai-harvest-clear"),
  bandaiHarvestOnce: (opts) => ipcRenderer.invoke("desktop:bandai-harvest-once", opts),
  // Disney Akamai + CapSolver harvest
  disneyHarvestStatus: () => ipcRenderer.invoke("desktop:disney-harvest-status"),
  disneyHarvestConfigure: (patch) => ipcRenderer.invoke("desktop:disney-harvest-configure", patch),
  disneyHarvestStart: (opts) => ipcRenderer.invoke("desktop:disney-harvest-start", opts),
  disneyHarvestStop: () => ipcRenderer.invoke("desktop:disney-harvest-stop"),
  disneyHarvestClear: () => ipcRenderer.invoke("desktop:disney-harvest-clear"),
  disneyHarvestOnce: (opts) => ipcRenderer.invoke("desktop:disney-harvest-once", opts),
  // Monitor Feed / Quick Task / Smart Actions
  monitorFeed: () => ipcRenderer.invoke("desktop:monitor-feed"),
  monitorFeedClear: () => ipcRenderer.invoke("desktop:monitor-feed-clear"),
  quickTask: (payload) => ipcRenderer.invoke("desktop:quick-task", payload || {}),
  smartActionsList: () => ipcRenderer.invoke("desktop:smart-actions-list"),
  smartActionUpsert: (a) => ipcRenderer.invoke("desktop:smart-action-upsert", a || {}),
  smartActionDelete: (id) => ipcRenderer.invoke("desktop:smart-action-delete", id),
  smartActionSetEnabled: (id, enabled) =>
    ipcRenderer.invoke("desktop:smart-action-set-enabled", id, enabled),
  smartActionLogs: (id) => ipcRenderer.invoke("desktop:smart-action-logs", id),
  smartActionFromHit: (hit) => ipcRenderer.invoke("desktop:smart-action-from-hit", hit || {}),
  smartActionCatalogGet: () => ipcRenderer.invoke("desktop:smart-action-catalog-get"),
  smartActionCatalogSave: (patch) =>
    ipcRenderer.invoke("desktop:smart-action-catalog-save", patch || {}),
  smartActionCatalogAddBulk: (text, opts) =>
    ipcRenderer.invoke("desktop:smart-action-catalog-add-bulk", text, opts || {}),
  smartActionCatalogApply: (opts) =>
    ipcRenderer.invoke("desktop:smart-action-catalog-apply", opts || {}),
  smartActionCatalogRemoveActions: (opts) =>
    ipcRenderer.invoke("desktop:smart-action-catalog-remove-actions", opts || {}),
  smartActionCatalogDeleteRow: (rowId) =>
    ipcRenderer.invoke("desktop:smart-action-catalog-delete-row", rowId),
  onEvent: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on("desktop:event", listener);
    return () => ipcRenderer.removeListener("desktop:event", listener);
  },
});
