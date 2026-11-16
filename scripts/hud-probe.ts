// Prints the activity panel for the current journal, for debugging: npx tsx scripts/hud-probe.ts
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { openStores } from "ed-mcp/journal";
import { edMcpSyncDir } from "../src/core/hud/edMcpConfig.js";
import { HudFeed } from "../src/core/hud/feed.js";
import { KnownBodies, fetchSpansh } from "../src/core/hud/known.js";
import { buildHud, currentMode } from "../src/core/hud/hud.js";
import { HUD_EVENTS } from "../src/core/hud/mode.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

const journalDir = path.join(
  os.homedir(),
  "Saved Games",
  "Frontier Developments",
  "Elite Dangerous",
);
const sync = edMcpSyncDir(
  await readFile(path.join(os.homedir(), ".claude.json"), "utf8").catch(() => ""),
);
const stores = openStores(
  { ED_JOURNAL_DIR: journalDir, ED_MCP_SYNC_DIR: sync ?? undefined },
  { keep: HUD_EVENTS },
);
const feed = new HudFeed(stores, journalDir, {
  onError: (w, m) => console.error(w, m),
  known: new KnownBodies(fetchSpansh, { onError: (m) => console.error("spansh", m) }),
});
await feed.poll();
// The Spansh lookup starts on the first poll and lands before the second.
await new Promise((r) => setTimeout(r, 3000));
const data = await feed.poll();
const input = { ...data, hotkey: null, settings: DEFAULT_SETTINGS.hud, now: Date.now() };
console.log("system:", data.journal?.location.system, "| status body:", data.status?.body);
console.log("mode:", currentMode(input));
console.log(JSON.stringify(buildHud(input, null), null, 2));
