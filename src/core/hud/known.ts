/** A planet in the current system as Spansh knows it, before the player scans it. */
export interface KnownBody {
  name: string;
  bodyId: number;
  /** The planet class, in the journal's spelling where it differs. */
  type: string | null;
  terraformable: boolean;
  distance_ls: number | null;
  /** Biological signals, and their genus journal keys when the surface was mapped. */
  bioSignals: number;
  genera: string[];
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

/** The planets in a Spansh system dump. */
export function parseSpanshDump(json: unknown): KnownBody[] {
  const j = (json ?? {}) as { system?: { bodies?: unknown }; bodies?: unknown };
  const raw = j.system?.bodies ?? j.bodies;
  if (!Array.isArray(raw)) return [];
  const out: KnownBody[] = [];
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
      distance_ls: typeof b.distanceToArrival === "number" ? b.distanceToArrival : null,
      ...bioOf(b.signals),
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

/** fetch() as JSON; a 404 means Spansh does not know the system yet. */
export async function fetchSpansh(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": "ED-Chat" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`Spansh ${res.status}`);
  return res.json();
}
