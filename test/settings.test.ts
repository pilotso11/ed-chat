import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  defaultSettingsText,
  newSettingsText,
  parseSettings,
} from "../src/core/settings.js";

describe("parseSettings", () => {
  it("fills every default from an empty object", () => {
    const r = parseSettings("{}");
    expect(r).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
    expect(DEFAULT_SETTINGS.hotkeys.openChat).toBe("Ctrl+Alt+C");
    expect(DEFAULT_SETTINGS.hotkeys.toggleOverlay).toBe("Ctrl+Alt+O");
    expect(DEFAULT_SETTINGS.hotkeys.cancel).toBe("Ctrl+Alt+X");
    expect(DEFAULT_SETTINGS.hotkeys.scope).toBe("game");
    expect(DEFAULT_SETTINGS.strip).toEqual({ lines: 2, keepChips: true, startAsIcon: false });
    expect(DEFAULT_SETTINGS.hotkeys.toggleIcon).toBe("`");
    expect(DEFAULT_SETTINGS.style).toEqual({ fontSize: 14, backgroundOpacity: 0.78 });
    expect(DEFAULT_SETTINGS.card).toEqual({ maxLines: 4, fadeSeconds: 20, width: 420 });
    expect(DEFAULT_SETTINGS.position).toEqual({
      anchor: "bottom-left",
      offsetX: 24,
      offsetY: 24,
      display: "primary",
    });
    expect(DEFAULT_SETTINGS.claude).toEqual({ path: null, permissionMode: "auto", extraArgs: [] });
  });

  it("keeps defaults next to a partial override", () => {
    const r = parseSettings('{"card":{"maxLines":6}}');
    expect(r.ok && r.settings.card).toEqual({ maxLines: 6, fadeSeconds: 20, width: 420 });
  });

  it("reports invalid JSON", () => {
    const r = parseSettings("{");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^not valid JSON/);
  });

  it("reports an unknown key", () => {
    const r = parseSettings('{"foo":1}');
    expect(!r.ok && r.error).toContain("foo");
  });

  it("reports a value out of range with its path", () => {
    const r = parseSettings('{"card":{"maxLines":11}}');
    expect(!r.ok && r.error).toMatch(/^card\.maxLines: /);
  });

  it("keeps backgroundOpacity between 0 and 1", () => {
    expect(parseSettings('{"style":{"backgroundOpacity":0}}').ok).toBe(true);
    const r = parseSettings('{"style":{"backgroundOpacity":1.5}}');
    expect(!r.ok && r.error).toMatch(/^style\.backgroundOpacity: /);
  });

  it("requires {n} in copyChip", () => {
    const r = parseSettings('{"hotkeys":{"copyChip":"Ctrl+Shift+1"}}');
    expect(!r.ok && r.error).toMatch(/^hotkeys\.copyChip: /);
  });

  it("writes defaults that parse back to the defaults", () => {
    expect(parseSettings(defaultSettingsText())).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
  });
});

describe("settings defaults", () => {
  // Every setting needs a default in code, so settings.json can stay empty and a later
  // release can change a default for everyone who has not set that key.
  it("gives every setting a default", () => {
    const missing: string[] = [];
    const walk = (schema: unknown, where: string): void => {
      const def = (schema as { def: { type: string; innerType?: unknown; shape?: object } }).def;
      if (def.type === "object") {
        for (const [k, v] of Object.entries(def.shape!)) walk(v, where ? `${where}.${k}` : k);
        return;
      }
      if (def.type === "prefault") return walk(def.innerType, where);
      if (def.type !== "default") missing.push(where);
    };
    walk(SettingsSchema, "");
    expect(missing).toEqual([]);
  });

  it("accepts one key or a list of keys", () => {
    const r = parseSettings(
      '{"hotkeys":{"openChat":["Ctrl+Alt+C","F13"],"copyChip":["Ctrl+Shift+{n}","F{n}"]}}',
    );
    expect(r.ok && r.settings.hotkeys.openChat).toEqual(["Ctrl+Alt+C", "F13"]);
    expect(parseSettings('{"hotkeys":{"openChat":[]}}').ok).toBe(false);
    expect(parseSettings('{"hotkeys":{"copyChip":["Ctrl+Shift+{n}","F1"]}}').ok).toBe(false);
  });

  it("ignores the $schema link", () => {
    expect(parseSettings('{"$schema":"./settings.schema.json"}')).toEqual({
      ok: true,
      settings: DEFAULT_SETTINGS,
    });
  });

  it("starts with an empty settings file that parses to the defaults", () => {
    expect(parseSettings(newSettingsText())).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
  });
});
