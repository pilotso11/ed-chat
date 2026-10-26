import { contextBridge, ipcRenderer } from "electron";
import type { ViewModel } from "../core/view.js";
import { IPC, type OverlayApi } from "../shared/ipc.js";

const api: OverlayApi = {
  onView: (cb) => {
    ipcRenderer.on(IPC.view, (_e, v: ViewModel) => cb(v));
  },
  send: (text) => ipcRenderer.invoke(IPC.send, text) as Promise<boolean>,
  closeChat: () => ipcRenderer.send(IPC.closeChat),
  copyChip: (n) => ipcRenderer.send(IPC.copyChip, n),
  reportHeight: (h) => ipcRenderer.send(IPC.height, h),
  chord: (accelerator) => ipcRenderer.send(IPC.chord, accelerator),
  hover: (over) => ipcRenderer.send(IPC.hover, over),
  expand: () => ipcRenderer.send(IPC.expand),
  holdCard: (hold) => ipcRenderer.send(IPC.holdCard, hold),
  copyNotice: () => ipcRenderer.send(IPC.copyNotice),
  showNotices: () => ipcRenderer.send(IPC.showNotices),
  closeKeys: () => ipcRenderer.send(IPC.closeKeys),
  showMore: () => ipcRenderer.send(IPC.showMore),
  answerApproval: (id, answer) => ipcRenderer.send(IPC.answerApproval, id, answer),
};

contextBridge.exposeInMainWorld("overlay", api);
