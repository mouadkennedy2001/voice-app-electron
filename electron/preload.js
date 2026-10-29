"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("soutDesktop", Object.freeze({
  setTheme: (theme) => ipcRenderer.invoke("sout:set-theme", theme)
}));
