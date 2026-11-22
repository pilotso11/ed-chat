import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOCAL_COMMANDS,
  agentArgs,
  blockedFor,
  displaySettingsFile,
  firstRunChoice,
  journalDir,
  localCommand,
  settingsChange,
} from "../src/core/agentSetup.js";
import { buildClaudeArgs } from "../src/core/backends/claude/command.js";
import { buildCodexArgs } from "../src/core/backends/codex/command.js";
import { DEFAULT_SETTINGS, type Settings } from "../src/core/settings.js";

const s = DEFAULT_SETTINGS;
const home = path.join("C:", "Users", "cmdr");

describe("local commands", () => {
  it("knows ED Chat's own commands", () => {
    for (const c of LOCAL_COMMANDS) expect(localCommand(c)).toBe(c);
    expect(LOCAL_COMMANDS).toEqual(["/new", "/version", "/claude", "/codex", "/quit", "/exit"]);
  });

  it("leaves everything else to the assistant", () => {
    expect(localCommand("/help")).toBeNull();
    expect(localCommand("new")).toBeNull();
    expect(localCommand("/new please")).toBeNull();
  });
});

describe("agent arguments", () => {
  const files = { mcpConfigFile: "mcp.json", settingsFile: "settings.json" };

  it("builds Claude's from its settings and ED Chat's files", () => {
    const claude = { ...s.claude, permissionMode: "default" as const, extraArgs: ["--x"] };
    expect(agentArgs("claude", { ...s, claude }, files)).toEqual(
      buildClaudeArgs({
        permissionMode: "default",
        model: s.claude.model,
        mcpConfigFile: "mcp.json",
        extraArgs: ["--x"],
        settingsFile: "settings.json",
      }),
    );
  });

  it("builds Codex's from its extra arguments", () => {
    const codex = { ...s.codex, extraArgs: ["--y"] };
    expect(agentArgs("codex", { ...s, codex }, files)).toEqual(
      buildCodexArgs({ extraArgs: ["--y"] }),
    );
  });
});

describe("blocked assistant", () => {
  it("blocks both when the data folder fails", () => {
    const p = { data: "no data", approval: "no server" };
    expect(blockedFor("claude", p)).toBe("no data");
    expect(blockedFor("codex", p)).toBe("no data");
  });

  it("blocks only Claude when the approval server fails", () => {
    const p = { data: null, approval: "no server" };
    expect(blockedFor("claude", p)).toBe("no server");
    expect(blockedFor("codex", p)).toBeNull();
  });
});

describe("first run", () => {
  const base = {
    firstRun: true,
    settingsText: "{}",
    settingsBroken: false,
    claudeFound: () => false,
    codexFound: () => true,
    hintShown: false,
  };

  it("picks Codex when only Codex is installed", () => {
    expect(firstRunChoice(base)).toBe("codex");
  });

  it("keeps Claude and hints once when both are installed", () => {
    expect(firstRunChoice({ ...base, claudeFound: () => true })).toBe("hint");
    expect(firstRunChoice({ ...base, claudeFound: () => true, hintShown: true })).toBeNull();
  });

  it("keeps Claude when Codex is not installed", () => {
    expect(
      firstRunChoice({ ...base, claudeFound: () => true, codexFound: () => false }),
    ).toBeNull();
    expect(firstRunChoice({ ...base, codexFound: () => false })).toBeNull();
  });

  it("looks for the CLIs only when the choice depends on them", () => {
    let looked = 0;
    const found = () => (looked++, true);
    firstRunChoice({ ...base, firstRun: false, claudeFound: found, codexFound: found });
    firstRunChoice({
      ...base,
      settingsText: '{"agent":"codex"}',
      claudeFound: found,
      codexFound: found,
    });
    expect(looked).toBe(0);
  });

  it("does nothing after the first run, or when settings.json chose or cannot be read", () => {
    expect(firstRunChoice({ ...base, firstRun: false })).toBeNull();
    expect(firstRunChoice({ ...base, settingsText: '{"agent":"claude"}' })).toBeNull();
    expect(firstRunChoice({ ...base, settingsBroken: true })).toBeNull();
    expect(firstRunChoice({ ...base, settingsText: "{not json" })).toBeNull();
  });
});

describe("game folders", () => {
  it("uses Elite's journal folder in Saved Games, unless set", () => {
    expect(journalDir(s, home)).toBe(
      path.join(home, "Saved Games", "Frontier Developments", "Elite Dangerous"),
    );
    expect(journalDir({ ...s, journalDir: "D:\\Journal" }, home)).toBe("D:\\Journal");
  });

  it("finds DisplaySettings.xml under LOCALAPPDATA, or under the profile", () => {
    const tail = path.join(
      "Frontier Developments",
      "Elite Dangerous",
      "Options",
      "Graphics",
      "DisplaySettings.xml",
    );
    expect(displaySettingsFile("L:\\Local", home)).toBe(path.join("L:\\Local", tail));
    expect(displaySettingsFile(undefined, home)).toBe(path.join(home, "AppData", "Local", tail));
  });
});

describe("settings change", () => {
  const change = (next: Partial<Settings>, agent: "claude" | "codex" = "claude") =>
    settingsChange(s, { ...s, ...next }, agent, home);

  it("changes nothing for the same settings", () => {
    expect(change({})).toEqual({
      reopenFeed: false,
      switchAgent: false,
      agentSettings: false,
      journal: false,
    });
  });

  it("reopens the feed and Status.json for another journal folder", () => {
    expect(change({ journalDir: "D:\\Journal" })).toMatchObject({
      reopenFeed: true,
      journal: true,
    });
    // The default folder written out is the same folder.
    expect(change({ journalDir: journalDir(s, home) })).toMatchObject({
      reopenFeed: false,
      journal: false,
    });
  });

  it("reopens the feed for another ed-mcp folder or a Spansh change", () => {
    expect(change({ hud: { ...s.hud, edMcpDataDir: "X" } }).reopenFeed).toBe(true);
    expect(change({ hud: { ...s.hud, spansh: false } }).reopenFeed).toBe(true);
    expect(change({ hud: { ...s.hud, fontSize: 20 } }).reopenFeed).toBe(false);
  });

  it("switches the assistant, which then needs no restart of the old one", () => {
    expect(change({ agent: "codex", claude: { ...s.claude, model: "opus" } })).toMatchObject({
      switchAgent: true,
      agentSettings: false,
    });
  });

  it("restarts only for the running assistant's own settings", () => {
    expect(change({ claude: { ...s.claude, model: "opus" } }).agentSettings).toBe(true);
    expect(change({ codex: { ...s.codex, model: "other" } }).agentSettings).toBe(false);
    expect(change({ codex: { ...s.codex, model: "other" } }, "codex").agentSettings).toBe(true);
  });
});
