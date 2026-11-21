import { num, type Obj } from "./json.js";
import { spanshJson } from "./known.js";

/** A station that buys a commodity, from a Spansh station search. */
export interface SellHit {
  station: string;
  system: string;
  distanceLy: number;
  arrivalLs: number | null;
  price: number;
  demand: number | null;
  largePad: boolean;
  mediumPad: boolean;
  carrier: boolean;
  marketId: number | null;
  /** ISO time of the market data. */
  updatedAt: string | null;
}

export interface SellQuery {
  /** The system to search around: where the ship is, or the carrier. */
  near: string;
  /** The English commodity name, as Spansh spells it. */
  commodity: string;
  radiusLy: number;
  /** The pad the ship needs: only stations with one; null for any. */
  pad: "L" | "M" | "S" | null;
  /** Include other players' fleet carriers. */
  carriers: boolean;
  maxAgeDays: number;
}

const CARRIER_TYPE = "Drake-Class Carrier";
// Spansh has no "not" filter, so carriers are left out by listing every other type. Near busy
// systems most market records are carriers, so dropping them after the search would leave few.
// From GET /api/stations/field_values/type (2026-10-14), the same list as ed-mcp's fallback.
// A type Spansh adds later is left out of the search until it is added here.
const NON_CARRIER_TYPES = [
  "Asteroid base",
  "Coriolis Starport",
  "Dockable Planet Station",
  "Dodec Starport",
  "Mega ship",
  "Ocellus Starport",
  "Orbis Starport",
  "Outpost",
  "Planetary Construction Depot",
  "Planetary Outpost",
  "Planetary Port",
  "Settlement",
  "Space Construction Depot",
  "Surface Settlement",
];

const PAGE = 25;

/** The Spansh station search for the best sale prices of a commodity near a system. */
export function sellSearchBody(q: SellQuery, now: number): unknown {
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const range = (min: number) => ({ comparison: "<=>", value: [min, 1_000_000_000] });
  const filters: Record<string, unknown> = {
    distance: { min: 0, max: q.radiusLy },
    market_updated_at: {
      comparison: "<=>",
      value: [iso(now - q.maxAgeDays * 86_400_000), iso(now)],
    },
    market: [{ name: q.commodity, sell_price: range(1), demand: range(1) }],
  };
  if (q.pad === "L") filters.has_large_pad = { value: true };
  // A medium ship can use a large pad too, but stations with large pads and no medium are rare.
  if (q.pad === "M") filters.medium_pads = { comparison: "<=>", value: [1, 1000] };
  if (!q.carriers) filters.type = { value: NON_CARRIER_TYPES };
  return {
    filters,
    sort: [{ market_sell_price: [{ name: q.commodity, direction: "desc" }] }],
    size: PAGE,
    page: 0,
    reference_system: q.near,
  };
}

/** The stations in a Spansh search result that buy the commodity. */
export function parseSellHits(json: unknown, commodity: string): SellHit[] {
  const results = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const want = commodity.toLowerCase();
  const out: SellHit[] = [];
  for (const s of results as Obj[]) {
    if (typeof s?.name !== "string" || typeof s.system_name !== "string") continue;
    const row = (Array.isArray(s.market) ? (s.market as Obj[]) : []).find(
      (m) => typeof m?.commodity === "string" && m.commodity.toLowerCase() === want,
    );
    const price = num(row?.sell_price);
    const distance = num(s.distance);
    // Without a distance the station could be anywhere: it cannot be ranked as near.
    if (price === null || price <= 0 || distance === null) continue;
    out.push({
      station: s.name,
      system: s.system_name,
      distanceLy: distance,
      arrivalLs: num(s.distance_to_arrival),
      price,
      demand: num(row?.demand),
      largePad: s.has_large_pad === true || (num(s.large_pads) ?? 0) > 0,
      mediumPad: (num(s.medium_pads) ?? 0) > 0,
      carrier: s.type === CARRIER_TYPE,
      marketId: num(s.market_id),
      updatedAt: typeof s.market_updated_at === "string" ? s.market_updated_at : null,
    });
  }
  return out;
}

const KEEP = 50;
const FRESH_MS = 30 * 60_000;
const RETRY_MS = 5 * 60_000;

/** Stations that buy, or why there are none to show yet. */
export type SellLookup = SellHit[] | "pending" | "failed";

/**
 * Sale prices from Spansh, searched once per query when first asked for and kept for half an
 * hour. get() returns "pending" until the first search is done, and "failed" when it failed.
 */
export class SellPrices {
  private readonly cache = new Map<string, { at: number; hits: SellHit[] }>();
  private readonly failed = new Map<string, number>();
  private readonly pending = new Set<string>();

  constructor(
    private readonly post: (url: string, body: unknown) => Promise<unknown>,
    private readonly opts: { now?: () => number; onError?: (m: string) => void } = {},
  ) {}

  get(q: SellQuery): SellLookup {
    const now = (this.opts.now ?? Date.now)();
    const key = JSON.stringify(q);
    const cached = this.cache.get(key);
    const failedAt = this.failed.get(key);
    const stale = !cached || now - cached.at > FRESH_MS;
    const mayRetry = failedAt === undefined || now - failedAt > RETRY_MS;
    if (stale && mayRetry && !this.pending.has(key)) {
      this.pending.add(key);
      void this.post("https://spansh.co.uk/api/stations/search", sellSearchBody(q, now))
        .then((j) => {
          this.cache.delete(key);
          this.cache.set(key, { at: now, hits: parseSellHits(j, q.commodity) });
          this.failed.delete(key);
          while (this.cache.size > KEEP) this.cache.delete(this.cache.keys().next().value!);
        })
        .catch((err: unknown) => {
          this.failed.delete(key);
          this.failed.set(key, now);
          while (this.failed.size > KEEP) this.failed.delete(this.failed.keys().next().value!);
          this.opts.onError?.(err instanceof Error ? err.message : String(err));
        })
        .finally(() => this.pending.delete(key));
    }
    // Older prices are still shown while new ones load.
    if (cached) return cached.hits;
    return failedAt !== undefined && !this.pending.has(key) ? "failed" : "pending";
  }
}

/** POST as JSON to Spansh. */
export function postSpansh(url: string, body: unknown): Promise<unknown> {
  // A station search can take longer than a system dump.
  return spanshJson(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    20_000,
  );
}
