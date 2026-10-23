import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSession, type BackendEvent } from "../src/core/claudeSession.js";

const fake = path.join(import.meta.dirname, "fake-claude.mjs");
const fixture = path.join(import.meta.dirname, "fixtures", "stream", "handwritten.jsonl");
const sessions: ClaudeSession[] = [];

async function setup(mode = "ok", command = process.execPath, extraEnv: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ed-overlay-"));
  const argsFile = path.join(dir, "args.jsonl");
  const s = new ClaudeSession({
    command,
    args: [fake, "--base"],
    cwd: dir,
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
