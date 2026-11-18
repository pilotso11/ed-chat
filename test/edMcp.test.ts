import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { edMcpState, findEdMcp, readAgentConfigs, syncDirOf } from "../src/core/edMcp.js";

const npx = { command: "cmd", args: ["/c", "npx", "-y", "ed-mcp@latest"] };

describe("findEdMcp", () => {
  it("takes the user-scope ed-mcp from ~/.claude.json first", () => {
    const claudeJson = JSON.stringify({
      mcpServers: { "ed-mcp": { ...npx, env: { ED_MCP_SYNC_DIR: "D:/Sync" } } },
      projects: { p: { mcpServers: { "ed-mcp": { command: "other" } } } },
    });
    expect(findEdMcp({ claudeJson })).toEqual({
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
    expect(findEdMcp({ claudeJson })).toEqual({
      source: "claudeProject",
      command: "ed-mcp",
      args: ["a"],
      env: {},
    });
  });

  it("gives null for no config, bad JSON or no ed-mcp", () => {
    expect(findEdMcp({})).toBeNull();
    expect(findEdMcp({ claudeJson: "{" })).toBeNull();
    expect(findEdMcp({ claudeJson: '{"mcpServers":{"other":{"command":"x"}}}' })).toBeNull();
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
  it("reads ~/.claude.json, and leaves out a missing file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "edmcp-"));
    try {
      expect(await readAgentConfigs(home)).toEqual({ claudeJson: undefined });
      await writeFile(path.join(home, ".claude.json"), "{}");
      expect(await readAgentConfigs(home)).toEqual({ claudeJson: "{}" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
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
