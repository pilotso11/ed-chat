import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
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
  parseProvider,
  redactKey,
  providerHomesDir,
  parseQuestions,
  summarizeRun,
  testProviderEnv,
  codexTestConfig,
  TEST_KEY_ENV,
  type TestProvider,
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
        providers: [],
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
        providers: [],
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

describe("providers", () => {
  it("reads --provider, and --run with @provider next to runs on the player's login", () => {
    const r = parseArgs(
      [
        "--provider",
        "scripts/providers/zai.json",
        "--run",
        "claude:sonnet",
        "--run",
        "codex:gpt-6.2-sol",
        "--run",
        "claude@zai",
        "--run=codex:glm-5.3@zai",
      ],
      defaults,
    );
    expect(r.ok && r.options.providers).toEqual(["scripts/providers/zai.json"]);
    expect(r.ok && r.options.runs).toEqual([
      { agent: "claude", model: "sonnet" },
      { agent: "codex", model: "gpt-6.2-sol" },
      { agent: "claude", provider: "zai" },
      { agent: "codex", model: "glm-5.3", provider: "zai" },
    ]);
    expect(parseArgs(["--provider"], defaults)).toMatchObject({ ok: false });
  });

  it("keeps an @ in a model id that names no provider, and takes any file name", () => {
    const runs = (...argv: string[]) => {
      const r = parseArgs(argv, defaults);
      return r.ok ? r.options.runs : r.error;
    };
    expect(runs("--run", "claude:claude-sonnet-4@20250514")).toEqual([
      { agent: "claude", model: "claude-sonnet-4@20250514" },
    ]);
    expect(runs("--provider", "zai.json", "--run", "claude:claude-sonnet-4@20250514@zai")).toEqual([
      { agent: "claude", model: "claude-sonnet-4@20250514", provider: "zai" },
    ]);
    // --provider after --run, and a file name with a space.
    expect(runs("--run", "codex:glm@my zai", "--provider", "dir/my zai.json")).toEqual([
      { agent: "codex", model: "glm", provider: "my zai" },
    ]);
  });

  it("refuses an unknown provider, an unused one, two of one name, and Codex with no model", () => {
    const err = (...argv: string[]) => {
      const r = parseArgs(argv, defaults);
      return r.ok ? null : r.error;
    };
    expect(err("--run", "claude@zai")).toMatch(/no --provider is named zai/);
    expect(err("--provider", "zai.json", "--run", "claude")).toMatch(/no --run <agent>@zai/);
    expect(err("--provider", "zai.json", "--only", "claude")).toMatch(/no --run <agent>@zai/);
    expect(
      err("--provider", "a/zai.json", "--provider", "b/zai.json", "--run", "claude@zai"),
    ).toMatch(/two --provider files are named zai/);
    expect(err("--provider", "zai.json", "--run", "codex@zai")).toMatch(/needs a model/);
    // A misspelt or missing provider after a model never runs on the player's own login.
    expect(err("--run", "codex:glm-5.3@zai")).toMatch(/no --provider is named zai/);
    expect(err("--provider", "zai.json", "--run", "codex:glm-5.3@zia")).toMatch(
      /no --provider is named zia/,
    );
  });

  it("reads the checked-in z.ai file, with no key in it", async () => {
    const text = await readFile(
      path.join(import.meta.dirname, "..", "scripts", "providers", "zai.json"),
      "utf8",
    );
    const p = parseProvider(text);
    expect(p.name).toBe("z.ai");
    expect(p.claude?.baseUrl).toBe("https://api.z.ai/api/anthropic");
    expect(p.codex?.baseUrl).toBe("https://api.z.ai/api/v1");
    expect(p.codex?.models).toHaveLength(1);
    // Claude's auto mode needs Anthropic's safety check, which z.ai does not have.
    expect(p.claude?.permissionMode).toBe("default");
    expect(p.codex?.permissionMode).toBeUndefined();
    expect(text).not.toMatch(/AUTH_TOKEN|API_KEY|"key"/i);
  });

  it("refuses a bad URL, a key or base URL in env, and a file with no assistant", () => {
    const parse = (o: unknown) => () => parseProvider(JSON.stringify(o));
    expect(parse({ claude: { baseUrl: "a.example" } })).toThrow(/baseUrl/);
    expect(
      parse({ claude: { baseUrl: "https://a.example", env: { ANTHROPIC_AUTH_TOKEN: "k" } } }),
    ).toThrow(/must not set/);
    expect(parse({ claude: { baseUrl: "https://a.example", env: { X: { y: 1 } } } })).toThrow(
      /not a string/,
    );
    expect(parse({ codex: { baseUrl: "https://b.example", models: {} } })).toThrow(/not a list/);
    expect(parse({ name: "x" })).toThrow(/neither/);
    for (const name of ["ANTHROPIC_API_KEY", "SOME_TOKEN", "a_secret", "DB_PASSWORD"])
      expect(parse({ claude: { baseUrl: "https://a.example", env: { [name]: "x" } } })).toThrow(
        /credential/,
      );
    expect(parse({ codex: { baseUrl: "https://b.example", permissionMode: "yolo" } })).toThrow(
      /auto or default/,
    );
    expect(
      parseProvider(JSON.stringify({ claude: { baseUrl: "https://a.example", env: { N: 1 } } }))
        .claude?.env,
    ).toEqual({ N: "1" });
  });

  const provider: TestProvider = {
    name: "test",
    claude: {
      baseUrl: "https://a.example/anthropic",
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "glm" },
    },
    codex: { baseUrl: "https://b.example/v1", models: [] },
  };
  const playerEnv = {
    PATH: "C:\\bin",
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_MODEL: "player-model",
    AWS_BEARER_TOKEN_BEDROCK: "player-bedrock",
    OPENAI_ORG_ID: "player-org",
    [TEST_KEY_ENV]: "k-from-shell",
    ANTHROPIC_API_KEY: "player-anthropic",
    Claude_Config_Dir: "C:\\Users\\p\\.claude-alt",
    CLAUDE_CODE_OAUTH_TOKEN: "player-oauth",
    OPENAI_API_KEY: "player-openai",
    CODEX_HOME: "C:\\Users\\p\\.codex",
  };

  it("runs Claude on the endpoint with its own config folder, and none of the player's login", () => {
    expect(testProviderEnv("claude", provider, "k1", "T:\\claude-home", playerEnv)).toEqual({
      PATH: "C:\\bin",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm",
      CLAUDE_CONFIG_DIR: "T:\\claude-home",
      ANTHROPIC_BASE_URL: "https://a.example/anthropic",
      ANTHROPIC_AUTH_TOKEN: "k1",
    });
  });

  it("runs Codex with its own CODEX_HOME and the key in ED_CHAT_TEST_API_KEY only", () => {
    expect(testProviderEnv("codex", provider, "k2", "T:\\codex-home", playerEnv)).toEqual({
      PATH: "C:\\bin",
      CODEX_HOME: "T:\\codex-home",
      [TEST_KEY_ENV]: "k2",
    });
    expect(() => testProviderEnv("codex", { name: "c" }, "k", "h", {})).toThrow(/no codex/);
  });

  it("keeps the config folders out of the temp folder, where Codex sets up no sandbox", () => {
    expect(providerHomesDir({ LOCALAPPDATA: "C:\\LA" }, "C:\\Users\\p", "win32", "run1")).toBe(
      "C:\\LA\\ed-chat-compare\\run1",
    );
    expect(providerHomesDir({}, "C:\\Users\\p", "win32", "run1")).toBe(
      "C:\\Users\\p\\AppData\\Local\\ed-chat-compare\\run1",
    );
    expect(providerHomesDir({}, "/home/p", "linux", "run1")).toBe(
      "/home/p/.cache/ed-chat-compare/run1",
    );
  });

  it("takes the key out of every copy in a report", () => {
    expect(redactKey("env: KEY=sk.1 and again sk.1", "sk.1")).toBe(
      "env: KEY=<key> and again <key>",
    );
    expect(redactKey("no key here", "")).toBe("no key here");
    const zai = "0123456789abcdef0123.ABCDEFGHIJKLMNOP";
    expect(redactKey(`id 0123456789abcdef0123, secret ABCDEFGHIJKLMNOP`, zai)).toBe(
      "id <key>, secret <key>",
    );
  });

  it("writes a Codex provider that reads the key from the environment, not the file", () => {
    expect(parseToml(codexTestConfig("https://b.example/v1", "T:\\h\\models.json"))).toEqual({
      model_provider: "ed-chat-test",
      model_catalog_json: "T:\\h\\models.json",
      model_providers: {
        "ed-chat-test": {
          name: "ed-chat-test",
          base_url: "https://b.example/v1",
          env_key: TEST_KEY_ENV,
          wire_api: "responses",
        },
      },
    });
    expect(parseToml(codexTestConfig("https://b.example/v1", null))).not.toHaveProperty(
      "model_catalog_json",
    );
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

  it("names the test endpoint a run went through", () => {
    const report = buildReport({
      ...run,
      runs: [
        { ...claudeRun, model: "sonnet" },
        { ...claudeRun, via: "z.ai", endpoint: "https://a.example/anthropic", model: "sonnet" },
      ],
    });
    expect(report).toContain("| | Claude (sonnet) | z.ai via Claude (sonnet) |");
    expect(report).toContain("through z.ai, https://a.example/anthropic");
    expect(buildReport(run)).not.toContain("through ");
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
