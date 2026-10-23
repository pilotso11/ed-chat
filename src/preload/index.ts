import { contextBridge, ipcRenderer } from "electron";
import type { ViewModel } from "../core/view.js";
import { IPC, type OverlayApi } from "../shared/ipc.js";

const api: OverlayApi = {
  onView: (cb) => {
    ipcRenderer.on(IPC.view, (_e, v: ViewModel) => cb(v));
  },
  send: (text) => ipcRenderer.send(IPC.send, text),
  closeChat: () => ipcRenderer.send(IPC.closeChat),
  copyChip: (n) => ipcRenderer.send(IPC.copyChip, n),
  reportHeight: (h) => ipcRenderer.send(IPC.height, h),
};

contextBridge.exposeInMainWorld("overlay", api);
