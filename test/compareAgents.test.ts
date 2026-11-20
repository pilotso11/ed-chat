import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReport,
  cell,
  edChatDataDir,
  edMcpDataDir,
  isolatedEdMcp,
  isInside,
  jsonPathFor,
  median,
  parseArgs,
  parseQuestions,
  summarizeRun,
  type AgentRun,
  type CompareRun,
  type QuestionResult,
} from "../scripts/compare-lib.js";

const defaults = { questions: "q.json", out: "/tmp/r.md" };

describe("parseArgs", () => {
  it("gives the defaults with no arguments", () => {
    expect(parseArgs([], defaults)).toEqual({
      ok: true,
      options: {
        only: null,
        runs: null,
        questions: "q.json",
        out: "/tmp/r.md",
        timeoutSec: 300,
        dryRun: false,
        help: false,
      },
    });
  });

  it("reads each option, with a space or =", () => {
    const r = parseArgs(
      ["--only", "codex", "--questions=mine.json", "--out", "o.md", "--timeout", "60", "--dry-run"],
      defaults,
    );
    expect(r).toEqual({
      ok: true,
      options: {
        only: "codex",
        runs: null,
        questions: "mine.json",
        out: "o.md",
        timeoutSec: 60,
        dryRun: true,
        help: false,
      },
    });
    expect(parseArgs(["-h"], defaults)).toMatchObject({ ok: true, options: { help: true } });
  });

  it("reads --run, with and without a model, in order", () => {
    const r = parseArgs(
      ["--run", "claude:sonnet", "--run=claude:opus", "--run", "codex"],
      defaults,
    );
    expect(r.ok && r.options.runs).toEqual([
      { agent: "claude", model: "sonnet" },
      { agent: "claude", model: "opus" },
      { agent: "codex" },
    ]);
    expect(parseArgs(["--run", "gpt"], defaults)).toMatchObject({ ok: false });
    expect(parseArgs(["--only", "codex", "--run", "claude"], defaults)).toMatchObject({
      ok: false,
    });
  });

  it("refuses an unknown assistant, a missing value and an unknown argument", () => {
    expect(parseArgs(["--only", "gpt"], defaults)).toEqual({
      ok: false,
      error: "--only takes claude or codex",
    });
    expect(parseArgs(["--out", "--dry-run"], defaults)).toMatchObject({ ok: false });
    expect(parseArgs(["--questions"], defaults)).toMatchObject({ ok: false });
    expect(parseArgs(["--timeout", "soon"], defaults)).toMatchObject({ ok: false });
    expect(parseArgs(["--fast"], defaults)).toEqual({
      ok: false,
      error: "unknown argument: --fast",
    });
  });
});

describe("parseQuestions", () => {
  it("numbers the questions and takes plain strings too", () => {
    expect(parseQuestions('[{"topic":"trade","text":" Sell? "},"Where am I?"]')).toEqual([
      { id: 1, topic: "trade", text: "Sell?" },
      { id: 2, topic: "", text: "Where am I?" },
    ]);
  });

  it("refuses a file that is not a list of questions", () => {
    expect(() => parseQuestions("{")).toThrow(/not JSON/);
    expect(() => parseQuestions("[]")).toThrow(/list of questions/);
    expect(() => parseQuestions('[{"topic":"x"}]')).toThrow(/question 1 has no text/);
  });

  it("parses the default questions: 10 to 15, with a settings question", async () => {
    const file = path.join(import.meta.dirname, "..", "scripts", "compare-questions.json");
    const qs = parseQuestions(await readFile(file, "utf8"));
    expect(qs.length).toBeGreaterThanOrEqual(10);
    expect(qs.length).toBeLessThanOrEqual(15);
    expect(qs.some((q) => q.topic === "settings")).toBe(true);
  });
});

describe("paths", () => {
  it("knows a path inside the repo", () => {
    const repo = path.resolve("/work/ed-chat");
    expect(isInside(repo, path.join(repo, "report.md"))).toBe(true);
    expect(isInside(repo, repo)).toBe(true);
    expect(isInside(repo, path.resolve("/work/ed-chat-reports/r.md"))).toBe(false);
    expect(isInside(repo, path.resolve("/tmp/r.md"))).toBe(false);
  });

  it("puts the JSON next to the report", () => {
    expect(jsonPathFor("/tmp/r.md")).toBe("/tmp/r.json");
    expect(jsonPathFor("/tmp/r.MD")).toBe("/tmp/r.json");
    expect(jsonPathFor("/tmp/report")).toBe("/tmp/report.json");
  });

  it("finds ED Chat's data folder as Electron does", () => {
    expect(
      edChatDataDir({ APPDATA: "C:\\Users\\p\\AppData\\Roaming" }, "C:\\Users\\p", "win32"),
    ).toBe("C:\\Users\\p\\AppData\\Roaming\\ed-chat");
    expect(edChatDataDir({}, "/Users/p", "darwin")).toBe(
      "/Users/p/Library/Application Support/ed-chat",
    );
    expect(edChatDataDir({}, "/home/p", "linux")).toBe("/home/p/.config/ed-chat");
    expect(edChatDataDir({ XDG_CONFIG_HOME: "/x" }, "/home/p", "linux")).toBe("/x/ed-chat");
  });
});

describe("ed-mcp on a copy of its data", () => {
  it("finds the data folder: the sync folder, else ed-mcp's own config folder", () => {
    const home = "C:\\Users\\cmdr";
    expect(edMcpDataDir({ env: { ED_MCP_SYNC_DIR: "D:\\Sync" } }, {}, home, "win32")).toBe(
      "D:\\Sync",
    );
    // ed-mcp names its folder ed-mcp, with no -nodejs suffix.
    expect(edMcpDataDir({ env: {} }, { APPDATA: "C:\\AD" }, home, "win32")).toBe(
      "C:\\AD\\ed-mcp\\Config",
    );
    expect(edMcpDataDir({ env: { ED_MCP_SYNC_DIR: " " } }, {}, "/home/c", "linux")).toBe(
      "/home/c/.config/ed-mcp",
    );
    // As ed-mcp reads it: ~ is home, and a relative path is refused.
    expect(edMcpDataDir({ env: { ED_MCP_SYNC_DIR: "~/Sync" } }, {}, home, "win32")).toBe(
      "C:\\Users\\cmdr\\Sync",
    );
    expect(edMcpDataDir({ env: { ED_MCP_SYNC_DIR: "Sync" } }, {}, home, "win32")).toBeNull();
  });

  it("points the definition at the copy, and its config and cache at the sandbox", () => {
    const def = {
      source: "claudeUser" as const,
      command: "node",
      args: ["x.js"],
      env: { ED_MCP_SYNC_DIR: "D:\\Sync", ED_MCP_SYNC_PASSWORD: "secret-password" },
    };
    const win = isolatedEdMcp(
      def,
      "T:\\copy",
      "T:\\box",
      { LOCALAPPDATA: "C:\\LA" },
      "C:\\U",
      "win32",
    );
    expect(win).toEqual({
      command: "node",
      args: ["x.js"],
      env: {
        ED_MCP_SYNC_DIR: "T:\\copy",
        ED_MCP_SYNC_PASSWORD: "secret-password",
        APPDATA: "T:\\box\\Roaming",
        LOCALAPPDATA: "T:\\box\\Local",
        npm_config_cache: "C:\\LA\\npm-cache",
      },
    });
    const linux = isolatedEdMcp(def, "/t/copy", "/t/box", {}, "/home/c", "linux");
    expect(linux.env).toMatchObject({
      ED_MCP_SYNC_DIR: "/t/copy",
      XDG_CONFIG_HOME: "/t/box/config",
      XDG_CACHE_HOME: "/t/box/cache",
    });
  });
});

const result = (id: number, o: Partial<QuestionResult> = {}): QuestionResult => ({
  questionId: id,
  tools: [],
  approvals: [],
  reply: "ok",
  replyChars: 2,
  firstTextMs: 1000,
  totalMs: 2000,
  isError: false,
  ...o,
});

const claudeRun: AgentRun = {
  agent: "claude",
  model: null,
  command: "claude.exe",
  version: "2.1.308",
  permissionMode: "auto",
  edMcp: "Claude's own config",
  results: [
    result(1, {
      tools: [
        "mcp__ed-mcp__journal_status",
        "mcp__ed-mcp__spansh_route",
        "mcp__ed-mcp__journal_status",
      ],
      reply: "Jump to ⟦Colonia⟧ | 12 jumps\nFuel scoop on the way",
      replyChars: 44,
      firstTextMs: 3200,
      totalMs: 9100,
    }),
    result(2, {
      approvals: [{ tool: "Edit", summary: "C:\\tmp\\settings.json", decision: "declined" }],
      reply: "I could not change it: <denied>",
      replyChars: 31,
      totalMs: 5100,
    }),
  ],
};

const codexRun: AgentRun = {
  agent: "codex",
  model: null,
  command: "codex.exe",
  version: "0.170.0",
  permissionMode: "auto",
  edMcp: "added by ED Chat, from claudeUser",
  results: [
    result(1, { tools: ["journal_status"], replyChars: 30, reply: "x".repeat(30), totalMs: 6000 }),
    result(2, {
      isError: true,
      reply: "",
      replyChars: 0,
      firstTextMs: null,
      totalMs: 300_000,
      error: "no result after 300 s",
    }),
  ],
};

const run: CompareRun = {
  startedAt: "2026-11-19T20:00:00.000Z",
  questions: [
    { id: 1, topic: "route", text: "Plot me a route to Colonia." },
    { id: 2, topic: "settings", text: "Set the bio threshold to 10 million." },
  ],
  runs: [claudeRun, codexRun],
};

describe("summaries", () => {
  it("takes the median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("counts answers, tools and approvals, and leaves errors out of the medians", () => {
    expect(summarizeRun(claudeRun)).toEqual({
      answered: 2,
      errors: 0,
      toolCalls: 3,
      approvals: 1,
      medianChars: 37.5,
      medianFirstTextMs: 2100,
      medianTotalMs: 7100,
      totalMs: 14_200,
    });
    expect(summarizeRun(codexRun)).toMatchObject({
      answered: 1,
      errors: 1,
      medianChars: 30,
      medianFirstTextMs: 1000,
      medianTotalMs: 6000,
      totalMs: 306_000,
    });
  });

  it("keeps a table cell in one piece", () => {
    expect(cell("a | b\nc <x> & d")).toBe("a \\| b<br>c &lt;x&gt; &amp; d");
  });
});

describe("buildReport", () => {
  const report = buildReport(run);

  it("names each run with its model, so two runs of one assistant stay apart", () => {
    const report = buildReport({
      ...run,
      runs: [
        { ...claudeRun, model: "sonnet" },
        { ...claudeRun, model: "opus" },
      ],
    });
    expect(report).toContain("| | Claude (sonnet) | Claude (opus) |");
    expect(report).toContain("model sonnet");
  });

  it("has a summary with a column per assistant", () => {
    expect(report).toContain("| | Claude | Codex |");
    expect(report).toContain("| Answered | 2/2 | 1/2 |");
    expect(report).toContain("| Tool calls | 3 | 1 |");
    expect(report).toContain("| Approvals asked | 1 | 0 |");
    expect(report).toContain("| Median total time | 7.1 s | 6.0 s |");
  });

  it("has a table per assistant, with repeated tools counted and errors named", () => {
    expect(report).toContain("## Claude");
    expect(report).toContain(
      "| 1 | route | mcp__ed-mcp__journal_status ×2, mcp__ed-mcp__spansh_route | 0 | 44 | 3.2 s | 9.1 s |  |",
    );
    expect(report).toContain("## Codex");
    expect(report).toContain(
      "| 2 | settings | none | 0 | 0 | - | 300.0 s | no result after 300 s |",
    );
  });

  it("puts each question's replies side by side, escaped for the table", () => {
    expect(report).toContain("### 1. route: Plot me a route to Colonia.");
    expect(report).toContain(
      `| Jump to ⟦Colonia⟧ \\| 12 jumps<br>Fuel scoop on the way | ${"x".repeat(30)} |`,
    );
    expect(report).toContain(
      "| I could not change it: &lt;denied&gt; | (error: no result after 300 s) |",
    );
    expect(report).toContain("Approvals: Edit (declined): C:\\tmp\\settings.json.");
  });

  it("names a skipped assistant and leaves it out of the tables", () => {
    const skipped: AgentRun = { ...codexRun, command: null, skipped: "not installed", results: [] };
    const r = buildReport({ ...run, runs: [claudeRun, skipped] });
    expect(r).toContain("- **Codex**: skipped: not installed");
    expect(r).toContain("| | Claude |\n|---|---|");
    expect(r).not.toContain("## Codex");
    expect(buildReport({ ...run, runs: [skipped] })).toContain("No assistant ran.");
  });
});
