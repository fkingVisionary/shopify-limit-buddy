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
  testProxyGroup: (id, opts) => ipcRenderer.invoke("desktop:test-proxy-group", id, opts || {}),
  testProxyEntries: (text, opts) =>
    ipcRenderer.invoke("desktop:test-proxy-entries", text, opts || {}),
  proxyTestPresets: () => ipcRenderer.invoke("desktop:proxy-test-presets"),
  upsertTask: (t) => ipcRenderer.invoke("desktop:upsert-task", t),
  deleteTask: (id) => ipcRenderer.invoke("desktop:delete-task", id),
  duplicateTask: (id) => ipcRenderer.invoke("desktop:duplicate-task", id),
  duplicateProfile: (id) => ipcRenderer.invoke("desktop:duplicate-profile", id),
  duplicateTaskGroup: (opts) => ipcRenderer.invoke("desktop:duplicate-task-group", opts || {}),
  setTaskGroupColor: (opts) => ipcRenderer.invoke("desktop:set-task-group-color", opts || {}),
  discordTest: (opts) => ipcRenderer.invoke("desktop:discord-test", opts || {}),
  runTasks: (ids, opts) => ipcRenderer.invoke("desktop:run-tasks", ids, opts || {}),
  runTaskGroup: (opts) => ipcRenderer.invoke("desktop:run-task-group", opts || {}),
  stopTaskGroup: (opts) => ipcRenderer.invoke("desktop:stop-task-group", opts || {}),
  patchTaskGroup: (opts) => ipcRenderer.invoke("desktop:patch-task-group", opts || {}),
  dropReady: () => ipcRenderer.invoke("desktop:drop-ready"),
  dropScheduleArm: (opts) => ipcRenderer.invoke("desktop:drop-schedule-arm", opts || {}),
  dropScheduleCancel: () => ipcRenderer.invoke("desktop:drop-schedule-cancel"),
  dropModeArm: (opts) => ipcRenderer.invoke("desktop:drop-mode-arm", opts || {}),
  bandaiVaultLoginCheck: (opts) => ipcRenderer.invoke("desktop:bandai-vault-login-check", opts || {}),
  upsertAccount: (a) => ipcRenderer.invoke("desktop:upsert-account", a || {}),
  importAccounts: (raw, opts) => ipcRenderer.invoke("desktop:import-accounts", raw, opts || {}),
  exportAccounts: (opts) => ipcRenderer.invoke("desktop:export-accounts", opts || {}),
  importProfiles: (raw, opts) => ipcRenderer.invoke("desktop:import-profiles", raw, opts || {}),
  exportProfiles: (opts) => ipcRenderer.invoke("desktop:export-profiles", opts || {}),
  importProxyGroups: (raw, opts) =>
    ipcRenderer.invoke("desktop:import-proxy-groups", raw, opts || {}),
  exportProxyGroups: (opts) => ipcRenderer.invoke("desktop:export-proxy-groups", opts || {}),
  importTasks: (raw, opts) => ipcRenderer.invoke("desktop:import-tasks", raw, opts || {}),
  exportTasks: (opts) => ipcRenderer.invoke("desktop:export-tasks", opts || {}),
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
  monitorEventLog: (opts) => ipcRenderer.invoke("desktop:monitor-event-log", opts || {}),
  quickTask: (payload) => ipcRenderer.invoke("desktop:quick-task", payload || {}),
  smartActionsList: () => ipcRenderer.invoke("desktop:smart-actions-list"),
  storeGroupsList: () => ipcRenderer.invoke("desktop:store-groups-list"),
  storeGroupUpsert: (g) => ipcRenderer.invoke("desktop:store-group-upsert", g || {}),
  storeGroupDelete: (id) => ipcRenderer.invoke("desktop:store-group-delete", id),
  storeGroupClone: (id) => ipcRenderer.invoke("desktop:store-group-clone", id),
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
  smartActionCatalogSync: (opts) =>
    ipcRenderer.invoke("desktop:smart-action-catalog-sync", opts || {}),
  smartActionCatalogSetRowPacks: (rowId, enabledTemplateIds) =>
    ipcRenderer.invoke("desktop:smart-action-catalog-set-row-packs", {
      rowId,
      enabledTemplateIds,
    }),
  smartActionCatalogPull: () => ipcRenderer.invoke("desktop:smart-action-catalog-pull"),
  smartActionCatalogRemoveActions: (opts) =>
    ipcRenderer.invoke("desktop:smart-action-catalog-remove-actions", opts || {}),
  smartActionCatalogDeleteRow: (rowId) =>
    ipcRenderer.invoke("desktop:smart-action-catalog-delete-row", rowId),
  windowMinimize: () => ipcRenderer.invoke("desktop:window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("desktop:window-maximize"),
  windowClose: () => ipcRenderer.invoke("desktop:window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("desktop:window-is-maximized"),
  onEvent: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on("desktop:event", listener);
    return () => ipcRenderer.removeListener("desktop:event", listener);
  },
});
