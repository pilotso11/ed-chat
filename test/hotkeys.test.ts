import { describe, expect, it } from "vitest";
import {
  HotkeyManager,
  activeBindings,
  bindings,
  chordBinding,
  type HotkeyAction,
  type Registrar,
} from "../src/core/hotkeys.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

function fakeRegistrar(taken: string[] = []) {
  const live = new Map<string, () => void>();
  const reg: Registrar = {
    register(acc, cb) {
      if (acc === "Bad+Key") throw new Error("invalid accelerator");
      if (taken.includes(acc) || live.has(acc)) return false;
      live.set(acc, cb);
      return true;
    },
    unregister(acc) {
      live.delete(acc);
    },
  };
  return { reg, live };
}

// A global shortcut eats the key, so a bare key would be untypeable in the chat input.
describe("activeBindings", () => {
  // Windows sends AltGr as Ctrl+Alt, so Ctrl+Alt+<character> would also eat AltGr letters.
  it("drops bare keys and Ctrl+Alt+character while the overlay has focus", () => {
    const all = bindings(DEFAULT_SETTINGS.hotkeys);
    expect(activeBindings(all, false)).toHaveLength(all.length);
    const names = activeBindings(all, true).map((b) => b.name);
    for (const gone of ["toggleIcon", "openChat", "toggleOverlay", "cancel", "nextDisplay"]) {
      expect(names).not.toContain(gone);
    }
    for (const kept of ["moveLeft", "moveUp", "approve", "deny", "showHistory", "copyChip1"]) {
      expect(names).toContain(kept);
    }
  });

  it("drops editing, caret and numpad keys, Alt+numpad and AltGr+character while the overlay has focus", () => {
    const keys = [
      "Home",
      "Left",
      "Shift+Home",
      "PageUp",
      "Alt+num5",
      "Space",
      "Tab",
      "Backspace",
      "num1",
      "Shift+numadd",
      "AltGr+C",
      "Plus",
      "Shift+Plus",
      "F13",
      "Shift+F2",
      "Ctrl+num1",
      "Ctrl+Left",
    ];
    const all = keys.map((accelerator) => ({
      name: accelerator,
      accelerator,
      action: { type: "openChat" } as const,
    }));
    expect(activeBindings(all, true).map((b) => b.accelerator)).toEqual([
      "F13",
      "Shift+F2",
      "Ctrl+num1",
      "Ctrl+Left",
    ]);
  });
});

describe("chordBinding", () => {
  const all = bindings(DEFAULT_SETTINGS.hotkeys);
  it("finds a Ctrl+Alt binding that is left out while the chat has focus", () => {
    expect(chordBinding(all, "Ctrl+Alt+X")?.action).toEqual({ type: "cancel" });
    expect(chordBinding(all, "Ctrl+Alt+O")?.action).toEqual({ type: "toggleOverlay" });
  });

  it("matches modifiers in any order and spelling", () => {
    const own = [
      { name: "cancel", accelerator: "Alt+Control+X", action: { type: "cancel" } as const },
    ];
    expect(chordBinding(own, "Ctrl+Alt+X")?.name).toBe("cancel");
  });

  it("ignores chords with no binding, and bindings that stay registered", () => {
    expect(chordBinding(all, "Ctrl+Alt+Q")).toBeNull();
    expect(chordBinding(all, "Ctrl+Alt+Left")).toBeNull();
  });
});

describe("bindings", () => {
  it("expands copyChip to 9 bindings and lists the rest", () => {
    const b = bindings(DEFAULT_SETTINGS.hotkeys);
    expect(b).toHaveLength(12 + 9);
    expect(b.find((x) => x.accelerator === "Ctrl+Shift+3")?.action).toEqual({
      type: "copyChip",
      n: 3,
    });
    expect(b.find((x) => x.name === "moveLeft")).toEqual({
      name: "moveLeft",
      accelerator: "Ctrl+Alt+Left",
      action: { type: "move", dir: "left" },
    });
    expect(b.some((x) => x.name === "scope")).toBe(false);
  });
});

describe("HotkeyManager", () => {
  it("registers on activate and runs actions", () => {
    const { reg, live } = fakeRegistrar();
    const ran: HotkeyAction[] = [];
    const m = new HotkeyManager(reg, (a) => ran.push(a));
    m.setBindings(bindings(DEFAULT_SETTINGS.hotkeys));
    expect(live.size).toBe(0);
    expect(m.activate()).toEqual([]);
    expect(live.size).toBe(21);
    live.get("Ctrl+Alt+C")!();
    expect(ran).toEqual([{ type: "openChat" }]);
    m.deactivate();
    expect(live.size).toBe(0);
  });

  it("reports taken and invalid keys and keeps the others", () => {
    const { reg, live } = fakeRegistrar(["Ctrl+Shift+O"]);
    const m = new HotkeyManager(reg, () => {});
    m.setBindings([
      { name: "toggleOverlay", accelerator: "Ctrl+Shift+O", action: { type: "toggleOverlay" } },
      { name: "openChat", accelerator: "Bad+Key", action: { type: "openChat" } },
      { name: "deny", accelerator: "Ctrl+Shift+N", action: { type: "deny" } },
    ]);
    expect(m.activate()).toEqual(["toggleOverlay (Ctrl+Shift+O)", "openChat (Bad+Key)"]);
    expect([...live.keys()]).toEqual(["Ctrl+Shift+N"]);
  });

  it("re-registers new bindings when active", () => {
    const { reg, live } = fakeRegistrar();
    const m = new HotkeyManager(reg, () => {});
    m.setBindings([{ name: "deny", accelerator: "A", action: { type: "deny" } }]);
    m.activate();
    m.setBindings([{ name: "deny", accelerator: "B", action: { type: "deny" } }]);
    expect([...live.keys()]).toEqual(["B"]);
    expect(m.active).toBe(true);
  });
});
