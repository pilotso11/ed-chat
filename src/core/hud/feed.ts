import { readFile } from "node:fs/promises";
import path from "node:path";
import { systemAddress, type JournalEvent, type Stores } from "ed-mcp/journal";
import type { HudInput } from "./hud.js";
import { parseShipStatus } from "./hud.js";
import type { KnownBodies } from "./known.js";
import { navRouteCleared, parseNavRoute, sampleKey, type Point } from "./panels.js";

export type FeedData = Pick<
  HudInput,
  "journal" | "status" | "nav" | "activity" | "plan" | "samples" | "known"
>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Reads what the panel shows: the journal through ed-mcp, Status.json and NavRoute.json from the
 * journal folder, and the activity note and its plan. It also notes where each bio sample was
 * taken, from the ship's position when the sample appears, since the journal does not say.
 */
export class HudFeed {
  readonly samples = new Map<string, Point[]>();
  private seen = new Set<string>();
  private primed = false;
  private lastError: string | null = null;

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
    const [journal, statusText, navText, activity] = await Promise.all([
      this.stores.journal.state().catch((err: unknown) => (this.error("journal", err), null)),
      this.read("Status.json"),
      this.read("NavRoute.json"),
      this.stores.activity.get().catch((err: unknown) => (this.error("activity", err), null)),
    ]);
    const status = statusText ? parseShipStatus(statusText) : null;
    let plan = null;
    if (activity?.plan_id) {
      plan = await this.stores.plans
        .get(activity.plan_id)
        .catch((err: unknown) => (this.error("plan", err), null));
    }
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
    };
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
