import { contextBridge, ipcRenderer } from "electron";
import { SETTINGS_IPC, type SettingsApi, type SettingsSnapshot } from "../shared/settingsIpc.js";

const api: SettingsApi = {
  load: () => ipcRenderer.invoke(SETTINGS_IPC.load) as Promise<SettingsSnapshot>,
  save: (changes) =>
    ipcRenderer.invoke(SETTINGS_IPC.save, changes) as ReturnType<SettingsApi["save"]>,
  openFile: () => ipcRenderer.send(SETTINGS_IPC.openFile),
  onChanged: (cb) => {
    ipcRenderer.on(SETTINGS_IPC.changed, () => cb());
  },
};

contextBridge.exposeInMainWorld("settingsApi", api);
