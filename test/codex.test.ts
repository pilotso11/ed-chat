import { describe, expect, it } from "vitest";
import { ApprovalBroker, type ApprovalRequest } from "../src/core/approvals.js";
import { brokerApprover } from "../src/core/backends/codex/approvals.js";
import {
  buildCodexArgs,
  codexThreadSettings,
  permissionModeOf,
  resolveCodex,
} from "../src/core/backends/codex/command.js";
import { CodexEvents, toolName } from "../src/core/backends/codex/events.js";
import { RpcClient, RpcError } from "../src/core/backends/codex/rpc.js";
import { lookedIn } from "../src/core/cli.js";
import { codexLookup } from "../src/core/backends/codex/command.js";
import { edMcpState } from "../src/core/edMcp.js";

describe("RpcClient", () => {
  function client() {
    const sent: unknown[] = [];
    const notes: [string, unknown][] = [];
    const requests: [unknown, string, unknown][] = [];
    const junk: string[] = [];
    const rpc = new RpcClient((l) => sent.push(JSON.parse(l)), {
      onNotification: (m, p) => notes.push([m, p]),
      onRequest: (id, m, p) => requests.push([id, m, p]),
      onJunk: (l) => junk.push(l),
    });
    return { rpc, sent, notes, requests, junk };
  }

  it("matches responses to requests, across chunk boundaries", async () => {
    const { rpc, sent } = client();
    const a = rpc.request("initialize", { x: 1 });
    const b = rpc.request("thread/start", {});
    expect(sent).toEqual([
      { id: 1, method: "initialize", params: { x: 1 } },
      { id: 2, method: "thread/start", params: {} },
    ]);
    rpc.feed('{"id":2,"result":{"thread"');
    rpc.feed(':{"id":"t"}}}\n{"id":1,"result":"ok"}\n');
    expect(await a).toBe("ok");
    expect(await b).toEqual({ thread: { id: "t" } });
  });

  it("rejects with the server's error code and message", async () => {
    const { rpc } = client();
    const p = rpc.request("thread/resume", {});
    rpc.feed('{"id":1,"error":{"code":-32600,"message":"no rollout found"}}\n');
    await expect(p).rejects.toEqual(new RpcError(-32600, "no rollout found"));
  });

  it("tells notifications from server requests, and reports junk", () => {
    const { rpc, notes, requests, junk } = client();
    rpc.feed('{"method":"turn/started","params":{"a":1}}\n');
    rpc.feed('{"id":"s1","method":"item/fileChange/requestApproval","params":{}}\n');
    rpc.feed("not json\n[1]\n" + '{"id":99,"result":1}\n\n');
    expect(notes).toEqual([["turn/started", { a: 1 }]]);
    expect(requests).toEqual([["s1", "item/fileChange/requestApproval", {}]]);
    expect(junk).toEqual(["not json", "[1]", '{"id":99,"result":1}']);
  });

  it("answers server requests, and sends notifications without params", () => {
    const { rpc, sent } = client();
    rpc.notify("initialized");
    rpc.respond("s1", { decision: "accept" });
    rpc.respondError(7, -32601, "no");
    expect(sent).toEqual([
      { method: "initialized" },
      { id: "s1", result: { decision: "accept" } },
      { id: 7, error: { code: -32601, message: "no" } },
    ]);
  });

  it("fails waiting and later requests once closed, and sends nothing more", async () => {
    const { rpc, sent } = client();
    const p = rpc.request("turn/start", {});
    rpc.close(new Error("gone"));
    await expect(p).rejects.toThrow("gone");
    await expect(rpc.request("x", {})).rejects.toThrow("gone");
    rpc.notify("y");
    expect(sent).toHaveLength(1);
  });
});

describe("CodexEvents", () => {
  const item = (i: Record<string, unknown>) => ({ threadId: "t", turnId: "u", item: i });

  it("names tools so that the status line shows the tool's own name", () => {
    expect(toolName({ type: "mcpToolCall", server: "ed-mcp", tool: "journal_status" })).toBe(
      "mcp__ed-mcp__journal_status",
    );
    expect(toolName({ type: "commandExecution" })).toBe("shell");
    expect(toolName({ type: "fileChange" })).toBe("edit");
    expect(toolName({ type: "webSearch" })).toBe("web_search");
    expect(toolName({ type: "agentMessage" })).toBeNull();
    expect(toolName({ type: "reasoning" })).toBeNull();
  });

  it("shows a message that came whole, once, and not one that streamed", () => {
    const e = new CodexEvents();
    expect(e.map("item/agentMessage/delta", { itemId: "a", delta: "Hi" })).toEqual([
      { type: "text", delta: "Hi" },
    ]);
    expect(e.map("item/completed", item({ type: "agentMessage", id: "a", text: "Hi" }))).toEqual(
      [],
    );
    expect(e.map("item/completed", item({ type: "agentMessage", id: "b", text: "There" }))).toEqual(
      [{ type: "text", delta: "\nThere" }],
    );
  });

  it("marks failed and declined tools as errors, and lists declined ones as denials", () => {
    const e = new CodexEvents();
    e.threadId = "t";
    e.map("item/started", item({ type: "commandExecution", id: "c" }));
    expect(
      e.map("item/completed", item({ type: "commandExecution", id: "c", status: "declined" })),
    ).toEqual([{ type: "toolEnd", id: "c", name: "shell", isError: true }]);
    const call = { type: "mcpToolCall", id: "m", server: "ed-mcp", tool: "x" };
    e.map("item/started", item(call));
    expect(e.map("item/completed", item({ ...call, status: "completed", error: null }))).toEqual([
      { type: "toolEnd", id: "m", name: "mcp__ed-mcp__x", isError: false },
    ]);
    expect(e.result({ id: "u", status: "completed", durationMs: 7, error: null })).toEqual({
      type: "result",
      isError: false,
      durationMs: 7,
      text: null,
      sessionId: "t",
      denials: ["shell"],
    });
    // The next turn starts clean.
    expect(e.result({ id: "w", status: "interrupted", durationMs: 1, error: null })).toMatchObject({
      isError: true,
      text: "Codex stopped the reply.",
    });
    expect(
      e.result({ id: "x", status: "cancelledByServer", durationMs: 1, error: null }),
    ).toMatchObject({ isError: true, text: "Codex ended the reply: cancelledByServer." });
    expect(e.result({ id: "v", status: "failed", durationMs: null, error: null })).toMatchObject({
      isError: true,
      text: "Codex returned an error.",
      denials: [],
    });
  });

  it("reports MCP servers in the words the shared ed-mcp check reads", () => {
    const e = new CodexEvents();
    expect(
      e.map("mcpServer/startupStatus/updated", { name: "ed-mcp", status: "starting" }),
    ).toEqual([]);
    e.threadId = "t";
    const [ready] = e.map("mcpServer/startupStatus/updated", { name: "ed-mcp", status: "failed" });
    expect(ready).toMatchObject({
      type: "ready",
      mcpServers: [{ name: "ed-mcp", status: "failed" }],
    });
    e.map("mcpServer/startupStatus/updated", { name: "codex_apps", status: "ready" });
    const [again] = e.map("mcpServer/startupStatus/updated", { name: "ed-mcp", status: "ready" });
    expect(again?.type === "ready" && edMcpState(again.mcpServers)).toBe("ok");
  });

  it("passes other notifications on as unknown", () => {
    expect(new CodexEvents().map("account/rateLimits/updated", { x: 1 })).toEqual([
      { type: "unknown", raw: { method: "account/rateLimits/updated", params: { x: 1 } } },
    ]);
  });
});

describe("codex command", () => {
  const env = {
    USERPROFILE: "C:\\Users\\p",
    APPDATA: "C:\\Users\\p\\AppData\\Roaming",
    PATH: "C:\\bin",
  };
  const has = (paths: string[]) => (p: string) => paths.includes(p);

  it("finds codex on PATH, then the standalone install, then the npm shim", () => {
    const standalone = "C:\\Users\\p\\.codex\\packages\\standalone\\current\\bin\\codex.exe";
    const npm = "C:\\Users\\p\\AppData\\Roaming\\npm\\codex.cmd";
    expect(resolveCodex(null, env, "win32", has(["C:\\bin\\codex.cmd", standalone]))).toEqual({
      command: "C:\\bin\\codex.cmd",
      shell: true,
    });
    expect(resolveCodex(null, env, "win32", has([standalone, npm]))).toEqual({
      command: standalone,
      shell: false,
    });
    expect(resolveCodex(null, env, "win32", has([npm]))).toEqual({ command: npm, shell: true });
    expect(resolveCodex(null, env, "win32", has([]))).toBeNull();
    expect(lookedIn(codexLookup(env, "win32"), null, env)).toEqual([
      "PATH",
      "~\\.codex\\packages\\standalone\\current\\bin\\codex.exe",
      "~\\AppData\\Roaming\\npm\\codex.cmd",
    ]);
  });

  it("runs the app server", () => {
    expect(buildCodexArgs({ extraArgs: ["-c", "x=1"] })).toEqual(["app-server", "-c", "x=1"]);
  });

  it("maps the permission modes to an approval policy in a workspace-write sandbox", () => {
    const cwd = "C:\\data\\workspace";
    expect(codexThreadSettings({ permissionMode: "auto", cwd })).toMatchObject({
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(codexThreadSettings({ permissionMode: "default", cwd }).approvalPolicy).toBe(
      "untrusted",
    );
    expect(permissionModeOf("on-request")).toBe("auto");
    expect(permissionModeOf("untrusted")).toBe("default");
    expect(permissionModeOf("never")).toBe("never");
    expect(permissionModeOf(undefined)).toBeNull();
  });

  it("puts ed-mcp in the thread config only when given, and refuses a relative cwd", () => {
    const cwd = "C:\\w";
    const edMcp = {
      command: "cmd",
      args: ["/c", "npx", "ed-mcp"],
      env: { ED_MCP_SYNC_PASSWORD: "x" },
    };
    expect(codexThreadSettings({ permissionMode: "auto", cwd }).config).toBeUndefined();
    expect(codexThreadSettings({ permissionMode: "auto", cwd, edMcp }).config).toEqual({
      mcp_servers: { "ed-mcp": edMcp },
    });
    expect(() => codexThreadSettings({ permissionMode: "auto", cwd: "work" })).toThrow("absolute");
  });

  it("gives Codex the HUD and settings instructions", () => {
    const s = codexThreadSettings({
      permissionMode: "auto",
      cwd: "C:\\w",
      settingsFile: "C:\\s.json",
    });
    expect(s.developerInstructions).toContain("⟦");
    expect(s.developerInstructions).toContain("C:\\s.json");
  });
});

describe("ApprovalBroker for Codex", () => {
  function setup(timeoutMs = 5_000) {
    const requests: ApprovalRequest[] = [];
    const broker = new ApprovalBroker({
      timeoutMs,
      onRequest: (r) => requests.push(r),
      onSettled: () => {},
    });
    return { broker, requests, approve: brokerApprover(broker) };
  }
  const ask = (signal = new AbortController().signal) =>
    ({ toolName: "shell", summary: "dir", shell: true, signal }) as const;

  it("accepts once, or for the session when the player allowed the tool until /new", async () => {
    const { broker, requests, approve } = setup();
    const once = approve(ask());
    await Promise.resolve();
    broker.answer(requests[0]!.id, "allow");
    expect(await once).toBe("accept");
    const always = approve(ask());
    await Promise.resolve();
    // What main does for "Allow until /new".
    broker.answer(requests[1]!.id, "allow");
    broker.allowTool("shell");
    expect(await always).toBe("acceptForSession");
    // Allowed tools skip the card until /new.
    expect(await approve(ask())).toBe("acceptForSession");
    expect(requests).toHaveLength(2);
    broker.clearAllowed();
    void approve(ask());
    await Promise.resolve();
    expect(requests).toHaveLength(3);
    broker.denyAll();
  });

  it("declines a denial, a timeout and a withdrawn request", async () => {
    const { broker, requests, approve } = setup(50);
    const denied = approve(ask());
    await Promise.resolve();
    expect(requests[0]).toMatchObject({ toolName: "shell", summary: "dir", shell: true });
    broker.answer(requests[0]!.id, "deny");
    expect(await denied).toBe("decline");
    expect(await approve(ask())).toBe("decline");
    const ctl = new AbortController();
    const withdrawn = approve(ask(ctl.signal));
    ctl.abort();
    expect(await withdrawn).toBe("decline");
    const gone = new AbortController();
    gone.abort();
    expect(await approve(ask(gone.signal))).toBe("decline");
  });

  it("uses a new timeout for the next request", async () => {
    const { broker, requests } = setup();
    broker.setTimeoutMs(20);
    expect(await broker.ask("x", {})).toBe("timeout");
    expect(requests[0]!.deadline - Date.now()).toBeLessThanOrEqual(20);
  });
});
