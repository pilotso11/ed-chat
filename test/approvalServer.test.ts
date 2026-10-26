import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalServer,
  summarize,
  type ApprovalRequest,
  type Outcome,
} from "../src/core/approvalServer.js";

let server: ApprovalServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function setup(timeoutMs = 5_000) {
  const requests: ApprovalRequest[] = [];
  const settled: string[] = [];
  const outcomes: Outcome[] = [];
  server = new ApprovalServer({
    timeoutMs,
    onRequest: (r) => requests.push(r),
    onSettled: (id, outcome) => {
      settled.push(id);
      outcomes.push(outcome);
    },
    now: () => 1_000,
  });
  await server.start();
  const cfg = server.mcpConfig().mcpServers.ed_chat!;
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
  return { requests, settled, outcomes, client, call, decision, waitRequest, cfg };
}

describe("ApprovalServer", () => {
  it("allows with the original input", async () => {
    const t = await setup();
    const p = t.call();
    const req = await t.waitRequest();
    expect(req).toMatchObject({ toolName: "Bash", summary: "ls", shell: true, deadline: 6_000 });
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

  it("rejects a wrong token", async () => {
    const t = await setup();
    const res = await fetch(t.cfg.url, {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("answers 404 for a wrong path", async () => {
    const t = await setup();
    const res = await fetch(t.cfg.url.replace("/mcp", "/other"), {
      method: "POST",
      headers: t.cfg.headers,
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("releases the approval when the client disconnects", async () => {
    const t = await setup(60_000);
    void t.call().catch(() => {});
    const req = await t.waitRequest();
    await t.client.close();
    while (!t.settled.length) await new Promise((r) => setTimeout(r, 10));
    expect(t.settled).toEqual([req.id]);
    expect(server!.answer(req.id, "allow")).toBe(false);
  });

  it("cancels at once when the request is already aborted", async () => {
    const t = await setup(60_000);
    const ask = (
      server as unknown as {
        ask: (n: string, i: unknown, s: AbortSignal) => Promise<string>;
      }
    ).ask.bind(server);
    expect(await ask("Bash", {}, AbortSignal.abort())).toBe("cancelled");
    expect(t.requests).toEqual([]);
    expect(t.settled).toEqual([]);
  });

  it("listens on 127.0.0.1", async () => {
    const t = await setup();
    expect(t.cfg.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(t.cfg.type).toBe("http");
  });
});

describe("summarize", () => {
  it("shows the command for a shell tool and the file for a file tool", () => {
    expect(summarize("Bash", { command: "ls /", description: "List" })).toBe("ls /");
    expect(summarize("Edit", { file_path: "C:/x.txt", old_string: "a" })).toBe("C:/x.txt");
  });

  it("shows other input as name: value pairs", () => {
    expect(summarize("mcp__ed-mcp__spansh_route", { from: "Sol", jumps: 3 })).toBe(
      "from: Sol, jumps: 3",
    );
  });

  it("cuts long input", () => {
    const s = summarize("Other", { text: "x".repeat(300) });
    expect(s).toHaveLength(200);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("always allow", () => {
  it("allows the tool without asking until cleared", async () => {
    const t = await setup();
    server!.allowTool("Bash");
    expect(await t.decision(t.call())).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
    expect(t.requests).toEqual([]);
    server!.clearAllowed();
    const p = t.call();
    server!.answer((await t.waitRequest()).id, "deny");
    expect(await t.decision(p)).toMatchObject({ behavior: "deny" });
    expect(t.outcomes).toEqual(["deny"]);
  });
});
