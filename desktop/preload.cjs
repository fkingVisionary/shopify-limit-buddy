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
  listProxyProbeStores: () => ipcRenderer.invoke("desktop:list-proxy-probe-stores"),
  testProxyGroup: (payload) => ipcRenderer.invoke("desktop:test-proxy-group", payload),
  upsertTask: (t) => ipcRenderer.invoke("desktop:upsert-task", t),
  createTasks: (t, n) => ipcRenderer.invoke("desktop:create-tasks", t, n),
  deleteTask: (id) => ipcRenderer.invoke("desktop:delete-task", id),
  runTasks: (ids) => ipcRenderer.invoke("desktop:run-tasks", ids),
  stopTask: (id) => ipcRenderer.invoke("desktop:stop-task", id),
  setActiveGroup: (id) => ipcRenderer.invoke("desktop:set-active-group", id),
  upsertTaskGroup: (g) => ipcRenderer.invoke("desktop:upsert-task-group", g),
  deleteTaskGroup: (id) => ipcRenderer.invoke("desktop:delete-task-group", id),
  addCustomStore: (payload) => ipcRenderer.invoke("desktop:add-custom-store", payload),
  monitorFeedStatus: () => ipcRenderer.invoke("desktop:monitor-feed-status"),
  monitorFeedConnect: () => ipcRenderer.invoke("desktop:monitor-feed-connect"),
  monitorFeedDisconnect: () => ipcRenderer.invoke("desktop:monitor-feed-disconnect"),
  onEvent: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on("desktop:event", listener);
    return () => ipcRenderer.removeListener("desktop:event", listener);
  },
});
