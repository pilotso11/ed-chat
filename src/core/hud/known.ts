import type { BioConditions } from "ed-mcp/journal";

/** A planet in the current system as Spansh knows it, before the player scans it. */
export interface KnownBody {
  name: string;
  bodyId: number;
  /** The planet class, in the journal's spelling where it differs. */
  type: string | null;
  terraformable: boolean;
  /** In Earth masses, for the planet's value. */
  massEM: number | null;
  distance_ls: number | null;
  /** Biological signals, and their genus journal keys when the surface was mapped. */
  bioSignals: number;
  genera: string[];
  /** The planet's conditions for the species predictor; the system address is added on use. */
  conditions: Omit<BioConditions, "systemAddress">;
}

// Spansh spells some planet classes differently from the journal.
const JOURNAL_TYPE: Record<string, string> = {
  "Earth-like world": "Earthlike body",
  "High metal content world": "High metal content body",
  "Metal-rich body": "Metal rich body",
  "Rocky Ice world": "Rocky ice body",
};

/** Earth-like, water and ammonia worlds, and terraformable planets: worth calling out. */
export function isHighlight(type: string | null, terraformable: boolean): boolean {
  return terraformable || /^(earthlike body|water world|ammonia world)$/i.test(type ?? "");
}

type Obj = Record<string, unknown>;

function bioOf(v: unknown): { bioSignals: number; genera: string[] } {
  const s = (v ?? {}) as { signals?: Record<string, unknown>; genuses?: unknown };
  const n = s.signals?.["$SAA_SignalType_Biological;"];
  const genera = Array.isArray(s.genuses)
    ? s.genuses.filter((g): g is string => typeof g === "string")
    : [];
  return { bioSignals: typeof n === "number" ? n : 0, genera };
}

function parentStar(parents: unknown, stars: Map<number, string>): string | null {
  if (!Array.isArray(parents)) return null;
  for (const p of parents as Obj[]) {
    const id = p?.Star;
    if (typeof id === "number" && stars.has(id)) return stars.get(id)!;
  }
  return null;
}

/** The planets in a Spansh system dump. */
export function parseSpanshDump(json: unknown): KnownBody[] {
  const j = (json ?? {}) as { system?: { bodies?: unknown }; bodies?: unknown };
  const raw = j.system?.bodies ?? j.bodies;
  if (!Array.isArray(raw)) return [];
  const out: KnownBody[] = [];
  // Star classes by body ID, for each planet's parent star.
  const stars = new Map<number, string>();
  let mainStar: string | null = null;
  for (const b of raw as Obj[]) {
    if (b?.type !== "Star" || typeof b.bodyId !== "number" || typeof b.subType !== "string")
      continue;
    stars.set(b.bodyId, b.subType);
    if (b.mainStar === true) mainStar = b.subType;
  }
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  for (const b of raw as Obj[]) {
    if (b?.type !== "Planet" || typeof b.name !== "string" || typeof b.bodyId !== "number") {
      continue;
    }
    const sub = typeof b.subType === "string" ? b.subType : null;
    out.push({
      name: b.name,
      bodyId: b.bodyId,
      type: sub ? (JOURNAL_TYPE[sub] ?? sub) : null,
      terraformable:
        b.terraformingState === "Terraformable" || b.terraformingState === "Terraforming",
      massEM: n(b.earthMasses),
      distance_ls: typeof b.distanceToArrival === "number" ? b.distanceToArrival : null,
      ...bioOf(b.signals),
      conditions: {
        planet: sub ? (JOURNAL_TYPE[sub] ?? sub) : null,
        atmosphere: typeof b.atmosphereType === "string" ? b.atmosphereType : "None",
        temperature: n(b.surfaceTemperature),
        gravity: n(b.gravity),
        pressure: n(b.surfacePressure),
        volcanism: typeof b.volcanismType === "string" ? b.volcanismType : null,
        star: parentStar(b.parents, stars) ?? mainStar,
      },
    });
  }
  return out;
}

const KEEP = 50;
const RETRY_MS = 5 * 60_000;

/**
 * Spansh's body list for each system, fetched once when first asked for. get() returns null
 * until the fetch is done, and an empty list when Spansh does not know the system, which is
 * asked again after a while since the player's own scans may reach Spansh.
 */
export class KnownBodies {
  private readonly cache = new Map<number, KnownBody[]>();
  private readonly failed = new Map<number, number>();
  private readonly pending = new Set<number>();

  constructor(
    private readonly fetchJson: (url: string) => Promise<unknown>,
    private readonly opts: { now?: () => number; onError?: (m: string) => void } = {},
  ) {}

  get(address: number): KnownBody[] | null {
    const now = (this.opts.now ?? Date.now)();
    const failedAt = this.failed.get(address);
    const cached = this.cache.get(address);
    if (cached?.length || (cached && failedAt !== undefined && now - failedAt <= RETRY_MS)) {
      return cached;
    }
    if (!this.pending.has(address) && (failedAt === undefined || now - failedAt > RETRY_MS)) {
      this.pending.add(address);
      void this.fetchJson(`https://spansh.co.uk/api/dump/${address}`)
        .then((j) => {
          const bodies = parseSpanshDump(j);
          this.cache.set(address, bodies);
          if (!bodies.length) this.failed.set(address, now);
          // Oldest first: drop the systems visited longest ago.
          while (this.cache.size > KEEP) this.cache.delete(this.cache.keys().next().value!);
        })
        .catch((err: unknown) => {
          this.failed.set(address, now);
          this.opts.onError?.(err instanceof Error ? err.message : String(err));
        })
        .finally(() => this.pending.delete(address));
    }
    return cached ?? null;
  }
}

/** A Spansh request as JSON, with ED Chat's User-Agent and a timeout. A 404 gives {}. */
export async function spanshJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", "ED-Chat");
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    ...init,
    headers,
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`Spansh ${res.status}`);
  return res.json();
}

/** GET as JSON; a 404 means Spansh does not know the system yet. */
export const fetchSpansh = (url: string): Promise<unknown> => spanshJson(url);
