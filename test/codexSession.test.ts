import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  startTimeoutMs?: number;
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
    startTimeoutMs: o.startTimeoutMs,
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
    // ed-mcp's status came during the turn, so its ready follows the stop.
    expect(
      types(events)
        .filter((t) => t !== "ready")
        .at(-1),
    ).toBe("spawned");
    expect(has(events, "result")).toBe(false);
    const m = await methods();
    expect(m).toContain("turn/interrupt");
    expect(m.filter((x) => x === "<start>")).toHaveLength(1);
    // The next message goes to the same thread.
    expect(s.send("next")).toBe(true);
    expect(s.sessionId).toBe("thr-1");
  });

  it("sends a message given while a stopped reply is still ending, once it has", async () => {
    const { s, events, received } = await setup({ mode: "hang" });
    s.send("hi");
    await until(async () => (await received()).some((m) => m.method === "turn/start"));
    await new Promise((r) => setTimeout(r, 50));
    s.cancel();
    expect(s.send("next")).toBe(true);
    // A third waits for nothing: the player sees busy.
    expect(s.send("third")).toBe(false);
    await until(
      async () => (await received()).filter((m) => m.method === "turn/start").length === 2,
    );
    const turns = (await received()).filter((m) => m.method === "turn/start");
    expect(turns[1]!.params).toMatchObject({ input: [{ text: "next" }] });
    expect(s.busy).toBe(true);
    expect(has(events, "result")).toBe(false);
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

  it("drops what a thread says when /new came while it was opening", async () => {
    const { s, events, received } = await setup({ mode: "slow-thread" });
    s.start();
    await until(async () => (await received()).some((m) => m.method === "thread/start"));
    s.newSession();
    await until(() => s.sessionId === "thr-2");
    const texts = events.flatMap((e) => (e.type === "text" ? [e.delta] : []));
    expect(texts.join("")).not.toContain("from thr-1");
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

  it("at /new mid-reply, stops the old turn and keeps its end out of the new thread", async () => {
    const { s, events, received } = await setup({ mode: "hang" });
    s.send("first");
    await until(async () => (await received()).some((m) => m.method === "turn/start"));
    await until(() => s.busy && s.sessionId === "thr-1");
    await new Promise((r) => setTimeout(r, 50));
    s.newSession();
    // Sent before the new thread exists, while the old turn's interrupted end is on its way.
    expect(s.send("second")).toBe(true);
    await until(async () =>
      (await received()).some(
        (m) => m.method === "turn/start" && (m.params as { threadId: string }).threadId === "thr-2",
      ),
    );
    const interrupt = (await received()).find((m) => m.method === "turn/interrupt")!;
    expect(interrupt.params).toMatchObject({ threadId: "thr-1" });
    expect(s.busy).toBe(true);
    // Only the process start: the old turn's end did not end the new message.
    expect(types(events).filter((t) => t === "spawned")).toHaveLength(1);
  });

  it("at /new before the turn has started, stops that turn when its id comes", async () => {
    const { s, received } = await setup({ mode: "slow-start" });
    s.send("first");
    await until(async () => (await received()).some((m) => m.method === "turn/start"));
    s.newSession();
    await until(async () => (await received()).some((m) => m.method === "turn/interrupt"));
    const interrupt = (await received()).find((m) => m.method === "turn/interrupt")!;
    expect(interrupt.params).toEqual({ threadId: "thr-1", turnId: "turn-1" });
  });

  it("declines an open approval request at /new, as well as withdrawing the card", async () => {
    let card: CodexApproval | null = null;
    const { s, received } = await setup({
      mode: "approval",
      approve: (r) => {
        card = r;
        return new Promise(() => {});
      },
    });
    s.send("run it");
    await until(() => card !== null);
    s.newSession();
    expect(card!.signal.aborted).toBe(true);
    await until(async () => (await received()).some((m) => m.id === "srv-1"));
    expect((await received()).find((m) => m.id === "srv-1")).toMatchObject({
      result: { decision: "decline" },
    });
  });

  it("declines, without a card, an approval request for a stopped reply", async () => {
    const { s, received, asked } = await setup({ mode: "late-approval" });
    s.send("hi");
    await until(() => s.sessionId === "thr-1" && s.busy);
    await until(async () => (await received()).some((m) => m.method === "turn/start"));
    await new Promise((r) => setTimeout(r, 50));
    s.cancel();
    await until(async () => (await received()).some((m) => m.id === "srv-3"));
    expect((await received()).find((m) => m.id === "srv-3")).toMatchObject({
      result: { decision: "decline" },
    });
    expect(asked).toHaveLength(0);
  });

  it("ignores an earlier turn's end that comes with the next turn's start", async () => {
    const { s, events, received } = await setup({ mode: "stale-complete" });
    s.send("hi");
    await until(() => has(events, "result"));
    await until(() => !s.busy);
    expect(s.send("again")).toBe(true);
    await until(
      async () => (await received()).filter((m) => m.method === "turn/start").length === 2,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(s.busy).toBe(true);
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
  });

  it("holds an MCP status change during a turn until the turn ends", async () => {
    const { s, events } = await setup({ mode: "mcp-mid-turn" });
    s.start();
    await until(() => has(events, "ready") && s.sessionId === "thr-1");
    await new Promise((r) => setTimeout(r, 50));
    const before = events.length;
    s.send("hi");
    await until(() => has(events, "result"));
    await until(() => events.slice(before).some((e) => e.type === "ready"));
    const after = types(events.slice(before));
    expect(after.indexOf("ready")).toBeGreaterThan(after.indexOf("result"));
  });

  it("does not put off the restart when stop is pressed again", async () => {
    const { s, methods } = await setup({ mode: "stuck", interruptGraceMs: 1_000 });
    s.send("hi");
    await until(async () => (await methods()).includes("turn/start"));
    await new Promise((r) => setTimeout(r, 50));
    s.cancel();
    const stopped = Date.now();
    await new Promise((r) => setTimeout(r, 900));
    s.cancel();
    // The restart begins 1 s after the first stop; put off, it would begin at 1.9 s. The
    // kill and the new process can take a while on a busy machine, so the new process is
    // looked for in a window that closes before 1.9 s, and the start itself after it.
    const restarted = async () => (await methods()).filter((x) => x === "<start>").length === 2;
    await new Promise((r) => setTimeout(r, Math.max(0, 1_800 - (Date.now() - stopped))));
    expect(s.busy).toBe(false);
    await until(restarted);
  });

  it("ignores a turn/start answer that comes after its turn ended", async () => {
    const { s, events } = await setup({ mode: "early-complete" });
    s.send("first");
    await until(() => has(events, "result"));
    expect(s.send("second")).toBe(true);
    // The first turn's late answer comes during the second turn, which still ends.
    await until(() => events.filter((e) => e.type === "result").length === 2, 3_000);
    expect(s.busy).toBe(false);
  });

  it("restarts when a stopped turn never gets its id", async () => {
    const { s, methods } = await setup({ mode: "no-turn-start", interruptGraceMs: 200 });
    s.send("hi");
    await until(async () => (await methods()).includes("turn/start"));
    s.cancel();
    expect(s.busy).toBe(true);
    await until(async () => (await methods()).filter((x) => x === "<start>").length === 2);
    expect(s.busy).toBe(false);
    expect(s.send("again")).toBe(true);
  });

  it("tries a refused resume once more, and keeps the thread when that works", async () => {
    const { s, events, received } = await setup({
      mode: "resume-error-once",
      resumeId: "thr-old",
    });
    s.send("hi");
    await until(() => has(events, "result"));
    expect(has(events, "resumeFailed")).toBe(false);
    expect(s.sessionId).toBe("thr-old");
    const turn = (await received()).find((m) => m.method === "turn/start")!;
    expect(turn.params).toMatchObject({ threadId: "thr-old" });
  });

  it("starts a new thread with the message when the resume is refused twice", async () => {
    const { s, events, received } = await setup({ mode: "resume-error", resumeId: "thr-old" });
    s.send("hi");
    await until(() => has(events, "result"));
    expect(events.find((e) => e.type === "resumeFailed")).toEqual({
      type: "resumeFailed",
      stderrTail: ["internal error"],
    });
    expect(has(events, "exit")).toBe(false);
    const turn = (await received()).find((m) => m.method === "turn/start")!;
    expect(turn.params).toMatchObject({ threadId: "thr-1" });
  });

  it("forgets the MCP statuses of a process that has gone", async () => {
    const { s, events, methods } = await setup({ mode: "mcp-first-only" });
    s.start();
    await until(() =>
      events.some((e) => e.type === "ready" && e.mcpServers.some((m) => m.name === "ed-mcp")),
    );
    s.send("hi");
    await until(() => has(events, "exit"));
    const before = events.length;
    s.send("again");
    await until(async () => (await methods()).includes("thread/resume"));
    await until(() => events.slice(before).some((e) => e.type === "ready"));
    const ready = events.slice(before).find((e) => e.type === "ready");
    expect(ready).toMatchObject({ mcpServers: [] });
  });

  it("keeps the saved thread when the process dies during the resume", async () => {
    const { s, events } = await setup({ mode: "resume-crash", resumeId: "thr-old" });
    s.start();
    await until(() => has(events, "exit"));
    expect(has(events, "resumeFailed")).toBe(false);
    expect(s.sessionId).toBe("thr-old");
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

  it("ends a process that never opens a conversation, so the message does not wait for ever", async () => {
    const { s, events } = await setup({ mode: "no-answer", startTimeoutMs: 200 });
    s.send("hi");
    await until(() => has(events, "exit"));
    expect(events.find((e) => e.type === "exit")).toMatchObject({
      stderrTail: ["codex did not open a conversation in time"],
    });
    expect(s.busy).toBe(false);
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
    // Declined once, by the session: the player's late answer is not sent as well.
    expect((await received()).filter((m) => m.id === "srv-1" && !m.method)).toEqual([
      { id: "srv-1", result: { decision: "decline" } },
    ]);
    expect(has(events, "result")).toBe(false);
  });

  it("withdraws and declines an approval request that the turn's end leaves open", async () => {
    let card: CodexApproval | null = null;
    const { s, events, received } = await setup({
      mode: "end-with-open-approval",
      approve: (r) => {
        card = r;
        return new Promise(() => {});
      },
    });
    s.send("run it");
    await until(() => has(events, "result"));
    expect(card!.signal.aborted).toBe(true);
    await until(async () => (await received()).some((m) => m.id === "srv-1"));
    expect((await received()).filter((m) => m.id === "srv-1")).toEqual([
      { id: "srv-1", result: { decision: "decline" } },
    ]);
  });

  it("withdraws the card, and sends nothing, when Codex resolves the request itself", async () => {
    let card: CodexApproval | null = null;
    let answer: ((d: CodexDecision) => void) | null = null;
    const { s, received } = await setup({
      mode: "self-resolved",
      approve: (r) => {
        card = r;
        return new Promise((resolve) => (answer = resolve));
      },
    });
    s.send("run it");
    await until(() => card !== null);
    await until(() => card!.signal.aborted);
    // The player's late answer goes nowhere.
    answer!("accept");
    await new Promise((r) => setTimeout(r, 100));
    expect((await received()).some((m) => m.id === "srv-1")).toBe(false);
    expect(s.busy).toBe(true);
  });

  it("declines MCP elicitation", async () => {
    const { s, events, received } = await setup({ mode: "elicit" });
    s.send("hi");
    await until(() => has(events, "result"));
    const reply = (await received()).find((m) => m.id === "srv-2" && !m.method)!;
    expect(reply.result).toEqual({ action: "decline", content: null, _meta: null });
  });
});

// npm installs Codex as codex.cmd, which needs a shell; the args must survive cmd.exe.
describe.skipIf(process.platform !== "win32")("CodexSession through a .cmd shim", () => {
  it("passes quoted args intact from a path with spaces", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ed chat spaces-"));
    const shim = path.join(dir, "fake codex.cmd");
    await writeFile(shim, `@"${process.execPath}" "${fake}" %*\r\n`);
    const log = path.join(dir, "log.jsonl");
    const s = new CodexSession({
      command: shim,
      args: ["app-server", "two words", path.join(dir, "a b.toml")],
      shell: true,
      cwd: dir,
      thread: codexThreadSettings({ permissionMode: "default", cwd: dir }),
      approve: async () => "decline",
      env: { ...process.env, FAKE_FIXTURE: fixture, FAKE_MODE: "ok", FAKE_LOG: log },
    });
    sessions.push(s);
    s.start();
    await until(() => s.sessionId !== null);
    const first = JSON.parse((await readFile(log, "utf8")).split("\n")[0]!) as { argv: string[] };
    expect(first.argv).toEqual(["app-server", "two words", path.join(dir, "a b.toml")]);
  });
});
