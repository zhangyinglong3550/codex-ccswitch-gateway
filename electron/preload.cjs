const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  health: () => ipcRenderer.invoke("status:health"),
  models: () => ipcRenderer.invoke("models:list"),
  config: () => ipcRenderer.invoke("config:list"),
  catalog: () => ipcRenderer.invoke("catalog:disk"),
  dbInfo: () => ipcRenderer.invoke("db:info"),
  refresh: () => ipcRenderer.invoke("refresh:run"),
  doctor: () => ipcRenderer.invoke("doctor:run"),
  profile: () => ipcRenderer.invoke("profile:run"),
  serviceInstall: () => ipcRenderer.invoke("service:install"),
  serviceUninstall: () => ipcRenderer.invoke("service:uninstall"),
  serviceRestart: () => ipcRenderer.invoke("service:restart"),
  serviceStatus: () => ipcRenderer.invoke("service:status"),
  testModel: (slug, opts) => ipcRenderer.invoke("model:test", slug, opts),
  logs: () => ipcRenderer.invoke("logs:read"),
  paths: () => ipcRenderer.invoke("paths:info"),
  setWatch: (enabled) => ipcRenderer.invoke("watch:set", enabled),
  showItem: (p) => ipcRenderer.invoke("shell:open", p),
  onDbChanged: (cb) => {
    const listener = (_e, info) => cb(info);
    ipcRenderer.on("db:changed", listener);
    return () => ipcRenderer.removeListener("db:changed", listener);
  },
  onRefreshDone: (cb) => {
    const listener = (_e, res) => cb(res);
    ipcRenderer.on("refresh:done", listener);
    return () => ipcRenderer.removeListener("refresh:done", listener);
  }
});
