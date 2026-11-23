import { visitOrder, type JournalEvent, type JournalState, type Plan } from "ed-mcp/journal";
import type { Settings } from "../settings.js";
import {
  isBuildPlan,
  judgeBuild,
  materialCount,
  materialsLeft,
  mod,
  rollsLeft,
  targetGrade,
  type Action,
  type ActionJudgement,
  type BuildJudgement,
  type Stop,
} from "./buildJudge.js";
import { num, objs, same, str } from "./json.js";
import {
  credits,
  currentStop,
  jumpsLeft,
  jumpsText,
  type FooterLine,
  type HudRow,
  type NavRoute,
  type PanelView,
  type Tone,
} from "./panels.js";
import { dockedAt, isDocking, stopAt, type Dock } from "./trade.js";

// The build panel: the build plan's current stop and its actions, what each still needs, the
// next stop, and the credits to spend. See docs/superpowers/specs/2026-11-22-build-panel.md.

/**
 * Every journal event the build panel, its mode and auto-advance read. The journal reader must
 * keep them all: ed-mcp keeps most, and HUD_EVENTS asks for the rest. A test checks it.
 */
export const BUILD_EVENTS = [
  "ModuleBuy",
  "ModuleSell",
  "ModuleSellRemote",
  "ModuleSwap",
  "ModuleStore",
  "MassModuleStore",
  "ModuleBuyAndStore",
  "ModuleRetrieve",
  "FetchRemoteModule",
  "StoredModules",
  "ShipyardBuy",
  "ShipyardRedeem",
  "ShipyardNew",
  "ShipyardTransfer",
  "ShipyardSwap",
  "EngineerCraft",
  "MaterialTrade",
  "Materials",
  "EngineerProgress",
  "TechnologyBroker",
  "Synthesis",
  "Loadout",
  "LoadGame",
  "Docked",
  "Undocked",
  "Location",
  "FSDJump",
  // Landing at a gather stop, and leaving it.
  "Touchdown",
  "Liftoff",
  "Disembark",
  "LeaveBody",
] as const;

/** The game's names for its ship types, as ed-mcp's ships table has them. */
const SHIP_NAMES: Record<string, string> = {
  adder: "Adder",
  anaconda: "Anaconda",
  asp: "Asp Explorer",
  asp_scout: "Asp Scout",
  belugaliner: "Beluga Liner",
  cobramkiii: "Cobra MkIII",
  cobramkiv: "Cobra MkIV",
  cobramkv: "Cobra MkV",
  corsair: "Corsair",
  cutter: "Imperial Cutter",
  diamondback: "Diamondback Scout",
  diamondbackxl: "Diamondback Explorer",
  dolphin: "Dolphin",
  eagle: "Eagle",
  empire_courier: "Imperial Courier",
  empire_eagle: "Imperial Eagle",
  empire_trader: "Imperial Clipper",
  explorer_nx: "Caspian Explorer",
  federation_corvette: "Federal Corvette",
  federation_dropship: "Federal Dropship",
  federation_dropship_mkii: "Federal Assault Ship",
  federation_gunship: "Federal Gunship",
  ferdelance: "Fer-de-Lance",
  hauler: "Hauler",
  independant_trader: "Keelback",
  krait_light: "Krait Phantom",
  krait_mkii: "Krait MkII",
  lakonminer: "Type-11 Prospector",
  mamba: "Mamba",
  mandalay: "Mandalay",
  mediumtransport01: "Lynx Highliner",
  orca: "Orca",
  panthermkii: "Panther Clipper MkII",
  python: "Python",
  python_nx: "Python MkII",
  sidewinder: "Sidewinder",
  smallcombat01_nx: "Kestrel Mk II",
  type6: "Type-6 Transporter",
  type7: "Type-7 Transporter",
  type8: "Type-8 Transporter",
  type9: "Type-9 Heavy",
  type9_military: "Type-10 Defender",
  typex: "Alliance Chieftain",
  typex_2: "Alliance Crusader",
  typex_3: "Alliance Challenger",
  viper: "Viper MkIII",
  viper_mkiv: "Viper MkIV",
  vulture: "Vulture",
};

/** A journal ship type as the game names it: "python_nx" is "Python MkII". */
export const shipName = (type: string | null | undefined) =>
  type ? (SHIP_NAMES[type.toLowerCase()] ?? type) : null;

// ---------- Outfitting.json ----------

/** Outfitting.json: the modules of the station whose outfitting screen was opened last. */
export interface Outfitting {
  marketId: number;
  /** When the game wrote it (epoch ms), or null when it does not say. */
  at: number | null;
  /** Normalised module symbols (normaliseModule()). */
  items: Set<string>;
}

export function parseOutfitting(text: string): Outfitting | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const marketId = num(j.MarketID);
    if (marketId === null) return null;
    const items = new Set(objs(j.Items).flatMap((i) => mod(i.Name) ?? []));
    const at = Date.parse(String(j.timestamp));
    return { marketId, at: Number.isNaN(at) ? null : at, items };
  } catch {
    return null;
  }
}

// ---------- Where the ship is ----------

/**
 * Landed on a body, not yet left: index is the Touchdown that began the landing, or the Disembark
 * on a planet for one reached without landing the ship.
 */
export interface Landed {
  system: string;
  body: string;
  index: number;
}

const LEAVE_BODY = new Set(["Liftoff", "LeaveBody", "FSDJump", "CarrierJump", "Docked", "Died"]);

/**
 * Being on a body's surface: a Touchdown, a Disembark on a planet, or the Location a game
 * restarted on a surface starts with (it has a Latitude, as Location has Docked for a station).
 */
export const isLanding = (e: JournalEvent) =>
  e.event === "Touchdown" ||
  (e.event === "Disembark" && e.OnPlanet === true) ||
  (e.event === "Location" && e.Docked !== true && typeof e.Latitude === "number");

export function landedAt(events: JournalEvent[]): Landed | null {
  let found: Landed | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    // The ship sent away while the commander is in the SRV or on foot is not leaving the body.
    if (e.event === "Liftoff" && e.PlayerControlled === false) continue;
    // A relog while landed is the same landing, as a relog while docked is the same docking
    // (dockedAt()): the Location after it says so, and the landing before it goes on.
    if (e.event === "LoadGame" || e.event === "Shutdown") {
      if (found) continue;
      return null;
    }
    if (LEAVE_BODY.has(e.event) || (e.event === "Location" && !isLanding(e))) return found;
    if (isLanding(e)) {
      const system = str(e.StarSystem);
      const body = str(e.Body);
      if (!system || !body) return found;
      if (found && !(same(found.body, body) && same(found.system, system))) return found;
      // The landing is its Touchdown: a Disembark after it is the same landing.
      found = { system, body, index: i };
      if (e.event === "Touchdown") return found;
    }
  }
  return found;
}

/** A gather stop's body, against the journal's full body name: "C 3 b" is "HIP 36601 C 3 b". */
function onBody(s: Pick<Stop, "system" | "body">, system: string, body: string): boolean {
  if (!s.body || !same(s.system, system)) return false;
  return same(s.body, body) || same(`${s.system} ${s.body}`, body);
}

/** Whether being docked or landed is at this stop: a gather stop by its body. */
function stopHere(s: Stop, dock: Dock | null, landed: Landed | null): boolean {
  if (s.kind === "gather" && s.body) return !!landed && onBody(s, landed.system, landed.body);
  return !!dock && stopAt(s, dock.system, dock.station);
}

/** The stop's actions still to do, as the journal judges them. */
const openAt = (j: BuildJudgement, stop: number) =>
  j.actions.filter((x) => x.stop === stop && !x.done);

// ---------- Which plan, and which stop ----------

type Journal = JournalState & { events: JournalEvent[] };

/** Whether a plan is for the ship flown now. */
function forShip(plan: Plan, j: BuildJudgement, journal: Journal): boolean {
  if (j.shipId !== null) return j.shipId === journal.ship.id;
  if (plan.stops.some((s) => s.actions?.some((a) => a.kind === "buy_ship"))) return false;
  const type = plan.build?.ship;
  return !type || same(type, journal.ship.type);
}

export interface BuildChoice {
  plan: Plan;
  judged: BuildJudgement;
  /** The stop shown as current: the one docked or landed at with work to do, else currentStop(). */
  current: number | null;
  /** Docked or landed at the current stop. */
  here: "docked" | "landed" | null;
  /** Why this plan, when it is not the note's. */
  why: "docked" | "acted" | null;
  /** The note's plan, when it names one. */
  noteId: string | null;
}

/**
 * The build plan to show. Of the note's plan and the open build plans for the ship flown (or, for
 * a plan buying its hull, docked at one of its stops): the plan with a stop where the ship is
 * docked or landed and work to do there (the note's plan first, else the one acted on most
 * recently); otherwise the plan acted on most recently; else the note's plan.
 */
export function chooseBuild(input: {
  note: Plan | null;
  plans: Plan[];
  journal: Journal | null;
}): BuildChoice | null {
  const journal = input.journal;
  if (!journal) return null;
  const all = new Map<string, Plan>();
  if (isBuildPlan(input.note)) all.set(input.note.id, input.note);
  for (const p of input.plans) if (isBuildPlan(p) && !all.has(p.id)) all.set(p.id, p);
  if (!all.size) return null;
  const dock = dockedAt(journal.events, journal.location);
  const landed = dock ? null : landedAt(journal.events);
  const noteId = isBuildPlan(input.note) ? input.note.id : null;
  type C = { plan: Plan; judged: BuildJudgement; at: number | null };
  const cands: C[] = [];
  for (const plan of all.values()) {
    const judged = judgeBuild(plan, journal);
    const at =
      visitOrder(plan).find(
        (i) =>
          plan.stops[i]!.status === "todo" &&
          stopHere(plan.stops[i]!, dock, landed) &&
          openAt(judged, i).length > 0,
      ) ?? null;
    // Another ship's plan shows only as the note's, or while docked at one of its stops.
    if (plan.id !== noteId && !forShip(plan, judged, journal) && at === null) continue;
    cands.push({ plan, judged, at });
  }
  const newest = (cs: C[]) =>
    cs.reduce<C | null>((b, c) => (!b || c.judged.actedAt > b.judged.actedAt ? c : b), null);
  const docked = cands.filter((c) => c.at !== null);
  let pick: C | null = null;
  let why: BuildChoice["why"] = null;
  if (docked.length) {
    pick = docked.find((c) => c.plan.id === noteId) ?? newest(docked);
    why = "docked";
  } else {
    // A finished plan only while its last action was done this docking: "Build complete".
    const since = dock?.index ?? landed?.index ?? Infinity;
    const live = (c: C) => c.judged.actions.some((x) => !x.done) || c.judged.lastMatch > since;
    const acted = newest(cands.filter((c) => c.judged.actedAt > 0 && live(c)));
    // Else the note's plan, else a plan for this ship with work to do.
    pick =
      acted ??
      cands.find((c) => c.plan.id === noteId) ??
      cands.find((c) => c.judged.actions.some((x) => !x.done)) ??
      null;
    why = acted ? "acted" : null;
  }
  if (!pick) return null;
  const current = pick.at ?? currentStop(pick.plan);
  const here =
    current !== null && stopHere(pick.plan.stops[current]!, dock, landed)
      ? dock
        ? "docked"
        : "landed"
      : null;
  return {
    plan: pick.plan,
    judged: pick.judged,
    current,
    here,
    why: pick.plan.id === noteId ? null : why,
    noteId,
  };
}

// ---------- The mode ----------

/** What the build rules need to know now: see journalMode(). */
export interface BuildNow {
  /** The build panel has something to show: an action to do, or "Build complete" until undocking. */
  active: boolean;
  /** The open stops of the build plans: docking (or landing, for a gather stop) at one is following the plan. */
  stops: { system: string; station?: string; body?: string; kind?: string }[];
  /** Events that matched an open action of a build plan. */
  matched: Set<JournalEvent>;
  /** Ships with an open build plan: swapping to one is building. */
  ships: number[];
}

export const NO_BUILD: BuildNow = { active: false, stops: [], matched: new Set(), ships: [] };

/** The BuildNow for the journal and the open build plans. */
export function buildNow(
  input: {
    note: Plan | null;
    plans: Plan[];
    journal: Journal | null;
  },
  /** The plan shown, when the caller has chosen it already. */
  chosen?: BuildChoice | null,
): BuildNow {
  const journal = input.journal;
  if (!journal) return NO_BUILD;
  const plans = [
    ...new Map([input.note, ...input.plans].filter(isBuildPlan).map((p) => [p.id, p])).values(),
  ];
  const matched = new Set<JournalEvent>();
  const stops: BuildNow["stops"] = [];
  const ships: number[] = [];
  for (const plan of plans) {
    const j = judgeBuild(plan, journal);
    for (const e of j.matched) matched.add(e);
    for (const i of visitOrder(plan))
      if (plan.stops[i]!.status === "todo" && openAt(j, i).length) {
        const s = plan.stops[i]!;
        stops.push({ system: s.system, station: s.station, body: s.body, kind: s.kind });
      }
    if (j.shipId !== null && j.actions.some((x) => !x.done)) ships.push(j.shipId);
  }
  const choice = chosen === undefined ? chooseBuild(input) : chosen;
  return { active: !!choice && buildActive(choice, journal), stops, matched, ships };
}

/**
 * Whether the plan shown has something to show: an action to do; or every action done during this
 * docking (or landing), which shows "Build complete" until the ship leaves.
 */
function buildActive(c: BuildChoice, journal: Journal): boolean {
  if (c.judged.actions.some((x) => !x.done)) return true;
  const dock = dockedAt(journal.events, journal.location);
  const landed = dock ? null : landedAt(journal.events);
  const since = dock?.index ?? landed?.index ?? null;
  return since !== null && c.judged.lastMatch > since;
}

/** Whether an event is docking or landing at an open build stop. */
export function atBuildStop(e: JournalEvent, stops: BuildNow["stops"]): boolean {
  const system = str(e.StarSystem) ?? "";
  if (isDocking(e)) {
    const station = str(e.StationName) ?? "";
    return stops.some((s) => !(s.kind === "gather" && s.body) && stopAt(s, system, station));
  }
  if (isLanding(e)) {
    const body = str(e.Body) ?? "";
    return stops.some((s) => s.kind === "gather" && !!s.body && onBody(s, system, body));
  }
  return false;
}

// ---------- The panel ----------

const place = (s: Stop) =>
  s.station ? `${s.system} · ${s.station}` : s.body ? `${s.system} · ${s.body}` : s.system;

/** The word for each kind of action, in the next stop's counts. */
const VERB: Partial<Record<Action["kind"], string>> = {
  buy_module: "buy",
  retrieve_module: "retrieve",
  fetch_module: "transfer",
  store_module: "store",
  sell_module: "sell",
  move_module: "move",
  buy_ship: "buy ship",
  transfer_ship: "transfer ship",
  swap_ship: "swap",
  unlock_tech: "unlock tech",
  unlock_engineer: "unlock",
  engineer: "roll",
  experimental: "apply",
  trade_material: "trade",
  collect_material: "collect",
  synthesis: "synthesise",
};

/** Short names of the core slots, for "after FSD G5". */
const SLOTS: Record<string, string> = {
  frameshiftdrive: "FSD",
  powerdistributor: "PD",
  powerplant: "power plant",
  mainengines: "thrusters",
  lifesupport: "life support",
  radar: "sensors",
  armour: "armour",
  fueltank: "fuel tank",
};
const slotName = (slot: string | undefined) =>
  slot ? (SLOTS[slot.toLowerCase()] ?? slot) : "the module";

const pct = (q: number | null) => `${Math.round((q ?? 0) * 100)}%`;

/** "G3 64% → G5 · ~7 rolls". */
function rollText(x: ActionJudgement, rolls: number[] | undefined): string {
  const left = [...rollsLeft(x.action, x.fitted, rolls).values()].reduce((n, r) => n + r, 0);
  const f = x.fitted;
  const from =
    f && same(f.blueprint, x.action.blueprint) && (f.level ?? 0) > 0
      ? `G${f.level} ${pct(f.quality)}`
      : "G0";
  return `${from} → G${targetGrade(x.action)} · ~${left} roll${left === 1 ? "" : "s"}`;
}

/** The stop that collects or trades for a material, by its place in visit order. */
function sourceOf(plan: Plan, j: BuildJudgement, name: string, symbol?: string): string | null {
  const order = visitOrder(plan);
  const key = (v: string | undefined) => v?.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = new Set([key(name), key(symbol)].filter(Boolean));
  for (const x of j.actions) {
    if (x.done) continue;
    const a = x.action;
    const gets =
      a.kind === "collect_material"
        ? a.material
        : a.kind === "trade_material"
          ? a.received?.material
          : undefined;
    if (!gets || !want.has(key(gets))) continue;
    const n = order.indexOf(x.stop) + 1;
    return `${a.kind === "collect_material" ? "collect" : "trade"} at stop ${n}`;
  }
  return null;
}

interface Need {
  right?: string;
  detail?: string;
  tone?: Tone;
}

/** What an open action still needs, for its row: see "What the panel shows" in the spec. */
function need(
  x: ActionJudgement,
  c: BuildChoice,
  ctx: {
    journal: Journal;
    dock: Dock | null;
    outfitting: Outfitting | null;
    balance: number | null;
    blockedBy: ActionJudgement | null;
  },
): Need {
  const a = x.action;
  const plan = c.plan;
  if (ctx.blockedBy) {
    const b = ctx.blockedBy.action;
    return { right: `after ${slotName(b.slot)} G${targetGrade(b)}` };
  }
  const out: Need = {};
  const right: string[] = [];
  if (a.kind === "engineer") right.push(rollText(x, plan.build?.rolls_per_grade));
  const price = a.needs?.credits;
  if (price) right.push(credits(price));
  if (a.kind === "retrieve_module" || a.kind === "fetch_module") {
    const m = mod(a.module);
    const stored = (ctx.journal.stored_modules ?? []).filter(
      (s) => s.symbol === m || (a.storage_slot !== undefined && s.storage_slot === a.storage_slot),
    );
    const here = ctx.dock?.marketId ?? null;
    if (here !== null && stored.some((s) => s.market_id === here)) right.push("here");
    else if (stored.some((s) => s.in_transit)) right.push("in transit");
    else {
      const s = stored[0];
      if (s?.transfer_cost && !price) right.push(credits(s.transfer_cost));
      if (s?.transfer_time) right.push(`~${Math.max(1, Math.round(s.transfer_time / 60))} min`);
    }
  }
  if (a.kind === "collect_material") {
    const have = materialCount(ctx.journal.materials, a.material);
    right.push(`${have}/${a.count ?? 1}`);
    const notes = plan.stops[x.stop]?.notes;
    if (notes) out.detail = notes;
  }
  if (a.kind === "trade_material" && x.taken > 0)
    right.push(`${x.taken}/${a.received?.count ?? 1} received`);
  // The first material short, with the stop that collects or trades for it.
  const mats =
    a.kind === "trade_material" && a.paid
      ? [{ name: a.paid.material, count: a.paid.count }]
      : a.kind === "collect_material"
        ? []
        : materialsLeft(a, x.fitted, plan.build?.rolls_per_grade);
  let short = false;
  for (const m of mats) {
    const have = materialCount(ctx.journal.materials, m.name, "symbol" in m ? m.symbol : undefined);
    if (have >= m.count) continue;
    short = true;
    if (a.kind === "trade_material") out.detail = `have ${have}/${m.count} ${m.name}`;
    else {
      const from = sourceOf(plan, c.judged, m.name, "symbol" in m ? m.symbol : undefined);
      // "(have 0/1)" only repeats the count short.
      const held = have > 0 ? ` (have ${have}/${m.count})` : "";
      out.detail = [`short ${m.count - have} ${m.name}${held}`, from].filter(Boolean).join(" · ");
    }
    break;
  }
  if (price && ctx.balance !== null && ctx.balance < price) {
    out.tone = "warn";
    out.detail ??= `short ${credits(price - ctx.balance)}`;
    short = true;
  }
  // Outfitting.json of this visit not listing a module to buy: the player can ask Claude for another station.
  if (a.kind === "buy_module" && ctx.dock && ctx.outfitting && c.here === "docked") {
    const o = ctx.outfitting;
    const since = Date.parse(ctx.dock.since ?? "");
    const fresh = o.marketId === ctx.dock.marketId && (Number.isNaN(since) || (o.at ?? 0) >= since);
    if (fresh && !o.items.has(mod(a.module) ?? "")) {
      out.detail = "not sold here";
      out.tone = "warn";
      short = true;
    }
  }
  if (!short && (mats.length || price) && a.kind !== "engineer") right.push("ready");
  if (right.length) out.right = right.join(" · ");
  return out;
}

/** "buy 2 · retrieve 1 · transfer 1 · sell 1": each kind of action still to do, in stop order. */
function counts(j: BuildJudgement, stop: number): string {
  const n = new Map<string, number>();
  for (const x of openAt(j, stop)) {
    const v = VERB[x.action.kind] ?? x.action.kind;
    n.set(v, (n.get(v) ?? 0) + 1);
  }
  return [...n].map(([v, k]) => `${v} ${k}`).join(" · ");
}

/** Past this, the next stop's counts go on a line of their own. */
const NEXT_WIDTH = 44;

export function buildPanel(input: {
  choice: BuildChoice;
  journal: Journal;
  nav?: NavRoute | null;
  outfitting?: Outfitting | null;
  /** Credits held, from Status.json's Balance. */
  balance?: number | null;
  settings: Settings["hud"]["build"];
}): PanelView {
  const c = input.choice;
  const plan = c.plan;
  const j = c.judged;
  const journal = input.journal;
  const order = visitOrder(plan);
  const dock = dockedAt(journal.events, journal.location);
  const balance = input.balance ?? null;
  const total = j.actions.length;
  const done = j.actions.filter((x) => x.done).length;
  const complete = total > 0 && done === total;
  const rows: HudRow[] = [];
  const cur = c.current;
  if (cur !== null && !complete) {
    const stop = plan.stops[cur]!;
    const jumps = jumpsLeft(input.nav ?? null, journal.location.system);
    const leads = jumps !== null && same(input.nav!.systems.at(-1), stop.system);
    const kind = stop.kind === "gather" ? "collect" : stop.kind === "shop" ? null : stop.kind;
    const right = [kind, c.here ?? (leads ? jumpsText(jumps) : null)].filter(Boolean).join(" · ");
    rows.push(right ? { text: `● ${place(stop)}`, right } : { text: `● ${place(stop)}` });
    const here = j.actions.filter((x) => x.stop === cur);
    const doneHere = here.filter((x) => x.done);
    const fold = doneHere.length > input.settings.doneShown;
    if (fold) rows.push({ text: `  ✓ ${doneHere.length} done`, tone: "dim" });
    for (const x of here) {
      if (x.done) {
        if (x.notFitted)
          rows.push({ text: `  ✓ ${x.action.label}`, right: "not fitted now", tone: "warn" });
        else if (!fold) rows.push({ text: `  ✓ ${x.action.label}`, tone: "dim" });
        continue;
      }
      // An experimental waits for its module's blueprint, rolled at this stop first.
      const blockedBy =
        x.action.kind === "experimental"
          ? (here.find(
              (y) => !y.done && y.action.kind === "engineer" && same(y.action.slot, x.action.slot),
            ) ?? null)
          : null;
      const n = need(x, c, {
        journal,
        dock,
        outfitting: input.outfitting ?? null,
        balance,
        blockedBy,
      });
      const row: HudRow = { text: `  ${x.action.label}` };
      if (n.right) row.right = n.right;
      if (n.detail) row.detail = n.detail;
      if (n.tone) row.tone = n.tone;
      rows.push(row);
    }
    const next = order.find(
      (i) => i !== cur && order.indexOf(i) > order.indexOf(cur) && plan.stops[i]!.status === "todo",
    );
    if (next !== undefined) {
      const text = `▸ ${place(plan.stops[next]!)}`;
      const what = counts(j, next);
      if (!what) rows.push({ text, tone: "dim" });
      else if (text.length + what.length <= NEXT_WIDTH)
        rows.push({ text, right: what, tone: "dim" });
      else rows.push({ text, detail: what, tone: "dim" });
    }
  }

  const footer: FooterLine[] = [];
  const at = cur !== null ? order.indexOf(cur) : -1;
  const todo = (i: number) => plan.stops[i]!.status === "todo";
  const before = at >= 0 ? order.slice(0, at).filter(todo).length : 0;
  const after = at >= 0 ? order.slice(at + 1).filter(todo).length : 0;
  const toSpend = j.actions
    .filter((x) => !x.done)
    .reduce((n, x) => n + (x.action.needs?.credits ?? 0), 0);
  const parts = [
    before ? `${before} open before` : null,
    after && !complete ? `${after} after` : null,
    toSpend ? `${credits(toSpend)} to spend` : null,
    balance !== null && toSpend ? `${credits(balance)} held` : null,
  ].filter(Boolean);
  if (parts.length) {
    const text = parts.join(" · ");
    footer.push(balance !== null && balance < toSpend ? { text, tone: "warn" } : text);
  }
  if (plan.build?.summary) footer.push(`Target: ${plan.build.summary}`);

  const ship = shipName(
    plan.build?.ship ?? (j.shipId === journal.ship.id ? journal.ship.type : null),
  );
  const n = at >= 0 ? at + 1 : null;
  const note =
    c.why && c.noteId
      ? `Showing build plan ${plan.id} (${c.why === "docked" ? "docked at its stop" : "its action was done last"}); the activity note names ${c.noteId}.`
      : undefined;
  return {
    mode: "build",
    title: plan.build?.scope === "upgrade" ? "UPGRADE" : "BUILD",
    subtitle:
      [ship, !complete && n !== null && order.length > 1 ? `stop ${n}/${order.length}` : null]
        .filter(Boolean)
        .join(" · ") || undefined,
    right: complete ? "Build complete" : `${done}/${total} actions`,
    ...(complete ? { tone: "good" as const } : {}),
    rows,
    footer,
    ...(note ? { note } : {}),
  };
}
