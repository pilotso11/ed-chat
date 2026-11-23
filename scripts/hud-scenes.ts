// Builds the activity panel for each scene in a scenes file, from the player's own journals, for
// the README screenshots. Each scene replays a journal up to a moment, through ed-mcp's journal
// reader as the app reads it, with the times moved to now so nothing reads as old or expired.
//
// Usage: npx tsx scripts/hud-scenes.ts docs/images/hud-scenes.json out/hud-scenes.json [journalDir]
// Then: npm run build && npx electron --force-device-scale-factor=2 scripts/hud-screenshots.cjs out/hud-scenes.json docs/images
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { openStores, type ActionInput, type Plan, type PlanStopInput } from "ed-mcp/journal";
import { HudFeed } from "../src/core/hud/feed.js";
import { buildHud, type HudView } from "../src/core/hud/hud.js";
import { KnownBodies, fetchSpansh } from "../src/core/hud/known.js";
import { HUD_EVENTS } from "../src/core/hud/mode.js";
import { SellPrices, postSpansh } from "../src/core/hud/sell.js";
import { SettingsSchema, type HudModeId } from "../src/core/settings.js";

export interface Scene {
  /** The PNG's name, without .png. */
  name: string;
  /** The journal file the moment is in; earlier journals are read too. */
  file: string;
  /** The moment, as the journal's own timestamp: events after it are left out. */
  until: string;
  /** The mode chosen with the hotkey; else the panel picks it as the app does. */
  mode?: HudModeId;
  /** Changes to the panel settings, as in settings.json. */
  settings?: Record<string, unknown>;
  /** Status.json: where the ship is on a body. */
  status?: Record<string, unknown>;
  /** Cargo.json: the hold, by journal name and tons. Older journals' Cargo events have no list. */
  cargo?: Record<string, number>;
  /**
   * A route plan, set as the activity note's plan. Its stops can carry actions, as ed-mcp 0.11.0
   * writes them. Times in it (started_at, a build's, an action's) are journal times, moved as the
   * journal's are.
   */
  plan?: {
    title: string;
    stops: PlanStopInput[];
    /** The activity note's kind: missions unless given; engineering for a build. */
    kind?: "missions" | "trading" | "engineering";
    repeat?: boolean;
    lap?: number;
    /** When the plan's actions count journal events from. */
    started_at?: string;
    /** A build plan's build. */
    build?: Plan["build"];
    /**
     * Gives each trade stop a buy or sale action for each cargo row, as trade_route and
     * trade_loops write them beside the cargo: on a loop's first lap, the first stop's sales get
     * none.
     */
    tradeActions?: boolean;
  };
  /** Surface bookmarks. */
  bookmarks?: PlanStopInput[];
  /** Earlier journal files to read, oldest dropped first. */
  history?: number;
}

// Every time in the journal's own form, such as timestamp, Expiry and DepartureTime, is moved.
const JOURNAL_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** A file's first line, without reading the rest. */
async function firstLine(file: string): Promise<string> {
  const stream = createReadStream(file, "utf8");
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line;
    return "";
  } finally {
    // Closing the lines leaves the file open: the stream is stopped too.
    lines.close();
    stream.destroy();
  }
}

/** Journal files, oldest first by their first event, so both name formats sort together. */
async function journals(dir: string): Promise<{ file: string; start: number }[]> {
  const names = (await readdir(dir)).filter((f) => /^Journal\.\d.*\.log$/.test(f));
  const list = await Promise.all(
    names.map(async (file) => {
      const first = await firstLine(path.join(dir, file));
      try {
        return { file, start: Date.parse((JSON.parse(first) as { timestamp: string }).timestamp) };
      } catch {
        return { file, start: Number.NaN };
      }
    }),
  );
  return list.filter((j) => !Number.isNaN(j.start)).sort((a, b) => a.start - b.start);
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A lower-case id part from a name, as ed-mcp's slug(): "Agri-Medicines" gives "agri-medicines". */
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";

/** The buy and sale actions ed-mcp's trade tools write for a stop's cargo (cargoAction()). */
function tradeActions(stop: PlanStopInput, firstLap: boolean): ActionInput[] {
  return (stop.cargo ?? [])
    .filter((c) => !(firstLap && c.action === "sell"))
    .map((c) => ({
      id: `${c.action}-${slug(c.commodity)}`,
      kind: c.action === "buy" ? "buy_commodity" : "sell_commodity",
      label: `${c.action === "buy" ? "Buy" : "Sell"} ${c.amount} t ${c.commodity}`,
      status: "todo",
      commodity: c.commodity,
      count: c.amount,
      ...(c.price !== undefined ? { price: c.price } : {}),
    }));
}

/** The scene's plan as it is saved: its times moved, and the trade actions added. */
function planStops(plan: NonNullable<Scene["plan"]>, move: (t: string) => string) {
  const firstLap = !!plan.repeat && (plan.lap ?? 1) === 1;
  return plan.stops.map((stop, i) => {
    const actions = [
      ...(plan.tradeActions && stop.kind === "trade"
        ? tradeActions(stop, firstLap && i === 0)
        : []),
      ...(stop.actions ?? []),
    ].map((a) => (a.started_at ? { ...a, started_at: move(a.started_at) } : a));
    return actions.length ? { ...stop, actions } : stop;
  });
}

async function scene(s: Scene, journalDir: string, all: { file: string; start: number }[]) {
  const at = all.findIndex((j) => j.file === s.file);
  if (at < 0) throw new Error(`${s.name}: no journal ${s.file}`);
  const cut = Date.parse(s.until);
  // A minute ago, so ed-mcp reads the journal as current.
  const shift = Date.now() - 60_000 - cut;
  const move = (t: string) => (JOURNAL_TIME.test(t) ? iso(Date.parse(t) + shift) : t);
  const dir = await mkdtemp(path.join(os.tmpdir(), "edchat-scene-"));
  const sync = await mkdtemp(path.join(os.tmpdir(), "edchat-scene-sync-"));
  try {
    for (const j of all.slice(Math.max(0, at - (s.history ?? 2)), at + 1)) {
      const lines = (await readFile(path.join(journalDir, j.file), "utf8"))
        .split("\n")
        .filter(Boolean)
        // A line cut off, as the game leaves one mid-write, is skipped as the reader skips it.
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
        .filter((e) => Date.parse(String(e.timestamp)) <= cut);
      for (const e of lines)
        for (const [f, v] of Object.entries(e))
          if (typeof v === "string" && JOURNAL_TIME.test(v)) e[f] = iso(Date.parse(v) + shift);
      // ed-mcp finds the newest journal by its name, read as UTC.
      const stamp = iso(j.start + shift)
        .slice(0, 19)
        .replace(/:/g, "");
      await writeFile(
        path.join(dir, `Journal.${stamp}.01.log`),
        lines.map((e) => JSON.stringify(e) + "\n").join(""),
      );
    }
    if (s.status)
      await writeFile(
        path.join(dir, "Status.json"),
        JSON.stringify({ timestamp: iso(Date.now()), event: "Status", ...s.status }),
      );
    if (s.cargo)
      await writeFile(
        path.join(dir, "Cargo.json"),
        JSON.stringify({
          timestamp: iso(Date.now()),
          event: "Cargo",
          Vessel: "Ship",
          Count: Object.values(s.cargo).reduce((a, b) => a + b, 0),
          Inventory: Object.entries(s.cargo).map(([Name, Count]) => ({ Name, Count, Stolen: 0 })),
        }),
      );
    const stores = openStores({ ED_JOURNAL_DIR: dir, ED_MCP_SYNC_DIR: sync }, { keep: HUD_EVENTS });
    if (s.plan) {
      const build = s.plan.build;
      const plan = await stores.plans.upsert({
        id: "route",
        name: s.plan.title,
        stops: planStops(s.plan, move),
        ...(s.plan.repeat ? { repeat: true, lap: s.plan.lap ?? 1 } : {}),
        ...(s.plan.started_at ? { started_at: move(s.plan.started_at) } : {}),
        ...(build
          ? {
              build: {
                ...build,
                ...(build.started_at ? { started_at: move(build.started_at) } : {}),
              },
            }
          : {}),
      });
      await stores.activity.set({
        kind: s.plan.kind ?? "missions",
        summary: s.plan.title,
        plan_id: plan.id,
      });
    }
    for (const b of s.bookmarks ?? []) await stores.plans.addStop("bookmarks", "Bookmarks", b);
    const errors: string[] = [];
    const feed = new HudFeed(stores, dir, {
      onError: (w, m) => errors.push(`${w}: ${m}`),
      known: new KnownBodies(fetchSpansh, { onError: (m) => errors.push(`spansh: ${m}`) }),
    });
    const sell = new SellPrices(postSpansh, { onError: (m) => errors.push(`prices: ${m}`) });
    // Read as settings.json is, so a scene can change one field of a group.
    const settings = SettingsSchema.parse({ hud: s.settings ?? {} }).hud;
    const build = async (): Promise<HudView> => {
      const data = await feed.poll();
      return buildHud(
        {
          ...data,
          hotkey: s.mode ? { mode: s.mode, at: Date.now() } : null,
          settings,
          sell: (q) => sell.get(q),
          now: Date.now(),
        },
        null,
      );
    };
    await build();
    // Spansh's planets and prices load after the first poll asks for them.
    await settle(8_000);
    const view = await build();
    if (errors.length) console.error(s.name, errors);
    return view;
  } finally {
    // A file still open on Windows can stop this: the temp folders are left, not the run.
    for (const d of [dir, sync])
      await rm(d, { recursive: true, force: true }).catch((err: unknown) =>
        console.error(`could not remove ${d}: ${String(err)}`),
      );
  }
}

const [scenesFile, outFile, journalDir = defaultJournalDir()] = process.argv.slice(2);
function defaultJournalDir(): string {
  return path.join(os.homedir(), "Saved Games", "Frontier Developments", "Elite Dangerous");
}
if (!scenesFile || !outFile) {
  console.error("usage: tsx scripts/hud-scenes.ts <scenes.json> <out.json> [journalDir]");
  process.exit(1);
}
const scenes = JSON.parse(await readFile(scenesFile, "utf8")) as Scene[];
const only = process.env.SCENE;
const all = await journals(journalDir);
const out: { name: string; view: HudView }[] = [];
for (const s of scenes) {
  if (only && s.name !== only) continue;
  const view = await scene(s, journalDir, all);
  out.push({ name: s.name, view });
  console.log(`${s.name}:`, JSON.stringify(view.panel, null, 1), JSON.stringify(view.route));
}
await writeFile(outFile, JSON.stringify(out, null, 2));
