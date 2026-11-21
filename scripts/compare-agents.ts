// Sends the same player questions to Claude and Codex through ED Chat's own sessions and writes
// a report with both replies side by side. It spends tokens: see --help, and try --dry-run first.
// Usage: npx tsx scripts/compare-agents.ts [--only claude|codex] [--questions f] [--out f] [--dry-run]
// The regression run, with the z.ai columns: set ED_CHAT_TEST_API_KEY to a z.ai Coding Plan key,
// then npm run compare:providers (add -- --dry-run to see the runs first).
import { execFile } from "node:child_process";
import { existsSync, rmdirSync, rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
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
import { claudeMcpConfig, findEdMcp, readAgentConfigs } from "../src/core/edMcp.js";
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
  TEST_KEY_ENV,
  USAGE,
  codexTestConfig,
  parseProvider,
  providerHomesDir,
  providerName,
  MIN_KEY_LENGTH,
  redactKey,
  withoutTestKey,
  type TestProvider,
  type RunSpec,
  buildReport,
  edChatDataDir,
  ED_MCP_DATA_FILES,
  edMcpDataDir,
  isolatedEdMcp,
  isInside,
  jsonPathFor,
  parseArgs,
  parseQuestions,
  type AgentRun,
  type ApprovalAsked,
  type CompareRun,
  type Question,
  type QuestionResult,
  testProviderEnv,
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
  console.error(outProblem.replace(/\boutDir\b/g, "--out"));
  process.exit(2);
}

// Every session that may have a CLI running, so each exit path can stop it.
const sessions = new Set<AgentBackend>();
let approvalServer: ApprovalServer | null = null;
let tempRoot: string | null = null;
// The config folders of runs through a provider, outside the temp folder (providerHomesDir).
let homesRoot: string | null = null;
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
      for (const dir of [tempRoot, homesRoot]) {
        if (!dir) continue;
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (err) {
          console.error(`could not remove ${dir}: ${String(err)}`);
        }
      }
      try {
        if (homesRoot) rmdirSync(path.dirname(homesRoot));
      } catch {
        // Not empty: another run is using it, or a folder above could not be removed.
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
// The player's ed-mcp, which both assistants run on a copy of its data. A definition that
// runs as a command is needed for that; the plugin alone cannot be redirected.
const edMcpDef = findEdMcp(configs, edChatWorkspace);
if (!edMcpDef) {
  console.error(
    "No ed-mcp definition that runs as a command (claude mcp add or codex mcp add): the " +
      "comparison runs ed-mcp on a copy of its data, so it needs one.",
  );
  process.exit(2);
}
const edMcpSource = edMcpDataDir(edMcpDef, process.env, os.homedir(), process.platform);
if (!edMcpSource) {
  console.error(
    `ed-mcp's ED_MCP_SYNC_DIR is not an absolute path or one starting with ~: ${edMcpDef.env.ED_MCP_SYNC_DIR}`,
  );
  process.exit(2);
}
if (process.platform === "darwin") {
  // ed-mcp's config folder on macOS follows HOME, which cannot be moved without moving the
  // journal too.
  console.error("compare-agents runs on Windows and Linux only: it cannot sandbox ed-mcp here.");
  process.exit(2);
}
// Codex still loads the player's other MCP servers from config.toml (only ed-mcp is replaced);
// a tool of theirs that would change something asks, and the script declines it.
const edMcpNote = `ed-mcp from ${edMcpDef.source}, on a copy of its data`;
const resolvers: Record<AgentId, (p: string | null) => ResolvedCommand | null> = {
  claude: (p) => resolveClaude(p),
  codex: (p) => resolveCodex(p),
};

interface Plan {
  /** The provider's --run name, unique where its display name may not be. */
  providerKey: string | null;
  agent: AgentId;
  model: string | null;
  cli: ResolvedCommand | null;
  /** The provider the run goes through, or null for the player's own login. */
  provider: TestProvider | null;
}
const specs: RunSpec[] =
  opts.runs ?? (opts.only ? [opts.only] : AGENT_IDS).map((agent) => ({ agent }));
// Providers, by the name --run gives them. A provider's key is read from the environment only,
// so it is never in a command line, a file in the repo or the report.
const providers = new Map<string, TestProvider>();
for (const file of opts.providers) {
  try {
    providers.set(providerName(file), parseProvider(await readFile(file, "utf8")));
  } catch (err) {
    console.error(`--provider ${file}: ${(err as Error).message}`);
    process.exit(2);
  }
}
// A run through a provider never falls back to the player's own login, so one the provider
// cannot serve stops the comparison here, before any tokens are spent.
for (const { agent, model, provider } of specs) {
  if (!provider) continue;
  if (!providers.get(provider)![agent]) {
    console.error(`--run ${agent}@${provider}: ${provider} has no ${agent} endpoint`);
    process.exit(2);
  }
  // Codex takes only the models in the provider's catalog, when it has one.
  const catalog = providers.get(provider)!.codex?.models;
  if (agent === "codex" && catalog) {
    const slugs = catalog.map((m) => (m as { slug?: unknown }).slug);
    if (!slugs.includes(model)) {
      console.error(`--run codex:${model}@${provider}: ${provider} has ${slugs.join(", ")}`);
      process.exit(2);
    }
  }
}
const testKey = process.env[TEST_KEY_ENV]?.trim() ?? "";
if (providers.size && !testKey && !opts.dryRun) {
  console.error(`--provider was given: set ${TEST_KEY_ENV} to the provider's key.`);
  process.exit(2);
}
if (providers.size && testKey && testKey.length < MIN_KEY_LENGTH) {
  console.error(`${TEST_KEY_ENV} is too short to be a key (${testKey.length} characters).`);
  process.exit(2);
}
const plans: Plan[] = specs.map(({ agent, model, provider }) => ({
  agent,
  model: model ?? settings[agent].model,
  cli: resolvers[agent](settings[agent].path),
  provider: provider ? providers.get(provider)! : null,
  providerKey: provider ?? null,
}));

/**
 * ED Chat's extra arguments for the CLI, which a run through a provider does not get: one such
 * as -c model_provider=… or --model would send it somewhere other than the provider.
 */
function cliArgs(s: Settings[AgentId], provider: TestProvider | null): string[] {
  return provider ? [] : s.extraArgs;
}

/** ED Chat's settings for a run, with the provider's permission mode when it sets one. */
function runSettings(agent: AgentId, provider: TestProvider | null): Settings[AgentId] {
  const mode = provider?.[agent]?.permissionMode;
  return mode ? { ...settings[agent], permissionMode: mode } : settings[agent];
}

if (opts.dryRun) {
  const short = (a: string) => (a.length > 60 ? `${a.slice(0, 57)}...` : a);
  console.log(`Questions (${questions.length}) from ${opts.questions}:`);
  for (const q of questions) console.log(`  ${q.id}. [${q.topic}] ${q.text}`);
  const ws = path.join(os.tmpdir(), "ed-chat-compare-XXXX", "workspace");
  for (const { agent, model, cli, provider, providerKey } of plans) {
    if (!cli) {
      console.log(`\n${agent}: not installed, skipped`);
      continue;
    }
    const s = runSettings(agent, provider);
    const args =
      agent === "claude"
        ? buildClaudeArgs({
            permissionMode: s.permissionMode,
            model,
            mcpConfigFile: "<temp>/approval-mcp.json",
            extraArgs: [...cliArgs(s, provider), "--strict-mcp-config"],
            settingsFile: "<temp>/settings.json",
          })
        : buildCodexArgs({ extraArgs: cliArgs(s, provider) });
    console.log(`\n${agent}: would run ${cli.command}${cli.shell ? " (through cmd)" : ""}`);
    console.log(`  args: ${args.map(short).join(" ")}`);
    console.log(`  model: ${model ?? "the CLI's default"}`);
    console.log(`  permission mode: ${s.permissionMode}`);
    console.log(`  ed-mcp: ${edMcpNote}`);
    const endpoint = provider?.[agent]?.baseUrl;
    if (endpoint)
      console.log(
        `  endpoint: ${providerKey}, ${endpoint}, key from ${TEST_KEY_ENV}` +
          (testKey ? "" : " (not set)") +
          ", own config folder, removed when the script ends",
      );
  }
  console.log(`\nReport: ${out}\nNumbers: ${jsonOut}`);
  process.exit(0);
}

function cliVersion(cli: ResolvedCommand, env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    const file = cli.shell ? quoteForCmd(cli.command) : cli.command;
    execFile(
      file,
      ["--version"],
      { shell: cli.shell, windowsHide: true, timeout: 15_000, env: env ?? process.env },
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
  // ed-mcp's notes and plans are copied fresh for each run (below), into this folder; its
  // config and cache folders go in the sandbox.
  const edMcpData = path.join(tempRoot, "ed-mcp-data");
  const edMcpSandbox = path.join(tempRoot, "ed-mcp-sandbox");
  const edMcp = isolatedEdMcp(
    edMcpDef,
    edMcpData,
    edMcpSandbox,
    process.env,
    os.homedir(),
    process.platform,
  );
  let copied = 0;
  // Fresh for each run: the data, and an empty sandbox (config, cache), so every run starts
  // the same way and none finds what an earlier one saved or downloaded. The previous run's
  // ed-mcp may take a moment to stop, so removal retries.
  const copyEdMcpData = async () => {
    for (const dir of [edMcpData, edMcpSandbox])
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    await mkdir(edMcpData, { recursive: true });
    copied = 0;
    for (const f of ED_MCP_DATA_FILES) {
      const from = path.join(edMcpSource, f);
      if (!existsSync(from)) continue;
      await cp(from, path.join(edMcpData, f), { recursive: true });
      copied++;
    }
  };
  await copyEdMcpData();
  if (!copied)
    console.error(
      `Nothing of ed-mcp's data was found in ${edMcpSource}: the assistants answer as a ` +
        "player with no plans, notes or preferences.",
    );
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

  for (const { agent, model, cli, provider, providerKey } of plans) {
    if (interrupted.signal.aborted) break;
    const s = runSettings(agent, provider);
    const entry: AgentRun = {
      agent,
      model,
      command: cli?.command ?? null,
      version: null,
      permissionMode: s.permissionMode,
      // A provider run's empty config folder has no MCP servers of the player's: only ed-mcp.
      edMcp: provider ? `${edMcpNote}, and no other MCP server` : edMcpNote,
      results: [],
    };
    // Checked when the provider files were read: a provider run always has its endpoint.
    const endpoint = provider?.[agent]?.baseUrl;
    if (providerKey) entry.via = providerKey;
    if (endpoint) entry.endpoint = endpoint;
    run.runs.push(entry);
    if (!cli) {
      entry.skipped = "not installed";
      console.error(`${agent}: not installed, skipped`);
      continue;
    }
    // A fresh copy for each run: a settings change by one assistant must not carry over to
    // the next, which would then find the change already made.
    await writeFile(settingsFile, settingsText ?? newSettingsText());
    // And ed-mcp's data, so a plan or note saved in one run is not there in the next.
    await copyEdMcpData();
    // Through a test endpoint: an empty config folder for the CLI, fresh for each run, so
    // nothing of the player's login, settings or history is read, and nothing is written there.
    // A run on the player's own login does not get the provider's key either.
    let env: NodeJS.ProcessEnv = withoutTestKey(process.env);
    if (provider) {
      // Checked when the provider files were read; never fall back to the player's own login.
      if (!endpoint) throw new Error(`${provider.name} has no ${agent} endpoint`);
      homesRoot ??= providerHomesDir(
        process.env,
        os.homedir(),
        process.platform,
        path.basename(tempRoot),
      );
      const home = path.join(homesRoot, `${run.runs.length}-${agent}-home`);
      // A new folder: homesRoot is this run's own, and each home has the run's number.
      await mkdir(home, { recursive: true });
      if (agent === "codex") {
        const models = provider.codex?.models;
        const catalog = models ? path.join(home, "models.json") : null;
        if (catalog) await writeFile(catalog, JSON.stringify({ models }, null, 2));
        await writeFile(path.join(home, "config.toml"), codexTestConfig(endpoint, catalog));
      }
      env = testProviderEnv(agent, provider, testKey, home, process.env);
    }
    // With the run's environment, so a provider run does not touch the player's config folder.
    entry.version = await cliVersion(cli, env);
    let session: AgentBackend;
    if (agent === "claude") {
      approvalServer = new ApprovalServer(broker);
      await approvalServer.start();
      const mcpConfigFile = path.join(tempRoot, "approval-mcp.json");
      const config = claudeMcpConfig(approvalServer.mcpConfig().mcpServers, edMcp);
      await writeFile(mcpConfigFile, JSON.stringify(config));
      const args = buildClaudeArgs({
        permissionMode: s.permissionMode,
        model,
        mcpConfigFile,
        // Only the servers in --mcp-config: the player's own ed-mcp, on the real data, must
        // not run next to the copy.
        extraArgs: [...cliArgs(s, provider), "--strict-mcp-config"],
        settingsFile,
      });
      session = new ClaudeSession({ ...cli, args, cwd: workspace, env });
    } else {
      session = new CodexSession({
        ...cli,
        args: buildCodexArgs({ extraArgs: cliArgs(s, provider) }),
        cwd: workspace,
        env,
        thread: codexThreadSettings({
          permissionMode: s.permissionMode,
          model,
          cwd: workspace,
          settingsFile,
          edMcp,
        }),
        approve: brokerApprover(broker),
        autoEditFiles: [settingsFile],
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
          `  ${r.isError ? `error: ${redactKey(r.error ?? "", testKey)}` : `${r.replyChars} chars`}, ` +
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
  console.error(
    redactKey(err instanceof Error ? (err.stack ?? err.message) : String(err), testKey),
  );
} finally {
  stopAll();
  await approvalServer?.stop();
  // What was recorded so far is written even after an error.
  // A report that cannot be written must not keep the temp folder from going.
  if (run.runs.length) {
    try {
      await mkdir(path.dirname(out), { recursive: true });
      // A reply can quote the key (a model that prints its environment). Every string goes
      // before either report is built, so escaping in Markdown or JSON cannot hide a copy.
      const clean = JSON.parse(
        JSON.stringify(run, (_, v: unknown) => (typeof v === "string" ? redactKey(v, testKey) : v)),
      ) as CompareRun;
      await writeFile(out, buildReport(clean));
      await writeFile(jsonOut, JSON.stringify(clean, null, 2) + "\n");
      console.error(`Report: ${out}\nNumbers: ${jsonOut}`);
    } catch (err) {
      failed = true;
      console.error(`could not write the report: ${String(err)}`);
    }
  }
  // The temp folder holds the copied ed-mcp env, which can have the sync password. The CLIs
  // may hold files open for a moment after taskkill, so removal retries.
  for (const dir of [tempRoot, homesRoot])
    if (dir)
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(
        (err: unknown) => console.error(`could not remove ${dir}: ${String(err)}`),
      );
  // ed-chat-compare itself, when no other run is using it: rmdir removes only an empty folder.
  if (homesRoot) await rmdir(path.dirname(homesRoot)).catch(() => {});
}
process.exitCode = interrupted.signal.aborted ? 130 : failed ? 1 : 0;
// A handle left open (a late taskkill, a socket) must not keep the script running.
setTimeout(() => process.exit(), 2000).unref();
