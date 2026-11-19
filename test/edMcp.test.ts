import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  edMcpState,
  edMcpToAdd,
  findEdMcp,
  readAgentConfigs,
  startableOn,
  syncDirOf,
} from "../src/core/edMcp.js";

const npx = { command: "cmd", args: ["/c", "npx", "-y", "ed-mcp@latest"] };

describe("findEdMcp", () => {
  it("takes the user-scope ed-mcp from ~/.claude.json first", () => {
    const claudeJson = JSON.stringify({
      mcpServers: { "ed-mcp": { ...npx, env: { ED_MCP_SYNC_DIR: "D:/Sync" } } },
      projects: { p: { mcpServers: { "ed-mcp": { command: "other" } } } },
    });
    expect(findEdMcp({ claudeJson }, workspace)).toEqual({
      source: "claudeUser",
      ...npx,
      env: { ED_MCP_SYNC_DIR: "D:/Sync" },
    });
  });

  it("falls back to a project entry, and skips entries that do not run a command", () => {
    const claudeJson = JSON.stringify({
      mcpServers: { "ed-mcp": { type: "http", url: "http://x" } },
      projects: { p: { mcpServers: { "ed-mcp": { command: "ed-mcp", args: [1, "a"] } } } },
    });
    expect(findEdMcp({ claudeJson }, workspace)).toEqual({
      source: "claudeProject",
      command: "ed-mcp",
      args: ["a"],
      env: {},
    });
  });

  it("gives null for no config, bad JSON or no ed-mcp", () => {
    expect(findEdMcp({}, workspace)).toBeNull();
    expect(findEdMcp({ claudeJson: "{" }, workspace)).toBeNull();
    expect(
      findEdMcp({ claudeJson: '{"mcpServers":{"other":{"command":"x"}}}' }, workspace),
    ).toBeNull();
  });
});

describe("syncDirOf", () => {
  it("reads the sync folder of the ed-mcp that runs, not of another entry", () => {
    const claudeJson = JSON.stringify({
      mcpServers: { "ed-mcp": npx },
      projects: {
        p: { mcpServers: { "ed-mcp": { ...npx, env: { ED_MCP_SYNC_DIR: "E:/Sync" } } } },
      },
    });
    expect(syncDirOf({ claudeJson })).toBeNull();
  });

  it("with no runnable entry, finds the first entry that names a sync folder", () => {
    const claudeJson = JSON.stringify({
      mcpServers: { "ed-mcp": { type: "http", url: "http://x" } },
      projects: { p: { mcpServers: { "ed-mcp": { env: { ED_MCP_SYNC_DIR: "E:/Sync" } } } } },
    });
    expect(syncDirOf({ claudeJson })).toBe("E:/Sync");
    expect(syncDirOf({})).toBeNull();
  });
});

describe("readAgentConfigs", () => {
  it("reads each CLI's config, and leaves out a missing file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "edmcp-"));
    try {
      expect(await readAgentConfigs(home, {})).toEqual({
        claudeJson: undefined,
        claudeSettings: undefined,
        codexToml: undefined,
      });
      await mkdir(path.join(home, ".claude"));
      await mkdir(path.join(home, ".codex"));
      await writeFile(path.join(home, ".claude.json"), "{}");
      await writeFile(path.join(home, ".claude", "settings.json"), "{ }");
      await writeFile(path.join(home, ".codex", "config.toml"), "x = 1");
      expect(await readAgentConfigs(home, {})).toEqual({
        claudeJson: "{}",
        claudeSettings: "{ }",
        codexToml: "x = 1",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("follows CLAUDE_CONFIG_DIR and CODEX_HOME", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "edmcp-"));
    try {
      const claude = path.join(home, "c");
      const codex = path.join(home, "x");
      await mkdir(claude);
      await mkdir(codex);
      await writeFile(path.join(claude, ".claude.json"), "{}");
      await writeFile(path.join(claude, "settings.json"), "{ }");
      await writeFile(path.join(codex, "config.toml"), "x = 1");
      expect(
        await readAgentConfigs(path.join(home, "none"), {
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: codex,
        }),
      ).toEqual({ claudeJson: "{}", claudeSettings: "{ }", codexToml: "x = 1" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

const codexToml = (extra = "") => `
model = "gpt-5"

[mcp_servers.ed-mcp]
command = "cmd"
args = ["/c", "npx", "-y", "ed-mcp@latest"]
${extra}

[mcp_servers.ed-mcp.env]
ED_MCP_SYNC_DIR = "C:/Codex/Sync"
`;
const pluginSettings = (on: boolean, dir = "P:/Sync") =>
  JSON.stringify({
    enabledPlugins: { "elite-dangerous-mcp@ed-mcp": on },
    pluginConfigs: { "elite-dangerous-mcp@ed-mcp": { options: { ed_mcp_sync_dir: dir } } },
  });
const workspace = path.resolve("ed-chat-data", "workspace");

describe("findEdMcp with Codex and the plugin", () => {
  it("reads [mcp_servers.ed-mcp] from Codex's config.toml", () => {
    expect(findEdMcp({ codexToml: codexToml() }, workspace)).toEqual({
      source: "codex",
      ...npx,
      env: { ED_MCP_SYNC_DIR: "C:/Codex/Sync" },
    });
  });

  it("prefers Claude's definitions, and skips one switched off or a bad file", () => {
    const claudeJson = JSON.stringify({ mcpServers: { "ed-mcp": { command: "claude-ed" } } });
    expect(findEdMcp({ claudeJson, codexToml: codexToml() }, workspace)?.source).toBe("claudeUser");
    expect(findEdMcp({ codexToml: codexToml("enabled = false") }, workspace)).toBeNull();
    expect(findEdMcp({ codexToml: "[mcp_servers" }, workspace)).toBeNull();
  });

  it("never runs the plugin's ed-mcp itself: it lives in the plugin's folder", () => {
    expect(findEdMcp({ claudeSettings: pluginSettings(true) }, workspace)).toBeNull();
  });
});

describe("edMcpToAdd", () => {
  const claudeUser = JSON.stringify({ mcpServers: { "ed-mcp": npx } });
  it("gives Claude the Codex definition when Claude has none", () => {
    expect(edMcpToAdd("claude", { codexToml: codexToml() }, workspace)?.source).toBe("codex");
  });

  it("gives Codex the Claude definition when config.toml has none", () => {
    const d = edMcpToAdd("codex", { claudeJson: claudeUser, codexToml: 'model = "x"' }, workspace);
    expect(d).toEqual({ source: "claudeUser", ...npx, env: {} });
  });

  it("adds nothing when the agent has its own, so ed-mcp never runs twice", () => {
    const both = { claudeJson: claudeUser, codexToml: codexToml() };
    expect(edMcpToAdd("claude", both, workspace)).toBeNull();
    expect(edMcpToAdd("codex", both, workspace)).toBeNull();
    // Switched off in Codex is the player's choice.
    expect(
      edMcpToAdd(
        "codex",
        { claudeJson: claudeUser, codexToml: codexToml("enabled = false") },
        workspace,
      ),
    ).toBeNull();
  });

  it("counts Claude's plugin, and a project entry for ED Chat's own folder, as Claude's own", () => {
    const codex = codexToml();
    expect(
      edMcpToAdd("claude", { codexToml: codex, claudeSettings: pluginSettings(true) }, workspace),
    ).toBeNull();
    expect(
      edMcpToAdd("claude", { codexToml: codex, claudeSettings: pluginSettings(false) }, workspace)
        ?.source,
    ).toBe("codex");
    const project = (dir: string) =>
      JSON.stringify({ projects: { [dir]: { mcpServers: { "ed-mcp": npx } } } });
    expect(
      edMcpToAdd("claude", { claudeJson: project(workspace + path.sep) }, workspace),
    ).toBeNull();
    // Another project's entry does not run in ED Chat's folder, so it is added.
    expect(
      edMcpToAdd("claude", { claudeJson: project(path.resolve("elsewhere")) }, workspace)?.source,
    ).toBe("claudeProject");
  });

  it("does not take another enabled plugin for ed-mcp", () => {
    const other = JSON.stringify({
      enabledPlugins: { "other-plugin@marketplace": true },
      pluginConfigs: { "other-plugin@marketplace": { options: { dir: "X:/" } } },
    });
    const c = { codexToml: codexToml(), claudeSettings: other };
    expect(edMcpToAdd("claude", c, workspace)?.source).toBe("codex");
    expect(syncDirOf({ claudeSettings: other }, "claude", workspace)).toBeNull();
  });

  it("gives nothing when ed-mcp is set up nowhere", () => {
    expect(edMcpToAdd("claude", {}, workspace)).toBeNull();
    expect(edMcpToAdd("codex", {}, workspace)).toBeNull();
  });
});

describe("startableOn", () => {
  const d = { source: "codex" as const, command: "npx", args: ["-y", "ed-mcp@latest"], env: {} };
  it("starts npx and other .cmd shims through cmd /c on Windows", () => {
    expect(startableOn(d, "win32")).toMatchObject({
      command: "cmd",
      args: ["/c", "npx", "-y", "ed-mcp@latest"],
    });
    expect(startableOn({ ...d, command: "C:\\x\\ed-mcp.CMD" }, "win32").command).toBe("cmd");
  });

  it("leaves other commands, and other systems, as they are", () => {
    const node = { ...d, command: "node", args: ["x.js"] };
    expect(startableOn(node, "win32")).toBe(node);
    expect(startableOn({ ...d, command: "cmd", args: ["/c", "npx"] }, "win32").args).toEqual([
      "/c",
      "npx",
    ]);
    expect(startableOn(d, "linux")).toBe(d);
  });
});

describe("syncDirOf per agent", () => {
  it("still finds the sync folder of an ed-mcp that is switched off in Codex", () => {
    expect(syncDirOf({ codexToml: codexToml("enabled = false") }, "codex", workspace)).toBe(
      "C:/Codex/Sync",
    );
  });

  it("reads the sync folder of the ed-mcp that the agent runs", () => {
    const claudeJson = JSON.stringify({
      mcpServers: { "ed-mcp": { ...npx, env: { ED_MCP_SYNC_DIR: "D:/Claude" } } },
    });
    const c = { claudeJson, codexToml: codexToml() };
    expect(syncDirOf(c, "claude", workspace)).toBe("D:/Claude");
    expect(syncDirOf(c, "codex", workspace)).toBe("C:/Codex/Sync");
    // Codex has none of its own, so it runs Claude's.
    expect(syncDirOf({ claudeJson }, "codex", workspace)).toBe("D:/Claude");
  });

  it("prefers the project entry for ED Chat's folder to user scope, as Claude does", () => {
    const claudeJson = JSON.stringify({
      mcpServers: { "ed-mcp": { ...npx, env: { ED_MCP_SYNC_DIR: "D:/User" } } },
      projects: {
        [workspace]: { mcpServers: { "ed-mcp": { ...npx, env: { ED_MCP_SYNC_DIR: "D:/Here" } } } },
      },
    });
    expect(syncDirOf({ claudeJson }, "claude", workspace)).toBe("D:/Here");
    // Codex gets the same one, and the panel follows it.
    expect(edMcpToAdd("codex", { claudeJson }, workspace)?.env).toEqual({
      ED_MCP_SYNC_DIR: "D:/Here",
    });
    expect(syncDirOf({ claudeJson }, "codex", workspace)).toBe("D:/Here");
    expect(findEdMcp({ claudeJson }, workspace)?.env.ED_MCP_SYNC_DIR).toBe("D:/Here");
    // Codex's own entry still wins for Codex.
    expect(edMcpToAdd("codex", { claudeJson, codexToml: codexToml() }, workspace)).toBeNull();
    expect(syncDirOf({ claudeJson, codexToml: codexToml() }, "codex", workspace)).toBe(
      "C:/Codex/Sync",
    );
  });

  it("reads the plugin's sync folder from Claude's settings", () => {
    const c = { claudeSettings: pluginSettings(true), codexToml: codexToml() };
    expect(syncDirOf(c, "claude", workspace)).toBe("P:/Sync");
    expect(syncDirOf({ claudeSettings: pluginSettings(true, "") }, "claude", workspace)).toBeNull();
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
