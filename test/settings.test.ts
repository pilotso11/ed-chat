import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, defaultSettingsText, parseSettings } from "../src/core/settings.js";

describe("parseSettings", () => {
  it("fills every default from an empty object", () => {
    const r = parseSettings("{}");
    expect(r).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
    expect(DEFAULT_SETTINGS.hotkeys.openChat).toBe("Ctrl+Shift+Space");
    expect(DEFAULT_SETTINGS.hotkeys.scope).toBe("game");
    expect(DEFAULT_SETTINGS.strip).toEqual({ lines: 2, keepChips: true, startAsIcon: false });
    expect(DEFAULT_SETTINGS.hotkeys.toggleIcon).toBe("`");
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
    const r = parseSettings('{"card":{"maxLines":9}}');
    expect(!r.ok && r.error).toMatch(/^card\.maxLines: /);
  });

  it("requires {n} in copyChip", () => {
    const r = parseSettings('{"hotkeys":{"copyChip":"Ctrl+Shift+1"}}');
    expect(!r.ok && r.error).toMatch(/^hotkeys\.copyChip: /);
  });

  it("writes defaults that parse back to the defaults", () => {
    expect(parseSettings(defaultSettingsText())).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
  });
});
