import { describe, expect, it } from "vitest";
import { AGENTS } from "../src/core/backend.js";
import {
  NO_AUTO,
  SCOPE_GAME,
  busyText,
  edMcpNotice,
  gaveUpText,
  hotkeysNotice,
  modeNotice,
  scopeNotice,
  versionNotice,
} from "../src/core/notices.js";
import { TESTED_CLI_VERSION } from "../src/core/backends/claude/command.js";
import { TESTED_CODEX_VERSION } from "../src/core/backends/codex/command.js";
import { parseCliVersion } from "../src/core/cli.js";
import { noticeCommand } from "../src/core/view.js";

describe("ed-mcp notice", () => {
  const setup = AGENTS.claude.mcpAddCommand;

  it("offers the setup command when ed-mcp is missing", () => {
    const text = edMcpNotice("missing", AGENTS.codex, setup)!;
    expect(text).toBe(`⚠ ed-mcp not connected; click to copy \`${setup}\``);
    // The notice's command is what a click copies.
    expect(noticeCommand("edmcp", text)).toBe(setup);
  });

  it("points at the agent's own list command when ed-mcp failed or needs auth", () => {
    expect(edMcpNotice("failed", AGENTS.codex, setup)).toBe(
      "⚠ ed-mcp failed to start; run `codex mcp list`",
    );
    expect(edMcpNotice("needsAuth", AGENTS.claude, setup)).toBe(
      "⚠ ed-mcp needs authentication; run `claude mcp list`",
    );
  });

  it("says nothing when ed-mcp runs", () => {
    expect(edMcpNotice("ok", AGENTS.claude, setup)).toBeNull();
  });
});

describe("mode notice", () => {
  it("warns when auto was asked for and another mode started", () => {
    expect(modeNotice("auto", "default")).toBe(NO_AUTO);
  });

  it("is quiet when auto started, another mode was asked for, or the mode is unknown", () => {
    expect(modeNotice("auto", "auto")).toBeNull();
    expect(modeNotice("default", "default")).toBeNull();
    expect(modeNotice("auto", undefined)).toBeNull();
    expect(modeNotice("auto", null)).toBeNull();
  });
});

describe("version notice", () => {
  it("names an older CLI and how to update it", () => {
    expect(versionNotice("2.0.1 (Claude Code)\n", "2.1.0", AGENTS.claude)).toEqual({
      version: "2.0.1",
      notice: "⚠ claude 2.0.1 is older than 2.1.0; run `claude update`",
    });
  });

  it("is quiet for the tested version or newer", () => {
    expect(versionNotice("2.1.0 (Claude Code)", "2.1.0", AGENTS.claude)).toEqual({
      version: "2.1.0",
      notice: null,
    });
    expect(versionNotice("codex-cli 9.0.0", "1.0.0", AGENTS.codex).notice).toBeNull();
  });

  it("can read the versions ED Chat was tested with", () => {
    // An unreadable one would turn the update warning off.
    expect(parseCliVersion(TESTED_CLI_VERSION)).not.toBeNull();
    expect(parseCliVersion(TESTED_CODEX_VERSION)).not.toBeNull();
  });

  it("gives no notice when the tested version cannot be read", () => {
    expect(versionNotice("1.0.0", "2.x", AGENTS.claude)).toEqual({
      version: "1.0.0",
      notice: null,
    });
  });

  it("knows no version when the check failed or printed none", () => {
    expect(versionNotice(null, "2.1.0", AGENTS.claude)).toEqual({ version: null, notice: null });
    expect(versionNotice("no version here", "2.1.0", AGENTS.claude)).toEqual({
      version: null,
      notice: null,
    });
  });
});

describe("hotkeys and scope notices", () => {
  it("counts the keys that do not work", () => {
    expect(hotkeysNotice([])).toBeNull();
    expect(hotkeysNotice(["Ctrl+Alt+C"])).toBe("⚠ 1 hotkey not working; see tray menu");
    expect(hotkeysNotice(["Ctrl+Alt+C", "F9"])).toBe("⚠ 2 hotkeys not working; see tray menu");
  });

  it("says why hotkeys do nothing away from the game", () => {
    expect(scopeNotice(true)).toBeNull();
    expect(scopeNotice(false)).toBe(SCOPE_GAME);
  });

  it("names the agent when it is busy or keeps stopping", () => {
    expect(busyText(AGENTS.codex)).toBe("⚠ Codex is busy");
    expect(gaveUpText(AGENTS.claude)).toBe("⚠ Claude keeps stopping");
  });
});
