const { contextBridge, ipcRenderer } = require("electron");

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
  runTasks: (ids) => ipcRenderer.invoke("desktop:run-tasks", ids),
  deleteAccount: (id) => ipcRenderer.invoke("desktop:delete-account", id),
  clearAccounts: (storeId) => ipcRenderer.invoke("desktop:clear-accounts", storeId),
  bandaiHarvestStatus: () => ipcRenderer.invoke("desktop:bandai-harvest-status"),
  bandaiHarvestConfigure: (patch) => ipcRenderer.invoke("desktop:bandai-harvest-configure", patch),
  bandaiHarvestStart: (opts) => ipcRenderer.invoke("desktop:bandai-harvest-start", opts),
  bandaiHarvestStop: () => ipcRenderer.invoke("desktop:bandai-harvest-stop"),
  bandaiHarvestClear: () => ipcRenderer.invoke("desktop:bandai-harvest-clear"),
  bandaiHarvestOnce: (opts) => ipcRenderer.invoke("desktop:bandai-harvest-once", opts),
  onEvent: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on("desktop:event", listener);
    return () => ipcRenderer.removeListener("desktop:event", listener);
  },
});
