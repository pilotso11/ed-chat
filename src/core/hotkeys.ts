import type { Direction } from "./anchor.js";
import type { Settings } from "./settings.js";

export type HotkeyAction =
  | { type: "openChat" }
  | { type: "toggleOverlay" }
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
