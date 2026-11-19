// A small `codex app-server`: answers the handshake and thread calls, and plays FAKE_FIXTURE for
// each turn. FAKE_MODE picks a failure to act out; FAKE_LOG records every message it receives.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const fixture = readFileSync(process.env.FAKE_FIXTURE, "utf8").split("\n").filter(Boolean);
const mode = process.env.FAKE_MODE ?? "ok";
const logFile = process.env.FAKE_LOG;
if (logFile) appendFileSync(logFile, JSON.stringify({ argv: process.argv.slice(2) }) + "\n");
// Which start of the fake this is, counted in the log: 1 for the first process.
const start = logFile
  ? readFileSync(logFile, "utf8")
      .split("\n")
      .filter((l) => l.startsWith('{"argv"')).length
  : 1;
// mcp-first-only: only the first process reports ed-mcp, and it dies at its first turn.
const reportsMcp = mode !== "mcp-first-only" || start === 1;

const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const note = (method, params) => out({ method, params });
let threads = 0;
let threadCwd = "";
let resumeRefused = 0;
let turns = 0;
let current = null;
const waiting = new Map();

function playTurn(threadId, turnId) {
  if (mode === "crash" || (mode === "mcp-first-only" && start === 1)) {
    process.stderr.write("boom\n", () => process.exit(1));
    return;
  }
  if (
    mode === "hang" ||
    mode === "stuck" ||
    mode === "late-approval" ||
    mode === "crash-on-interrupt"
  )
    return;
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
  // Codex ends the turn by itself, with no stop from the player.
  // A shell command in the workspace, which Codex echoes with another case (Windows) or a
  // trailing slash.
  if (mode === "approval-in-workspace") {
    waiting.set("srv-4", () =>
      note("turn/completed", {
        threadId,
        turn: { id: turnId, status: "completed", error: null, durationMs: 1 },
      }),
    );
    const cwd = process.platform === "win32" ? threadCwd.toUpperCase() : threadCwd + "/";
    out({
      id: "srv-4",
      method: "item/commandExecution/requestApproval",
      params: { threadId, turnId, itemId: "cmd-4", command: "dir", cwd },
    });
    return;
  }
  if (mode === "self-interrupt") {
    note("item/agentMessage/delta", { threadId, turnId, itemId: "m", delta: "Part of " });
    note("turn/completed", {
      threadId,
      turn: { id: turnId, status: "interrupted", error: null, durationMs: 2 },
    });
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
  // An approval request that the turn leaves open: the turn ends, or Codex resolves the
  // request itself, while the card is up.
  if (mode === "end-with-open-approval" || mode === "self-resolved") {
    out({
      id: "srv-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId, turnId, itemId: "cmd-1", command: "dir", cwd: "C:\\" },
    });
    setTimeout(() => {
      if (mode === "self-resolved")
        note("serverRequest/resolved", { threadId, requestId: "srv-1" });
      else
        note("turn/completed", {
          threadId,
          turn: { id: turnId, status: "completed", error: null, durationMs: 1 },
        });
    }, 100);
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
      if (mode === "no-answer") return;
      if (mode === "init-error")
        return out({ id, error: { code: -32603, message: "not logged in" } });
      return out({ id, result: { userAgent: "fake-codex/0.170.0" } });
    case "initialized":
      return;
    case "thread/start":
    case "thread/resume": {
      if (method === "thread/resume" && mode === "resume-crash") process.exit(1);
      // resume-error refuses every resume; resume-error-once only the first in each process.
      if (
        method === "thread/resume" &&
        (mode === "resume-error" || (mode === "resume-error-once" && !resumeRefused++))
      )
        return out({ id, error: { code: -32603, message: "internal error" } });
      if (method === "thread/resume" && mode === "resume-null") return out({ id, result: null });
      if (method === "thread/resume" && mode === "no-thread")
        return out({
          id,
          error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` },
        });
      if (reportsMcp)
        note("mcpServer/startupStatus/updated", {
          threadId: null,
          name: "ed-mcp",
          status: "starting",
          error: null,
        });
      const threadId = method === "thread/resume" ? params.threadId : `thr-${++threads}`;
      threadCwd = params.cwd ?? "";
      // slow-thread: the answer comes late, and the thread then says something on its own.
      if (mode === "slow-thread") {
        setTimeout(
          () => {
            out({
              id,
              result: { thread: { id: threadId }, approvalPolicy: params.approvalPolicy },
            });
            setTimeout(
              () =>
                note("item/agentMessage/delta", {
                  threadId,
                  turnId: "t",
                  itemId: `m-${threadId}`,
                  delta: `from ${threadId}`,
                }),
              30,
            );
            // The second thread opens later, so the first one speaks before it is known.
          },
          threadId === "thr-1" ? 200 : 500,
        );
        return;
      }
      out({
        id,
        result: {
          thread: { id: threadId },
          approvalPolicy: params.approvalPolicy,
          cwd: params.cwd,
        },
      });
      const failed = mode === "edmcp-fail";
      if (reportsMcp)
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
      // The first turn ends before its turn/start answer, which comes late, during the next
      // turn. The next turn ends once that late answer is out.
      if (mode === "early-complete") {
        if (turnId === "turn-1") {
          note("turn/completed", {
            threadId: params.threadId,
            turn: { id: turnId, status: "completed", error: null, durationMs: 1 },
          });
          return setTimeout(answer, 300);
        }
        answer();
        // Only the end: no turn/started that would name the running turn again.
        return setTimeout(
          () =>
            note("turn/completed", {
              threadId: params.threadId,
              turn: { id: turnId, status: "completed", error: null, durationMs: 1 },
            }),
          600,
        );
      }
      answer();
      return playTurn(params.threadId, turnId);
    }
    case "turn/interrupt":
      if (mode === "crash-on-interrupt") process.exit(1);
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
