import { BrowserWindow } from "electron";
import type { WindowProps } from "../core/controller.js";

export function createOverlayWindow(
  preload: string,
  url: string | undefined,
  html: string,
): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 48,
    show: false,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true, { forward: true });
  if (url) void win.loadURL(url);
  else void win.loadFile(html);
  return win;
}

export function applyWindow(win: BrowserWindow, p: WindowProps, prev: WindowProps | null): void {
  if (prev && prev.show === p.show && prev.interactive === p.interactive) return;
  if (p.interactive) {
    win.setFocusable(true);
    win.setIgnoreMouseEvents(false);
    win.show();
    win.focus();
    return;
  }
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setFocusable(false);
  // showInactive: showing the card must never take focus from the game.
  if (p.show) win.showInactive();
  else win.hide();
}
