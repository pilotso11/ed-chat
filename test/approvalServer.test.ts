import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, summarize, type ApprovalRequest } from "../src/core/approvalServer.js";

let server: ApprovalServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function setup(timeoutMs = 5_000) {
  const requests: ApprovalRequest[] = [];
  const settled: string[] = [];
  server = new ApprovalServer({
    timeoutMs,
    onRequest: (r) => requests.push(r),
    onSettled: (id) => settled.push(id),
  });
  await server.start();
  const cfg = server.mcpConfig().mcpServers.ed_overlay!;
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }),
  );
  const call = () =>
    client.callTool({
      name: "approve",
      arguments: { tool_name: "Bash", input: { command: "ls" } },
    });
  const decision = async (p: ReturnType<typeof call>) => {
    const r = await p;
    const content = r.content as { type: string; text: string }[];
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  };
  const waitRequest = async () => {
    while (!requests.length) await new Promise((r) => setTimeout(r, 10));
    return requests[0]!;
  };
  return { requests, settled, client, call, decision, waitRequest, cfg };
}

describe("ApprovalServer", () => {
  it("allows with the original input", async () => {
    const t = await setup();
    const p = t.call();
    const req = await t.waitRequest();
    expect(req).toMatchObject({ toolName: "Bash", summary: '{"command":"ls"}' });
    expect(server!.answer(req.id, "allow")).toBe(true);
    expect(await t.decision(p)).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(t.settled).toEqual([req.id]);
    expect(server!.answer(req.id, "allow")).toBe(false);
  });

  it("denies", async () => {
    const t = await setup();
    const p = t.call();
    server!.answer((await t.waitRequest()).id, "deny");
    expect(await t.decision(p)).toEqual({ behavior: "deny", message: "Player denied" });
  });

  it("denies when nobody answers in time", async () => {
    const t = await setup(50);
    expect(await t.decision(t.call())).toEqual({
      behavior: "deny",
      message: "Player did not answer",
    });
    expect(t.settled).toHaveLength(1);
  });

  it("rejects a request without the token", async () => {
    const t = await setup();
    const res = await fetch(t.cfg.url, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("listens on 127.0.0.1", async () => {
    const t = await setup();
    expect(t.cfg.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(t.cfg.type).toBe("http");
  });
});

describe("summarize", () => {
  it("cuts long input", () => {
    const s = summarize({ text: "x".repeat(200) });
    expect(s).toHaveLength(80);
    expect(s.endsWith("…")).toBe(true);
  });
});
