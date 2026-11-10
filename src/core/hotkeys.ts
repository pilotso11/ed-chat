import type { Direction } from "./anchor.js";
import { NUMPAD_CHIP, keyList, type Keys, type Settings } from "./settings.js";

export type HotkeyAction =
  | { type: "openChat"; step?: boolean }
  | { type: "toggleOverlay" }
  | { type: "toggleIcon" }
  | { type: "showMore" }
  | { type: "step" }
  | { type: "alwaysAllow" }
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

export function chipPatterns(h: Settings["hotkeys"]): string[] {
  return [...keyList(h.copyChip), ...(h.copyChipNumpad ? [NUMPAD_CHIP] : [])];
}

export function bindings(h: Settings["hotkeys"]): Binding[] {
  const b = (name: string, k: Keys, action: HotkeyAction): Binding[] =>
    keyList(k).map((accelerator) => ({ name, accelerator, action }));
  return [
    ...b("openChat", h.openChat, { type: "openChat" }),
    ...b("toggleIcon", h.toggleIcon, { type: "toggleIcon" }),
    ...b("showMore", h.showMore, { type: "step" }),
    ...b("showHistory", h.showHistory, { type: "showHistory" }),
    ...b("approve", h.approve, { type: "approve" }),
    ...b("deny", h.deny, { type: "deny" }),
    ...b("alwaysAllow", h.alwaysAllow, { type: "alwaysAllow" }),
    ...b("cancel", h.cancel, { type: "cancel" }),
    ...b("moveUp", h.moveUp, { type: "move", dir: "up" }),
    ...b("moveDown", h.moveDown, { type: "move", dir: "down" }),
    ...b("moveLeft", h.moveLeft, { type: "move", dir: "left" }),
    ...b("moveRight", h.moveRight, { type: "move", dir: "right" }),
    ...b("nextDisplay", h.nextDisplay, { type: "nextDisplay" }),
    ...chipPatterns(h).flatMap((p) =>
      Array.from({ length: 9 }, (_, i) => ({
        name: `copyChip${i + 1}`,
        accelerator: p.replace("{n}", String(i + 1)),
        action: { type: "copyChip", n: i + 1 } as const,
      })),
    ),
  ];
}

const CTRL = new Set(["ctrl", "control", "cmdorctrl", "commandorcontrol"]);
const NUMPAD = /^num(\d|dec|add|sub|mult|div)$/;
const MODIFIER =
  /(^|\+)(Ctrl|Control|Alt|Shift|Cmd|Command|CmdOrCtrl|CommandOrControl|Super|Meta|Option|AltGr)\+/i;

export const hasModifier = (accelerator: string) => MODIFIER.test(accelerator);

/**
 * True when the chat input needs the key: any key but a function key, alone or with Shift
 * (characters, editing and caret keys), a character with AltGr, which Windows reports as Ctrl+Alt, or Alt+numpad,
 * which types Alt codes.
 */
function typesText(accelerator: string): boolean {
  const parts = accelerator.split("+");
  const key = (parts.at(-1) ?? "").toLowerCase();
  const mods = parts
    .slice(0, -1)
    .map((m) => m.toLowerCase())
    .filter((m) => m !== "shift");
  // Function keys type nothing, and F13–F24 suit HOTAS buttons.
  if (mods.length === 0) return !/^f\d+$/.test(key);
  if (mods.length === 1 && mods[0] === "alt" && NUMPAD.test(key)) return true;
  // "+" is the separator, so Electron names that character "Plus".
  if (key.length !== 1 && key !== "plus") return false;
  if (mods.length === 1 && mods[0] === "altgr") return true;
  return mods.length === 2 && mods.includes("alt") && mods.some((m) => CTRL.has(m));
}

function normalize(accelerator: string): string {
  const parts = accelerator.toLowerCase().split("+");
  const key = parts.at(-1) ?? "";
  const mods = parts.slice(0, -1).map((m) => (CTRL.has(m) ? "ctrl" : m));
  return [...new Set(mods)].sort().concat(key).join("+");
}

/**
 * The binding for a Ctrl+Alt chord pressed in the chat input. Such bindings are left out while
 * the overlay has focus, so AltGr letters stay typeable; the input reports a real Ctrl+Alt
 * chord (not AltGr) instead, so keys such as cancel still work while chatting.
 */
export function chordBinding(all: Binding[], chord: string): Binding | null {
  const want = normalize(chord);
  return all.find((b) => typesText(b.accelerator) && normalize(b.accelerator) === want) ?? null;
}

/**
 * The bindings to register. A global shortcut swallows its key. While the overlay has focus,
 * keys that type text are left out, so the chat input gets them. In "always" scope, keys
 * without a modifier are left out, so every other app gets them.
 */
export function activeBindings(
  all: Binding[],
  overlayFocused: boolean,
  scope: Settings["hotkeys"]["scope"] = "game",
): Binding[] {
  return all.filter(
    (b) =>
      !(overlayFocused && typesText(b.accelerator)) &&
      !(scope === "always" && !hasModifier(b.accelerator)),
  );
}

/** How a key list reads on screen: "Ctrl+Alt+C" or "Ctrl+Alt+C / F13". */
export const keyLabel = (k: Keys) => keyList(k).join(" / ");

/** The copy keys as one label: "Ctrl+Shift+1–9". */
export function chipKeyLabel(h: Settings["hotkeys"]): string {
  return chipPatterns(h)
    .map((p) => p.replace("{n}", "1–9"))
    .join(" / ");
}

export interface Registrar {
  register(accelerator: string, cb: () => void): boolean;
  unregister(accelerator: string): void;
}

export class HotkeyManager {
  private current: Binding[] = [];
  private registered: string[] = [];
  private _active = false;
  /** The accelerators that failed at the last activation. */
  failedKeys: string[] = [];

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
    this.failedKeys = this.current
      .map((b) => b.accelerator)
      .filter((a) => !this.registered.includes(a));
    return failed;
  }

  deactivate(): void {
    for (const a of this.registered) this.reg.unregister(a);
    this.registered = [];
    this._active = false;
  }
}

// "Ctrl+Alt+Arrows" when the four move keys share their modifiers, else the full list.
function arrowLabel(keys: string[]): string {
  const mods = keys.map((k) => k.slice(0, k.lastIndexOf("+") + 1));
  const same = keys.length === 4 && mods.every((m) => m === mods[0]);
  return same ? `${mods[0]}Arrows` : keys.join(" / ");
}

/** One line of the hotkey list. */
export interface KeyRow {
  label: string;
  keys: string;
  failed: string[];
  /** Keys that "always" scope never registers, because they have no modifier. */
  unused: string[];
}

// The step key comes first: it is the one key a player needs for replies and the chat.
const LABELS: [keyof Settings["hotkeys"], string][] = [
  ["showMore", "Reply → whole reply → chat"],
  ["openChat", "Open chat directly"],
  ["approve", "Allow tool"],
  ["deny", "Deny tool"],
  ["alwaysAllow", "Always allow tool"],
  ["cancel", "Stop reply"],
  ["showHistory", "History"],
  ["toggleIcon", "Icon mode"],
];

/** The hotkey list for the keys card; failed holds the keys another app has taken. */
export function keyRows(h: Settings["hotkeys"], failed: string[]): KeyRow[] {
  const taken = (ks: string[]) => ks.filter((k) => failed.includes(k));
  const unused = (ks: string[]) => (h.scope === "always" ? ks.filter((k) => !hasModifier(k)) : []);
  const rows: KeyRow[] = LABELS.map(([name, label]) => {
    const ks = keyList(h[name] as Keys);
    return { label, keys: ks.join(" / "), failed: taken(ks), unused: unused(ks) };
  });
  const chipKeys = chipPatterns(h).flatMap((p) =>
    Array.from({ length: 9 }, (_, i) => p.replace("{n}", String(i + 1))),
  );
  rows.splice(2, 0, {
    label: "Copy chip",
    keys: chipKeyLabel(h),
    failed: taken(chipKeys),
    unused: unused(chipKeys),
  });
  const arrows = [h.moveUp, h.moveDown, h.moveLeft, h.moveRight].flatMap(keyList);
  rows.push({
    label: "Move overlay",
    keys: arrowLabel(arrows),
    failed: taken(arrows),
    unused: unused(arrows),
  });
  const next = keyList(h.nextDisplay);
  rows.push({
    label: "Next monitor",
    keys: next.join(" / "),
    failed: taken(next),
    unused: unused(next),
  });
  return rows;
}
