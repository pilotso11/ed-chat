// Step 0 of the Codex backend spec (docs/superpowers/specs/2026-11-18-codex-backend-design.md).
// Drives `codex app-server` the way ED Chat will, and records every JSON-RPC line raw.
// The recordings hold personal data (commander name, journal paths): keep them out of git and
// scrub them before they become test fixtures. ED_MCP env values longer than 8 chars are redacted.
// It reads the ed-mcp definition from ~/.claude.json (user scope, then each project) and spends
// a few Codex turns.
// Usage: node scripts/codex-probe.mjs <codex.exe> <outDir outside any git repo> [mode]; see USAGE.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MODES = ["thread-config", "cli-config"];
const USAGE = `Usage: node scripts/codex-probe.mjs <path to codex.exe> <outDir outside any git repo> [${MODES.join("|")}]`;
const [codex, outDir, mode = MODES[0]] = process.argv.slice(2);
if (!codex || !outDir || !MODES.includes(mode)) {
  console.error(USAGE);
  process.exit(2);
}
// The recordings hold personal data, so they must not land where git add can pick them up:
// git itself says whether the nearest existing folder is in a work tree, this repo's or any
// other (a worktree, the main checkout), however the path is spelled.
function inWorkTree(p) {
  let base = resolve(p);
  while (!existsSync(base)) {
    const up = dirname(base);
    if (up === base) return null;
    base = up;
  }
  try {
    const out = execFileSync("git", ["-C", base, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "true";
  } catch (err) {
    // git exits non-zero outside a repo; a missing git cannot tell, so the folder is refused.
    return typeof err.status === "number" ? false : null;
  }
}
const out = resolve(outDir);
const inside = inWorkTree(out);
if (inside !== false) {
  console.error(
    inside
      ? `outDir must be outside any git work tree: ${out}`
      : `cannot check that outDir is outside git (no such drive, or git not found): ${out}`,
  );
  console.error(USAGE);
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const work = join(out, "cwd");
mkdirSync(work, { recursive: true });

const claudeJson = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
// The same order as findEdMcp() in src/core/edMcp.ts.
const ed = [
  claudeJson.mcpServers?.["ed-mcp"],
  ...Object.values(claudeJson.projects ?? {}).map((p) => p?.mcpServers?.["ed-mcp"]),
].find((e) => typeof e?.command === "string");
if (!ed) {
  console.error("No ed-mcp with a command in ~/.claude.json");
  process.exit(1);
}
// The log lines are JSON, so each value is also redacted in its JSON-escaped form.
const secrets = Object.values(ed.env ?? {})
  .filter((v) => typeof v === "string" && v.length > 8)
  .flatMap((v) => [JSON.stringify(v).slice(1, -1), v]);
const redact = (s) => secrets.reduce((acc, v) => acc.split(v).join("<redacted>"), s);
const edToml = { command: ed.command, args: ed.args, env: ed.env };

const log = (file, line) => appendFileSync(join(out, file), redact(line) + "\n");

function start(file, extraArgs = []) {
  const p = spawn(codex, ["app-server", ...extraArgs], {
    cwd: work,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  // A crash or a failed spawn ends every request still waiting, so the probe does not hang.
  const failAll = (err) => {
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };
  p.on("error", (err) => {
    log(file, `!! spawn error: ${err.message}`);
    failAll(err);
  });
  p.on("exit", (code) => failAll(new Error(`codex exited with code ${code}`)));
  p.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      log(file, "<< " + line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      } else {
        // A copy: a listener that is done removes itself while the loop runs.
        for (const l of [...listeners]) l(msg);
      }
    }
  });
  p.stderr.on("data", (d) => log(file.replace(".jsonl", ".stderr.txt"), d.toString("utf8")));
  const send = (obj) => {
    const s = JSON.stringify(obj);
    log(file, ">> " + s);
    p.stdin.write(s + "\n");
  };
  const request = (method, params, ms = 180000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, ms);
      pending.set(id, {
        resolve: (m) => (clearTimeout(t), resolve(m)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      send({ id, method, params });
    });
  const waitFor = (pred, ms = 180000) =>
    new Promise((resolve, reject) => {
      const remove = () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
      const t = setTimeout(() => {
        remove();
        reject(new Error("timeout waiting"));
      }, ms);
      const l = (m) => {
        if (pred(m)) {
          clearTimeout(t);
          remove();
          resolve(m);
        }
      };
      listeners.push(l);
    });
  return { p, send, request, waitFor, on: (l) => listeners.push(l) };
}

const DEV =
  "You are a co-pilot in an Elite Dangerous overlay. Begin every reply with the word ROGER. Keep replies under 40 words.";
const cliOverrides =
  mode === "cli-config"
    ? [
        "-c",
        `mcp_servers.ed-mcp.command=${JSON.stringify(ed.command)}`,
        "-c",
        `mcp_servers.ed-mcp.args=${JSON.stringify(ed.args)}`,
        ...Object.entries(ed.env ?? {}).flatMap(([k, v]) => [
          "-c",
          `mcp_servers.ed-mcp.env.${k}=${JSON.stringify(v)}`,
        ]),
      ]
    : [];
const threadConfig = mode === "thread-config" ? { mcp_servers: { "ed-mcp": edToml } } : undefined;

async function init(s) {
  const r = await s.request("initialize", {
    clientInfo: { name: "ed-chat-probe", title: "ED Chat probe", version: "0.0.0" },
    capabilities: { experimentalApi: false, requestAttestation: false },
  });
  s.send({ method: "initialized" });
  return r;
}

// Answer approvals: decline anything, and record that it was asked.
function autoAnswer(s, file) {
  s.on((m) => {
    if (m.id !== undefined && m.method) {
      log("approvals.txt", `${file}: ${m.method} ${JSON.stringify(m.params).slice(0, 400)}`);
      const result = m.method.includes("elicitation")
        ? { action: "decline", content: null }
        : { decision: "decline" };
      s.send({ id: m.id, result });
    }
  });
}

const summary = {};
try {
  // Run 1: new thread, ed-mcp tool, a command needing approval, streaming.
  const a = start("run1.jsonl", cliOverrides);
  autoAnswer(a, "run1");
  summary.initialize = (await init(a)).result ? "ok" : "error";
  const ts = await a.request("thread/start", {
    cwd: work,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    developerInstructions: DEV,
    config: threadConfig,
  });
  if (ts.error) throw new Error("thread/start: " + JSON.stringify(ts.error));
  const threadId = ts.result.thread.id;
  summary.threadId = threadId;
  let deltas = 0;
  a.on((m) => {
    if (m.method === "item/agentMessage/delta") deltas++;
  });
  await a.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: "Call the ed-mcp journal_status tool and tell me the commander name. Then create the file C:\\Users\\Public\\edchat-probe.txt containing hi using a shell command.",
        text_elements: [],
      },
    ],
  });
  const done1 = await a.waitFor((m) => m.method === "turn/completed");
  summary.turn1 = { status: done1.params.turn.status, deltas };

  // Run 1b: interrupt a long turn after the first delta.
  await a.request("turn/start", {
    threadId,
    input: [
      { type: "text", text: "Count slowly from 1 to 200, one number per line.", text_elements: [] },
    ],
  });
  const first = await a.waitFor(
    (m) =>
      m.method === "item/agentMessage/delta" ||
      (m.method === "item/started" && m.params.item.type === "agentMessage"),
  );
  const ir = await a.request("turn/interrupt", { threadId, turnId: first.params.turnId });
  const done2 = await a.waitFor((m) => m.method === "turn/completed");
  summary.interrupt = { response: ir.error ? ir.error : "ok", status: done2.params.turn.status };
  a.p.kill();

  // Run 2: new process, resume by id, check memory; then a bogus id.
  const b = start("run2.jsonl", cliOverrides);
  autoAnswer(b, "run2");
  await init(b);
  const rr = await b.request("thread/resume", {
    threadId,
    developerInstructions: DEV,
    config: threadConfig,
    excludeTurns: true,
  });
  summary.resume = rr.error ? rr.error : "ok";
  await b.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: "What commander name did you find earlier? One line.",
        text_elements: [],
      },
    ],
  });
  const done3 = await b.waitFor((m) => m.method === "turn/completed");
  summary.resumedTurn = done3.params.turn.status;
  const bogus = await b.request("thread/resume", {
    threadId: "019a0000-0000-7000-8000-000000000000",
  });
  summary.bogusResume = bogus.error ?? "unexpected ok";
  b.p.kill();
} catch (e) {
  summary.failure = String(e);
}
writeFileSync(join(out, "summary.json"), redact(JSON.stringify(summary, null, 2)));
console.log(redact(JSON.stringify(summary, null, 2)));
process.exit(0);
