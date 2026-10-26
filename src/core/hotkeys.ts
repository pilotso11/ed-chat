import type { Direction } from "./anchor.js";
import type { Settings } from "./settings.js";

export type HotkeyAction =
  | { type: "openChat" }
  | { type: "toggleOverlay" }
  | { type: "toggleIcon" }
  | { type: "showHistory" }
  | { type: "approve" }
  | { type: "deny" }
  | { type: "cancel" }
  | { type: "copyChip"; n: number }
  | { type: "move"; dir: Direction }
  | { type: "nextDisplay" };

export interface Binding {
  name: string;
  accelerator: string;
  action: HotkeyAction;
}

export function bindings(h: Settings["hotkeys"]): Binding[] {
  const b = (name: string, accelerator: string, action: HotkeyAction): Binding => ({
    name,
    accelerator,
    action,
  });
  return [
    b("openChat", h.openChat, { type: "openChat" }),
    b("toggleOverlay", h.toggleOverlay, { type: "toggleOverlay" }),
    b("toggleIcon", h.toggleIcon, { type: "toggleIcon" }),
    b("showHistory", h.showHistory, { type: "showHistory" }),
    b("approve", h.approve, { type: "approve" }),
    b("deny", h.deny, { type: "deny" }),
    b("cancel", h.cancel, { type: "cancel" }),
    b("moveUp", h.moveUp, { type: "move", dir: "up" }),
    b("moveDown", h.moveDown, { type: "move", dir: "down" }),
    b("moveLeft", h.moveLeft, { type: "move", dir: "left" }),
    b("moveRight", h.moveRight, { type: "move", dir: "right" }),
    b("nextDisplay", h.nextDisplay, { type: "nextDisplay" }),
    ...Array.from({ length: 9 }, (_, i) =>
      b(`copyChip${i + 1}`, h.copyChip.replace("{n}", String(i + 1)), {
        type: "copyChip",
        n: i + 1,
      }),
    ),
  ];
}

const CTRL = new Set(["ctrl", "control", "cmdorctrl", "commandorcontrol"]);
// Named keys that type or edit text in the chat input, besides single characters.
const TYPING_KEYS = new Set(["space", "tab", "backspace", "delete", "return", "enter"]);
const NUMPAD = /^num(\d|dec|add|sub|mult|div)$/;

/**
 * True when the accelerator is a key the player could type: a character, a numpad key or an
 * editing key, alone or with Shift; or a character with AltGr, which Windows reports as
 * Ctrl+Alt.
 */
function typesText(accelerator: string): boolean {
  const parts = accelerator.split("+");
  const key = (parts.at(-1) ?? "").toLowerCase();
  const char = key.length === 1;
  if (!char && !TYPING_KEYS.has(key) && !NUMPAD.test(key)) return false;
  const mods = parts
    .slice(0, -1)
    .map((m) => m.toLowerCase())
    .filter((m) => m !== "shift");
  if (mods.length === 0) return true;
  if (!char) return false;
  if (mods.length === 1 && mods[0] === "altgr") return true;
  return mods.length === 2 && mods.includes("alt") && mods.some((m) => CTRL.has(m));
}

/**
 * The bindings to register. While the overlay has focus, keys that type text are left out:
 * a global shortcut swallows the key, so it could not be typed in the chat input.
 */
export function activeBindings(all: Binding[], overlayFocused: boolean): Binding[] {
  return overlayFocused ? all.filter((b) => !typesText(b.accelerator)) : all;
}

export interface Registrar {
  register(accelerator: string, cb: () => void): boolean;
  unregister(accelerator: string): void;
}

export class HotkeyManager {
  private current: Binding[] = [];
  private registered: string[] = [];
  private _active = false;

  constructor(
    private readonly reg: Registrar,
    private readonly run: (a: HotkeyAction) => void,
  ) {}

  get active(): boolean {
    return this._active;
  }

  /** Returns the bindings that failed to register, when active. */
  setBindings(b: Binding[]): string[] {
    const wasActive = this._active;
    this.deactivate();
    this.current = b;
    return wasActive ? this.activate() : [];
  }

  activate(): string[] {
    if (this._active) return [];
    this._active = true;
    const failed: string[] = [];
    for (const b of this.current) {
      let ok = false;
      try {
        ok = this.reg.register(b.accelerator, () => this.run(b.action));
      } catch {
        // Electron throws on an accelerator it cannot parse.
      }
      if (ok) this.registered.push(b.accelerator);
      else failed.push(`${b.name} (${b.accelerator})`);
    }
    return failed;
  }

  deactivate(): void {
    for (const a of this.registered) this.reg.unregister(a);
    this.registered = [];
    this._active = false;
  }
}
