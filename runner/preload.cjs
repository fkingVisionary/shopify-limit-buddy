const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("runner", {
  getConfig:  () => ipcRenderer.invoke("runner:get-config"),
  saveConfig: (cfg) => ipcRenderer.invoke("runner:save-config", cfg),
  pair:       (code) => ipcRenderer.invoke("runner:pair", code),
  start:      () => ipcRenderer.invoke("runner:start"),
  stop:       () => ipcRenderer.invoke("runner:stop"),
  onEvent:    (handler) => ipcRenderer.on("runner:event", (_e, payload) => handler(payload)),
});
