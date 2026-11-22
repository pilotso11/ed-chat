import { describe, expect, it } from "vitest";
import {
  BUNDLED_ED_MCP,
  LATEST_TTL_MS,
  fetchLatestEdMcp,
  freshLatest,
  versionText,
} from "../src/core/version.js";

const base = { app: "0.4.0", claude: "2.1.308", edMcpStatus: "ok" as const };

describe("versionText", () => {
  it("lists ED Chat, claude and both ed-mcp copies", () => {
    expect(versionText({ ...base, edMcpLatest: BUNDLED_ED_MCP })).toBe(
      [
        "ED Chat 0.4.0",
        "claude 2.1.308",
        `ed-mcp for Claude: added, latest on npm ${BUNDLED_ED_MCP}`,
        `ed-mcp in ED Chat: ${BUNDLED_ED_MCP} (activity panel)`,
      ].join("\n"),
    );
  });

  it("says when npm has a newer ed-mcp than the one ED Chat carries", () => {
    expect(versionText({ ...base, edMcpLatest: "99.0.0" })).toContain("newer ED Chat release");
    expect(versionText({ ...base, edMcpLatest: "0.0.1" })).not.toContain("newer");
  });

  it("shows a lookup in progress, a failed lookup and a missing claude", () => {
    expect(versionText({ ...base, edMcpLatest: "checking" })).toContain("checking npm…");
    const t = versionText({ app: "0.4.0", claude: null, edMcpStatus: null, edMcpLatest: null });
    expect(t).toContain("claude not found");
    expect(t).toContain("ed-mcp for Claude: not started yet, could not read the latest from npm");
  });

  it("shows why Claude's ed-mcp does not work", () => {
    expect(versionText({ ...base, edMcpStatus: "missing", edMcpLatest: null })).toContain(
      "not added to claude",
    );
  });
});

describe("versionText for the active assistant", () => {
  it("names the CLI and assistant that runs", () => {
    const t = versionText({ ...base, agent: "claude", edMcpLatest: null });
    expect(t).toContain("claude 2.1.308");
    expect(t).toContain("ed-mcp for Claude: added");
  });
});

describe("fetchLatestEdMcp", () => {
  const reply = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("reads the version from npm", async () => {
    expect(await fetchLatestEdMcp(reply(200, { version: "0.7.2" }))).toBe("0.7.2");
  });

  it("gives null for an error, a bad body or no network", async () => {
    expect(await fetchLatestEdMcp(reply(404, {}))).toBeNull();
    expect(await fetchLatestEdMcp(reply(200, { version: "<b>" }))).toBeNull();
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await fetchLatestEdMcp(down)).toBeNull();
  });
});

describe("freshLatest", () => {
  it("reuses the npm lookup for ten minutes", () => {
    const cached = { version: "1.2.3", at: 1_000 };
    expect(freshLatest(cached, 1_000 + LATEST_TTL_MS - 1)).toBe(cached);
    expect(freshLatest(cached, 1_000 + LATEST_TTL_MS)).toBeNull();
    expect(freshLatest(null, 0)).toBeNull();
  });
});
