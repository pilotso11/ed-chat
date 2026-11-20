import { describe, expect, it } from "vitest";
import {
  changedPaths,
  describeChanges,
  playerOnlyValues,
  withValues,
  type PlayerOnlyValues,
} from "../src/core/playerOnly.js";
import { PlayerOnlyGuard, type PlayerOnlyHost } from "../src/core/playerOnlyGuard.js";
import { parseSettings, type Settings } from "../src/core/settings.js";

describe("player-only values", () => {
  it("reads only the player-only settings, as the file sets them", () => {
    const text = '{"claude":{"extraArgs":["--x"]},"hud":{"bioMin":1,"edMcpDataDir":"D:/x"}}';
    expect(playerOnlyValues(text)).toEqual({
      claude: { extraArgs: ["--x"] },
      "hud.edMcpDataDir": "D:/x",
    });
    expect(playerOnlyValues("not json")).toEqual({});
  });

  it("finds the changed ones", () => {
    const a = playerOnlyValues('{"claude":{"permissionMode":"auto"}}');
    const b = playerOnlyValues('{"claude":{"permissionMode":"auto"},"journalDir":"D:/j"}');
    expect(changedPaths(a, b)).toEqual(["journalDir"]);
    expect(changedPaths(a, a)).toEqual([]);
  });

  it("sets them in the file, removes those not set, and keeps the rest", () => {
    const now =
      '{"$schema":"./s.json","claude":{"path":"C:/evil.exe"},"journalDir":"D:/j","hud":{"bioMin":1}}';
    const back = withValues(now, { claude: { permissionMode: "default" } });
    expect(JSON.parse(back)).toEqual({
      $schema: "./s.json",
      claude: { permissionMode: "default" },
      hud: { bioMin: 1 },
    });
  });

  // The player decides on these values, so nothing in them may be cut.
  it("describes each changed value in full", () => {
    const long = `C:/Users/cmdr/${"a".repeat(120)}/evil.exe`;
    const lines = describeChanges(
      { claude: { permissionMode: "auto" } },
      { claude: { permissionMode: "auto", path: long }, "hud.edMcpDataDir": "D:/x" },
      ["claude", "hud.edMcpDataDir"],
    );
    expect(lines).toEqual([
      `claude.path: (default) → ${JSON.stringify(long)}`,
      'hud.edMcpDataDir: (default) → "D:/x"',
    ]);
  });
});

// A host whose file and answers the test controls.
function fakeHost(text: string) {
  const h = {
    text,
    applied: [] as Settings[],
    saved: [] as PlayerOnlyValues[],
    questions: [] as string[][],
    answers: [] as ((ok: boolean) => void)[],
    waiting: false,
    writes: [] as string[],
  };
  const host: PlayerOnlyHost = {
    fileText: () => h.text,
    parse: (t) => {
      const r = parseSettings(t);
      return r.ok ? r.settings : null;
    },
    apply: (s) => void h.applied.push(s),
    write: async (t) => {
      h.writes.push(t);
      h.text = t;
    },
    ask: (lines) =>
      new Promise((resolve) => {
        h.questions.push(lines);
        h.answers.push(resolve);
      }),
    waiting: (on) => void (h.waiting = on),
    save: (v) => void h.saved.push(v),
    log: () => {},
  };
  return { h, host };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const START = '{"claude":{"permissionMode":"default"},"hud":{"bioMin":1}}';

describe("PlayerOnlyGuard", () => {
  it("trusts the file on the first run of this version and saves its values", () => {
    const { h, host } = fakeHost(START);
    const g = new PlayerOnlyGuard(host, null);
    expect(g.values).toEqual({ claude: { permissionMode: "default" } });
    expect(h.saved).toEqual([{ claude: { permissionMode: "default" } }]);
  });

  it("applies the other settings of a save at once and keeps the player-only ones", async () => {
    const { h, host } = fakeHost(START);
    const g = new PlayerOnlyGuard(host, null);
    h.text = '{"claude":{"permissionMode":"auto","path":"C:/evil.exe"},"hud":{"bioMin":2}}';
    g.fileChanged();
    expect(h.applied[0]!.hud.bioMin).toBe(2);
    expect(h.applied[0]!.claude.path).toBeNull();
    expect(h.applied[0]!.claude.permissionMode).toBe("default");
    expect(h.waiting).toBe(true);
    expect(h.questions[0]).toEqual([
      'claude.permissionMode: "default" → "auto"',
      'claude.path: (default) → "C:/evil.exe"',
    ]);
    await tick();
  });

  it("applies the shown values when the player chooses Apply", async () => {
    const { h, host } = fakeHost(START);
    const g = new PlayerOnlyGuard(host, null);
    h.text = '{"claude":{"permissionMode":"auto"}}';
    g.fileChanged();
    h.answers[0]!(true);
    await tick();
    expect(g.values).toEqual({ claude: { permissionMode: "auto" } });
    expect(h.saved.at(-1)).toEqual({ claude: { permissionMode: "auto" } });
    expect(h.applied.at(-1)!.claude.permissionMode).toBe("auto");
    expect(h.waiting).toBe(false);
  });

  it("writes the old values back on Undo and keeps the rest of the save", async () => {
    const { h, host } = fakeHost(START);
    const g = new PlayerOnlyGuard(host, null);
    h.text = '{"claude":{"extraArgs":["--x"]},"hud":{"bioMin":2}}';
    g.fileChanged();
    h.answers[0]!(false);
    await tick();
    expect(JSON.parse(h.writes[0]!)).toEqual({
      claude: { permissionMode: "default" },
      hud: { bioMin: 2 },
    });
    expect(g.values).toEqual({ claude: { permissionMode: "default" } });
  });

  // The answer is for the values the player read, not for what the file holds later.
  it("asks again when the file changes while the question is open", async () => {
    const { h, host } = fakeHost(START);
    const g = new PlayerOnlyGuard(host, null);
    h.text = '{"claude":{"permissionMode":"default","path":"C:/a.exe"}}';
    g.fileChanged();
    h.text = '{"claude":{"permissionMode":"default","path":"C:/evil.exe"}}';
    g.fileChanged();
    expect(h.questions.length).toBe(1);
    h.answers[0]!(true);
    await tick();
    expect(g.values).toEqual({ claude: { permissionMode: "default" } });
    expect(h.questions[1]).toEqual(['claude.path: (default) → "C:/evil.exe"']);
    h.answers[1]!(true);
    await tick();
    expect(g.values).toEqual({ claude: { permissionMode: "default", path: "C:/evil.exe" } });
  });

  // A change made while ED Chat was closed, or left unanswered at quit.
  it("asks at start when the file differs from the values last applied", () => {
    const { h, host } = fakeHost('{"claude":{"path":"C:/evil.exe"}}');
    const g = new PlayerOnlyGuard(host, { claude: { permissionMode: "default" } });
    expect(g.effective()!.claude.path).toBeNull();
    expect(g.effective()!.claude.permissionMode).toBe("default");
    g.check();
    expect(h.questions.length).toBe(1);
  });

  it("does not ask about a value ED Chat writes for the player", async () => {
    const { h, host } = fakeHost(START);
    const g = new PlayerOnlyGuard(host, null);
    await g.playerWrite(
      '{"claude":{"permissionMode":"auto"},"hud":{"bioMin":1}}',
      "claude.permissionMode",
      "auto",
    );
    g.fileChanged();
    expect(h.questions).toEqual([]);
    expect(g.values).toEqual({ claude: { permissionMode: "auto" } });
  });

  it("keeps a change that waits for the player when ED Chat writes another value", async () => {
    const { h, host } = fakeHost(START);
    const g = new PlayerOnlyGuard(host, null);
    // The assistant (or the player) changes extraArgs; the question is open.
    h.text = '{"claude":{"permissionMode":"default","extraArgs":["--x"]},"hud":{"bioMin":1}}';
    g.fileChanged();
    expect(h.questions).toHaveLength(1);
    // Meanwhile ED Chat writes the agent for the player.
    h.text = JSON.stringify({ ...JSON.parse(h.text), agent: "codex" });
    await g.playerWrite(h.text, "agent", "codex");
    expect(g.values).toEqual({ claude: { permissionMode: "default" }, agent: "codex" });
    // The waiting change is still in the file and still waits.
    expect(h.text).toContain("--x");
    // The file changed while the question was open, so the player is asked again, about it
    // as it is now; agent is no longer part of the question.
    h.answers[0]!(true);
    await tick();
    expect(h.questions).toHaveLength(2);
    expect(h.questions[1]!.join(" ")).not.toContain("agent");
    h.answers[1]!(true);
    await tick();
    expect(g.values).toMatchObject({ claude: { extraArgs: ["--x"] }, agent: "codex" });
  });

  it("keeps the old values when ED Chat's own write fails", async () => {
    const { host } = fakeHost(START);
    const g = new PlayerOnlyGuard(
      { ...host, write: () => Promise.reject(new Error("EBUSY")) },
      null,
    );
    await expect(
      g.playerWrite('{"claude":{"permissionMode":"auto"}}', "claude.permissionMode", "auto"),
    ).rejects.toThrow();
    expect(g.values).toEqual({ claude: { permissionMode: "default" } });
  });
});
