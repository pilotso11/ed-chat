import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSession, type BackendEvent } from "../src/core/claudeSession.js";

const fake = path.join(import.meta.dirname, "fake-claude.mjs");
const fixture = path.join(import.meta.dirname, "fixtures", "stream", "handwritten.jsonl");
const sessions: ClaudeSession[] = [];

async function setup(
  mode = "ok",
  command = process.execPath,
  extraEnv: NodeJS.ProcessEnv = {},
  resumeId: string | null = null,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ed-chat-"));
  const argsFile = path.join(dir, "args.jsonl");
  const s = new ClaudeSession({
    command,
    args: [fake, "--base"],
    cwd: dir,
    resumeId,
    env: {
      ...process.env,
      FAKE_FIXTURE: fixture,
      FAKE_ARGS_FILE: argsFile,
      FAKE_MODE: mode,
      ...extraEnv,
    },
  });
  sessions.push(s);
  const events: BackendEvent[] = [];
  s.onEvent((e) => events.push(e));
  const spawns = async () =>
    (await readFile(argsFile, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  return { s, events, spawns };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(() => {
  for (const s of sessions.splice(0)) s.stop();
});

describe("ClaudeSession", () => {
  it("reports spawned at start, and ready only after the first message", async () => {
    const { s, events } = await setup();
    s.start();
    await until(() => events.some((e) => e.type === "spawned"));
    await new Promise((r) => setTimeout(r, 200));
    expect(events.map((e) => e.type)).toEqual(["spawned"]);
    expect(s.sessionId).toBeNull();
  });

  it("streams a reply and is busy until the result", async () => {
    const { s, events } = await setup();
    s.start();
    await until(() => events.some((e) => e.type === "spawned"));
    expect(s.send("hi")).toBe(true);
    expect(s.busy).toBe(true);
    expect(s.send("again")).toBe(false);
    await until(() => events.some((e) => e.type === "result"));
    expect(s.busy).toBe(false);
    expect(s.sessionId).toBe("sess-1");
    expect(events.map((e) => e.type)).toEqual([
      "spawned",
      "ready",
      "text",
      "toolStart",
      "toolEnd",
      "text",
      "result",
    ]);
  });

  it("cancel restarts with --resume and reports no exit", async () => {
    const { s, events, spawns } = await setup("hang");
    s.start();
    s.send("hi");
    await until(() => s.sessionId !== null);
    s.cancel();
    expect(s.busy).toBe(false);
    await until(async () => (await spawns()).length === 2);
    expect((await spawns())[1]).toEqual(["--base", "--resume", "sess-1"]);
    await until(() => events.filter((e) => e.type === "spawned").length === 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(events.some((e) => e.type === "exit")).toBe(false);
  });

  it("reports exits, restarts on the next send, and gives up after 3", async () => {
    const { s, events, spawns } = await setup("crash");
    s.start();
    for (let i = 1; i <= 2; i++) {
      expect(s.send("hi")).toBe(true);
      await until(() => events.filter((e) => e.type === "exit").length === i);
    }
    expect(events.find((e) => e.type === "exit")).toMatchObject({ code: 1, stderrTail: ["boom"] });
    expect((await spawns())[1]).toContain("--resume");
    expect(s.send("hi")).toBe(true);
    await until(() => events.some((e) => e.type === "gaveUp"));
    expect(s.send("hi")).toBe(false);
  });

  it("ignores stderr from a child it has replaced", async () => {
    const { s, events } = await setup("crash", process.execPath, { FAKE_STDERR_ON_KILL: "1" });
    s.start();
    await until(() => events.some((e) => e.type === "spawned"));
    // Let the fake install its SIGTERM handler.
    await new Promise((r) => setTimeout(r, 300));
    s.cancel();
    await until(() => events.filter((e) => e.type === "spawned").length === 2);
    await new Promise((r) => setTimeout(r, 300));
    s.send("hi");
    await until(() => events.some((e) => e.type === "exit"));
    expect(events.find((e) => e.type === "exit")).toMatchObject({ stderrTail: ["boom"] });
  });

  it("resumes a saved conversation on the first spawn", async () => {
    const { s, events, spawns } = await setup("ok", process.execPath, {}, "saved-1");
    expect(s.sessionId).toBe("saved-1");
    s.start();
    s.send("hi");
    await until(() => events.some((e) => e.type === "result"));
    expect((await spawns())[0]).toEqual(["--base", "--resume", "saved-1"]);
    expect(events.some((e) => e.type === "resumeFailed")).toBe(false);
  });

  it("starts a new conversation once when the saved one is gone, and resends the message", async () => {
    const { s, events, spawns } = await setup("no-session", process.execPath, {}, "gone-1");
    s.start();
    s.send("hi");
    await until(() => events.some((e) => e.type === "result"));
    expect((await spawns()).map((a) => a.includes("--resume"))).toEqual([true, false]);
    const types = events.map((e) => e.type);
    expect(types).toContain("resumeFailed");
    // The CLI's error result for the unknown id is not shown as a reply, and is not a crash.
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    expect(events.find((e) => e.type === "result")).toMatchObject({ isError: false });
    expect(types.some((t) => t === "exit" || t === "gaveUp")).toBe(false);
    expect(s.sessionId).toBe("sess-1");
  });

  it("falls back once when the saved conversation is gone before any message", async () => {
    const { s, events, spawns } = await setup("no-session", process.execPath, {}, "gone-1");
    s.start();
    await until(async () => (await spawns()).length === 2);
    await until(() => events.filter((e) => e.type === "spawned").length === 2);
    expect((await spawns()).map((a) => a.includes("--resume"))).toEqual([true, false]);
    expect(events.filter((e) => e.type === "resumeFailed")).toEqual([
      { type: "resumeFailed", stderrTail: ["No conversation found with session ID: gone-1"] },
    ]);
    expect(events.some((e) => e.type === "result" || e.type === "exit")).toBe(false);
    expect(s.sessionId).toBeNull();
  });

  it("keeps the saved conversation when the CLI fails for another reason", async () => {
    const { s, events, spawns } = await setup("exit-now", process.execPath, {}, "saved-1");
    s.start();
    await until(() => events.some((e) => e.type === "exit"));
    expect(events.some((e) => e.type === "resumeFailed")).toBe(false);
    expect(events.find((e) => e.type === "exit")).toMatchObject({ stderrTail: ["boom"] });
    expect(s.sessionId).toBe("saved-1");
    expect(await spawns()).toHaveLength(1);
  });

  it("gives up on the saved conversation after a second early exit", async () => {
    const { s, events, spawns } = await setup("exit-now", process.execPath, {}, "saved-1");
    s.start();
    await until(() => events.some((e) => e.type === "exit"));
    s.send("hi");
    await until(() => events.some((e) => e.type === "resumeFailed"));
    await until(async () => (await spawns()).length === 3);
    expect((await spawns()).map((a) => a.includes("--resume"))).toEqual([true, true, false]);
    expect(s.sessionId).toBeNull();
  });

  it("shows an error reply in a resumed conversation and is no longer busy", async () => {
    const { s, events } = await setup("error-reply", process.execPath, {}, "saved-1");
    s.start();
    s.send("hi");
    await until(() => events.some((e) => e.type === "result"));
    expect(events.find((e) => e.type === "result")).toMatchObject({
      isError: true,
      text: "API down",
    });
    expect(s.busy).toBe(false);
    expect(events.some((e) => e.type === "resumeFailed")).toBe(false);
  });

  it("newSession starts without --resume", async () => {
    const { s, events, spawns } = await setup();
    s.start();
    s.send("hi");
    await until(() => events.some((e) => e.type === "result"));
    s.newSession();
    expect(s.sessionId).toBeNull();
    await until(async () => (await spawns()).length === 2);
    expect((await spawns())[1]).toEqual(["--base"]);
  });

  it("reports a missing command", async () => {
    const { s, events } = await setup("ok", path.join(os.tmpdir(), "no-such-claude"));
    s.start();
    await until(() => events.some((e) => e.type === "spawnError"));
    expect(events.find((e) => e.type === "spawnError")).toMatchObject({
      message: expect.stringContaining("ENOENT"),
    });
  });
});

// npm installs Claude Code as claude.cmd, which needs a shell; the args must survive cmd.exe.
describe.skipIf(process.platform !== "win32")("ClaudeSession through a .cmd shim", () => {
  it("passes quoted args intact from a path with spaces", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ed chat spaces-"));
    const shim = path.join(dir, "fake claude.cmd");
    await writeFile(shim, `@"${process.execPath}" "${fake}" %*\r\n`);
    const argsFile = path.join(dir, "args.jsonl");
    const s = new ClaudeSession({
      command: shim,
      args: ["--base", "two words", path.join(dir, "mcp config.json")],
      shell: true,
      cwd: dir,
      env: { ...process.env, FAKE_FIXTURE: fixture, FAKE_ARGS_FILE: argsFile, FAKE_MODE: "ok" },
    });
    sessions.push(s);
    s.start();
    await until(async () => (await readFile(argsFile, "utf8").catch(() => "")).length > 0);
    const first = JSON.parse((await readFile(argsFile, "utf8")).split("\n")[0]!) as string[];
    expect(first).toEqual(["--base", "two words", path.join(dir, "mcp config.json")]);
  });
});
