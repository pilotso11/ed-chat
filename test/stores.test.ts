import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
} from "../src/core/stores.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "ed-overlay-"));

describe("SettingsStore", () => {
  it("writes defaults on first run", async () => {
    const file = path.join(await tmp(), "sub", "settings.json");
    const s = new SettingsStore(file);
    expect(await s.load()).toEqual({ changed: true, error: null });
    expect(await readFile(file, "utf8")).toBe(defaultSettingsText());
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
    expect(await s.load()).toEqual({ changed: false, error: null });
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
