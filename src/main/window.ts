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

/** The settings window: a normal window with a frame, that takes focus, unlike the overlay. */
export function createSettingsWindow(
  preload: string,
  url: string | undefined,
  html: string,
  icon: string,
): BrowserWindow {
  const win = new BrowserWindow({
    width: 860,
    height: 820,
    minWidth: 560,
    minHeight: 400,
    show: false,
    title: "ED Chat settings",
    icon,
    backgroundColor: "#0b0d11",
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // No menu: Alt would open it, and its keys would take presses meant for a hotkey field.
  win.removeMenu();
  // The page is ED Chat's own; a link must not replace it or open another window.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => win.show());
  if (url) void win.loadURL(url);
  else void win.loadFile(html);
  return win;
}
