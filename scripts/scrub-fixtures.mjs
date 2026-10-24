// Removes personal data from recorded CLI fixtures: home paths, the user name, and the lists
// of the recorder's MCP servers, plugins, skills and commands. Safe to run more than once.
// Usage: node scripts/scrub-fixtures.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.join(import.meta.dirname, "..", "test", "fixtures", "stream");
const home = os.homedir();
const user = path.basename(home);
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

function scrubStrings(v) {
  if (typeof v === "string") return v.split(home).join("/home/player").split(user).join("player");
  if (Array.isArray(v)) return v.map(scrubStrings);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubStrings(x)]));
  }
  return v;
}

function scrubLine(j) {
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
  return scrubStrings(j);
}

for (const name of readdirSync(dir).filter((f) => f.startsWith("recorded-"))) {
  const file = path.join(dir, name);
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const out = lines.map((l) => JSON.stringify(scrubLine(JSON.parse(l))));
  writeFileSync(file, out.join("\n") + "\n");
  console.log(`scrubbed ${name}`);
}
