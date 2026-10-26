import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, defaultSettingsText } from "../src/core/settings.js";
import {
  HistoryStore,
  SettingsStore,
  StateStore,
  effectivePosition,
  savePosition,
  type LoadResult,
} from "../src/core/stores.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "ed-chat-"));

describe("SettingsStore", () => {
  // settings.json holds only the player's overrides, so new defaults reach existing installs.
  it("writes only the schema link on first run, so every value comes from the defaults", async () => {
    const file = path.join(await tmp(), "sub", "settings.json");
    const s = new SettingsStore(file);
    expect(await s.load()).toEqual({ changed: true, error: null });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ $schema: "./settings.schema.json" });
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
    expect(await s.load()).toEqual({ changed: false, error: null });
  });

  it("rewrites the defaults reference when settings.json already exists", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "settings.json"), '{"card":{"maxLines":5}}');
    await writeFile(path.join(dir, "settings.defaults.json"), "stale");
    expect(await new SettingsStore(path.join(dir, "settings.json")).load()).toEqual({
      changed: true,
      error: null,
    });
    expect(await readFile(path.join(dir, "settings.defaults.json"), "utf8")).toBe(
      defaultSettingsText(),
    );
  });

  it("reports a defaults reference it cannot write, and still loads the settings", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "settings.json"), '{"card":{"maxLines":5}}');
    await mkdir(path.join(dir, "settings.defaults.json"));
    const s = new SettingsStore(path.join(dir, "settings.json"));
    const r = await s.load();
    expect(r.changed).toBe(true);
    expect(r.error).toMatch(/^⚠ settings\.defaults\.json: /);
    expect(s.settings.card.maxLines).toBe(5);
  });

  it("counts only a bad settings.json as broken, not a failed reference file", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "settings.json"), "{");
    const bad = new SettingsStore(path.join(dir, "settings.json"));
    await bad.load();
    expect(bad.broken).toBe(true);
    const dir2 = await tmp();
    await writeFile(path.join(dir2, "settings.json"), "{}");
    await mkdir(path.join(dir2, "settings.defaults.json"));
    const ok = new SettingsStore(path.join(dir2, "settings.json"));
    expect((await ok.load()).error).not.toBeNull();
    expect(ok.broken).toBe(false);
  });

  it("adds the schema link to an existing settings.json and keeps its layout", async () => {
    const file = path.join(await tmp(), "settings.json");
    await writeFile(file, '{\n  "card": { "maxLines": 5 }\n}\n');
    const s = new SettingsStore(file);
    expect(await s.load()).toEqual({ changed: true, error: null });
    expect(await readFile(file, "utf8")).toBe(
      '{\n  "$schema": "./settings.schema.json",\n  "card": { "maxLines": 5 }\n}\n',
    );
    expect(s.settings.card.maxLines).toBe(5);
    expect(await s.load()).toEqual({ changed: false, error: null });
  });

  it("adds the schema link to an empty object, and leaves a linked file alone", async () => {
    const dir = await tmp();
    const empty = path.join(dir, "settings.json");
    await writeFile(empty, "{}");
    await new SettingsStore(empty).load();
    expect(JSON.parse(await readFile(empty, "utf8"))).toEqual({
      $schema: "./settings.schema.json",
    });
    const own = path.join(await tmp(), "settings.json");
    await writeFile(own, '{"$schema":"x.json"}');
    await new SettingsStore(own).load();
    expect(await readFile(own, "utf8")).toBe('{"$schema":"x.json"}');
  });

  it("names the reference file that could not be written", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "settings.json"), "{}");
    await mkdir(path.join(dir, "settings.schema.json"));
    const r = await new SettingsStore(path.join(dir, "settings.json")).load();
    expect(r.error).toMatch(/^⚠ settings.schema.json: /);
  });

  it("sets one value and keeps the rest of the file", async () => {
    const file = path.join(await tmp(), "settings.json");
    await writeFile(file, '{ "$schema": "./settings.schema.json", "card": { "maxLines": 5 } }');
    const s = new SettingsStore(file);
    await s.load();
    await s.set("claude", "permissionMode", "default");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      $schema: "./settings.schema.json",
      card: { maxLines: 5 },
      claude: { permissionMode: "default" },
    });
  });

  it("writes the schema next to settings.json", async () => {
    const dir = await tmp();
    await new SettingsStore(path.join(dir, "settings.json")).load();
    const schema = JSON.parse(await readFile(path.join(dir, "settings.schema.json"), "utf8"));
    expect(schema.properties.$schema).toEqual({ type: "string" });
    expect(schema.properties.hotkeys.properties.openChat.default).toBe("Ctrl+Alt+C");
  });

  it("accepts a file saved with a UTF-8 BOM", async () => {
    const file = path.join(await tmp(), "settings.json");
    await writeFile(file, '\uFEFF{"card":{"maxLines":5}}');
    const s = new SettingsStore(file);
    expect(await s.load()).toEqual({ changed: true, error: null });
    expect(s.settings.card.maxLines).toBe(5);
  });

  it("keeps the last good settings on a bad edit", async () => {
    const file = path.join(await tmp(), "settings.json");
    await writeFile(file, '{"card":{"maxLines":6}}');
    const s = new SettingsStore(file);
    await s.load();
    await writeFile(file, '{"card":');
    const r = await s.load();
    expect(r.changed).toBe(false);
    expect(r.error).toMatch(/^⚠ settings\.json: not valid JSON/);
    expect(s.settings.card.maxLines).toBe(6);
    await writeFile(file, '{"card":{"maxLines":3}}');
    expect(await s.load()).toEqual({ changed: true, error: null });
    expect(s.settings.card.maxLines).toBe(3);
  });
});

describe("SettingsStore.watch", () => {
  it("reports a failed reload instead of dropping it", async () => {
    const file = path.join(await tmp(), "settings.json");
    await writeFile(file, "{}");
    class Failing extends SettingsStore {
      override load(): Promise<LoadResult> {
        return Promise.reject(new Error("disk gone"));
      }
    }
    const s = new Failing(file);
    const results: LoadResult[] = [];
    s.watch((r) => results.push(r), 20);
    try {
      await new Promise((r) => setTimeout(r, 100));
      await writeFile(file, '{"card":{"maxLines":3}}');
      const end = Date.now() + 5_000;
      while (!results.length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      expect(results[0]).toEqual({ changed: false, error: "⚠ settings.json: disk gone" });
    } finally {
      s.unwatch();
    }
  });
});

describe("position precedence", () => {
  const base = DEFAULT_SETTINGS.position;
  const moved = { ...base, anchor: "bottom-left" as const };

  it("uses the saved position while settings are unchanged", () => {
    const saved = savePosition(base, {}, moved);
    expect(effectivePosition(base, saved).position).toEqual(moved);
  });

  it("uses settings once their position changes, and drops the saved one", () => {
    const saved = savePosition(base, {}, moved);
    const edited = { ...base, offsetX: 50 };
    expect(effectivePosition(edited, saved)).toEqual({ position: edited, saved: {} });
  });

  it("uses settings when nothing is saved", () => {
    expect(effectivePosition(base, {}).position).toEqual(base);
  });
});

describe("StateStore", () => {
  it("round-trips and ignores a broken file", async () => {
    const file = path.join(await tmp(), "state.json");
    const st = new StateStore(file);
    expect(await st.read()).toEqual({});
    const saved = savePosition(DEFAULT_SETTINGS.position, {}, DEFAULT_SETTINGS.position);
    await st.write(saved);
    expect(await st.read()).toEqual(saved);
    await st.write({ ...saved, iconMode: true });
    expect((await st.read()).iconMode).toBe(true);
    await writeFile(file, "{");
    expect(await st.read()).toEqual({});
  });
});

describe("HistoryStore", () => {
  it("writes one JSONL file per session", async () => {
    const dir = await tmp();
    let t = new Date("2026-10-23T10:00:00.000Z");
    const h = new HistoryStore(dir, () => t);
    h.newSession();
    await h.append({ role: "user", text: "a" });
    t = new Date("2026-10-23T11:00:00.000Z");
    h.newSession();
    await h.append({ role: "assistant", text: "b" });
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["2026-10-23T10-00-00-000Z.jsonl", "2026-10-23T11-00-00-000Z.jsonl"]);
    const line = JSON.parse((await readFile(path.join(dir, files[0]!), "utf8")).trim());
    expect(line).toEqual({ at: "2026-10-23T10:00:00.000Z", role: "user", text: "a" });
  });
});
