import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  commanderFromJournal,
  commandersFromJournals,
  makeScrubber,
  scrubClaudeLine,
  scrubCodexLines,
} from "../scripts/scrub-fixtures.mjs";

const scrub = makeScrubber({
  home: "C:\\Users\\Ann",
  user: "Ann",
  commander: "Hawk Eye",
  fid: "F7654321",
});
const THREAD = "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b";
const TURN = "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5c";

describe("makeScrubber", () => {
  it("replaces the home folder in every spelling", () => {
    expect(scrub.text("C:\\Users\\Ann\\Saved Games")).toBe("/home/player\\Saved Games");
    expect(scrub.text("C:/Users/Ann/Saved Games")).toBe("/home/player/Saved Games");
    expect(scrub.text("c:\\users\\ann\\x")).toBe("/home/player\\x");
    // JSON-escaped once and twice, as in a tool result that holds JSON text.
    expect(scrub.text("C:\\\\Users\\\\Ann\\\\x")).toBe("/home/player\\\\x");
    expect(scrub.text("C:\\\\\\\\Users\\\\\\\\Ann")).toBe("/home/player");
  });

  it("replaces a POSIX home folder", () => {
    const s = makeScrubber({ home: "/home/ann", user: "ann" });
    expect(s.text("/home/ann/.codex and \\/home\\/ann")).toBe(
      "/home/player/.codex and /home/player",
    );
  });

  it("replaces a short user name only as a whole word", () => {
    const s = makeScrubber({ user: "Ed" });
    expect(s.text("mcp__ed-mcp__journal_status started; ed@pc")).toBe(
      "mcp__ed-mcp__journal_status started; player@pc",
    );
  });

  it("still replaces a user name joined to other words by - or _, or after an escape", () => {
    const s = makeScrubber({ user: "seth" });
    expect(s.text("host SETH-PC, seth_backup, D:\\seth-games, user-seth")).toBe(
      "host player-PC, player_backup, D:\\player-games, user-player",
    );
    expect(s.text("line\\nseth and\\tseth")).toBe("line\\nplayer and\\tplayer");
  });

  it("replaces the user name, the commander name and the FID", () => {
    expect(scrub.text("ann@pc ANN")).toBe("player@pc player");
    expect(scrub.text("CMDR Hawk Eye (FID F7654321), CMDR HAWK EYE")).toBe(
      "CMDR Jameson (FID F0000000), CMDR Jameson",
    );
  });

  it("replaces a commander name as a whole word only", () => {
    const s = makeScrubber({ commander: "Al" });
    expect(s.text("Al found salt. al.")).toBe("Jameson found salt. Jameson.");
  });

  it("scrubs keys and nested values, and keeps other values", () => {
    expect(scrub.json({ "C:/Users/Ann": [{ n: 1, ok: true, s: "Ann", z: null }] })).toEqual({
      "/home/player": [{ n: 1, ok: true, s: "player", z: null }],
    });
  });

  it("is safe to run more than once", () => {
    const once = scrub.text("C:\\Users\\Ann CMDR Hawk Eye F7654321");
    expect(scrub.text(once)).toBe(once);
  });
});

describe("scrubCodexLines", () => {
  it("keeps the probe's direction marks, thread ids and turn ids", () => {
    const sent = { id: 3, method: "thread/start", params: { cwd: "C:\\Users\\Ann\\probe" } };
    const got = {
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: TURN, status: "completed" } },
    };
    const out = scrubCodexLines([">> " + JSON.stringify(sent), "<< " + JSON.stringify(got)], scrub);
    expect(out).toEqual([
      '>> {"id":3,"method":"thread/start","params":{"cwd":"/home/player\\\\probe"}}',
      "<< " + JSON.stringify(got),
    ]);
  });

  it("scrubs paths inside JSON text in a tool result", () => {
    const inner = JSON.stringify({ journal: "C:\\Users\\Ann\\Saved Games", cmdr: "Hawk Eye" });
    const line = JSON.stringify({ method: "item/completed", params: { text: inner } });
    const [out] = scrubCodexLines(["<< " + line], scrub);
    expect(out).not.toMatch(/Ann|Hawk/i);
    const text = JSON.parse(JSON.parse(out!.slice(3)).params.text);
    expect(text).toEqual({ journal: "/home/player\\Saved Games", cmdr: "Jameson" });
  });

  it("removes account and remoteControl notifications", () => {
    const lines = [
      '<< {"method":"account/rateLimits/updated","params":{"plan":"pro"}}',
      '<< {"method":"remoteControl/status/changed","params":{"device":"Ann-PC"}}',
      '<< {"method":"thread/tokenUsage/updated","params":{}}',
    ];
    expect(scrubCodexLines(lines, scrub)).toEqual([lines[2]]);
  });

  it("removes an account request and its answer, and keeps an answer with the same id the other way", () => {
    const lines = [
      '>> {"id":2,"method":"account/read","params":{}}',
      '>> {"id":2,"result":{}}',
      '<< {"id":2,"result":{"account":{"email":"ann@example.com"}}}',
      '<< {"id":2,"result":{}}',
    ];
    expect(scrubCodexLines(lines, scrub)).toEqual([lines[1], lines[3]]);
  });

  it("removes an account request from Codex and the probe's answer", () => {
    const lines = [
      '<< {"id":0,"method":"account/chatgptAuthTokens/refresh","params":{}}',
      '>> {"id":0,"result":{"accessToken":"x"}}',
    ];
    expect(scrubCodexLines(lines, scrub)).toEqual([]);
  });

  it("works on plain JSON lines", () => {
    const lines = [
      '{"id":5,"method":"account/read"}',
      '{"id":5,"result":{"plan":"pro"}}',
      '{"method":"thread/started","params":{"thread":{"id":"' +
        THREAD +
        '","cwd":"C:/Users/Ann"}}}',
    ];
    expect(scrubCodexLines(lines, scrub)).toEqual([
      '{"method":"thread/started","params":{"thread":{"id":"' +
        THREAD +
        '","cwd":"/home/player"}}}',
    ]);
  });

  it("scrubs a line that is not JSON as text", () => {
    expect(scrubCodexLines(["!! spawn error: C:\\Users\\Ann\\codex.exe"], scrub)).toEqual([
      "!! spawn error: /home/player\\codex.exe",
    ]);
  });
});

describe("scrubClaudeLine", () => {
  it("drops the recorder's private init keys and other MCP servers, and scrubs strings", () => {
    const init = {
      type: "system",
      subtype: "init",
      cwd: "C:\\Users\\Ann\\ed",
      plugins: ["x"],
      tools: ["Read", "mcp__ed-mcp__journal_status", "mcp__gmail__send"],
      mcp_servers: [{ name: "ed-mcp" }, { name: "gmail" }],
    };
    expect(scrubClaudeLine(init, scrub)).toEqual({
      type: "system",
      subtype: "init",
      cwd: "/home/player\\ed",
      tools: ["Read", "mcp__ed-mcp__journal_status"],
      mcp_servers: [{ name: "ed-mcp" }],
    });
  });
});

describe("commanderFromJournal", () => {
  it("reads the name and FID from the newest journal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "journal-"));
    try {
      const old = path.join(dir, "Journal.2026-01-01T000000.01.log");
      await writeFile(old, '{"event":"Commander","FID":"F1","Name":"Old"}\n');
      await utimes(old, new Date(2026, 0, 1), new Date(2026, 0, 1));
      await writeFile(
        path.join(dir, "Journal.2026-11-18T120000.01.log"),
        '{"event":"Fileheader"}\n{"event":"LoadGame","FID":"F2","Commander":"New"}\n',
      );
      expect(commanderFromJournal(dir)).toEqual({ name: "New", fid: "F2" });
      // Every commander, for a machine with two game accounts, and both FIDs when two accounts
      // have the same commander name.
      await writeFile(
        path.join(dir, "Journal.2026-11-19T120000.01.log"),
        '{"event":"LoadGame","FID":"F3","Commander":"new"}\n',
      );
      expect(commandersFromJournals(dir)).toEqual(
        expect.arrayContaining([
          { name: "Old", fid: "F1" },
          { name: "New", fid: "F2" },
          { name: "new", fid: "F3" },
        ]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scrubs every commander, and tells what a spelling it missed left behind", () => {
    const s = makeScrubber({ commander: "New", commanders: ["Old", "New"], fids: ["F1", "F2"] });
    expect(s.text("CMDR Old (F1) and CMDR New (F2)")).toBe(
      "CMDR Jameson (F0000000) and CMDR Jameson (F0000000)",
    );
    expect(s.leaks("all clean, Jameson")).toEqual([]);
    expect(s.leaks("CMDR old and F2")).toEqual(["Old", "F2"]);
  });

  it("scrubs a longer name or FID before one that starts it", () => {
    const s = makeScrubber({ commanders: ["New", "New Horizon"], fids: ["F123", "F1234"] });
    const out = s.text("CMDR New Horizon F1234, CMDR New F123");
    expect(out).toBe("CMDR Jameson F0000000, CMDR Jameson F0000000");
    expect(s.leaks(out)).toEqual([]);
  });

  it("finds a spelling the rules skip, but not ed-mcp's own names", () => {
    const s = makeScrubber({ user: "seth", commanders: ["Hawk Eye", "Ed"], fids: ["F7654321"] });
    // Right after __, and joined: the rules leave these, the check finds them.
    expect(s.leaks("tmp__hawk eye and hawkeye")).toEqual(["Hawk Eye"]);
    expect(s.leaks("f7654321")).toEqual(["F7654321"]);
    expect(s.leaks("mcp__ed-mcp__journal_status and ed_overlay")).toEqual([]);
    // A commander called Ed keeps ED Chat's own server names.
    expect(s.text('{"name":"ed_overlay"} ed_chat, CMDR Ed')).toBe(
      '{"name":"ed_overlay"} ed_chat, CMDR Jameson',
    );
  });

  it("does not raise a false alarm for a name inside other words or the placeholders", () => {
    for (const commander of ["Star", "James", "Player", "Nova"]) {
      const s = makeScrubber({ user: "seth", commander });
      const out = s.text(`turn/started innovation ${commander} seth`);
      expect(s.leaks(out)).toEqual([]);
    }
  });

  it("still finds a name that holds a placeholder, left where the rules skip it", () => {
    for (const commander of ["Jameson Smith", "Soloplayer"]) {
      const s = makeScrubber({ commander });
      expect(s.leaks(s.text(`tmp__${commander}`))).toEqual([commander]);
    }
  });

  it("does not replace a commander named like a word the recordings use, and says so", () => {
    for (const commander of ["User", "Owner", "System", "Home"]) {
      const s = makeScrubber({ commander });
      expect(s.text('{"type":"user"} /home/player')).toBe('{"type":"user"} /home/player');
      expect(s.unscrubbable).toEqual([commander]);
    }
    expect(makeScrubber({ commander: "Star" }).unscrubbable).toEqual([]);
  });

  it("leaves a user name that the recordings use as a word to the home folder rule", () => {
    const s = makeScrubber({ home: "C:\\Users\\User", user: "User" });
    expect(s.text('{"type":"user"} C:\\Users\\User\\x')).toBe('{"type":"user"} /home/player\\x');
  });

  it("does not scrub or report the placeholders themselves", () => {
    const s = makeScrubber({ commander: "Jameson", fid: "F0000000" });
    expect(s.leaks(s.text("hi Jameson F0000000"))).toEqual([]);
  });

  it("gives nothing for a missing folder", () => {
    expect(commanderFromJournal(path.join(os.tmpdir(), "no-such-journal-folder"))).toBeNull();
  });
});
