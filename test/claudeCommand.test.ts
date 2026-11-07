import { describe, expect, it } from "vitest";
import { CrashTracker } from "../src/core/crashTracker.js";
import {
  APPROVAL_TOOL,
  buildClaudeArgs,
  edMcpState,
  isOlder,
  parseCliVersion,
  quoteForCmd,
  resolveClaude,
} from "../src/core/claudeCommand.js";
import { HUD_PROMPT } from "../src/core/prompt.js";

describe("CrashTracker", () => {
  it("gives up after 3 exits in 60 seconds", () => {
    let t = 0;
    const c = new CrashTracker({ max: 3, windowMs: 60_000, now: () => t });
    expect(c.record()).toBe(false);
    t = 30_000;
    expect(c.record()).toBe(false);
    t = 59_000;
    expect(c.record()).toBe(true);
    expect(c.gaveUp).toBe(true);
    c.reset();
    expect(c.gaveUp).toBe(false);
  });

  it("forgets exits older than the window", () => {
    let t = 0;
    const c = new CrashTracker({ max: 3, windowMs: 60_000, now: () => t });
    c.record();
    t = 10_000;
    c.record();
    t = 70_001;
    expect(c.record()).toBe(false);
  });
});

describe("resolveClaude", () => {
  const has = (paths: string[]) => (p: string) => paths.includes(p);
  it("prefers claude.exe over claude.cmd on Windows", () => {
    const env = { PATH: "C:\\a;C:\\b" };
    expect(
      resolveClaude(null, env, "win32", has(["C:\\a\\claude.cmd", "C:\\b\\claude.exe"])),
    ).toEqual({ command: "C:\\b\\claude.exe", shell: false });
    expect(resolveClaude(null, env, "win32", has(["C:\\a\\claude.cmd"]))).toEqual({
      command: "C:\\a\\claude.cmd",
      shell: true,
    });
  });

  it("uses the configured path when it exists", () => {
    expect(resolveClaude("/opt/claude", {}, "linux", has(["/opt/claude"]))).toEqual({
      command: "/opt/claude",
      shell: false,
    });
    expect(resolveClaude("/opt/claude", {}, "linux", has([]))).toBeNull();
  });

  it("returns null when claude is not on PATH", () => {
    expect(resolveClaude(null, { PATH: "/usr/bin" }, "linux", has([]))).toBeNull();
  });
});

describe("quoteForCmd", () => {
  it("wraps in quotes and doubles inner quotes", () => {
    expect(quoteForCmd('a "b" c')).toBe('"a ""b"" c"');
  });
});

describe("buildClaudeArgs", () => {
  it("builds the stream-json command line", () => {
    expect(
      buildClaudeArgs({
        permissionMode: "auto",
        mcpConfigFile: "C:\\x\\a.json",
        extraArgs: ["--model", "m"],
      }),
    ).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "auto",
      "--append-system-prompt",
      HUD_PROMPT,
      "--mcp-config",
      "C:\\x\\a.json",
      "--permission-prompt-tool",
      APPROVAL_TOOL,
      "--model",
      "m",
    ]);
  });
});

describe("versions", () => {
  it("parses and compares", () => {
    expect(parseCliVersion("2.1.302 (Claude Code)")).toEqual([2, 1, 302]);
    expect(parseCliVersion("nope")).toBeNull();
    expect(isOlder([2, 1, 9], [2, 1, 10])).toBe(true);
    expect(isOlder([2, 2, 0], [2, 1, 10])).toBe(false);
    expect(isOlder([2, 1, 10], [2, 1, 10])).toBe(false);
  });
});

describe("edMcpState", () => {
  it("finds ed-mcp added with claude mcp add or by the plugin", () => {
    expect(edMcpState([{ name: "ed-mcp", status: "pending" }])).toBe("ok");
    expect(edMcpState([{ name: "plugin:elite-dangerous-mcp:ed-mcp", status: "connected" }])).toBe(
      "ok",
    );
    expect(edMcpState([{ name: "ed-mcp", status: "failed" }])).toBe("failed");
    expect(edMcpState([{ name: "ed-mcp", status: "needs-auth" }])).toBe("needsAuth");
    expect(edMcpState([{ name: "semble", status: "pending" }])).toBe("missing");
  });

  it("is ok when one of a plugin and a claude mcp add server works", () => {
    const plugin = { name: "plugin:elite-dangerous-mcp:ed-mcp", status: "failed" };
    expect(edMcpState([plugin, { name: "ed-mcp", status: "pending" }])).toBe("ok");
    expect(edMcpState([{ name: "ed-mcp", status: "connected" }, plugin])).toBe("ok");
    expect(edMcpState([plugin, { name: "ed-mcp", status: "needs-auth" }])).toBe("needsAuth");
    expect(edMcpState([plugin, { name: "ed-mcp", status: "failed" }])).toBe("failed");
  });
});
