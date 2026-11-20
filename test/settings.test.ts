import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  defaultSettingsText,
  newSettingsText,
  parseSettings,
  settingsSchemaText,
} from "../src/core/settings.js";
import { PLAYER_ONLY_NOTE, SETTINGS_DICTIONARY } from "../src/core/settingsDictionary.js";

describe("parseSettings", () => {
  it("fills every default from an empty object", () => {
    const r = parseSettings("{}");
    expect(r).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
    expect(DEFAULT_SETTINGS.hotkeys.openChat).toBe("Ctrl+Alt+Enter");
    expect(DEFAULT_SETTINGS.hotkeys.showMore).toBe("Ctrl+`");
    expect(DEFAULT_SETTINGS.hotkeys.alwaysAllow).toBe("Ctrl+Alt+A");
    expect(DEFAULT_SETTINGS.hotkeys.cancel).toBe("Ctrl+Alt+X");
    expect(DEFAULT_SETTINGS.hotkeys.scope).toBe("game");
    expect(DEFAULT_SETTINGS.strip).toEqual({ lines: 2, keepChips: true, startAsIcon: false });
    expect(DEFAULT_SETTINGS.hotkeys.toggleIcon).toBe("Ctrl+Shift+Enter");
    expect(DEFAULT_SETTINGS.style).toEqual({ fontSize: 14, backgroundOpacity: 0.78 });
    expect(DEFAULT_SETTINGS.card).toEqual({ maxLines: 4, fadeSeconds: 20, width: 420 });
    expect(DEFAULT_SETTINGS.position).toEqual({
      anchor: "bottom-left",
      offsetX: 24,
      offsetY: 24,
      display: "primary",
    });
    const cli = { path: null, permissionMode: "auto", extraArgs: [] };
    expect(DEFAULT_SETTINGS).toMatchObject({ agent: "claude", resumeHours: 12 });
    expect(DEFAULT_SETTINGS.claude).toEqual({ ...cli, model: "sonnet" });
    expect(DEFAULT_SETTINGS.codex).toEqual({ ...cli, model: "gpt-6.1-terra" });
    // null leaves the model to the CLI's own config.
    const own = parseSettings('{"claude":{"model":null}}');
    expect(own.ok && own.settings.claude.model).toBeNull();
  });

  it("loads claude.resumeHours from an older file at the top level", () => {
    const old = parseSettings('{"claude":{"resumeHours":3,"path":"C:/c.exe"}}');
    expect(old.ok && old.settings.resumeHours).toBe(3);
    expect(old.ok && old.settings.claude.path).toBe("C:/c.exe");
    const both = parseSettings('{"resumeHours":5,"claude":{"resumeHours":3}}');
    expect(both.ok && both.settings.resumeHours).toBe(5);
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

describe("removed settings", () => {
  it("loads an older settings.json that still sets hotkeys.toggleOverlay", () => {
    const r = parseSettings('{"hotkeys":{"toggleOverlay":"Ctrl+Alt+O","openChat":"F13"}}');
    expect(r.ok && r.settings.hotkeys.openChat).toBe("F13");
  });
});

describe("settings dictionary", () => {
  type Node = {
    description?: string;
    readOnly?: boolean;
    default?: unknown;
    properties?: Record<string, Node>;
  };
  const schema = JSON.parse(settingsSchemaText()) as Node;
  const nodes = (n: Node, where = ""): [string, Node][] =>
    Object.entries(n.properties ?? {})
      .filter(([k]) => k !== "$schema")
      .flatMap(([k, c]) => {
        const p = where ? `${where}.${k}` : k;
        return [[p, c] as [string, Node], ...nodes(c, p)];
      });
  const all = nodes(schema);

  // Claude reads the schema to explain and change settings, so each one needs its meaning.
  it("describes every setting in settings.schema.json", () => {
    expect(all.filter(([, n]) => !n.description).map(([p]) => p)).toEqual([]);
  });

  it("has no entry for a setting that does not exist", () => {
    const paths = new Set(all.map(([p]) => p));
    expect(Object.keys(SETTINGS_DICTIONARY).filter((p) => !paths.has(p))).toEqual([]);
  });

  it("keeps each default next to its description", () => {
    const bio = all.find(([p]) => p === "hud.bioMin")![1];
    expect(bio.default).toBe(5_000_000);
    expect(bio.description).toMatch(/^Credits\./);
  });

  it("marks the settings that only the player may change", () => {
    const readOnly = all.filter(([, n]) => n.readOnly).map(([p]) => p);
    for (const p of ["claude", "claude.permissionMode", "claude.extraArgs", "approval.sound"])
      expect(readOnly).toContain(p);
    for (const p of ["journalDir", "hud.edMcpDataDir", "safety.blockWhenInDanger"])
      expect(readOnly).toContain(p);
    expect(readOnly).not.toContain("hud.bioMin");
    expect(readOnly).not.toContain("hotkeys.openChat");
    const claude = all.find(([p]) => p === "claude")![1];
    expect(claude.description).toContain(PLAYER_ONLY_NOTE);
  });
});
