// A small `codex app-server`: answers the handshake and thread calls, and plays FAKE_FIXTURE for
// each turn. FAKE_MODE picks a failure to act out; FAKE_LOG records every message it receives.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const fixture = readFileSync(process.env.FAKE_FIXTURE, "utf8").split("\n").filter(Boolean);
const mode = process.env.FAKE_MODE ?? "ok";
const logFile = process.env.FAKE_LOG;
if (logFile) appendFileSync(logFile, JSON.stringify({ argv: process.argv.slice(2) }) + "\n");

const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const note = (method, params) => out({ method, params });
let threads = 0;
let turns = 0;
let current = null;
const waiting = new Map();

function playTurn(threadId, turnId) {
  if (mode === "crash") {
    process.stderr.write("boom\n", () => process.exit(1));
    return;
  }
  if (mode === "hang" || mode === "stuck" || mode === "late-approval") return;
  // The first turn plays as usual. The second gets the first turn's end again, sent with the
  // turn/start answer in one chunk, and then hangs.
  if (mode === "stale-complete" && turnId !== "turn-1") return;
  // An MCP server changes status during the turn.
  if (mode === "mcp-mid-turn") {
    note("mcpServer/startupStatus/updated", {
      threadId: null,
      name: "other",
      status: "ready",
      error: null,
    });
    setTimeout(
      () =>
        note("turn/completed", {
          threadId,
          turn: { id: turnId, status: "completed", error: null, durationMs: 1 },
        }),
      100,
    );
    return;
  }
  if (mode === "fail-turn") {
    note("turn/completed", {
      threadId,
      turn: { id: turnId, status: "failed", error: { message: "API down" }, durationMs: 5 },
    });
    return;
  }
  if (mode === "approval" || mode === "file-approval") {
    const file = mode === "file-approval";
    const itemId = file ? "patch-1" : "cmd-1";
    if (file)
      note("item/started", {
        threadId,
        turnId,
        item: {
          type: "fileChange",
          id: itemId,
          changes: [{ path: "C:/x/a.txt" }],
          status: "inProgress",
        },
      });
    const id = "srv-1";
    waiting.set(id, (decision) => {
      const declined = decision === "decline";
      note("item/completed", {
        threadId,
        turnId,
        item: file
          ? {
              type: "fileChange",
              id: itemId,
              changes: [],
              status: declined ? "declined" : "completed",
            }
          : {
              type: "commandExecution",
              id: itemId,
              command: "dir",
              status: declined ? "declined" : "completed",
            },
      });
      note("turn/completed", {
        threadId,
        turn: { id: turnId, status: "completed", error: null, durationMs: 9 },
      });
    });
    out({
      id,
      method: file ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval",
      params: file
        ? { threadId, turnId, itemId, reason: "outside the workspace" }
        : { threadId, turnId, itemId, command: "powershell.exe -Command dir C:\\", cwd: "C:\\" },
    });
    return;
  }
  if (mode === "elicit") {
    waiting.set("srv-2", () =>
      note("turn/completed", {
        threadId,
        turn: { id: turnId, status: "completed", error: null, durationMs: 1 },
      }),
    );
    out({
      id: "srv-2",
      method: "mcpServer/elicitation/request",
      params: { threadId, serverName: "ed-mcp" },
    });
    return;
  }
  for (const l of fixture)
    process.stdout.write(l.replaceAll("$THREAD", threadId).replaceAll("$TURN", turnId) + "\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (logFile) appendFileSync(logFile, line + "\n");
  const msg = JSON.parse(line);
  // A response to a request this server made.
  if (msg.method === undefined) {
    waiting.get(msg.id)?.(msg.result?.decision ?? msg.result?.action);
    waiting.delete(msg.id);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      if (mode === "init-error")
        return out({ id, error: { code: -32603, message: "not logged in" } });
      return out({ id, result: { userAgent: "fake-codex/0.170.0" } });
    case "initialized":
      return;
    case "thread/start":
    case "thread/resume": {
      if (method === "thread/resume" && mode === "resume-crash") process.exit(1);
      if (method === "thread/resume" && mode === "no-thread")
        return out({
          id,
          error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` },
        });
      note("mcpServer/startupStatus/updated", {
        threadId: null,
        name: "ed-mcp",
        status: "starting",
        error: null,
      });
      const threadId = method === "thread/resume" ? params.threadId : `thr-${++threads}`;
      out({
        id,
        result: {
          thread: { id: threadId },
          approvalPolicy: params.approvalPolicy,
          cwd: params.cwd,
        },
      });
      const failed = mode === "edmcp-fail";
      note("mcpServer/startupStatus/updated", {
        threadId: null,
        name: "ed-mcp",
        status: failed ? "failed" : "ready",
        error: failed ? "spawn npx ENOENT" : null,
      });
      return;
    }
    case "turn/start": {
      const turnId = `turn-${++turns}`;
      current = { threadId: params.threadId, turnId };
      const answer = () =>
        out({ id, result: { turn: { id: turnId, items: [], status: "inProgress", error: null } } });
      if (mode === "slow-start") return setTimeout(answer, 300);
      if (mode === "stale-complete" && turnId !== "turn-1") {
        const stale = {
          method: "turn/completed",
          params: {
            threadId: params.threadId,
            turn: { id: "turn-1", status: "completed", error: null, durationMs: 1 },
          },
        };
        process.stdout.write(
          JSON.stringify({
            id,
            result: { turn: { id: turnId, items: [], status: "inProgress", error: null } },
          }) +
            "\n" +
            JSON.stringify(stale) +
            "\n",
        );
        return playTurn(params.threadId, turnId);
      }
      if (mode === "no-turn-start") return;
      answer();
      return playTurn(params.threadId, turnId);
    }
    case "turn/interrupt":
      out({ id, result: {} });
      if (mode === "late-approval" && current)
        out({
          id: "srv-3",
          method: "item/commandExecution/requestApproval",
          params: { ...current, itemId: "cmd-3", command: "del C:\\x", cwd: "C:\\" },
        });
      if (mode !== "stuck" && current)
        note("turn/completed", {
          threadId: current.threadId,
          turn: { id: current.turnId, status: "interrupted", error: null, durationMs: 3 },
        });
      return;
    default:
      return out({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
rl.on("close", () => process.exit(0));
