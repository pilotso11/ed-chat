import { readFile } from "node:fs/promises";
import path from "node:path";
import { systemAddress, type JournalEvent, type Plan, type Stores } from "ed-mcp/journal";
import { parseOutfitting, type Outfitting } from "./build.js";
import type { HudInput } from "./hud.js";
import { parseShipStatus, type ShipStatus } from "./hud.js";
import { BOOKMARKS_PLAN, isPlanNotFound } from "./bookmarks.js";
import type { KnownBodies } from "./known.js";
import { navRouteCleared, parseNavRoute, sampleKey, type Point } from "./panels.js";
import { parseMarket, type Market } from "./trade.js";

export type FeedData = Pick<
  HudInput,
  | "journal"
  | "status"
  | "nav"
  | "activity"
  | "plan"
  | "samples"
  | "known"
  | "bookmarks"
  | "market"
  | "buildPlans"
  | "outfitting"
>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Reads what the panel shows: the journal through ed-mcp, Status.json, NavRoute.json and
 * Market.json from the journal folder, and the activity note and its plan. It also notes where each bio sample was
 * taken, from the ship's position when the sample appears, since the journal does not say.
 */
export class HudFeed {
  readonly samples = new Map<string, Point[]>();
  private seen = new Set<string>();
  private primed = false;
  private lastError: string | null = null;
  /** Market.json as last parsed: it changes only when a market screen opens. */
  private market: { text: string; parsed: Market | null } | null = null;
  private outfitting: { text: string; parsed: Outfitting | null } | null = null;
  /** Build plans as last read, by ID: read again only when the plan list says one changed. */
  private builds = new Map<string, { updated: string; plan: Plan }>();

  constructor(
    private readonly stores: Pick<Stores, "journal" | "activity" | "plans">,
    private readonly journalDir: string,
    private readonly opts: {
      read?: (file: string) => Promise<string>;
      onError?: (what: string, message: string) => void;
      /** Spansh's planets for the current system; none when the lookup is off. */
      known?: KnownBodies;
    } = {},
  ) {}

  /** Status.json as it is now, for a key press that must not use the last poll's position. */
  async readStatus(): Promise<ShipStatus | null> {
    // The game rewrites the file several times a second: a read caught mid-write is tried again.
    for (let tries = 0; tries < 3; tries++) {
      const text = await this.read("Status.json");
      const status = text ? parseShipStatus(text) : null;
      if (status) return status;
      if (tries < 2) await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  private read(name: string): Promise<string | null> {
    const read = this.opts.read ?? ((f: string) => readFile(f, "utf8"));
    return read(path.join(this.journalDir, name)).catch(() => null);
  }

  private error(what: string, err: unknown): void {
    const m = `${what}: ${message(err)}`;
    // Logged once per new problem: the feed polls every second.
    if (m !== this.lastError) this.opts.onError?.(what, message(err));
    this.lastError = m;
  }

  async poll(): Promise<FeedData> {
    const [journal, statusText, navText, marketText, outfittingText, activity] = await Promise.all([
      this.stores.journal.state().catch((err: unknown) => (this.error("journal", err), null)),
      this.read("Status.json"),
      this.read("NavRoute.json"),
      this.read("Market.json"),
      this.read("Outfitting.json"),
      this.stores.activity.get().catch((err: unknown) => (this.error("activity", err), null)),
    ]);
    const status = statusText ? parseShipStatus(statusText) : null;
    // Read together; no bookmarks plan is the usual case, not an error.
    const [plan, bookmarks, buildPlans] = await Promise.all([
      activity?.plan_id
        ? this.stores.plans
            .get(activity.plan_id)
            .catch((err: unknown) => (this.error("plan", err), null))
        : null,
      this.stores.plans
        .get(BOOKMARKS_PLAN)
        .catch((err: unknown) =>
          isPlanNotFound(err) ? null : (this.error("bookmarks", err), null),
        ),
      this.buildPlans().catch((err: unknown) => (this.error("build plans", err), [])),
    ]);
    if (journal) this.noteSamples(journal.events, status);
    const system = journal?.location.system ?? null;
    const address = journal && system ? systemAddress(journal.events, system) : null;
    const known = address !== null ? (this.opts.known?.get(address) ?? null) : null;
    return {
      journal,
      status,
      nav: navText && !(journal && navRouteCleared(journal.events)) ? parseNavRoute(navText) : null,
      activity,
      plan,
      samples: this.samples,
      known,
      bookmarks,
      market: marketText ? this.parseMarket(marketText) : null,
      buildPlans,
      outfitting: outfittingText ? this.parseOutfitting(outfittingText) : null,
    };
  }

  /**
   * The build plans with an action still to do: docking at one of their stops or acting on one
   * shows it, whatever plan the note names. A plan is read again only when it changed.
   */
  private async buildPlans(): Promise<Plan[]> {
    const list = await this.stores.plans.list();
    const open = list.filter((p) => (p.actions ?? 0) > (p.actions_done ?? 0));
    const out: Plan[] = [];
    const keep = new Set<string>();
    for (const p of open) {
      keep.add(p.id);
      const kept = this.builds.get(p.id);
      if (kept && kept.updated === p.updated_at) {
        out.push(kept.plan);
        continue;
      }
      const plan = await this.stores.plans.get(p.id).catch((err: unknown) => {
        // Deleted since the list: not an error.
        if (!isPlanNotFound(err)) this.error("build plan", err);
        return null;
      });
      if (!plan) continue;
      this.builds.set(p.id, { updated: plan.updated_at, plan });
      out.push(plan);
    }
    for (const id of this.builds.keys()) if (!keep.has(id)) this.builds.delete(id);
    return out;
  }

  private parseOutfitting(text: string): Outfitting | null {
    if (this.outfitting?.text !== text) this.outfitting = { text, parsed: parseOutfitting(text) };
    return this.outfitting.parsed;
  }

  private parseMarket(text: string): Market | null {
    if (this.market?.text !== text) this.market = { text, parsed: parseMarket(text) };
    return this.market.parsed;
  }

  private noteSamples(events: JournalEvent[], status: FeedData["status"]): void {
    for (const e of events) {
      if (e.event !== "ScanOrganic") continue;
      const id = `${e.timestamp}|${String(e.Species)}|${e.ScanType}`;
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      // Samples from before ED Chat started have no known position.
      if (!this.primed) continue;
      const body = typeof e.Body === "number" ? e.Body : null;
      const species = typeof e.Species_Localised === "string" ? e.Species_Localised : null;
      if (body === null || !species) continue;
      const address = typeof e.SystemAddress === "number" ? e.SystemAddress : null;
      const key = sampleKey(address, body, species);
      if (e.ScanType === "Log") this.samples.set(key, []);
      if (e.ScanType === "Analyse") {
        this.samples.delete(key);
        continue;
      }
      if (status?.latitude == null || status.longitude == null) continue;
      const list = this.samples.get(key) ?? [];
      list.push({ latitude: status.latitude, longitude: status.longitude });
      this.samples.set(key, list);
    }
    this.primed = true;
  }
}
