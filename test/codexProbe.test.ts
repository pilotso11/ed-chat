import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cliConfig,
  isTurnCompleted,
  makeRedactor,
  outDirProblem,
  secretsOf,
  stopTree,
} from "../scripts/codex-probe.mjs";

describe("outDirProblem", () => {
  let tmp = "";
  let repo = "";
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "probe-out-"));
    repo = path.join(tmp, "repo");
    await mkdir(path.join(repo, "sub"), { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    spawnSync("git", ["init", "-q", "--bare", path.join(tmp, "bare")]);
    await mkdir(path.join(tmp, "outside"));
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  it("accepts a folder outside any repository, also one not made yet", () => {
    expect(outDirProblem(path.join(tmp, "outside"))).toBeNull();
    expect(outDirProblem(path.join(tmp, "outside", "new", "deeper"))).toBeNull();
  });

  it("refuses a folder in a work tree, also one not made yet", () => {
    expect(outDirProblem(path.join(repo, "sub"))).toMatch(/outside any git work tree/);
    expect(outDirProblem(path.join(repo, "new"))).toMatch(/outside any git work tree/);
  });

  it("refuses a folder inside a .git folder or a bare repository", () => {
    expect(outDirProblem(path.join(repo, ".git", "rec"))).toMatch(/inside a \.git folder/);
    expect(outDirProblem(path.join(repo, ".GIT"))).toMatch(/inside a \.git folder/);
    expect(outDirProblem(path.join(tmp, "bare", "rec"))).toMatch(/inside a \.git folder/);
  });

  it("ignores inherited GIT_* variables", () => {
    const toRepo = { ...process.env, GIT_DIR: path.join(repo, ".git"), GIT_WORK_TREE: repo };
    expect(outDirProblem(path.join(tmp, "outside"), { env: toRepo })).toBeNull();
    const hideRepo = { ...process.env, GIT_CEILING_DIRECTORIES: repo };
    expect(outDirProblem(path.join(repo, "sub"), { env: hideRepo })).toMatch(/work tree/);
  });

  it("gives git a clean environment with English messages", () => {
    let seen: NodeJS.ProcessEnv = {};
    const run = (_args: string[], env: NodeJS.ProcessEnv) => {
      seen = env;
      return { status: 128, stderr: "fatal: not a git repository (or any of the parent dirs)" };
    };
    const env = { PATH: "x", GIT_DIR: "y", git_index_file: "z", LANGUAGE: "de" };
    expect(outDirProblem(path.join(tmp, "outside"), { run, env })).toBeNull();
    expect(seen).toEqual({ PATH: "x", LC_ALL: "C", GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" });
  });

  it("fails closed on any other git error", () => {
    const out = path.join(tmp, "outside");
    const dubious = () => ({ status: 128, stderr: "fatal: detected dubious ownership" });
    expect(outDirProblem(out, { run: dubious })).toMatch(/cannot check.*dubious ownership/);
    const crashed = () => ({ status: null, stderr: "" });
    expect(outDirProblem(out, { run: crashed })).toMatch(/cannot check/);
    const missing = () => ({ status: null, error: new Error("spawn git ENOENT") });
    expect(outDirProblem(out, { run: missing })).toMatch(/git not found/);
  });
});

describe("isTurnCompleted", () => {
  const done = (id: string) => ({ method: "turn/completed", params: { turn: { id } } });
  it("matches the turn/completed of its own turn only", () => {
    expect(isTurnCompleted(done("t1"), "t1")).toBe(true);
    expect(isTurnCompleted(done("t0"), "t1")).toBe(false);
    expect(isTurnCompleted({ method: "turn/started", params: { turn: { id: "t1" } } }, "t1")).toBe(
      false,
    );
    expect(isTurnCompleted(done(""), "")).toBe(false);
    expect(isTurnCompleted(null, "t1")).toBe(false);
  });
});

describe("secretsOf and makeRedactor", () => {
  const ed = {
    command: "cmd",
    args: ["/c", "npx", "-y", "ed-mcp@latest", "--password", "hunter2", "--token=tok1", "KEY=k"],
    env: { ED_MCP_SYNC_PASSWORD: "pw1", ED_MCP_SYNC_DIR: "C:\\Users\\Ann\\Sync", SHORT: "1" },
  };

  it("takes the password, long env values, and secret-looking args", () => {
    expect(secretsOf(ed).sort()).toEqual(["C:\\Users\\Ann\\Sync", "hunter2", "pw1", "tok1"]);
    expect(secretsOf({ args: ["API_KEY=abc", "--auth", "xyz", "--author"] }).sort()).toEqual([
      "abc",
      "xyz",
    ]);
  });

  it("knows a secret flag by whole word, not by a part of another word", () => {
    const args = [
      "--author",
      "Jane",
      "--passthrough",
      "on",
      "--authToken",
      "t1",
      "--api-key",
      "k1",
    ];
    expect(secretsOf({ args }).sort()).toEqual(["k1", "t1"]);
  });

  it("still knows secret flags whose word only starts with or holds a secret word", () => {
    const flags = [
      "--authorization",
      "--passphrase",
      "--oauth",
      "--apitoken",
      "--APIToken",
      "--tokens",
      "--secrets",
      "--SYNCPASSWORD",
      "--client-secret",
      "--credentials",
      "--db-pass",
      "--pass",
      "--pass-word",
      "--pass-phrase",
      "--db-pass-file",
      "--api-keys",
      "--api_keys",
      "--apikeys",
      // Errs on the safe side: pass is a word of its own here.
      "--pass-through",
    ];
    for (const flag of flags) expect(secretsOf({ args: [flag, "v1"] }), flag).toEqual(["v1"]);
    for (const flag of ["--author", "--authors", "--passthrough", "--passes"])
      expect(secretsOf({ args: [flag, "v1"] }), flag).toEqual([]);
  });

  it("redacts a path in any slash, escaping and case", () => {
    const redact = makeRedactor(secretsOf(ed));
    for (const spelling of [
      "C:\\Users\\Ann\\Sync",
      "C:/Users/Ann/Sync",
      "c:\\users\\ann\\sync",
      JSON.stringify("C:\\Users\\Ann\\Sync").slice(1, -1),
      JSON.stringify(JSON.stringify("C:\\Users\\Ann\\Sync").slice(1, -1)).slice(1, -1),
    ]) {
      expect(redact(`dir=${spelling}\\x`)).toBe("dir=<redacted>\\x");
    }
  });

  it("redacts a value with quotes when doubly escaped, and keeps short values", () => {
    const redact = makeRedactor(['pa"ss', "pw1"]);
    const twice = JSON.stringify(JSON.stringify({ p: 'pa"ss' }));
    expect(redact(twice)).not.toContain("pa");
    expect(redact("pw1 and 1 and 12")).toBe("<redacted> and 1 and 12");
    expect(makeRedactor([])("pw1")).toBe("pw1");
  });

  it("redacts the longer of two values first", () => {
    expect(makeRedactor(["abc", "abcdef"])("abcdef")).toBe("<redacted>");
  });
});

describe("cliConfig", () => {
  it("passes ed-mcp's env through codex's environment and env_vars, never the command line", () => {
    const ed = { command: "cmd", args: ["/c", "npx"], env: { ED_MCP_SYNC_PASSWORD: "pw1", N: 2 } };
    const { args, env } = cliConfig(ed, { PATH: "p" });
    expect(args).toEqual([
      "-c",
      'mcp_servers.ed-mcp.command="cmd"',
      "-c",
      'mcp_servers.ed-mcp.args=["/c","npx"]',
      "-c",
      'mcp_servers.ed-mcp.env_vars=["ED_MCP_SYNC_PASSWORD"]',
    ]);
    expect(args.join(" ")).not.toContain("pw1");
    expect(env).toEqual({ PATH: "p", ED_MCP_SYNC_PASSWORD: "pw1" });
  });

  it("adds no env_vars without an env", () => {
    expect(cliConfig({ command: "ed-mcp" }, {}).args).toHaveLength(4);
  });
});

// A node process that starts a sleeping child, prints its pid, and maybe exits. The child is
// detached: Node puts the others in a job that ends them with their parent, and codex (written
// in Rust) does not, so its ed-mcp outlives it.
function parentWithChild(exit: boolean) {
  const code = `const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true, windowsHide: true });
console.log(c.pid);${exit ? " setTimeout(() => process.exit(0), 100);" : " setInterval(() => {}, 1000);"}`;
  const p = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  const childPid = new Promise<number>((resolve) =>
    p.stdout.once("data", (d: Buffer) => resolve(Number(String(d).trim()))),
  );
  return { p, childPid };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number) {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

describe.runIf(process.platform === "win32")("stopTree", () => {
  // A failed test must not leave the sleepers running.
  const started: number[] = [];
  afterEach(() => {
    for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid);
  });

  it("stops a running process and what it started", async () => {
    const { p, childPid } = parentWithChild(false);
    const child = await childPid;
    started.push(p.pid!, child);
    stopTree(p, Date.now() - 5000);
    expect(await gone(p.pid!)).toBe(true);
    expect(await gone(child)).toBe(true);
  });

  it("stops what a process started after the process itself has gone", async () => {
    const startedAt = Date.now();
    const { p, childPid } = parentWithChild(true);
    const child = await childPid;
    started.push(child);
    await new Promise((r) => p.once("exit", r));
    expect(alive(child)).toBe(true);
    stopTree(p, startedAt);
    expect(await gone(child)).toBe(true);
  });
});
