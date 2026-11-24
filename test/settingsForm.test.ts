import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsSchema } from "../src/core/settings.js";
import {
  GENERAL,
  acceleratorFromKey,
  allFields,
  chipPatternFromKey,
  keyProblems,
  resetAll,
  saveText,
  settingsForm,
  textWithChanges,
  type FormField,
  type KeyInput,
} from "../src/core/settingsForm.js";
import { changesArg } from "../src/core/guards.js";
import { getAt, setAt } from "../src/core/paths.js";

const form = settingsForm();
const fields = allFields(form);
const fieldAt = (path: string): FormField => {
  const f = fields.find((x) => x.path === path);
  if (!f) throw new Error(`no field ${path}`);
  return f;
};

/** Every leaf setting in the schema, as dotted paths. */
function leaves(o: unknown, at = ""): string[] {
  if (!o || typeof o !== "object" || Array.isArray(o)) return [at];
  // A record of values (mining targets) is one setting.
  if (at === "hud.mining.targets") return [at];
  return Object.entries(o).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k));
}

describe("settings form", () => {
  it("has a field for every setting, each once", () => {
    const paths = fields.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect([...paths].sort()).toEqual(leaves(DEFAULT_SETTINGS).sort());
  });

  it("puts the top-level settings in General, first, then the groups in order", () => {
    expect(form[0]!.path).toBe(GENERAL);
    expect(form[0]!.fields.map((f) => f.path)).toEqual(["agent", "resumeHours", "journalDir"]);
    expect(form.map((s) => s.path).slice(0, 4)).toEqual([GENERAL, "style", "strip", "card"]);
    const hud = form.find((s) => s.path === "hud")!;
    expect(hud.title).toBe("Activity panel");
    expect(hud.sections.map((s) => s.path)).toContain("hud.mining");
  });

  it("gives each field the control its type needs", () => {
    expect(fieldAt("strip.keepChips").kind).toEqual({ type: "boolean" });
    expect(fieldAt("style.theme").kind).toMatchObject({ type: "choice" });
    expect(fieldAt("strip.lines").kind).toEqual({ type: "choice", options: [1, 2] });
    expect(fieldAt("card.maxLines").kind).toEqual({
      type: "number",
      integer: true,
      min: 2,
      max: 10,
    });
    // No upper bound: the schema's safe-integer bound is not shown.
    expect(fieldAt("hud.valuableMin").kind).toEqual({
      type: "number",
      integer: true,
      min: 0,
      max: undefined,
    });
    expect(fieldAt("claude.model").kind).toEqual({ type: "text", nullable: true });
    expect(fieldAt("hotkeys.openChat").kind).toEqual({ type: "keys", chip: false });
    expect(fieldAt("hotkeys.copyChip").kind).toEqual({ type: "keys", chip: true });
    expect(fieldAt("position.display").kind).toEqual({ type: "display" });
    expect(fieldAt("claude.extraArgs").kind).toEqual({ type: "list" });
    expect(fieldAt("hud.mining.targets").kind).toEqual({ type: "json" });
  });

  it("labels, describes and marks the player-only fields", () => {
    expect(fieldAt("hotkeys.showHistory").label).toBe("Show history");
    expect(fieldAt("hud.edMcpDataDir").label).toBe("ed-mcp data folder");
    expect(fieldAt("style.fontSize").help).toMatch(/Scales the whole overlay/);
    expect(fieldAt("style.fontSize").default).toBe(14);
    expect(fieldAt("hotkeys.approve").playerOnly).toBe(true);
    expect(fieldAt("claude.model").playerOnly).toBe(true);
    expect(fieldAt("hud.edMcpDataDir").playerOnly).toBe(true);
    expect(fieldAt("style.theme").playerOnly).toBe(false);
  });
});

describe("saving", () => {
  const FILE = '{\n  "$schema": "./settings.schema.json",\n  "card": { "width": 500 }\n}\n';

  it("writes a changed value and keeps the rest of the file", () => {
    const text = textWithChanges(FILE, [{ path: "style.theme", value: "blue" }]);
    expect(JSON.parse(text)).toEqual({
      $schema: "./settings.schema.json",
      card: { width: 500 },
      style: { theme: "blue" },
    });
  });

  it("takes a value back to its default out of the file, and its group when empty", () => {
    const text = textWithChanges(FILE, [{ path: "card.width", value: 420 }]);
    expect(JSON.parse(text)).toEqual({ $schema: "./settings.schema.json" });
  });

  it("refuses a file that is not an object", () => {
    expect(() => textWithChanges("[]", [])).toThrow(/not an object/);
    expect(saveText("nope", [])).toMatchObject({ ok: false });
  });

  it("checks the result against the schema, and says which setting is wrong", () => {
    expect(saveText(FILE, [{ path: "card.maxLines", value: 99 }])).toMatchObject({
      ok: false,
      path: "card.maxLines",
    });
  });

  it("refuses a path that is not a setting", () => {
    for (const path of ["__proto__.polluted", "constructor.prototype.x", "card", "nope"])
      expect(saveText(FILE, [{ path, value: 1 }])).toMatchObject({ ok: false, path });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns the settings and the player-only values as written", () => {
    const r = saveText(FILE, [
      { path: "style.theme", value: "green" },
      { path: "claude.model", value: "opus" },
      { path: "hotkeys.approve", value: DEFAULT_SETTINGS.hotkeys.approve },
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(r.settings.style.theme).toBe("green");
    expect(r.playerOnly).toEqual([
      { path: "claude.model", value: "opus" },
      // A default is not written, so it is trusted as absent.
      { path: "hotkeys.approve", value: undefined },
    ]);
  });

  it("resets every setting to its default", () => {
    const changes = resetAll(form);
    expect(changes).toHaveLength(fields.length);
    const r = saveText(FILE, changes);
    if (!r.ok) throw new Error(r.error);
    expect(JSON.parse(r.text)).toEqual({ $schema: "./settings.schema.json" });
    expect(r.settings).toEqual(SettingsSchema.parse({}));
  });
});

describe("paths", () => {
  it("reads and sets nested values", () => {
    const o: Record<string, unknown> = {};
    setAt(o, "a.b.c", 1);
    expect(getAt(o, "a.b.c")).toBe(1);
    expect(getAt(o, "a.x.c")).toBeUndefined();
    setAt(o, "a.b.d", 2);
    setAt(o, "a.b.c", undefined);
    expect(o).toEqual({ a: { b: { d: 2 } } });
    setAt(o, "a.b.d", undefined);
    expect(o).toEqual({});
    // Deleting under a group that is not there changes nothing.
    setAt(o, "q.r", undefined);
    expect(o).toEqual({});
  });
});

describe("changes over IPC", () => {
  it("takes a list of paths and values only", () => {
    expect(changesArg([{ path: "a", value: 1 }, { path: "b" }])).toEqual([
      { path: "a", value: 1 },
      { path: "b", value: undefined },
    ]);
    expect(changesArg("x")).toBeNull();
    expect(changesArg([{ value: 1 }])).toBeNull();
    expect(changesArg([null])).toBeNull();
  });
});

describe("hotkey problems", () => {
  const h = DEFAULT_SETTINGS.hotkeys;

  it("finds none in the defaults", () => {
    expect(keyProblems(h, [])).toEqual({});
  });

  it("marks both actions that share a key", () => {
    const p = keyProblems({ ...h, deny: "Ctrl+Alt+Y" }, []);
    expect(p["hotkeys.deny"]).toMatch(/Ctrl\+Alt\+Y is also Approve/);
    expect(p["hotkeys.approve"]).toMatch(/is also Deny/);
  });

  it("matches keys as Windows does, whatever the case and modifier order", () => {
    const p = keyProblems({ ...h, deny: "alt+control+y" }, []);
    expect(p["hotkeys.deny"]).toBeDefined();
  });

  it("marks a key that another app holds", () => {
    expect(keyProblems(h, ["ctrl+alt+h"])).toEqual({
      "hotkeys.showHistory": "Ctrl+Alt+H is in use by another app",
    });
  });

  it("reports a chip key once, and a chip key that clashes", () => {
    const p = keyProblems({ ...h, bookmark: "Ctrl+Alt+3" }, ["Ctrl+Alt+1", "Ctrl+Alt+2"]);
    expect(p["hotkeys.copyChip"]).toBe(
      "Ctrl+Alt+1 is in use by another app; Ctrl+Alt+2 is in use by another app; " +
        "Ctrl+Alt+3 is also Bookmark",
    );
    expect(p["hotkeys.bookmark"]).toBe("Ctrl+Alt+3 is also Copy chip");
  });

  it("marks the numpad chip key set twice", () => {
    const p = keyProblems({ ...h, copyChip: ["Ctrl+num{n}"], copyChipNumpad: true }, []);
    expect(p["hotkeys.copyChip"]).toContain("Ctrl+num{n} is set twice");
  });

  it("does not fail on a chip key without {n}", () => {
    expect(() => keyProblems({ ...h, copyChip: "Ctrl+Alt+Q" }, [])).not.toThrow();
  });
});

describe("key capture", () => {
  const k = (key: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
    key,
    code,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    ...mods,
  });
  const ca = { ctrl: true, alt: true };

  it("waits while only modifiers are held", () => {
    expect(acceleratorFromKey(k("Control", "ControlLeft", { ctrl: true }))).toBeNull();
    expect(acceleratorFromKey(k("Alt", "AltRight", ca))).toBeNull();
    expect(acceleratorFromKey(k("AltGraph", "AltRight", ca))).toBeNull();
  });

  it("names keys as Electron does", () => {
    expect(acceleratorFromKey(k("x", "KeyX", ca))).toBe("Ctrl+Alt+X");
    expect(acceleratorFromKey(k("Enter", "Enter", ca))).toBe("Ctrl+Alt+Enter");
    expect(acceleratorFromKey(k("ArrowUp", "ArrowUp", ca))).toBe("Ctrl+Alt+Up");
    expect(acceleratorFromKey(k("F13", "F13"))).toBe("F13");
    expect(acceleratorFromKey(k("`", "Backquote", { ctrl: true }))).toBe("Ctrl+`");
    expect(acceleratorFromKey(k("2", "Numpad2", { ctrl: true }))).toBe("Ctrl+num2");
    expect(acceleratorFromKey(k("+", "NumpadAdd", { ctrl: true }))).toBe("Ctrl+numadd");
    expect(acceleratorFromKey(k("x", "KeyX", { meta: true, shift: true }))).toBe("Shift+Super+X");
  });

  it("takes a digit and punctuation from the key's position, a letter from the layout", () => {
    // Shift+1 types "!", but the hotkey is Shift+1.
    expect(acceleratorFromKey(k("!", "Digit1", { shift: true }))).toBe("Shift+1");
    expect(acceleratorFromKey(k("_", "Minus", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+-");
    // AZERTY: the key at Q's place types A.
    expect(acceleratorFromKey(k("a", "KeyQ", ca))).toBe("Ctrl+Alt+A");
    // AltGr+Q types @ on a German layout: the key's letter, from its position.
    expect(acceleratorFromKey(k("@", "KeyQ", ca))).toBe("Ctrl+Alt+Q");
    expect(acceleratorFromKey(k("+", "", ca))).toBe("Ctrl+Alt+Plus");
    expect(acceleratorFromKey(k("ü", "", ca))).toBe("Ctrl+Alt+Ü");
    expect(acceleratorFromKey(k("Unidentified", ""))).toBeNull();
  });

  it("turns a digit into {n} for the chip keys", () => {
    expect(chipPatternFromKey(k("3", "Digit3", ca))).toBe("Ctrl+Alt+{n}");
    expect(chipPatternFromKey(k("5", "Numpad5", { ctrl: true }))).toBe("Ctrl+num{n}");
    expect(chipPatternFromKey(k("0", "Digit0", ca))).toBeNull();
    expect(chipPatternFromKey(k("x", "KeyX", ca))).toBeNull();
    expect(chipPatternFromKey(k("Shift", "ShiftLeft", { shift: true }))).toBeNull();
  });
});
