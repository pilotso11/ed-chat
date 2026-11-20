// Step 0 of the Codex backend spec (docs/superpowers/specs/2026-11-18-codex-backend-design.md).
// Drives `codex app-server` the way ED Chat will, and records every JSON-RPC line raw.
// The recordings hold personal data (commander name, journal paths): keep them out of git and
// scrub them (scripts/scrub-fixtures.mjs) before they become test fixtures. ED_MCP_SYNC_PASSWORD,
// any other env value longer than 8 chars, and secret-looking values in ed-mcp's args are
// redacted, in any path spelling and escaping.
// It reads the ed-mcp definition from ~/.claude.json (user scope, then each project) and spends
// a few Codex turns.
// Usage: node scripts/codex-probe.mjs <codex.exe> <outDir outside any git repo> [mode]; see USAGE.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const MODES = ["thread-config", "cli-config"];
const USAGE = `Usage: node scripts/codex-probe.mjs <path to codex.exe> <outDir outside any git repo> [${MODES.join("|")}]`;

const runGit = (args, env) =>
  spawnSync("git", args, { encoding: "utf8", env, windowsHide: true, stdio: "pipe" });

/**
 * Why `p` cannot hold the recordings, or null when it can. The recordings hold personal data,
 * so they must not land where git add can pick them up. Git itself says whether the nearest
 * existing folder is in a repository (a work tree or a .git folder), this repo's or any other,
 * however the path is spelled. Inherited GIT_* variables are ignored, so GIT_DIR cannot point
 * git somewhere else. Any answer other than "not a git repository" refuses the folder.
 */
export function outDirProblem(p, { run = runGit, env = process.env } = {}) {
  const full = resolve(p);
  if (full.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) {
    return `outDir must not be inside a .git folder: ${full}`;
  }
  let base = full;
  while (!existsSync(base)) {
    const up = dirname(base);
    if (up === base) return `cannot check that outDir is outside git (no such drive): ${full}`;
    base = up;
  }
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_/i.test(k)));
  // English messages, and a search that does not stop at a drive or mount boundary.
  delete clean.LANGUAGE;
  Object.assign(clean, { LC_ALL: "C", GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" });
  const r = run(["-C", base, "rev-parse", "--is-inside-work-tree", "--is-inside-git-dir"], clean);
  if (r.error) return `cannot check that outDir is outside git (git not found): ${full}`;
  // Any answer means a repository: a work tree, a .git folder or a bare repository.
  if (r.status === 0) {
    const [, gitDir] = (r.stdout ?? "").trim().split(/\s+/);
    return gitDir === "true"
      ? `outDir must not be inside a .git folder: ${full}`
      : `outDir must be outside any git work tree: ${full}`;
  }
  if (/not a git repository/i.test(r.stderr ?? "")) return null;
  return `cannot check that outDir is outside git (${(r.stderr ?? "").trim() || `git exited with ${r.status}`}): ${full}`;
}

/** Whether `m` is the turn/completed of the turn `turnId`. */
export const isTurnCompleted = (m, turnId) =>
  m?.method === "turn/completed" && !!turnId && m.params?.turn?.id === turnId;

// Flags and names whose value is a secret. Each word (split at - _ = and capitals) is looked
// at: one that holds password, passwd, passphrase, secret, token or apikey, or starts with
// auth, oauth, cred or pass, is a secret, unless it is one of the words that only look like
// one. When unsure, a value is redacted: a recording with too much hidden is safe.
// The bare word pass is a secret (--pass-word, --db-pass); only longer words are excluded.
const NOT_SECRET =
  /^(author(s|ed|ing|ship)?|passthrough|passive\w*|passenger\w*|passage\w*|pass(es|ed|ing))$/;
const SECRET_NAME = {
  test(name) {
    const words = String(name)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return words.some(
      (w, i) =>
        (!NOT_SECRET.test(w) &&
          (/password|passwd|passphrase|secret|token|apikey/.test(w) ||
            /^(auth|oauth|cred|pass)/.test(w))) ||
        (w === "api" && words[i + 1] === "key"),
    );
  },
};

/**
 * The values to redact from ed-mcp's definition. From env: the password at any length, other
 * values when long enough to be one (a short one such as "1" would blank out ids and counts all
 * through the recording). From args: the value after a secret-looking flag (`--password x`), and
 * the value of `--password=x` or `PASSWORD=x`.
 */
export function secretsOf(ed) {
  const out = Object.entries(ed?.env ?? {})
    .filter(
      ([k, v]) => typeof v === "string" && v && (k === "ED_MCP_SYNC_PASSWORD" || v.length > 8),
    )
    .map(([, v]) => v);
  const args = Array.isArray(ed?.args) ? ed.args.filter((a) => typeof a === "string") : [];
  args.forEach((a, i) => {
    const eq = /^(-*[\w.-]+)=(.+)$/s.exec(a);
    if (eq && SECRET_NAME.test(eq[1])) out.push(eq[2]);
    else if (/^-/.test(a) && SECRET_NAME.test(a) && args[i + 1]) out.push(args[i + 1]);
  });
  return [...new Set(out)];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A function that replaces each secret with <redacted>. A path matches with either slash, and
 * any value matches however many times it was JSON-escaped (a backslash or quote gains more
 * backslashes each time). Paths on Windows ignore case, so every match does.
 */
export function makeRedactor(secrets) {
  const pattern = secrets
    .filter(Boolean)
    // Longest first, so a value inside another is not redacted half-way.
    .sort((a, b) => b.length - a.length)
    .map((v) =>
      [...v]
        .map((c) => (c === "\\" || c === "/" ? "(?:\\\\+|/)+" : c === '"' ? '\\\\*"' : escapeRe(c)))
        .join(""),
    )
    .join("|");
  if (!pattern) return (s) => s;
  const re = new RegExp(pattern, "gi");
  return (s) => s.replace(re, "<redacted>");
}

/**
 * The `-c` overrides and the environment for codex in cli-config mode. ed-mcp's env goes into
 * codex's own environment, and `env_vars` names it, so codex passes it on. Env values never go
 * on the command line, where other processes can read them (ED_MCP_SYNC_PASSWORD). ed-mcp's
 * args do: a secret passed as an arg is visible to other processes while the probe runs (it is
 * still redacted from the recordings). Use config-field mode for such a setup.
 */
export function cliConfig(ed, baseEnv = process.env) {
  const env = Object.fromEntries(
    Object.entries(ed.env ?? {}).filter(([, v]) => typeof v === "string"),
  );
  const args = [
    "-c",
    `mcp_servers.ed-mcp.command=${JSON.stringify(ed.command)}`,
    "-c",
    `mcp_servers.ed-mcp.args=${JSON.stringify(ed.args ?? [])}`,
  ];
  const names = Object.keys(env);
  if (names.length) args.push("-c", `mcp_servers.ed-mcp.env_vars=${JSON.stringify(names)}`);
  return { args, env: { ...baseEnv, ...env } };
}

// The processes started by `pid`, found by parent id. Used when codex has already gone, so
// taskkill /T can no longer find its tree. Only those started after codex count: a pid can be
// used again.
function childrenOf(pid, since) {
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | ForEach-Object { "$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`,
    ],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  if (r.status !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split(" ").map(Number))
    .filter(([id, at]) => id > 0 && at >= since - 1000)
    .map(([id]) => id);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stops a child and everything it started (ed-mcp under cmd /c npx), as in ED Chat's own
 * sessions. On Windows kill() stops only the child, so taskkill /T stops the tree. When the child
 * has already gone, its own children are stopped the same way. Elsewhere the child runs in its
 * own process group (spawned detached), and the group goes.
 */
export function stopTree(child, startedAt = 0) {
  if (!child?.pid) return;
  const gone = child.exitCode !== null || child.signalCode !== null;
  if (process.platform === "win32") {
    const taskkill = (pid) =>
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    if (!gone) {
      const r = taskkill(child.pid);
      // No taskkill, or it was refused: the child itself still goes.
      if (r.error || r.status !== 0) child.kill();
      return;
    }
    // A pid in use again belongs to another program, and so do its children.
    if (alive(child.pid)) return;
    for (const pid of childrenOf(child.pid, startedAt)) taskkill(pid);
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    if (!gone) child.kill();
  }
}

// readline decodes across chunks and gives the last line too when it has no newline.
const onLines = (stream, cb) =>
  createInterface({ input: stream, crlfDelay: Infinity }).on("line", cb);

async function main(argv) {
  const [codex, outDir, mode = MODES[0]] = argv;
  if (!codex || !outDir || !MODES.includes(mode)) {
    console.error(USAGE);
    process.exit(2);
  }
  const out = resolve(outDir);
  const problem = outDirProblem(out);
  if (problem) {
    console.error(problem);
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
  const redact = makeRedactor(secretsOf(ed));
  const edToml = { command: ed.command, args: ed.args, env: ed.env };
  const log = (file, line) => appendFileSync(join(out, file), redact(line) + "\n");

  // Every codex started, so each exit path stops them and their ed-mcp.
  const sessions = [];
  const stopAll = () => {
    for (const s of sessions) s.stop();
  };
  // Also when the probe ends early: an uncaught error or process.exit runs the exit event, and
  // Ctrl+C is turned into an exit.
  process.on("exit", stopAll);
  process.on("SIGINT", () => process.exit(130));

  function start(file, { args = [], env = process.env } = {}) {
    const startedAt = Date.now();
    const p = spawn(codex, ["app-server", ...args], {
      cwd: work,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group outside Windows, so stopTree() can stop ed-mcp too.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stopTree(p, startedAt);
    };
    let nextId = 1;
    const pending = new Map();
    const listeners = [];
    // Waits for a notification, each with its reject, so a crash ends them too.
    const waiters = new Set();
    // Every turn/completed by turn id: it can come in the same chunk as the turn/start answer,
    // before anyone waits for it.
    const completed = new Map();
    // A crash or a failed spawn ends every request and wait still open, so the probe does not hang.
    let dead = null;
    const failAll = (err) => {
      dead ??= err;
      for (const { reject } of pending.values()) reject(dead);
      pending.clear();
      for (const reject of [...waiters]) reject(dead);
      // ed-mcp can outlive a codex that crashed.
      stop();
    };
    p.on("error", (err) => {
      log(file, `!! spawn error: ${err.message}`);
      failAll(err);
    });
    // exit can come before the last stdout line is read, and close can wait for ever when a
    // grandchild (ed-mcp under cmd) holds the pipes. So: close, or a moment after exit.
    p.on("exit", (code) => {
      const err = new Error(`codex exited with code ${code}`);
      setTimeout(() => failAll(err), 500).unref();
    });
    p.on("close", (code) => failAll(new Error(`codex exited with code ${code}`)));
    // EPIPE when writing to a codex that has gone; the exit reports it.
    p.stdin.on("error", () => {});
    const onMessage = (raw) => {
      const line = raw.trim();
      if (!line) return;
      log(file, "<< " + line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg?.method === "turn/completed" && msg.params?.turn?.id) {
        completed.set(msg.params.turn.id, msg);
      }
      if (msg?.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      } else {
        // A copy: a listener that is done removes itself while the loop runs.
        for (const l of [...listeners]) l(msg);
      }
    };
    onLines(p.stdout, onMessage);
    // By whole lines, like stdout: a secret split across two chunks would not be redacted.
    const errFile = file.replace(".jsonl", ".stderr.txt");
    onLines(p.stderr, (line) => log(errFile, line));
    const send = (obj) => {
      const s = JSON.stringify(obj);
      log(file, ">> " + s);
      if (!dead) p.stdin.write(s + "\n");
    };
    const request = (method, params, ms = 180000) =>
      new Promise((resolve, reject) => {
        if (dead) return reject(dead);
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
        if (dead) return reject(dead);
        const remove = () => {
          clearTimeout(t);
          waiters.delete(fail);
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
        const fail = (err) => {
          remove();
          reject(err);
        };
        const t = setTimeout(() => fail(new Error("timeout waiting")), ms);
        const l = (m) => {
          if (pred(m)) {
            remove();
            resolve(m);
          }
        };
        listeners.push(l);
        waiters.add(fail);
      });
    // The turn/completed of this turn only, also when it came before the wait.
    const turnDone = (turnId) =>
      completed.has(turnId)
        ? Promise.resolve(completed.get(turnId))
        : waitFor((m) => isTurnCompleted(m, turnId));
    const s = { p, send, request, waitFor, turnDone, stop, on: (l) => listeners.push(l) };
    sessions.push(s);
    return s;
  }

  const DEV =
    "You are a co-pilot in an Elite Dangerous overlay. Begin every reply with the word ROGER. Keep replies under 40 words.";
  const cli = mode === "cli-config" ? cliConfig(ed) : { args: [], env: process.env };
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
      if (m?.id !== undefined && m.method) {
        log("approvals.txt", `${file}: ${m.method} ${JSON.stringify(m.params).slice(0, 400)}`);
        const result = m.method.includes("elicitation")
          ? { action: "decline", content: null }
          : { decision: "decline" };
        s.send({ id: m.id, result });
      }
    });
  }

  const summary = {};
  const turnStart = async (s, threadId, text) => {
    const r = await s.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
    if (r.error) throw new Error("turn/start: " + JSON.stringify(r.error));
    const turnId = r.result?.turn?.id;
    if (!turnId) throw new Error("turn/start: no turn id");
    return turnId;
  };
  const turn = async (s, threadId, text) => s.turnDone(await turnStart(s, threadId, text));

  try {
    const a = start("run1.jsonl", cli);
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
      if (m?.method === "item/agentMessage/delta") deltas++;
    });
    const done1 = await turn(
      a,
      threadId,
      "Call the ed-mcp journal_status tool and tell me the commander name. Then create the file C:\\Users\\Public\\edchat-probe.txt containing hi using a shell command.",
    );
    summary.turn1 = { status: done1.params.turn.status, deltas };

    // Run 1b: interrupt a long turn after the first delta. The wait starts before the request:
    // one stdout chunk can carry the turn/start answer and the first delta together.
    const first = a.waitFor(
      (m) =>
        m?.method === "item/agentMessage/delta" ||
        (m?.method === "item/started" && m.params?.item?.type === "agentMessage"),
    );
    first.catch(() => {});
    const turn2 = await turnStart(a, threadId, "Count slowly from 1 to 200, one number per line.");
    await first;
    const ir = await a.request("turn/interrupt", { threadId, turnId: turn2 });
    summary.interrupt = {
      response: ir.error ? ir.error : "ok",
      status: (await a.turnDone(turn2)).params.turn.status,
    };
    a.stop();

    // Run 2: new process, resume by id, check memory; then a bogus id.
    const b = start("run2.jsonl", cli);
    autoAnswer(b, "run2");
    await init(b);
    const rr = await b.request("thread/resume", {
      threadId,
      developerInstructions: DEV,
      config: threadConfig,
      excludeTurns: true,
    });
    if (rr.error) throw new Error("thread/resume: " + JSON.stringify(rr.error));
    summary.resume = "ok";
    const done3 = await turn(b, threadId, "What commander name did you find earlier? One line.");
    summary.resumedTurn = done3.params.turn.status;
    const bogus = await b.request("thread/resume", {
      threadId: "019a0000-0000-7000-8000-000000000000",
    });
    summary.bogusResume = bogus.error ?? "unexpected ok";
  } catch (e) {
    summary.failure = String(e);
  } finally {
    // A failed run must not leave codex and its ed-mcp running.
    stopAll();
  }
  writeFileSync(join(out, "summary.json"), redact(JSON.stringify(summary, null, 2)));
  console.log(redact(JSON.stringify(summary, null, 2)));
  process.exit(summary.failure ? 1 : 0);
}

// Run as a script, not when a test imports it. Windows paths differ in case only.
const self = import.meta.filename ?? "";
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === self.toLowerCase()) {
  await main(process.argv.slice(2));
}
