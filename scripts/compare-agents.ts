// Sends the same player questions to Claude and Codex through ED Chat's own sessions and writes
// a report with both replies side by side. It spends tokens: see --help, and try --dry-run first.
// Usage: npx tsx scripts/compare-agents.ts [--only claude|codex] [--questions f] [--out f] [--dry-run]
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalBroker } from "../src/core/approvals.js";
import type { AgentBackend, AgentId } from "../src/core/backend.js";
import { ApprovalServer } from "../src/core/backends/claude/approvalServer.js";
import { buildClaudeArgs, resolveClaude } from "../src/core/backends/claude/command.js";
import { ClaudeSession } from "../src/core/backends/claude/session.js";
import { brokerApprover } from "../src/core/backends/codex/approvals.js";
import {
  buildCodexArgs,
  codexThreadSettings,
  resolveCodex,
} from "../src/core/backends/codex/command.js";
import { CodexSession } from "../src/core/backends/codex/session.js";
import { outDirProblem } from "./codex-probe.mjs";
import { parseCliVersion, quoteForCmd, type ResolvedCommand } from "../src/core/cli.js";
import { claudeMcpConfig, readAgentConfigs } from "../src/core/edMcp.js";
import {
  DEFAULTS_FILE,
  DEFAULT_SETTINGS,
  SCHEMA_FILE,
  defaultSettingsText,
  newSettingsText,
  parseSettings,
  settingsSchemaText,
  type Settings,
} from "../src/core/settings.js";
import {
  AGENT_IDS,
  USAGE,
  buildReport,
  edChatDataDir,
  edMcpPlan,
  isInside,
  jsonPathFor,
  parseArgs,
  parseQuestions,
  type AgentRun,
  type ApprovalAsked,
  type CompareRun,
  type Question,
  type QuestionResult,
} from "./compare-lib.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const parsed = parseArgs(process.argv.slice(2), {
  questions: path.join(repo, "scripts", "compare-questions.json"),
  out: path.join(os.tmpdir(), `ed-chat-compare-${stamp}.md`),
});
if (!parsed.ok) {
  console.error(`${parsed.error}\n\n${USAGE}`);
  process.exit(2);
}
const opts = parsed.options;
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
const out = path.resolve(opts.out);
const jsonOut = jsonPathFor(out);
// The report holds the player's journal data and replies: it never goes into this repo, or any
// other git checkout (a worktree, the main checkout), where git add could pick it up.
const outProblem = isInside(repo, out)
  ? `--out must be outside the repo: ${out}`
  : outDirProblem(path.dirname(out));
if (outProblem) {
  console.error(outProblem.replace(/^outDir/, "--out"));
  process.exit(2);
}

// Every session that may have a CLI running, so each exit path can stop it.
const sessions = new Set<AgentBackend>();
let approvalServer: ApprovalServer | null = null;
let tempRoot: string | null = null;
function stopAll(): void {
  // stop() ends the CLI and its children (ed-mcp) with taskkill /T on Windows.
  for (const s of sessions) s.stop();
  sessions.clear();
}
process.on("exit", stopAll);
// Ctrl+C: the run ends at once, and the report keeps what was recorded.
const interrupted = new AbortController();
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) {
  process.on(sig, () => {
    stopAll();
    // The first stop ends the question in progress, and the report is written with what was
    // recorded. A second one does not wait for that.
    if (!interrupted.signal.aborted) {
      console.error(`\n${sig}: stopping; ${sig} again to quit at once`);
      process.exitCode = 130;
      interrupted.abort();
      return;
    }
    // taskkill needs a moment to start before this process goes. The temp folder can hold the
    // sync password, so it goes too.
    setTimeout(() => {
      if (tempRoot) {
        try {
          rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (err) {
          console.error(`could not remove ${tempRoot}: ${String(err)}`);
        }
      }
      process.exit(130);
    }, 1000);
  });
}

const questions = parseQuestions(await readFile(opts.questions, "utf8"));

// The player's ED Chat settings, read only: each CLI's path, permission mode and extra arguments.
const dataDir = edChatDataDir(process.env, os.homedir(), process.platform);
const settingsText = await readFile(path.join(dataDir, "settings.json"), "utf8").catch(() => null);
let settings: Settings = DEFAULT_SETTINGS;
if (settingsText !== null) {
  const p = parseSettings(settingsText);
  if (p.ok) settings = p.settings;
  else console.error(`ED Chat's settings.json has an error (${p.error}); using the defaults`);
}

const configs = await readAgentConfigs();
const edChatWorkspace = path.join(dataDir, "workspace");
const resolvers: Record<AgentId, (p: string | null) => ResolvedCommand | null> = {
  claude: (p) => resolveClaude(p),
  codex: (p) => resolveCodex(p),
};

interface Plan {
  agent: AgentId;
  cli: ResolvedCommand | null;
}
const plans: Plan[] = (opts.only ? [opts.only] : AGENT_IDS).map((agent) => ({
  agent,
  cli: resolvers[agent](settings[agent].path),
}));

if (opts.dryRun) {
  const short = (a: string) => (a.length > 60 ? `${a.slice(0, 57)}...` : a);
  console.log(`Questions (${questions.length}) from ${opts.questions}:`);
  for (const q of questions) console.log(`  ${q.id}. [${q.topic}] ${q.text}`);
  const ws = path.join(os.tmpdir(), "ed-chat-compare-XXXX", "workspace");
  for (const { agent, cli } of plans) {
    if (!cli) {
      console.log(`\n${agent}: not installed, skipped`);
      continue;
    }
    const s = settings[agent];
    const args =
      agent === "claude"
        ? buildClaudeArgs({
            permissionMode: s.permissionMode,
            mcpConfigFile: "<temp>/approval-mcp.json",
            extraArgs: s.extraArgs,
            settingsFile: "<temp>/settings.json",
          })
        : buildCodexArgs({ extraArgs: s.extraArgs });
    console.log(`\n${agent}: would run ${cli.command}${cli.shell ? " (through cmd)" : ""}`);
    console.log(`  args: ${args.map(short).join(" ")}`);
    console.log(`  permission mode: ${s.permissionMode}`);
    console.log(`  ed-mcp: ${edMcpPlan(agent, configs, ws, edChatWorkspace).note}`);
  }
  console.log(`\nReport: ${out}\nNumbers: ${jsonOut}`);
  process.exit(0);
}

function cliVersion(cli: ResolvedCommand): Promise<string | null> {
  return new Promise((resolve) => {
    const file = cli.shell ? quoteForCmd(cli.command) : cli.command;
    execFile(
      file,
      ["--version"],
      { shell: cli.shell, windowsHide: true, timeout: 15_000 },
      (err, stdout) => resolve(err ? null : (parseCliVersion(stdout)?.join(".") ?? null)),
    );
  });
}

// Sends one question and waits for its result, an exit or the timeout.
function ask(session: AgentBackend, q: Question, asked: ApprovalAsked[]): Promise<QuestionResult> {
  const tools: string[] = [];
  let text = "";
  let firstTextMs: number | null = null;
  const t0 = performance.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (isError: boolean, reply: string, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve({
        questionId: q.id,
        tools,
        approvals: [...asked],
        reply,
        replyChars: reply.length,
        firstTextMs,
        totalMs: Math.round(performance.now() - t0),
        isError,
        ...(error === undefined ? {} : { error }),
      });
    };
    const offEvents = session.onEvent((e) => {
      switch (e.type) {
        case "text":
          firstTextMs ??= Math.round(performance.now() - t0);
          text += e.delta;
          break;
        case "toolStart":
          tools.push(e.name);
          break;
        case "result": {
          // As the overlay shows it: an error carries the CLI's own message.
          const reply = e.isError ? (e.text ?? "") : text || (e.text ?? "");
          finish(e.isError, reply, e.isError ? (e.text ?? "error result") : undefined);
          break;
        }
        case "exit":
        case "gaveUp":
          finish(true, text, `${e.type}: ${e.stderrTail.join(" / ") || "no stderr"}`);
          break;
        case "spawnError":
          finish(true, text, `spawn error: ${e.message}`);
          break;
      }
    });
    const timer = setTimeout(() => {
      session.cancel();
      finish(true, text, `no result after ${opts.timeoutSec} s`);
    }, opts.timeoutSec * 1000);
    const onStop = () => finish(true, text, "stopped with Ctrl+C");
    interrupted.signal.addEventListener("abort", onStop, { once: true });
    const off = () => {
      offEvents();
      interrupted.signal.removeEventListener("abort", onStop);
    };
    if (!session.send(q.text)) finish(true, "", "the session refused the message");
  });
}

const run: CompareRun = { startedAt: new Date().toISOString(), questions, runs: [] };
let failed = false;
try {
  // ED Chat's data folder, rebuilt in the temp folder: the workspace, and a copy of settings.json
  // with its schema, so a settings question reads the player's values and a change touches
  // only the copy.
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "ed-chat-compare-"));
  const workspace = path.join(tempRoot, "workspace");
  const settingsFile = path.join(tempRoot, "settings.json");
  await mkdir(workspace);
  await writeFile(settingsFile, settingsText ?? newSettingsText());
  await writeFile(path.join(tempRoot, SCHEMA_FILE), settingsSchemaText());
  await writeFile(path.join(tempRoot, DEFAULTS_FILE), defaultSettingsText());

  // The approvals of the question in progress. A decline is the safe answer for a script;
  // ed-mcp tools do not ask, but are allowed if they do, as the player would.
  let asked: ApprovalAsked[] = [];
  const broker = new ApprovalBroker({
    timeoutMs: 60_000,
    onRequest: (r) => {
      const allow = /ed-mcp/i.test(r.toolName);
      asked.push({
        tool: r.toolName,
        summary: r.summary,
        decision: allow ? "allowed" : "declined",
      });
      queueMicrotask(() => broker.answer(r.id, allow ? "allow" : "deny"));
    },
    onSettled: () => {},
  });

  for (const { agent, cli } of plans) {
    if (interrupted.signal.aborted) break;
    const s = settings[agent];
    const plan = edMcpPlan(agent, configs, workspace, edChatWorkspace);
    const entry: AgentRun = {
      agent,
      command: cli?.command ?? null,
      version: null,
      permissionMode: s.permissionMode,
      edMcp: plan.note,
      results: [],
    };
    run.runs.push(entry);
    if (!cli) {
      entry.skipped = "not installed";
      console.error(`${agent}: not installed, skipped`);
      continue;
    }
    entry.version = await cliVersion(cli);
    let session: AgentBackend;
    if (agent === "claude") {
      approvalServer = new ApprovalServer(broker);
      await approvalServer.start();
      const mcpConfigFile = path.join(tempRoot, "approval-mcp.json");
      const config = claudeMcpConfig(approvalServer.mcpConfig().mcpServers, plan.server);
      await writeFile(mcpConfigFile, JSON.stringify(config));
      const args = buildClaudeArgs({
        permissionMode: s.permissionMode,
        mcpConfigFile,
        extraArgs: s.extraArgs,
        settingsFile,
      });
      session = new ClaudeSession({ ...cli, args, cwd: workspace });
    } else {
      session = new CodexSession({
        ...cli,
        args: buildCodexArgs({ extraArgs: s.extraArgs }),
        cwd: workspace,
        thread: codexThreadSettings({
          permissionMode: s.permissionMode,
          cwd: workspace,
          settingsFile,
          edMcp: plan.server,
        }),
        approve: brokerApprover(broker),
      });
    }
    sessions.add(session);
    try {
      session.start();
      for (const q of questions) {
        if (interrupted.signal.aborted) break;
        // A new conversation for each question, as /new does.
        if (q !== questions[0]) session.newSession();
        asked = [];
        console.error(`${agent} ${q.id}/${questions.length}: ${q.text}`);
        const r = await ask(session, q, asked);
        entry.results.push(r);
        console.error(
          `  ${r.isError ? `error: ${r.error}` : `${r.replyChars} chars`}, ` +
            `${(r.totalMs / 1000).toFixed(1)} s, tools: ${r.tools.join(", ") || "none"}`,
        );
      }
    } finally {
      session.stop();
      sessions.delete(session);
      await approvalServer?.stop();
      approvalServer = null;
    }
  }
} catch (err) {
  failed = true;
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
} finally {
  stopAll();
  await approvalServer?.stop();
  // What was recorded so far is written even after an error.
  if (run.runs.length) {
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, buildReport(run));
    await writeFile(jsonOut, JSON.stringify(run, null, 2) + "\n");
    console.error(`Report: ${out}\nNumbers: ${jsonOut}`);
  }
  // The temp folder holds the copied ed-mcp env, which can have the sync password. The CLIs
  // may hold files open for a moment after taskkill, so removal retries.
  if (tempRoot)
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(
      (err: unknown) => console.error(`could not remove ${tempRoot}: ${String(err)}`),
    );
}
process.exitCode = interrupted.signal.aborted ? 130 : failed ? 1 : 0;
// A handle left open (a late taskkill, a socket) must not keep the script running.
setTimeout(() => process.exit(), 2000).unref();
