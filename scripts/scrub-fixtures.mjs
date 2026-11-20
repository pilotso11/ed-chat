// Removes personal data from recorded CLI fixtures: home paths, the user name, the commander
// name and FID, and the lists of the recorder's MCP servers, plugins, skills and commands.
// Claude fixtures are in test/fixtures/stream, Codex fixtures (recorded with codex-probe.mjs) in
// test/fixtures/codex. Codex's account/* and remoteControl/* lines are removed. Thread and turn
// ids stay as they are. Safe to run more than once.
// The commander name comes from --commander, else ED_COMMANDER, else the newest game journal.
// Usage: node scripts/scrub-fixtures.mjs [--commander <name>]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PRIVATE_INIT_KEYS = [
  "memory_paths",
  "plugins",
  "skills",
  "agents",
  "slash_commands",
  "messaging_socket_path",
  "apiKeySource",
];
const keepTool = (t) => !t.startsWith("mcp__") || /^mcp__(ed-mcp|ed_chat|ed_overlay)__/.test(t);
const keepServer = (s) => /^(ed-mcp|ed_chat|ed_overlay)$/.test(s.name);
// Codex methods that carry the account, its plan and its devices.
const PRIVATE_METHOD = /^(account|remoteControl)\//;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A run of slashes or backslashes: one path separator in any spelling, JSON-escaped or not.
const SEP = "(?:\\\\+|/)+";

/**
 * A scrubber for one recorder: `text` scrubs a string, `json` every string and key in a value.
 * The home folder matches with either slash and any escaping, in any case (Windows paths).
 */
export function makeScrubber({ home, user, commander, fid, commanders = [], fids = [] }) {
  const rules = [];
  const parts = home ? home.split(/[\\/]+/).filter(Boolean) : [];
  if (parts.length) {
    const lead = /^[\\/]/.test(home) ? SEP : "";
    rules.push([new RegExp(lead + parts.map(escapeRe).join(SEP), "gi"), "/home/player"]);
  }
  // Whole words only, so a short name does not eat parts of other words. A letter after a
  // backslash is an escape (\n in JSON text), not part of the word. ed-mcp's tool names
  // (mcp__ed-mcp__…) are not a name either.
  const word = (s) =>
    new RegExp(
      `(?<!__)(?<!(?<!\\\\)[\\p{L}\\p{N}])${s.trim().split(/\s+/).map(escapeRe).join("\\s+")}(?![\\p{L}\\p{N}])(?!-mcp)`,
      "giu",
    );
  // Every commander the player has: a machine with two game accounts records either.
  const names = [...new Set([commander, ...commanders].filter(Boolean))];
  for (const name of names) rules.push([word(name), "Jameson"]);
  for (const f of new Set([fid, ...fids].filter(Boolean)))
    rules.push([new RegExp(escapeRe(f), "g"), "F0000000"]);
  if (user) rules.push([word(user), "player"]);
  /** What of the names and FIDs is still in the text, to check the result. */
  const leaks = (s) => [
    ...names.filter((n) => word(n).test(s)),
    ...[fid, ...fids].filter((f) => f && s.includes(f)),
  ];
  const text = (s) => rules.reduce((acc, [re, to]) => acc.replace(re, to), s);
  const json = (v) => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(json);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), json(x)]));
    }
    return v;
  };
  return { text, json, leaks };
}

/** Scrubs one parsed line of a Claude stream-json recording. */
export function scrubClaudeLine(j, scrub) {
  if (j.type === "system" && j.subtype === "init") {
    for (const k of PRIVATE_INIT_KEYS) delete j[k];
    if (Array.isArray(j.tools)) j.tools = j.tools.filter(keepTool);
    if (Array.isArray(j.mcp_servers)) j.mcp_servers = j.mcp_servers.filter(keepServer);
  }
  if (j.type === "system" && /^hook_/.test(j.subtype ?? "")) {
    for (const k of Object.keys(j))
      if (!["type", "subtype", "session_id", "uuid"].includes(k)) delete j[k];
  }
  if (j.type === "system" && j.subtype === "commands_changed") j.commands = [];
  return scrub.json(j);
}

/**
 * Scrubs the lines of a Codex recording. codex-probe.mjs writes `>> ` before what it sent and
 * `<< ` before what Codex sent; plain JSON lines work too. A line that is not JSON (a spawn
 * error) is scrubbed as text. An account/* or remoteControl/* message is removed, and so is the
 * answer to it: the answer has the request's id and comes the other way.
 */
export function scrubCodexLines(lines, scrub) {
  const answersToDrop = { ">>": new Set(), "<<": new Set(), "": new Set() };
  const out = [];
  for (const line of lines) {
    const m = /^(>>|<<) (.*)$/s.exec(line);
    const dir = m ? m[1] : "";
    const body = m ? m[2] : line;
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      out.push(scrub.text(line));
      continue;
    }
    if (j && typeof j === "object" && !Array.isArray(j)) {
      if (typeof j.method === "string" && PRIVATE_METHOD.test(j.method)) {
        if (j.id !== undefined) answersToDrop[{ ">>": "<<", "<<": ">>", "": "" }[dir]].add(j.id);
        continue;
      }
      if (j.method === undefined && answersToDrop[dir].delete(j.id)) continue;
    }
    out.push((m ? dir + " " : "") + JSON.stringify(scrub.json(j)));
  }
  return out;
}

/** The commander's name and FID from the newest game journals in `dir`, or nothing. */
export function commanderFromJournal(dir) {
  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => /^Journal\..*\.log$/.test(f))
      .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 5);
  } catch {
    return null;
  }
  for (const { f } of files) {
    for (const line of readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!/"event":\s*"(Commander|LoadGame)"/.test(line)) continue;
      try {
        const e = JSON.parse(line);
        const name = e.event === "Commander" ? e.Name : e.Commander;
        if (typeof name === "string" && name) return { name, fid: e.FID };
      } catch {
        // A line cut short while the game wrote it.
      }
    }
  }
  return null;
}

/**
 * Every commander in the journals, with the FID: one game account or several. A journal names
 * its commander in the first lines, so only those are read.
 */
export function commandersFromJournals(dir) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^Journal\..*\.log$/.test(f));
  } catch {
    return [];
  }
  const found = new Map();
  for (const f of files) {
    let head;
    try {
      head = readFileSync(path.join(dir, f), "utf8").split("\n", 30);
    } catch {
      continue;
    }
    for (const line of head) {
      if (!/"event":\s*"(Commander|LoadGame)"/.test(line)) continue;
      try {
        const e = JSON.parse(line);
        const name = e.event === "Commander" ? e.Name : e.Commander;
        if (typeof name === "string" && name) {
          const key = name.trim().toLowerCase();
          const fid = typeof e.FID === "string" ? e.FID : found.get(key)?.fid;
          found.set(key, { name, fid });
        }
      } catch {
        // A line cut short while the game wrote it.
      }
    }
  }
  return [...found.values()];
}

const sameName = (a, b) =>
  a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

function main(argv) {
  const at = argv.indexOf("--commander");
  const journal = path.join(
    os.homedir(),
    "Saved Games",
    "Frontier Developments",
    "Elite Dangerous",
  );
  const fromJournal = commanderFromJournal(journal);
  // Every commander in the journals: the fixtures may have been recorded with any of them.
  const all = commandersFromJournals(journal);
  const commander = (at >= 0 ? argv[at + 1] : process.env.ED_COMMANDER) || fromJournal?.name;
  // Without it the commander's name and FID would stay in the fixtures: nothing is written.
  if (!commander) {
    console.error("No commander name: pass --commander <name>, or set ED_COMMANDER.");
    process.exit(1);
  }
  const home = os.homedir();
  const scrub = makeScrubber({
    home,
    user: path.basename(home),
    commander,
    // The journal's FID is this commander's when the names match, in any case or spacing.
    fid: fromJournal && sameName(fromJournal.name, commander) ? fromJournal.fid : undefined,
    commanders: all.map((c) => c.name),
    fids: all.flatMap((c) => (c.fid ? [c.fid] : [])),
  });
  let leaked = false;
  const fixtures = path.join(import.meta.dirname, "..", "test", "fixtures");
  for (const [sub, scrubLines] of [
    ["stream", (lines) => lines.map((l) => JSON.stringify(scrubClaudeLine(JSON.parse(l), scrub)))],
    ["codex", (lines) => scrubCodexLines(lines, scrub)],
  ]) {
    const dir = path.join(fixtures, sub);
    for (const name of readdirSync(dir).filter((f) => f.startsWith("recorded-"))) {
      const file = path.join(dir, name);
      const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
      const out = scrubLines(lines).join("\n") + "\n";
      writeFileSync(file, out);
      // A name or FID still there, in a spelling the rules missed, must not pass as scrubbed.
      const left = scrub.leaks(out);
      if (left.length) {
        leaked = true;
        console.error(`NOT CLEAN ${sub}/${name}: still holds ${left.length} name(s) or FID(s)`);
      } else console.log(`scrubbed ${sub}/${name}`);
    }
  }
  if (leaked) process.exit(1);
}

// Run as a script, not when a test imports it. Windows paths differ in case only.
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
if (process.argv[1] && same(path.resolve(process.argv[1]), import.meta.filename ?? "")) {
  main(process.argv.slice(2));
}
