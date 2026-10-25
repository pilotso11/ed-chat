import { describe, expect, it } from "vitest";
import {
  HotkeyManager,
  activeBindings,
  bindings,
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
  it("drops keys without a modifier while the overlay has focus", () => {
    const all = bindings(DEFAULT_SETTINGS.hotkeys);
    expect(activeBindings(all, false)).toHaveLength(all.length);
    const focused = activeBindings(all, true);
    expect(focused.some((b) => b.name === "toggleIcon")).toBe(false);
    expect(focused.some((b) => b.name === "openChat")).toBe(true);
    expect(focused).toHaveLength(all.length - 1);
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
