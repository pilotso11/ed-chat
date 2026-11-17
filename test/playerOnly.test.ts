import { describe, expect, it } from "vitest";
import {
  describeChanges,
  keepPlayerOnly,
  playerOnlyChanges,
  restorePaths,
} from "../src/core/playerOnly.js";
import { DEFAULT_SETTINGS, parseSettings, type Settings } from "../src/core/settings.js";

const parsed = (text: string): Settings => {
  const r = parseSettings(text);
  if (!r.ok) throw new Error(r.error);
  return r.settings;
};

describe("player-only settings", () => {
  const extra = parsed('{"claude":{"extraArgs":["--x"]},"hud":{"edMcpDataDir":"D:/x"}}');

  it("finds a change to a player-only setting, and only those", () => {
    expect(playerOnlyChanges(DEFAULT_SETTINGS, extra)).toEqual(["claude", "hud.edMcpDataDir"]);
    expect(playerOnlyChanges(DEFAULT_SETTINGS, parsed('{"hud":{"bioMin":2000000}}'))).toEqual([]);
    expect(playerOnlyChanges(DEFAULT_SETTINGS, parsed('{"journalDir":"D:/j"}'))).toEqual([
      "journalDir",
    ]);
  });

  it("applies the other changes and keeps the player-only ones as they were", () => {
    const next = parsed('{"claude":{"path":"C:/evil.exe"},"hud":{"bioMin":2000000}}');
    const kept = keepPlayerOnly(next, DEFAULT_SETTINGS);
    expect(kept.hud.bioMin).toBe(2_000_000);
    expect(kept.claude).toEqual(DEFAULT_SETTINGS.claude);
    expect(next.claude.path).toBe("C:/evil.exe");
  });

  it("describes each changed value for the question", () => {
    expect(describeChanges(DEFAULT_SETTINGS, extra, ["claude", "hud.edMcpDataDir"])).toEqual([
      'claude.extraArgs: [] → ["--x"]',
      'hud.edMcpDataDir: null → "D:/x"',
    ]);
  });

  it("undoes the change in the file and keeps the rest", () => {
    const earlier = '{"claude":{"permissionMode":"default"}}';
    const now = '{"claude":{"permissionMode":"auto","extraArgs":["--x"]},"hud":{"bioMin":1}}';
    const back = JSON.parse(restorePaths(now, earlier, ["claude"])) as unknown;
    expect(back).toEqual({ claude: { permissionMode: "default" }, hud: { bioMin: 1 } });
  });

  it("removes a setting the earlier file did not set, so it takes its default", () => {
    const now = '{"$schema":"./s.json","journalDir":"D:/j","hud":{"edMcpDataDir":"D:/x"}}';
    const back = restorePaths(now, '{"$schema":"./s.json"}', ["journalDir", "hud.edMcpDataDir"]);
    expect(JSON.parse(back)).toEqual({ $schema: "./s.json", hud: {} });
    expect(restorePaths('{"journalDir":"x"}', "not json", ["journalDir"])).toBe("{}\n");
  });
});
