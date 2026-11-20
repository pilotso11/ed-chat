// The pure parts of scripts/compare-agents.ts: arguments, questions, the ed-mcp each assistant
// gets, and the report. Kept apart so tests can import them without starting anything.
import path from "node:path";
import type { AgentId } from "../src/core/backend.js";
import {
  edMcpToAdd,
  findEdMcp,
  forCli,
  hasOwnEdMcp,
  type AgentConfigs,
  type CliMcpServer,
} from "../src/core/edMcp.js";

export const AGENT_IDS: AgentId[] = ["claude", "codex"];
const NAMES: Record<AgentId, string> = { claude: "Claude", codex: "Codex" };

export const USAGE = `Usage: npx tsx scripts/compare-agents.ts [options]

Sends the same player questions to Claude and Codex through ED Chat's own sessions, with the
HUD prompt and ed-mcp, and writes a report with both replies side by side. Each question starts
a new conversation. Approvals are declined. This spends tokens on each assistant.

Options:
  --only claude|codex   Run one assistant only.
  --questions <file>    A JSON list of { "topic", "text" } (default scripts/compare-questions.json).
  --out <file>          The Markdown report (default in the temp folder). The raw numbers go
                        next to it, with .json. It must be outside the repo.
  --timeout <seconds>   How long one reply may take (default 300).
  --dry-run             Print what would run, and start no CLI.
  --help                Show this message.`;

export interface CompareOptions {
  only: AgentId | null;
  questions: string;
  out: string;
  timeoutSec: number;
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
    questions: defaults.questions,
    out: defaults.out,
    timeoutSec: 300,
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
      default:
        return { ok: false, error: `unknown argument: ${arg}` };
    }
  }
  return { ok: true, options: o };
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

export interface EdMcpPlan {
  /** Passed to the assistant; null when it has its own, or none is found. */
  server: CliMcpServer | null;
  /** For the report: where the assistant's ed-mcp comes from. */
  note: string;
}

/**
 * The ed-mcp that main would give the assistant. The script runs in another folder, so
 * Claude does not see a project entry for ED Chat's own workspace there: that entry is then
 * added, as the definition main would rank first.
 */
export function edMcpPlan(
  agent: AgentId,
  c: AgentConfigs,
  workspace: string,
  edChatWorkspace: string,
): EdMcpPlan {
  if (hasOwnEdMcp(agent, c, workspace))
    return { server: null, note: `${NAMES[agent]}'s own config` };
  // None at all, or the assistant's own is switched off or in a file that cannot be read.
  if (!edMcpToAdd(agent, c, workspace))
    return { server: null, note: "none added: none found, or its own is off or unreadable" };
  const add = findEdMcp(c, edChatWorkspace);
  return add
    ? { server: forCli(add), note: `added by ED Chat, from ${add.source}` }
    : { server: null, note: "none found" };
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
  /** The CLI started, or null when it is not installed. */
  command: string | null;
  version: string | null;
  permissionMode: string;
  edMcp: string;
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
      : `${r.command}${r.version ? ` (${r.version})` : ""}, permission mode ${r.permissionMode}, ed-mcp: ${r.edMcp}`;
    out.push(`- **${NAMES[r.agent]}**: ${cell(what)}`);
  }
  out.push("");
  if (!ran.length) {
    out.push("No assistant ran.", "");
    return out.join("\n");
  }

  out.push("## Summary", "");
  const sums = ran.map(summarizeRun);
  out.push(`| | ${ran.map((r) => NAMES[r.agent]).join(" | ")} |`);
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
    out.push(`## ${NAMES[r.agent]}`, "");
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
    // Escaped like the table cells: a line break or a leading # must not break the layout.
    out.push(`### ${q.id}. ${cell(q.topic ? `${q.topic}: ` : "")}${cell(q.text)}`, "");
    out.push(`| ${ran.map((r) => NAMES[r.agent]).join(" | ")} |`);
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
