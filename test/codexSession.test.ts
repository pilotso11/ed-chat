import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendEvent } from "../src/core/backend.js";
import { codexThreadSettings } from "../src/core/backends/codex/command.js";
import {
  CodexSession,
  type Approver,
  type CodexApproval,
  type CodexDecision,
} from "../src/core/backends/codex/session.js";

const fake = path.join(import.meta.dirname, "fake-codex.mjs");
const fixture = path.join(import.meta.dirname, "fixtures", "codex", "handwritten.jsonl");
const sessions: CodexSession[] = [];

interface Setup {
  mode?: string;
  resumeId?: string | null;
  approve?: Approver;
  command?: string;
  interruptGraceMs?: number;
}

async function setup(o: Setup = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ed-chat-codex-"));
  const log = path.join(dir, "log.jsonl");
  const asked: CodexApproval[] = [];
  const s = new CodexSession({
    command: o.command ?? process.execPath,
    args: [fake],
    cwd: dir,
    resumeId: o.resumeId ?? null,
    thread: codexThreadSettings({ permissionMode: "default", cwd: dir }),
    approve:
      o.approve ??
      (async (r) => {
        asked.push(r);
        return "decline";
      }),
    interruptGraceMs: o.interruptGraceMs,
    env: { ...process.env, FAKE_FIXTURE: fixture, FAKE_MODE: o.mode ?? "ok", FAKE_LOG: log },
  });
  sessions.push(s);
  const events: BackendEvent[] = [];
  s.onEvent((e) => events.push(e));
  // Every message the fake received, newest last, with one entry per process start.
  const received = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const methods = async () =>
    (await received()).map((m) => (m.argv ? "<start>" : ((m.method as string) ?? "<response>")));
  return { s, events, received, methods, asked, dir };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const types = (events: BackendEvent[]) => events.map((e) => e.type);
const has = (events: BackendEvent[], t: BackendEvent["type"]) => events.some((e) => e.type === t);

afterEach(() => {
  for (const s of sessions.splice(0)) s.stop();
});

describe("CodexSession", () => {
  it("starts a thread with the HUD instructions, and is ready with ed-mcp's status", async () => {
    const { s, events, received, dir } = await setup();
    s.start();
    // The status can come in the same chunk as the thread, so the first ready may carry it.
    await until(() =>
      events.some((e) => e.type === "ready" && e.mcpServers.some((m) => m.status === "connected")),
    );
    expect(s.sessionId).toBe("thr-1");
    const start = (await received()).find((m) => m.method === "thread/start")!;
    const params = start.params as Record<string, unknown>;
    expect(params.cwd).toBe(dir);
    expect(params.approvalPolicy).toBe("untrusted");
    expect(params.sandbox).toBe("workspace-write");
    expect(String(params.developerInstructions)).toContain("Elite Dangerous");
    const last = events.filter((e) => e.type === "ready").at(-1)!;
    expect(last).toMatchObject({
      sessionId: "thr-1",
      permissionMode: "default",
      mcpServers: [{ name: "ed-mcp", status: "connected" }],
    });
    expect(events[0]!.type).toBe("spawned");
  });

  it("streams a reply with tools and is busy until the turn completes", async () => {
    const { s, events, received } = await setup();
    s.start();
    await until(() => has(events, "ready"));
    expect(s.send("where am I?")).toBe(true);
    expect(s.busy).toBe(true);
    expect(s.send("again")).toBe(false);
    await until(() => has(events, "result"));
    expect(s.busy).toBe(false);
    const turn = types(events).slice(types(events).indexOf("text"));
    expect(turn).toEqual(["text", "toolStart", "toolEnd", "unknown", "text", "text", "result"]);
    const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
    expect(text).toBe("Checking the journal.\nYou are at ⟦Sol⟧.");
    expect(events.find((e) => e.type === "toolStart")).toMatchObject({
      name: "mcp__ed-mcp__journal_status",
    });
    expect(events.find((e) => e.type === "result")).toEqual({
      type: "result",
      isError: false,
      durationMs: 1234,
      text: null,
      sessionId: "thr-1",
      denials: [],
    });
    const start = (await received()).find((m) => m.method === "turn/start")!;
    expect(start.params).toEqual({
      threadId: "thr-1",
      input: [{ type: "text", text: "where am I?", text_elements: [] }],
    });
  });

  it("sends a message given before start once the thread is ready", async () => {
    const { s, events } = await setup();
    expect(s.send("hi")).toBe(true);
    await until(() => has(events, "result"));
    expect(types(events).slice(0, 2)).toEqual(["spawned", "ready"]);
  });

  it("shows a failed turn's message as an error reply", async () => {
    const { s, events } = await setup({ mode: "fail-turn" });
    s.send("hi");
    await until(() => has(events, "result"));
    expect(events.find((e) => e.type === "result")).toMatchObject({
      isError: true,
      text: "API down",
    });
    expect(s.busy).toBe(false);
  });

  it("reports a failed ed-mcp from its startup status", async () => {
    const { s, events } = await setup({ mode: "edmcp-fail" });
    s.start();
    await until(() =>
      events.some((e) => e.type === "ready" && e.mcpServers.some((m) => m.status === "failed")),
    );
  });

  it("stops a reply with turn/interrupt and keeps the process", async () => {
    const { s, events, methods } = await setup({ mode: "hang" });
    s.send("hi");
    await until(async () => (await methods()).includes("turn/start"));
    await until(() => s.busy && has(events, "ready"));
    // The turn id arrives with the turn/start answer.
    await new Promise((r) => setTimeout(r, 50));
    s.cancel();
    await until(() => !s.busy);
    expect(types(events).at(-1)).toBe("spawned");
    expect(has(events, "result")).toBe(false);
    const m = await methods();
    expect(m).toContain("turn/interrupt");
    expect(m.filter((x) => x === "<start>")).toHaveLength(1);
    // The next message goes to the same thread.
    expect(s.send("next")).toBe(true);
    expect(s.sessionId).toBe("thr-1");
  });

  it("restarts a process whose turn does not stop, and resumes the thread", async () => {
    const { s, events, methods } = await setup({ mode: "stuck", interruptGraceMs: 200 });
    s.send("hi");
    await until(async () => (await methods()).includes("turn/start"));
    await new Promise((r) => setTimeout(r, 50));
    s.cancel();
    await until(async () => (await methods()).filter((x) => x === "<start>").length === 2);
    await until(async () => (await methods()).includes("thread/resume"));
    expect(s.busy).toBe(false);
    expect(s.sessionId).toBe("thr-1");
    expect(has(events, "exit")).toBe(false);
  });

  it("drops a message that was still waiting for the thread when stopped", async () => {
    const { s, events, methods } = await setup({ mode: "hang" });
    s.send("hi");
    s.cancel();
    expect(s.busy).toBe(false);
    await until(() => has(events, "ready"));
    await new Promise((r) => setTimeout(r, 100));
    expect(await methods()).not.toContain("turn/start");
  });

  it("starts a new thread in the same process at /new", async () => {
    const { s, events, methods } = await setup();
    s.start();
    await until(() => s.sessionId === "thr-1");
    s.newSession();
    expect(s.sessionId).toBeNull();
    await until(() => s.sessionId === "thr-2");
    const m = await methods();
    expect(m.filter((x) => x === "thread/start")).toHaveLength(2);
    expect(m.filter((x) => x === "<start>")).toHaveLength(1);
    expect(events.filter((e) => e.type === "ready").at(-1)).toMatchObject({ sessionId: "thr-2" });
  });

  it("resumes a saved thread", async () => {
    const { s, events, received } = await setup({ resumeId: "thr-old" });
    s.send("hi");
    await until(() => has(events, "result"));
    const resume = (await received()).find((m) => m.method === "thread/resume")!;
    expect(resume.params).toMatchObject({ threadId: "thr-old", approvalPolicy: "untrusted" });
    expect(String((resume.params as Record<string, unknown>).developerInstructions)).toContain(
      "overlay",
    );
    expect(s.sessionId).toBe("thr-old");
    expect(has(events, "resumeFailed")).toBe(false);
  });

  it("starts a new thread with the player's message when the saved one is gone", async () => {
    const { s, events, received } = await setup({ mode: "no-thread", resumeId: "thr-gone" });
    s.send("hi");
    await until(() => has(events, "result"));
    const failed = events.find((e) => e.type === "resumeFailed");
    expect(failed).toEqual({
      type: "resumeFailed",
      stderrTail: ["no rollout found for thread id thr-gone"],
    });
    expect(s.sessionId).toBe("thr-1");
    const turn = (await received()).find((m) => m.method === "turn/start")!;
    expect(turn.params).toMatchObject({ threadId: "thr-1" });
    expect(types(events).indexOf("resumeFailed")).toBeLessThan(types(events).indexOf("ready"));
  });

  it("reports an exit, and resumes the thread at the next message", async () => {
    const { s, events, methods } = await setup({ mode: "crash" });
    s.send("hi");
    await until(() => has(events, "exit"));
    expect(events.find((e) => e.type === "exit")).toMatchObject({ code: 1, stderrTail: ["boom"] });
    expect(s.busy).toBe(false);
    expect(s.send("again")).toBe(true);
    await until(async () => (await methods()).includes("thread/resume"));
  });

  it("gives up after three exits in a minute", async () => {
    const { s, events } = await setup({ mode: "crash" });
    for (let i = 0; i < 3; i++) {
      await until(() => !s.busy);
      s.send("hi");
      await until(() => events.filter((e) => e.type === "exit" || e.type === "gaveUp").length > i);
    }
    expect(types(events).at(-1)).toBe("gaveUp");
    expect(s.send("more")).toBe(false);
  });

  it("reports a refused initialize like an exit, with the server's message", async () => {
    const { s, events } = await setup({ mode: "init-error" });
    s.start();
    await until(() => has(events, "exit"));
    expect(events.find((e) => e.type === "exit")).toMatchObject({
      code: null,
      stderrTail: ["not logged in"],
    });
  });

  it("reports a CLI that cannot start", async () => {
    const { s, events } = await setup({ command: path.join(os.tmpdir(), "no-such-codex.exe") });
    s.start();
    await until(() => has(events, "spawnError"));
  });

  it("asks before a shell command and answers with the player's decision", async () => {
    const answers: CodexDecision[] = ["acceptForSession"];
    const asked: CodexApproval[] = [];
    const { s, events, received } = await setup({
      mode: "approval",
      approve: async (r) => {
        asked.push(r);
        return answers.shift()!;
      },
    });
    s.send("list C:");
    await until(() => has(events, "result"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      toolName: "shell",
      shell: true,
      summary: "powershell.exe -Command dir C:\\ (in C:\\)",
    });
    const reply = (await received()).find((m) => m.id === "srv-1" && !m.method)!;
    expect(reply.result).toEqual({ decision: "acceptForSession" });
    expect(events.find((e) => e.type === "result")).toMatchObject({ denials: [] });
  });

  it("names the files of a change, and lists a declined tool as denied", async () => {
    const { s, events, asked, received } = await setup({ mode: "file-approval" });
    s.send("edit");
    await until(() => has(events, "result"));
    expect(asked[0]).toMatchObject({ toolName: "edit", shell: false, summary: "C:/x/a.txt" });
    const reply = (await received()).find((m) => m.id === "srv-1" && !m.method)!;
    expect(reply.result).toEqual({ decision: "decline" });
    expect(events.find((e) => e.type === "result")).toMatchObject({ denials: ["edit"] });
    expect(events.find((e) => e.type === "toolEnd")).toMatchObject({ name: "edit", isError: true });
  });

  it("withdraws the approval card when the reply is stopped", async () => {
    let signal: AbortSignal | null = null;
    const { s, events, received } = await setup({
      mode: "approval",
      approve: (r) =>
        new Promise((resolve) => {
          signal = r.signal;
          r.signal.addEventListener("abort", () => resolve("decline"));
        }),
    });
    s.send("hi");
    await until(() => signal !== null);
    s.cancel();
    expect(signal!.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect((await received()).some((m) => m.id === "srv-1" && !m.method)).toBe(false);
    expect(has(events, "result")).toBe(false);
  });

  it("declines MCP elicitation", async () => {
    const { s, events, received } = await setup({ mode: "elicit" });
    s.send("hi");
    await until(() => has(events, "result"));
    const reply = (await received()).find((m) => m.id === "srv-2" && !m.method)!;
    expect(reply.result).toEqual({ action: "decline", content: null, _meta: null });
  });
});
