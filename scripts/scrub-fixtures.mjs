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
export function makeScrubber({ home, user, commander, fid }) {
  const rules = [];
  const parts = home ? home.split(/[\\/]+/).filter(Boolean) : [];
  if (parts.length) {
    const lead = /^[\\/]/.test(home) ? SEP : "";
    rules.push([new RegExp(lead + parts.map(escapeRe).join(SEP), "gi"), "/home/player"]);
  }
  // A whole word only: a short name must not eat parts of other words.
  if (commander) {
    const name = commander.trim().split(/\s+/).map(escapeRe).join("\\s+");
    rules.push([new RegExp(`(?<![\\p{L}\\p{N}])${name}(?![\\p{L}\\p{N}])`, "giu"), "Jameson"]);
  }
  if (fid) rules.push([new RegExp(escapeRe(fid), "g"), "F0000000"]);
  if (user) rules.push([new RegExp(escapeRe(user), "gi"), "player"]);
  const text = (s) => rules.reduce((acc, [re, to]) => acc.replace(re, to), s);
  const json = (v) => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(json);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), json(x)]));
    }
    return v;
  };
  return { text, json };
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

function main(argv) {
  const at = argv.indexOf("--commander");
  const journal = path.join(
    os.homedir(),
    "Saved Games",
    "Frontier Developments",
    "Elite Dangerous",
  );
  const fromJournal = commanderFromJournal(journal);
  const commander = (at >= 0 ? argv[at + 1] : process.env.ED_COMMANDER) || fromJournal?.name;
  if (!commander) {
    console.error("No commander name (--commander, ED_COMMANDER or a journal): check by hand.");
  }
  const home = os.homedir();
  const scrub = makeScrubber({
    home,
    user: path.basename(home),
    commander,
    fid: fromJournal?.name === commander ? fromJournal?.fid : undefined,
  });
  const fixtures = path.join(import.meta.dirname, "..", "test", "fixtures");
  for (const [sub, scrubLines] of [
    ["stream", (lines) => lines.map((l) => JSON.stringify(scrubClaudeLine(JSON.parse(l), scrub)))],
    ["codex", (lines) => scrubCodexLines(lines, scrub)],
  ]) {
    const dir = path.join(fixtures, sub);
    for (const name of readdirSync(dir).filter((f) => f.startsWith("recorded-"))) {
      const file = path.join(dir, name);
      const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
      writeFileSync(file, scrubLines(lines).join("\n") + "\n");
      console.log(`scrubbed ${sub}/${name}`);
    }
  }
}

// Run as a script, not when a test imports it. Windows paths differ in case only.
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
if (process.argv[1] && same(path.resolve(process.argv[1]), import.meta.filename ?? "")) {
  main(process.argv.slice(2));
}
