import { describe, expect, it } from "vitest";
import {
  HotkeyManager,
  activeBindings,
  bindings,
  chordBinding,
  chipKeyLabel,
  keyRows,
  type HotkeyAction,
  type Registrar,
} from "../src/core/hotkeys.js";
import { DEFAULT_SETTINGS, SettingsSchema } from "../src/core/settings.js";

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
    for (const gone of [
      "cancel",
      "nextDisplay",
      "approve",
      "deny",
      "alwaysAllow",
      "showHistory",
      "copyChip1",
    ]) {
      expect(names).not.toContain(gone);
    }
    // The chat input reports these as real Ctrl+Alt chords, so they still work there.
    const chords: [string, string][] = [
      ["Ctrl+Alt+Y", "approve"],
      ["Ctrl+Alt+N", "deny"],
      ["Ctrl+Alt+A", "alwaysAllow"],
      ["Ctrl+Alt+H", "showHistory"],
      ["Ctrl+Alt+1", "copyChip1"],
    ];
    for (const [chord, name] of chords) expect(chordBinding(all, chord)?.name).toBe(name);
    for (const kept of ["openChat", "toggleIcon", "moveLeft", "moveUp"]) {
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
    expect(chordBinding(all, "Ctrl+Alt+M")?.action).toEqual({ type: "nextDisplay" });
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
    expect(b).toHaveLength(20 + 9);
    expect(b.find((x) => x.accelerator === "Ctrl+Alt+-")?.action).toEqual({
      type: "clearBookmark",
    });
    expect(b.find((x) => x.accelerator === "Ctrl+Alt+3")?.action).toEqual({
      type: "copyChip",
      n: 3,
    });
    expect(b.find((x) => x.name === "moveLeft")).toEqual({
      name: "moveLeft",
      accelerator: "Ctrl+Alt+Left",
      action: { type: "move", dir: "left" },
    });
    expect(b.some((x) => x.name === "scope")).toBe(false);
    // The showMore key steps through the reply, the whole reply and the chat.
    expect(b.find((x) => x.name === "showMore")?.action).toEqual({ type: "step" });
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
    expect(live.size).toBe(29);
    live.get("Ctrl+Alt+Enter")!();
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

  it("gives each default action its own key", () => {
    const keys = bindings(DEFAULT_SETTINGS.hotkeys).map((b) => b.accelerator.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  // A player who kept the old toggleIcon key gets the new openChat default on the same key,
  // written the same way (as a 0.1.0 settings.json has it) or not.
  for (const key of ["Ctrl+Alt+Enter", "Alt+Ctrl+Enter"]) {
    it(`reports a key set for two actions, and keeps it for the first (${key})`, () => {
      const { reg, live } = fakeRegistrar();
      const ran: HotkeyAction[] = [];
      const m = new HotkeyManager(reg, (a) => ran.push(a));
      const h = SettingsSchema.parse({ hotkeys: { toggleIcon: key } }).hotkeys;
      m.setBindings(bindings(h));
      expect(m.activate()).toEqual([`toggleIcon (${key}): also set for openChat`]);
      // No other app has the key: it registered, for openChat.
      expect(m.failedKeys).toEqual([]);
      expect(m.duplicateKeys).toEqual([{ name: "toggleIcon", accelerator: key }]);
      live.get("Ctrl+Alt+Enter")!();
      expect(ran).toEqual([{ type: "openChat" }]);
      // Only the row of the action that lost the key is marked.
      const rows = keyRows(h, m.failedKeys, m.duplicateKeys);
      expect(rows.find((r) => r.label === "Icon mode")?.failed).toEqual([key]);
      expect(rows.find((r) => r.label === "Open chat directly")?.failed).toEqual([]);
    });
  }

  it("does not report a key that one action lists twice", () => {
    const { reg } = fakeRegistrar();
    const m = new HotkeyManager(reg, () => {});
    const h = SettingsSchema.parse({
      hotkeys: { openChat: ["Ctrl+Alt+Enter", "Ctrl+Alt+Enter"] },
    }).hotkeys;
    m.setBindings(bindings(h));
    expect(m.activate()).toEqual([]);
    expect(m.duplicateKeys).toEqual([]);
  });

  // Each row of the keys card matches the actions behind it, chips and arrows included.
  it.each([
    // The chip keys register last, so the chip loses here.
    [{ hudMode: "Ctrl+Alt+5" }, "Copy chip", "Panel mode"],
    [{ hudToggle: "Ctrl+Alt+Up" }, "Activity panel", "Move overlay"],
    [{ hudMove: "Ctrl+Alt+M" }, "Move panel (then arrows)", "Next monitor"],
  ])("marks only the row that lost a shared key (%o)", (set, loser, winner) => {
    const { reg } = fakeRegistrar();
    const m = new HotkeyManager(reg, () => {});
    const h = SettingsSchema.parse({ hotkeys: set }).hotkeys;
    m.setBindings(bindings(h));
    m.activate();
    const rows = keyRows(h, m.failedKeys, m.duplicateKeys);
    expect(rows.find((r) => r.label === loser)?.failed).toEqual(Object.values(set));
    expect(rows.find((r) => r.label === winner)?.failed).toEqual([]);
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

describe("key lists", () => {
  const hk = (h: object) => SettingsSchema.parse({ hotkeys: h }).hotkeys;

  it("binds every key in a list to the same action", () => {
    const b = bindings(hk({ openChat: ["Ctrl+Alt+C", "F13"] })).filter(
      (x) => x.name === "openChat",
    );
    expect(b.map((x) => x.accelerator)).toEqual(["Ctrl+Alt+C", "F13"]);
  });

  it("adds Ctrl+numpad copy keys when copyChipNumpad is on", () => {
    const keys = (h: object) =>
      bindings(hk(h))
        .filter((x) => x.action.type === "copyChip")
        .map((x) => x.accelerator);
    expect(keys({})).not.toContain("Ctrl+num1");
    expect(keys({ copyChipNumpad: true })).toEqual(
      expect.arrayContaining(["Ctrl+Alt+1", "Ctrl+num9"]),
    );
    expect(chipKeyLabel(hk({ copyChipNumpad: true }))).toBe("Ctrl+Alt+1–9 / Ctrl+num1–9");
  });

  it("drops keys without a modifier in always scope, so other apps keep them", () => {
    const all = bindings(hk({ toggleIcon: "`" }));
    const always = activeBindings(all, false, "always").map((b) => b.accelerator);
    expect(always).not.toContain("`");
    expect(activeBindings(all, false, "game").map((b) => b.accelerator)).toContain("`");
  });

  it("lists the keys for the keys card and marks the taken ones", () => {
    const rows = keyRows(DEFAULT_SETTINGS.hotkeys, ["Ctrl+Alt+Enter", "Ctrl+Alt+3", "Ctrl+Alt+Up"]);
    expect(rows[0]).toEqual({
      label: "Reply → whole reply → chat",
      keys: "Ctrl+`",
      failed: [],
      unused: [],
    });
    expect(rows[1]).toEqual({
      label: "Open chat directly",
      keys: "Ctrl+Alt+Enter",
      failed: ["Ctrl+Alt+Enter"],
      unused: [],
    });
    expect(rows[2]).toEqual({
      label: "Copy chip",
      keys: "Ctrl+Alt+1–9",
      failed: ["Ctrl+Alt+3"],
      unused: [],
    });
    expect(rows.find((r) => r.label === "Move overlay")).toEqual({
      label: "Move overlay",
      keys: "Ctrl+Alt+Arrows",
      failed: ["Ctrl+Alt+Up"],
      unused: [],
    });
  });

  it("marks keys that always scope never registers", () => {
    const h = hk({ scope: "always", toggleIcon: "`" });
    const icon = keyRows(h, []).find((r) => r.label === "Icon mode");
    expect(icon?.unused).toEqual(["`"]);
    expect(keyRows(DEFAULT_SETTINGS.hotkeys, []).every((r) => r.unused.length === 0)).toBe(true);
  });
});
