// The pure parts of scripts/compare-agents.ts: arguments, questions, the ed-mcp each assistant
// gets, and the report. Kept apart so tests can import them without starting anything.
import path from "node:path";
import type { AgentId } from "../src/core/backend.js";
import {
  findEdMcp,
  forCli,
  type AgentConfigs,
  type CliMcpServer,
  type EdMcpDefinition,
} from "../src/core/edMcp.js";

export const AGENT_IDS: AgentId[] = ["claude", "codex"];
const NAMES: Record<AgentId, string> = { claude: "Claude", codex: "Codex" };

export const USAGE = `Usage: npx tsx scripts/compare-agents.ts [options]

Sends the same player questions to Claude and Codex through ED Chat's own sessions, with the
HUD prompt and ed-mcp, and writes a report with both replies side by side. Each question starts
a new conversation. Approvals are declined. This spends tokens on each assistant.

Options:
  --only claude|codex   Run one assistant only.
  --run <agent>[:model][@provider]
                        Run this assistant with this model; give it more than once to compare
                        models, for example --run claude:sonnet --run claude:opus --run codex.
                        Without a model, the model in ED Chat's settings is used. With
                        @provider, the run goes through that provider (see --provider), for
                        example --run claude:glm-5.3@zai --run codex:glm-5.3@zai. After a model,
                        an @ must name a --provider, or be a version in digits, which stays
                        part of the model, as in claude:model@20250514.
  --provider <file>     A third-party endpoint that --run <agent>@<name> can use instead of the
                        player's own login; <name> is the file name without .json, for example
                        scripts/providers/zai.json gives zai. Give it more than once for more
                        providers. The key is read from ED_CHAT_TEST_API_KEY. A run through a
                        provider gets an empty config folder of its own, removed when the
                        script ends: the player's login, settings and history are not read or
                        changed. It needs a model: --run <agent>:<model>@<name>. ED Chat's
                        extra arguments for the CLI are not passed to it.
  --questions <file>    A JSON list of { "topic", "text" } (default scripts/compare-questions.json).
  --out <file>          The Markdown report (default in the temp folder). The raw numbers go
                        next to it, with .json. It must be outside the repo.
  --timeout <seconds>   How long one reply may take (default 300).
  --dry-run             Print what would run, and start no CLI.
  --help                Show this message.`;

/** One assistant to run, with a model that overrides the one in ED Chat's settings. */
export interface RunSpec {
  agent: AgentId;
  model?: string;
  /** The provider's name (--provider), or absent for the player's own login. */
  provider?: string;
}

export interface CompareOptions {
  only: AgentId | null;
  /** From --run, in order; null when none was given. */
  runs: RunSpec[] | null;
  questions: string;
  out: string;
  timeoutSec: number;
  /** The provider files (--provider), in order. */
  providers: string[];
  dryRun: boolean;
  help: boolean;
}

export type ParseResult = { ok: true; options: CompareOptions } | { ok: false; error: string };

/** Reads the command line. defaults gives the questions file and the report path. */
export function parseArgs(
  argv: string[],
  defaults: { questions: string; out: string },
): ParseResult {
  const o: CompareOptions = {
    only: null,
    runs: null,
    questions: defaults.questions,
    out: defaults.out,
    timeoutSec: 300,
    providers: [],
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // --name=value and --name value both work.
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    const value = (): string | null => {
      if (name !== arg) return arg.slice(eq + 1) || null;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i++;
      return v;
    };
    switch (name) {
      case "--help":
      case "-h":
        o.help = true;
        break;
      case "--dry-run":
        o.dryRun = true;
        break;
      case "--only": {
        const v = value();
        if (v !== "claude" && v !== "codex")
          return { ok: false, error: "--only takes claude or codex" };
        o.only = v;
        break;
      }
      case "--run": {
        const v = value();
        // The provider is split off after all --provider files are known: a model id can
        // hold an @ too (claude-sonnet-4@20250514).
        const m = v ? /^(claude|codex)(?::(.+)|@([^:]+))?$/.exec(v) : null;
        if (v && /^(claude|codex)@[^:]*:/.test(v))
          return { ok: false, error: `--run ${v}: the model goes first, as agent:model@provider` };
        if (!m)
          return {
            ok: false,
            error: "--run takes claude or codex, :model and @provider if wanted",
          };
        const spec: RunSpec = { agent: m[1] as AgentId };
        if (m[2]) spec.model = m[2];
        if (m[3]) spec.provider = m[3];
        (o.runs ??= []).push(spec);
        break;
      }
      case "--questions": {
        const v = value();
        if (!v) return { ok: false, error: "--questions takes a file" };
        o.questions = v;
        break;
      }
      case "--out": {
        const v = value();
        if (!v) return { ok: false, error: "--out takes a file" };
        o.out = v;
        break;
      }
      case "--timeout": {
        const v = Number(value());
        if (!Number.isFinite(v) || v <= 0)
          return { ok: false, error: "--timeout takes a number of seconds" };
        o.timeoutSec = v;
        break;
      }
      case "--provider": {
        const v = value();
        if (!v) return { ok: false, error: "--provider takes a file" };
        o.providers.push(v);
        break;
      }
      default:
        return { ok: false, error: `unknown argument: ${arg}` };
    }
  }
  if (o.only && o.runs) return { ok: false, error: "give --only or --run, not both" };
  const names = o.providers.map(providerName);
  // An empty name would let --run claude:model@ pass as no provider, on the player's login.
  if (names.some((n) => !n.trim()))
    return { ok: false, error: "a --provider file needs a name before .json" };
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return { ok: false, error: `two --provider files are named ${dup}` };
  for (const r of o.runs ?? []) {
    const at = r.model?.lastIndexOf("@") ?? -1;
    if (r.model && at >= 0) {
      const tail = r.model.slice(at + 1);
      if (names.includes(tail)) {
        r.provider = tail;
        if (at > 0) r.model = r.model.slice(0, at);
        else delete r.model;
      } else if (!/^\d+$/.test(tail))
        // Only a version such as @20250514 stays in a model id: a misspelt or missing
        // provider must not run on the player's own login.
        return {
          ok: false,
          error: `--run ${r.agent}:${r.model}: no --provider is named ${tail}`,
        };
    }
    if (r.provider && !names.includes(r.provider))
      return {
        ok: false,
        error: `--run ${r.agent}@${r.provider}: no --provider is named ${r.provider}`,
      };
    // The model in ED Chat's settings is the player's own, which the provider may not know.
    if (r.provider && !r.model)
      return {
        ok: false,
        error: `--run ${r.agent}@${r.provider} needs a model: ${r.agent}:<model>@${r.provider}`,
      };
  }
  for (const n of names)
    if (!o.runs?.some((r) => r.provider === n))
      return { ok: false, error: `--provider ${n} is given, but no --run <agent>@${n} uses it` };
  return { ok: true, options: o };
}

/**
 * Where the config folders of runs through a provider go: outside the temp folder, because
 * Codex will not set up its helpers (its sandbox on Windows) in a CODEX_HOME there, and then
 * asks before every shell command.
 */
export function providerHomesDir(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
  run: string,
): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA || p.join(home, "AppData", "Local")
      : env.XDG_CACHE_HOME || p.join(home, ".cache");
  return p.join(base, "ed-chat-compare", run);
}

/** The name --run uses for a provider file: its file name without .json. */
export const providerName = (file: string): string => path.basename(file).replace(/\.json$/i, "");

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    // The key goes in a header: plain http only to this computer.
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return u.protocol === "https:" || (u.protocol === "http:" && local);
  } catch {
    return false;
  }
}

/** The environment variable that holds the provider's key. Never an argument or a file. */
export const TEST_KEY_ENV = "ED_CHAT_TEST_API_KEY";

/** A third-party endpoint for the assistants, from --provider. It holds no key. */
export interface TestProvider {
  name: string;
  /** An Anthropic-compatible endpoint, and more environment for Claude (model names). */
  claude?: { baseUrl: string; env: Record<string, string>; permissionMode?: PermissionMode };
  /** An OpenAI Responses endpoint, and a model catalog (models.json) for the models it has. */
  codex?: { baseUrl: string; models: unknown[] | null; permissionMode?: PermissionMode };
}

type PermissionMode = "auto" | "default";

// What a provider file may set for Claude: model names, context and compaction, timeouts and
// telemetry. Anything else (a key, a proxy, a cloud, PATH, NODE_OPTIONS) is refused.
const PROVIDER_CLAUDE_VARS =
  /^(ANTHROPIC_(MODEL|SMALL_FAST_MODEL|DEFAULT_(HAIKU|SONNET|OPUS)_MODEL)|CLAUDE_CODE_(AUTO_COMPACT_WINDOW|MAX_CONTEXT_TOKENS|MAX_OUTPUT_TOKENS|SIMPLE_SYSTEM_PROMPT|DISABLE_NONESSENTIAL_TRAFFIC)|MAX_THINKING_TOKENS|API_TIMEOUT_MS|DISABLE_TELEMETRY|DISABLE_ERROR_REPORTING)$/;

/** Reads a provider file. Env values may be numbers or booleans, and become strings. */
export function parseProvider(json: string): TestProvider {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`the provider file is not JSON: ${(err as Error).message}`);
  }
  const r = (data ?? {}) as Record<string, unknown>;
  const out: TestProvider = { name: typeof r.name === "string" && r.name ? r.name : "provider" };
  const section = (agent: AgentId): Record<string, unknown> | null => {
    const v = r[agent];
    if (v === undefined) return null;
    if (typeof v !== "object" || v === null || Array.isArray(v))
      throw new Error(`the provider's ${agent} is not an object`);
    const o = v as Record<string, unknown>;
    if (!isHttpUrl(o.baseUrl))
      throw new Error(`the provider's ${agent}.baseUrl is not an https URL (or http to localhost)`);
    if (
      o.permissionMode !== undefined &&
      o.permissionMode !== "auto" &&
      o.permissionMode !== "default"
    )
      throw new Error(`the provider's ${agent}.permissionMode is not auto or default`);
    return o;
  };
  // Instead of the one in ED Chat's settings, for an endpoint where that mode does not work.
  const mode = (o: Record<string, unknown>) =>
    o.permissionMode === undefined ? {} : { permissionMode: o.permissionMode as PermissionMode };
  const claude = section("claude");
  if (claude) {
    const env: Record<string, string> = {};
    const raw = claude.env ?? {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error("the provider's claude.env is not an object");
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!["string", "number", "boolean"].includes(typeof v))
        throw new Error(`the provider's claude.env.${k} is not a string`);
      // Only model names and Claude Code's tuning: the file is checked in, so no key, and the
      // run goes to baseUrl with what the script sets, not to a proxy, cloud or other code.
      if (!PROVIDER_CLAUDE_VARS.test(k))
        throw new Error(`the provider's claude.env must not set ${k}: only model names and tuning`);
      env[k] = String(v);
    }
    out.claude = { baseUrl: claude.baseUrl as string, env, ...mode(claude) };
  }
  const codex = section("codex");
  if (codex) {
    const models = codex.models ?? null;
    if (
      models !== null &&
      (!Array.isArray(models) ||
        !models.length ||
        models.some((m) => typeof m !== "object" || m === null || Array.isArray(m)))
    )
      throw new Error("the provider's codex.models is not a list of models");
    out.codex = { baseUrl: codex.baseUrl as string, models, ...mode(codex) };
  }
  if (!out.claude && !out.codex) throw new Error("the provider names neither claude nor codex");
  return out;
}

/** The provider name in the test CODEX_HOME's config.toml. */
const CODEX_TEST_PROVIDER = "ed-chat-test";

// What a run through a provider takes from the player's environment: an allow list, so a
// login, routing, model or tuning variable of the player's, or one a later CLI release adds,
// never reaches it. Only what Windows, Node, npx (for ed-mcp), the network and Git Bash need.
const ALLOWED_VARS = new Set([
  // Windows
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "COMPUTERNAME",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "ALLUSERSPROFILE",
  "PUBLIC",
  // The user's folders
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "USERNAME",
  "USER",
  "LOGNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SHELL",
  "LANG",
  "TERM",
  // The network: a proxy or company CA the machine needs to reach the endpoint
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  // Node version managers, for node and npx (ed-mcp)
  "NVM_HOME",
  "NVM_SYMLINK",
  "VOLTA_HOME",
  "PNPM_HOME",
  // Where Claude Code finds Git Bash on Windows
  "CLAUDE_CODE_GIT_BASH_PATH",
]);
const isAllowedVar = (name: string) => {
  const n = name.toUpperCase();
  // npm_config_*: npm's registry and cache, which npx needs to start ed-mcp.
  return ALLOWED_VARS.has(n) || n.startsWith("LC_") || n.startsWith("NPM_CONFIG_");
};

/**
 * The environment for a CLI run through a provider. home is an empty folder that becomes the
 * CLI's config folder, so it finds none of the player's login, settings or history, and writes
 * nothing to theirs. Of the player's own environment it gets only ALLOWED_VARS.
 */
export function testProviderEnv(
  agent: AgentId,
  provider: TestProvider,
  key: string,
  home: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (isAllowedVar(k)) out[k] = v;
  if (agent === "claude") {
    const c = provider.claude;
    if (!c) throw new Error(`${provider.name} has no claude endpoint`);
    return {
      ...out,
      ...c.env,
      // No update checks or telemetry to Anthropic: the run talks to the provider only. After
      // the provider's own values, so it cannot turn them back on.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: c.baseUrl,
      // Where Claude reads the key. Its child processes (ed-mcp, shell commands) inherit it, as
      // they would with the player's own provider setup; only the reports are redacted.
      ANTHROPIC_AUTH_TOKEN: key,
    };
  }
  if (!provider.codex) throw new Error(`${provider.name} has no codex endpoint`);
  // config.toml's env_key names this variable, so Codex reads the key from it.
  return { ...out, CODEX_HOME: home, [TEST_KEY_ENV]: key };
}

/** A provider key is at least this long; a shorter value is a mistake, not a key. */
export const MIN_KEY_LENGTH = 16;

/** The environment for a run on the player's own login: theirs, without the provider's key. */
export function withoutTestKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== TEST_KEY_ENV));
}

/**
 * text with every copy of key replaced, so a reply that quotes the key keeps it out of a report.
 * The long parts of a key with dots (z.ai's <id>.<secret>) go too, as a reply may quote one.
 */
export function redactKey(text: string, key: string): string {
  // The script refuses a key this short; a short one would match ordinary words.
  if (key.length < MIN_KEY_LENGTH) return text;
  const parts = [key, ...key.split(".").filter((p) => p.length >= 16 && p !== key)];
  // Not <key>: a Markdown viewer hides that as an unknown HTML tag.
  return parts.reduce((t, p) => t.split(p).join("[key]"), text);
}

/**
 * config.toml for the test CODEX_HOME: the endpoint as the model provider, with its key read
 * from TEST_KEY_ENV, and the model catalog when there is one. Codex 0.170 takes only the
 * Responses API (wire_api "chat" is refused).
 */
export function codexTestConfig(baseUrl: string, catalogFile: string | null): string {
  // A JSON string is a valid TOML basic string.
  const q = JSON.stringify;
  return [
    `model_provider = ${q(CODEX_TEST_PROVIDER)}`,
    ...(catalogFile ? [`model_catalog_json = ${q(catalogFile)}`] : []),
    "",
    `[model_providers.${CODEX_TEST_PROVIDER}]`,
    `name = ${q(CODEX_TEST_PROVIDER)}`,
    `base_url = ${q(baseUrl)}`,
    `env_key = ${q(TEST_KEY_ENV)}`,
    `wire_api = "responses"`,
    "",
  ].join("\n");
}

export interface Question {
  id: number;
  topic: string;
  text: string;
}

/** The questions file: a JSON list of { topic, text }, or of plain strings. */
export function parseQuestions(json: string): Question[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`the questions file is not JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(data) || data.length === 0)
    throw new Error("the questions file must hold a list of questions");
  return data.map((q, i) => {
    if (typeof q === "string" && q.trim()) return { id: i + 1, topic: "", text: q.trim() };
    const r = (q ?? {}) as Record<string, unknown>;
    if (typeof r.text !== "string" || !r.text.trim())
      throw new Error(`question ${i + 1} has no text`);
    return {
      id: i + 1,
      topic: typeof r.topic === "string" ? r.topic : "",
      text: r.text.trim(),
    };
  });
}

/** child is parent itself or inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The JSON file next to the report: report.md gives report.json. */
export const jsonPathFor = (out: string) =>
  out.toLowerCase().endsWith(".md") ? out.slice(0, -3) + ".json" : out + ".json";

/** ED Chat's data folder, as Electron's appData gives it on each platform. */
export function edChatDataDir(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32")
    return p.join(env.APPDATA ?? p.join(home, "AppData", "Roaming"), "ed-chat");
  if (platform === "darwin") return p.join(home, "Library", "Application Support", "ed-chat");
  return p.join(env.XDG_CONFIG_HOME || p.join(home, ".config"), "ed-chat");
}

/**
 * Where an ed-mcp definition keeps the player's notes and plans: its sync folder, else ed-mcp's
 * own config folder (env-paths("ed-mcp", { suffix: "" }), as ed-mcp names it). A sync folder
 * is read as ed-mcp reads it: ~ is the home folder, and a relative path is refused (null).
 */
export function edMcpDataDir(
  def: { env: Record<string, string> },
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): string | null {
  const p = platform === "win32" ? path.win32 : path.posix;
  const sync = def.env.ED_MCP_SYNC_DIR?.trim();
  if (sync) {
    const tilde = /^~(?:[/\\]|$)/.exec(sync);
    if (tilde) return p.join(home, sync.slice(tilde[0].length));
    return p.isAbsolute(sync) ? p.resolve(sync) : null;
  }
  if (platform === "win32")
    return p.join(env.APPDATA || p.join(home, "AppData", "Roaming"), "ed-mcp", "Config");
  if (platform === "darwin") return p.join(home, "Library", "Preferences", "ed-mcp");
  return p.join(env.XDG_CONFIG_HOME || p.join(home, ".config"), "ed-mcp");
}

/**
 * The files in ed-mcp's data folder that a question can change. Secrets (API keys, the
 * Frontier login) are not copied: a refreshed login saved only in a copy would spend the
 * player's real one. The assistants run as a player with no stored keys.
 */
export const ED_MCP_DATA_FILES = ["activity.json", "plans.json", "plans", "preferences.json"];

/**
 * The player's ed-mcp, run on a copy of its data: a question that saves a plan or a note
 * changes only the copy. Its config and cache folders (secrets.json, locks, cache) are moved
 * into the sandbox too, so nothing of the player's ed-mcp state is read or written. npm keeps
 * its own cache, so npx does not fetch ed-mcp again.
 */
export function isolatedEdMcp(
  def: EdMcpDefinition,
  dataCopy: string,
  sandbox: string,
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): CliMcpServer {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs: Record<string, string> =
    platform === "win32"
      ? {
          APPDATA: p.join(sandbox, "Roaming"),
          LOCALAPPDATA: p.join(sandbox, "Local"),
          npm_config_cache: p.join(
            env.LOCALAPPDATA || p.join(home, "AppData", "Local"),
            "npm-cache",
          ),
        }
      : { XDG_CONFIG_HOME: p.join(sandbox, "config"), XDG_CACHE_HOME: p.join(sandbox, "cache") };
  return forCli({ ...def, env: { ...def.env, ...dirs, ED_MCP_SYNC_DIR: dataCopy } })!;
}

export interface ApprovalAsked {
  tool: string;
  summary: string;
  decision: "declined" | "allowed";
}

export interface QuestionResult {
  questionId: number;
  /** Tool names from toolStart events, in order. */
  tools: string[];
  approvals: ApprovalAsked[];
  reply: string;
  replyChars: number;
  /** From send to the first text, in ms; null when no text came. */
  firstTextMs: number | null;
  totalMs: number;
  isError: boolean;
  /** Why the question failed: the CLI's error, an exit or a timeout. */
  error?: string;
}

export interface AgentRun {
  agent: AgentId;
  /** The model asked for, or null for the CLI's own default. */
  model: string | null;
  /** The CLI started, or null when it is not installed. */
  command: string | null;
  version: string | null;
  permissionMode: string;
  edMcp: string;
  /** The provider it ran through, when not the player's own login. */
  via?: string;
  /** That provider's endpoint. */
  endpoint?: string;
  /** Why the assistant did not run. */
  skipped?: string;
  results: QuestionResult[];
}

export interface CompareRun {
  startedAt: string;
  questions: Question[];
  runs: AgentRun[];
}

export interface RunSummary {
  answered: number;
  errors: number;
  toolCalls: number;
  approvals: number;
  medianChars: number | null;
  medianFirstTextMs: number | null;
  medianTotalMs: number | null;
  totalMs: number;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function summarizeRun(r: AgentRun): RunSummary {
  const ok = r.results.filter((x) => !x.isError);
  return {
    answered: ok.length,
    errors: r.results.length - ok.length,
    toolCalls: r.results.reduce((n, x) => n + x.tools.length, 0),
    approvals: r.results.reduce((n, x) => n + x.approvals.length, 0),
    medianChars: median(ok.map((x) => x.replyChars)),
    // From the answered questions only, like the other medians.
    medianFirstTextMs: median(ok.flatMap((x) => (x.firstTextMs === null ? [] : [x.firstTextMs]))),
    medianTotalMs: median(ok.map((x) => x.totalMs)),
    totalMs: r.results.reduce((n, x) => n + x.totalMs, 0),
  };
}

export const seconds = (ms: number | null) => (ms === null ? "-" : `${(ms / 1000).toFixed(1)} s`);

// Text for one Markdown table cell: no pipes or line breaks to end it, no HTML to run.
export function cell(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

// Repeated tools are counted: "journal_status ×2".
function toolList(tools: string[]): string {
  if (!tools.length) return "none";
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(", ");
}

function approvalList(a: ApprovalAsked[]): string {
  return a.length ? a.map((x) => `${x.tool} (${x.decision}): ${x.summary}`).join("; ") : "none";
}

/** How a run is named in the report: the assistant, and its model when one was set. */
// Escaped like the table cells: the model is free text from --run.
export const runLabel = (r: AgentRun): string => {
  const who = r.via ? `${r.via} via ${NAMES[r.agent]}` : NAMES[r.agent];
  return cell(r.model ? `${who} (${r.model})` : who);
};

/** The Markdown report: a summary, a table per assistant, then each question's replies side by side. */
export function buildReport(run: CompareRun): string {
  const ran = run.runs.filter((r) => !r.skipped);
  const out: string[] = [];
  out.push("# ED Chat: Claude and Codex compared", "");
  out.push(
    `Run on ${run.startedAt}, ${run.questions.length} questions. Each question starts a new ` +
      "conversation with ED Chat's HUD prompt and ed-mcp. Approvals are declined, except for " +
      "ed-mcp tools. No [Game state] note is sent. Times are from sending the question, so they " +
      "include starting the new conversation.",
    "",
  );
  for (const r of run.runs) {
    const what = r.skipped
      ? `skipped: ${r.skipped}`
      : `${r.command}${r.version ? ` (${r.version})` : ""}, model ${r.model ?? "the CLI's default"}, permission mode ${r.permissionMode}, ed-mcp: ${r.edMcp}${r.endpoint ? `, through ${r.via}, ${r.endpoint}` : ""}`;
    out.push(`- **${runLabel(r)}**: ${cell(what)}`);
  }
  out.push("");
  if (!ran.length) {
    out.push("No assistant ran.", "");
    return out.join("\n");
  }

  out.push("## Summary", "");
  const sums = ran.map(summarizeRun);
  out.push(`| | ${ran.map(runLabel).join(" | ")} |`);
  out.push(`|---|${ran.map(() => "---").join("|")}|`);
  const row = (label: string, f: (s: RunSummary) => string) =>
    out.push(`| ${label} | ${sums.map(f).join(" | ")} |`);
  row("Answered", (s) => `${s.answered}/${s.answered + s.errors}`);
  row("Errors", (s) => String(s.errors));
  row("Tool calls", (s) => String(s.toolCalls));
  row("Approvals asked", (s) => String(s.approvals));
  row("Median reply length", (s) => (s.medianChars === null ? "-" : `${s.medianChars} chars`));
  row("Median time to first text", (s) => seconds(s.medianFirstTextMs));
  row("Median total time", (s) => seconds(s.medianTotalMs));
  row("Time for all questions", (s) => seconds(s.totalMs));
  out.push("");

  const byId = (r: AgentRun, id: number) => r.results.find((x) => x.questionId === id);
  for (const r of ran) {
    out.push(`## ${runLabel(r)}`, "");
    out.push("| # | Topic | Tools | Approvals | Chars | First text | Total | Error |");
    out.push("|---|---|---|---|---|---|---|---|");
    for (const q of run.questions) {
      const x = byId(r, q.id);
      if (!x) {
        out.push(`| ${q.id} | ${cell(q.topic)} | | | | | | not run |`);
        continue;
      }
      out.push(
        `| ${q.id} | ${cell(q.topic)} | ${cell(toolList(x.tools))} | ${x.approvals.length} | ` +
          `${x.replyChars} | ${seconds(x.firstTextMs)} | ${seconds(x.totalMs)} | ` +
          `${x.isError ? cell(x.error ?? "error") : ""} |`,
      );
    }
    out.push("");
  }

  out.push("## Replies", "");
  for (const q of run.questions) {
    // Escaped like the table cells: a line break, a | or HTML must not break the layout.
    out.push(`### ${q.id}. ${cell(q.topic ? `${q.topic}: ` : "")}${cell(q.text)}`, "");
    out.push(`| ${ran.map(runLabel).join(" | ")} |`);
    out.push(`|${ran.map(() => "---").join("|")}|`);
    const results = ran.map((r) => byId(r, q.id));
    const replyCell = (x: QuestionResult | undefined) => {
      if (!x) return "(not run)";
      const text = x.reply || (x.isError ? `(error: ${x.error ?? "unknown"})` : "(no reply)");
      return cell(text);
    };
    out.push(`| ${results.map(replyCell).join(" | ")} |`);
    const facts = (x: QuestionResult | undefined) =>
      x
        ? cell(
            `${x.replyChars} chars, first text ${seconds(x.firstTextMs)}, total ${seconds(x.totalMs)}` +
              `${x.isError ? ", error" : ""}. Tools: ${toolList(x.tools)}. ` +
              `Approvals: ${approvalList(x.approvals)}.`,
          )
        : "";
    out.push(`| ${results.map(facts).join(" | ")} |`, "");
  }
  return out.join("\n");
}
