import {
  ACTION_EVENTS,
  normaliseModule,
  visitOrder,
  type DoneBy,
  type JournalEvent,
  type JournalState,
  type Plan,
} from "ed-mcp/journal";
import { resourceCount, sameMod, sameWeapon, squash, suitOf } from "./foot.js";
import { held, used } from "./hold.js";
import { num, objs, same, str, type Obj } from "./json.js";
import { commodityKey } from "./mining.js";

// Judging a plan's stop actions from the journal: which events did which action, what is done,
// and how far an engineer action has got. Every plan with actions is judged here: builds, trade
// routes and mission runs. The panels (build.ts, trade.ts) show it; ActionFinisher
// (actionStops.ts) writes it to the plan.

export type Stop = Plan["stops"][number];
export type Action = NonNullable<Stop["actions"]>[number];

/** The action kinds judged by one event each. */
const BY_EVENT = new Set<Action["kind"]>([
  "buy_module",
  "retrieve_module",
  "fetch_module",
  "store_module",
  "sell_module",
  "move_module",
  "buy_ship",
  "transfer_ship",
  "swap_ship",
  "unlock_tech",
  "engineer",
  "experimental",
  "synthesis",
  "complete_mission",
  "sell_data",
  "redeem_vouchers",
  "refuel",
  "repair",
  "restock",
  "buy_suit",
  "buy_weapon",
  "upgrade_suit",
  "upgrade_weapon",
]);
/** The kinds whose events add up to a count: the tons, items or materials received. */
const BY_SUM = new Set<Action["kind"]>([
  "trade_material",
  "buy_commodity",
  "sell_commodity",
  "collect_cargo",
  "deliver_cargo",
  "trade_resource",
  "buy_resource",
]);
/**
 * The kinds done when the journal state shows them: on foot a modification shows only in the next
 * loadout event (no event applies it), and a resource collected only in the locker or backpack.
 */
const BY_STATE = new Set<Action["kind"]>([
  "collect_material",
  "unlock_engineer",
  "modify_suit",
  "modify_weapon",
  "collect_resource",
]);
/**
 * The kinds done at the stop's own station (or in its system, for a stop with none): a sale or a
 * refuel elsewhere is not this stop's. A mission is known by its ID wherever it is handed in.
 */
const AT_STOP = new Set<Action["kind"]>([
  "buy_commodity",
  "sell_commodity",
  "sell_data",
  "redeem_vouchers",
  "refuel",
  "repair",
  "restock",
]);

/** Whether the judge judges an action of this kind from the journal. */
export const judged = (a: Action) =>
  BY_EVENT.has(a.kind) || BY_SUM.has(a.kind) || BY_STATE.has(a.kind);

/**
 * The kinds any plan's stops can have (ed-mcp's ACTION_EVENTS): trade, missions and the station's
 * services. Every other kind is a build's.
 */
const STOP_KINDS = new Set<string>(Object.keys(ACTION_EVENTS));

/** Whether a plan has stop actions. */
export const hasActions = (plan: Plan | null | undefined): plan is Plan =>
  !!plan && plan.stops.some((s) => (s.actions?.length ?? 0) > 0);

/**
 * A build plan, for a ship or a suit loadout: the build panel follows it. A plan with a build,
 * or with stop actions of a build's kinds; a trade route or a mission run, whose actions are only
 * buys, sales, missions and services, is not one.
 */
export const isBuildPlan = (plan: Plan | null | undefined): plan is Plan =>
  hasActions(plan) &&
  (!!plan.build || plan.stops.some((s) => s.actions?.some((a) => !STOP_KINDS.has(a.kind))));

/** An engineer action's target grade: G5 when the plan gives none. */
export const targetGrade = (a: Pick<Action, "grade">) => a.grade ?? 5;

/** A module symbol from any event or file in one form (normaliseModule()). */
export const mod = (v: unknown) => (typeof v === "string" && v ? normaliseModule(v) : null);

const lower = (v: unknown) => (typeof v === "string" && v ? v.toLowerCase() : null);

/** An event's name in done_by: its time, its name and its place among those of that second. */
export type EventRef = Pick<DoneBy, "at" | "event" | "n">;
export const refKey = (r: EventRef) => `${r.at}|${r.event}|${r.n}`;

/** The ship an event is for: its ShipID and type, as the journal gives them. */
interface ShipOf {
  id: number | null;
  type: string | null;
}

/** What one event does, for one role: see "One event, one action per role" in the spec. */
interface Role {
  /** The done_by role, as "bought" or "stored.1" for a MassModuleStore item. */
  name: string;
  kind:
    | "bought"
    | "sold"
    | "stored"
    | "retrieved"
    | "fetched"
    | "moved"
    | "new_ship"
    | "swapped"
    | "transferred"
    | "rolled"
    | "experimental"
    | "received"
    | "synthesised"
    | "unlocked"
    | "goods_bought"
    | "goods_sold"
    | "completed"
    | "collected"
    | "delivered"
    | "data_sold"
    | "redeemed"
    | "refuelled"
    | "repaired"
    | "restocked"
    | "suit_bought"
    | "weapon_bought"
    | "suit_upgraded"
    | "weapon_upgraded"
    | "resource_traded"
    | "resource_bought";
  /** The module, material, ship type, recipe or technology, compared lower case. */
  item: string | null;
  /** The game's name for a material, beside its symbol. */
  alt?: string | null;
  slot?: string | null;
  /** A ModuleBuyAndStore: the module went to storage, not to a slot. */
  stored?: boolean;
  shipId?: number | null;
  storageSlot?: number | null;
  blueprint?: string | null;
  level?: number | null;
  broker?: string | null;
  /** 1, or a trade's quantity received. */
  amount: number;
  /** A market trade's commodity, by every name the event gives (commodityKey()). */
  goods?: string[];
  missionId?: number | null;
  /** A CargoDepot that shows all of the mission's cargo collected or delivered. */
  all?: boolean;
  /** Data sold: "exploration" or "organic". A voucher redeemed: "bounty", "combat_bond", ... */
  sort?: string | null;
  /** Where the ship was docked (the station null in space), or null when the events do not say. */
  place?: Place | null;
  /** On foot: the SuitID or SuitModuleID of the suit or weapon bought or upgraded. */
  gearId?: number | null;
  /** The ship the event is for; null for one that is not for a ship (materials, remote storage). */
  ship: ShipOf | null;
}

function shipOf(e: JournalEvent): ShipOf {
  return { id: num(e.ShipID), type: lower(e.Ship) };
}

/** Where the ship is, from the events: docked at a station, or in a system. */
interface Place {
  system: string | null;
  station: string | null;
}

/** Where the ship is after an event, or undefined when the event does not move it. */
function moved(e: JournalEvent, was: Place | null): Place | null | undefined {
  switch (e.event) {
    case "Docked":
      return { system: str(e.StarSystem) ?? was?.system ?? null, station: str(e.StationName) };
    case "Location":
    case "CarrierJump":
      return {
        system: str(e.StarSystem),
        station: e.Docked === true ? str(e.StationName) : null,
      };
    case "FSDJump":
      return { system: str(e.StarSystem), station: null };
    case "Undocked":
      return was ? { system: was.system, station: null } : null;
    case "Died":
    case "LoadGame":
      // Somewhere the next Location says.
      return null;
    default:
      return undefined;
  }
}

/** The kind of a voucher in a plan, from RedeemVoucher's Type. */
const voucherOf = (type: unknown) => {
  const t = lower(type);
  return t === "combatbond" ? "combat_bond" : t;
};

/** Every key a commodity goes by in an event: its internal and its game name. */
const goodsOf = (...names: unknown[]) =>
  names.filter((x): x is string => typeof x === "string" && x !== "").map(commodityKey);

/** The roles an event plays. `flying` is the ship flown at the time, for EngineerCraft. */
function rolesOf(e: JournalEvent, flying: ShipOf, place: Place | null): Role[] {
  const one = (r: Omit<Role, "name" | "amount"> & { name?: string; amount?: number }): Role => ({
    name: r.kind,
    amount: 1,
    ...r,
  });
  switch (e.event) {
    case "ModuleBuy": {
      const out = [
        one({ kind: "bought", item: mod(e.BuyItem), slot: str(e.Slot), ship: shipOf(e) }),
      ];
      if (mod(e.SellItem)) out.push(one({ kind: "sold", item: mod(e.SellItem), ship: shipOf(e) }));
      if (mod(e.StoredItem))
        out.push(one({ kind: "stored", item: mod(e.StoredItem), ship: shipOf(e) }));
      return out;
    }
    case "ModuleBuyAndStore":
      return [one({ kind: "bought", item: mod(e.BuyItem), stored: true, ship: shipOf(e) })];
    case "ModuleSell":
      return [one({ kind: "sold", item: mod(e.SellItem), ship: shipOf(e) })];
    case "ModuleSellRemote":
      return [one({ kind: "sold", item: mod(e.SellItem), ship: null })];
    case "ModuleStore":
      return [one({ kind: "stored", item: mod(e.StoredItem), ship: shipOf(e) })];
    case "MassModuleStore":
      return objs(e.Items).map((x, i) =>
        one({ kind: "stored", name: `stored.${i}`, item: mod(x.Name), ship: shipOf(e) }),
      );
    case "ModuleRetrieve": {
      const out = [
        one({
          kind: "retrieved",
          item: mod(e.RetrievedItem),
          blueprint: str(e.EngineerModifications),
          level: num(e.Level),
          ship: shipOf(e),
        }),
      ];
      if (mod(e.SwapOutItem))
        out.push(one({ kind: "stored", item: mod(e.SwapOutItem), ship: shipOf(e) }));
      return out;
    }
    case "FetchRemoteModule":
      return [
        one({
          kind: "fetched",
          item: mod(e.StoredItem),
          storageSlot: num(e.StorageSlot),
          ship: null,
        }),
      ];
    case "ModuleSwap": {
      const out: Role[] = [];
      const from = mod(e.FromItem);
      const to = mod(e.ToItem);
      // FromItem goes to ToSlot, ToItem (Null for an empty slot) to FromSlot.
      if (from && from !== "null")
        out.push(
          one({
            kind: "moved",
            name: "moved.from",
            item: from,
            slot: str(e.ToSlot),
            ship: shipOf(e),
          }),
        );
      if (to && to !== "null")
        out.push(
          one({
            kind: "moved",
            name: "moved.to",
            item: to,
            slot: str(e.FromSlot),
            ship: shipOf(e),
          }),
        );
      return out;
    }
    case "ShipyardBuy":
    case "ShipyardRedeem":
      return [one({ kind: "new_ship", item: lower(e.ShipType), ship: null })];
    case "ShipyardSwap":
      return [one({ kind: "swapped", item: lower(e.ShipType), shipId: num(e.ShipID), ship: null })];
    case "ShipyardNew":
      return [
        one({ kind: "swapped", item: lower(e.ShipType), shipId: num(e.NewShipID), ship: null }),
      ];
    case "ShipyardTransfer":
      return [
        one({ kind: "transferred", item: lower(e.ShipType), shipId: num(e.ShipID), ship: null }),
      ];
    case "EngineerCraft": {
      const out = [
        one({
          kind: "rolled",
          item: mod(e.Module),
          slot: str(e.Slot),
          blueprint: str(e.BlueprintName),
          level: num(e.Level),
          ship: flying,
        }),
      ];
      const x = str(e.ApplyExperimentalEffect) ?? str(e.ExperimentalEffect);
      if (x)
        out.push(
          one({ kind: "experimental", item: x.toLowerCase(), slot: str(e.Slot), ship: flying }),
        );
      return out;
    }
    case "MaterialTrade": {
      const r = (e.Received ?? {}) as Obj;
      const q = num(r.Quantity) ?? 0;
      if (q <= 0) return [];
      return [
        one({
          kind: "received",
          item: lower(r.Material),
          alt: lower(r.Material_Localised),
          amount: q,
          ship: null,
        }),
      ];
    }
    case "Synthesis":
      return [one({ kind: "synthesised", item: lower(e.Name), ship: null })];
    case "MarketBuy":
    case "MarketSell": {
      const q = num(e.Count) ?? 0;
      // Stolen goods sold at a black market are not the plan's trade.
      if (q <= 0 || e.StolenGoods === true) return [];
      return [
        one({
          kind: e.event === "MarketBuy" ? "goods_bought" : "goods_sold",
          item: null,
          goods: goodsOf(e.Type, e.Type_Localised),
          amount: q,
          place,
          ship: null,
        }),
      ];
    }
    case "MissionCompleted":
      return [one({ kind: "completed", item: null, missionId: num(e.MissionID), ship: null })];
    case "CargoDepot": {
      const collect = e.UpdateType === "Collect";
      if (!collect && e.UpdateType !== "Deliver") return [];
      const q = num(e.Count) ?? 0;
      if (q <= 0) return [];
      const total = num(e.TotalItemsToDeliver);
      const so = num(collect ? e.ItemsCollected : e.ItemsDelivered);
      return [
        one({
          kind: collect ? "collected" : "delivered",
          item: null,
          missionId: num(e.MissionID),
          amount: q,
          all: total !== null && so !== null && so >= total,
          ship: null,
        }),
      ];
    }
    case "MultiSellExplorationData":
    case "SellExplorationData":
    case "SellOrganicData":
      return [
        one({
          kind: "data_sold",
          item: null,
          sort: e.event === "SellOrganicData" ? "organic" : "exploration",
          place,
          ship: null,
        }),
      ];
    case "RedeemVoucher":
      return [one({ kind: "redeemed", item: null, sort: voucherOf(e.Type), place, ship: null })];
    case "RefuelAll":
    case "RefuelPartial":
      return [one({ kind: "refuelled", item: null, place, ship: null })];
    case "RepairAll":
    case "Repair":
      return [one({ kind: "repaired", item: null, place, ship: null })];
    case "BuyAmmo":
      return [one({ kind: "restocked", item: null, place, ship: null })];
    // On foot: none of these says where the player was, so no place.
    case "BuySuit": {
      const suit = suitOf(str(e.Name) ?? undefined);
      return [
        one({
          kind: "suit_bought",
          item: suit?.type ?? null,
          level: suit?.grade ?? null,
          gearId: num(e.SuitID),
          ship: null,
        }),
      ];
    }
    case "BuyWeapon":
      return [
        one({
          kind: "weapon_bought",
          item: lower(e.Name),
          alt: str(e.Name_Localised),
          level: num(e.Class),
          gearId: num(e.SuitModuleID),
          ship: null,
        }),
      ];
    case "UpgradeSuit":
      return [
        one({
          kind: "suit_upgraded",
          item: null,
          level: num(e.Class),
          gearId: num(e.SuitID),
          ship: null,
        }),
      ];
    case "UpgradeWeapon":
      return [
        one({
          kind: "weapon_upgraded",
          item: null,
          level: num(e.Class),
          gearId: num(e.SuitModuleID),
          ship: null,
        }),
      ];
    case "TradeMicroResources": {
      const q = num(e.Count) ?? 0;
      if (q <= 0) return [];
      return [
        one({
          kind: "resource_traded",
          item: lower(e.Received),
          alt: str(e.Received_Localised),
          amount: q,
          ship: null,
        }),
      ];
    }
    case "BuyMicroResources": {
      // One resource in older journals; newer ones list several under Items.
      const items = Array.isArray(e.Items) ? objs(e.Items) : [e];
      return items.flatMap((x, i) => {
        const q = num(x.Count) ?? 0;
        return q > 0
          ? [
              one({
                kind: "resource_bought",
                name: `resource_bought.${i}`,
                item: lower(x.Name),
                alt: str(x.Name_Localised),
                amount: q,
                ship: null,
              }),
            ]
          : [];
      });
    }
    case "TechnologyBroker":
      return objs(e.ItemsUnlocked).map((x, i) =>
        one({
          kind: "unlocked",
          name: `unlocked.${i}`,
          item: lower(x.Name),
          broker: str(e.BrokerType),
          ship: null,
        }),
      );
    default:
      return [];
  }
}

/** Events that set the ship flown: EngineerCraft names none, so it is for this one. */
function flown(e: JournalEvent): ShipOf | null {
  switch (e.event) {
    case "Loadout":
    case "LoadGame":
      return num(e.ShipID) !== null ? { id: num(e.ShipID), type: lower(e.Ship) } : null;
    case "ShipyardSwap":
      return { id: num(e.ShipID), type: lower(e.ShipType) };
    case "ShipyardNew":
      return { id: num(e.NewShipID), type: lower(e.ShipType) };
    default:
      return null;
  }
}

/** A module fitted in a slot, from the newest Loadout and the crafts after it. */
export interface Fitted {
  item: string | null;
  blueprint: string | null;
  level: number | null;
  quality: number | null;
  experimental: string | null;
}

function fittedOf(m: Obj): Fitted {
  const eng = (m.Engineering ?? null) as Obj | null;
  return {
    item: mod(m.Item),
    blueprint: eng ? str(eng.BlueprintName) : null,
    level: eng ? num(eng.Level) : null,
    quality: eng ? num(eng.Quality) : null,
    experimental: eng ? lower(eng.ExperimentalEffect) : null,
  };
}

/** Whether an event of a kind finishes an action, for the plan's ship. */
function matches(
  a: Action,
  r: Role,
  plan: Plan,
  stop: Stop,
  boundId: number | null,
  gearId: number | null = null,
): boolean {
  const sameMod = () => !!a.module && mod(a.module) === r.item;
  if (AT_STOP.has(a.kind) && !atStop(stop, r.place ?? null)) return false;
  const sameGoods = () => !!a.commodity && !!r.goods?.includes(commodityKey(a.commodity));
  const sameMission = () => a.mission_id !== undefined && r.missionId === a.mission_id;
  switch (a.kind) {
    case "buy_commodity":
      return r.kind === "goods_bought" && sameGoods();
    case "sell_commodity":
      return r.kind === "goods_sold" && sameGoods();
    case "complete_mission":
      return r.kind === "completed" && sameMission();
    case "collect_cargo":
      return r.kind === "collected" && sameMission();
    case "deliver_cargo":
      return r.kind === "delivered" && sameMission();
    case "sell_data":
      return r.kind === "data_sold" && (!a.data || a.data === r.sort);
    case "redeem_vouchers":
      return r.kind === "redeemed" && (!a.voucher || a.voucher === r.sort);
    case "refuel":
      return r.kind === "refuelled";
    case "repair":
      return r.kind === "repaired";
    case "restock":
      return r.kind === "restocked";
    case "buy_module":
      if (r.kind !== "bought" || !sameMod()) return false;
      // Bought straight into storage counts only for a buy that names no slot.
      return r.stored ? !a.slot : !a.slot || same(a.slot, r.slot);
    case "retrieve_module":
      return (
        r.kind === "retrieved" &&
        sameMod() &&
        (!a.blueprint || same(a.blueprint, r.blueprint)) &&
        (a.grade === undefined || (r.level ?? 0) >= a.grade)
      );
    case "fetch_module":
      return (
        r.kind === "fetched" &&
        (sameMod() || (a.storage_slot !== undefined && a.storage_slot === r.storageSlot))
      );
    case "store_module":
      return r.kind === "stored" && sameMod();
    case "sell_module":
      return r.kind === "sold" && sameMod();
    case "move_module":
      return r.kind === "moved" && sameMod() && same(a.slot, r.slot);
    case "buy_ship":
      return r.kind === "new_ship" && r.item === lower(a.ship ?? plan.build?.ship);
    case "swap_ship": {
      const id = a.ship_id ?? boundId;
      return r.kind === "swapped" && id !== null && r.shipId === id;
    }
    case "transfer_ship": {
      const id = a.ship_id ?? boundId;
      return r.kind === "transferred" && id !== null && r.shipId === id;
    }
    case "unlock_tech":
      return (
        r.kind === "unlocked" && r.item === lower(a.item) && (!a.broker || same(a.broker, r.broker))
      );
    case "engineer":
      return (
        r.kind === "rolled" &&
        same(a.slot, r.slot) &&
        same(a.blueprint, r.blueprint) &&
        (r.level ?? 0) >= targetGrade(a) &&
        (!a.module || mod(a.module) === r.item)
      );
    case "experimental":
      return r.kind === "experimental" && same(a.slot, r.slot) && r.item === lower(a.experimental);
    case "trade_material": {
      const m = lower(a.received?.material);
      return r.kind === "received" && !!m && (r.item === m || r.alt === m);
    }
    case "synthesis":
      return r.kind === "synthesised" && r.item === lower(a.recipe);
    case "buy_suit": {
      const want = suitOf(a.suit);
      return (
        r.kind === "suit_bought" &&
        !!want &&
        r.item === want.type &&
        (r.level ?? 0) >= (a.grade ?? want.grade ?? 0)
      );
    }
    case "buy_weapon":
      return (
        r.kind === "weapon_bought" &&
        sameWeapon(r.item, r.alt ?? null, a.weapon) &&
        (r.level ?? 0) >= (a.grade ?? 0)
      );
    case "upgrade_suit":
      return (
        r.kind === "suit_upgraded" &&
        gearId !== null &&
        r.gearId === gearId &&
        (r.level ?? 0) >= targetGrade(a)
      );
    case "upgrade_weapon":
      return (
        r.kind === "weapon_upgraded" &&
        gearId !== null &&
        r.gearId === gearId &&
        (r.level ?? 0) >= targetGrade(a)
      );
    case "trade_resource":
      return r.kind === "resource_traded" && sameResource(r, a.received?.material);
    case "buy_resource":
      return r.kind === "resource_bought" && sameResource(r, a.resource);
    default:
      return false;
  }
}

/**
 * How much of an action's role it takes to be done: a trade's count, the tons to buy or sell, the
 * cargo to collect or deliver, else one event. A collect or deliver with no count is done only by
 * the CargoDepot that shows all of it (Infinity here).
 */
function needOf(a: Action): number {
  if (a.kind === "trade_material" || a.kind === "trade_resource")
    return Math.max(1, a.received?.count ?? 1);
  if (a.kind === "buy_resource") return Math.max(1, a.count ?? 1);
  if (a.kind === "collect_cargo" || a.kind === "deliver_cargo")
    return a.count !== undefined ? Math.max(1, a.count) : Infinity;
  if (BY_SUM.has(a.kind)) return Math.max(1, a.count ?? 1);
  return 1;
}

/**
 * Whether an event where the ship was is at a stop. Where the events do not say yet (null), it is
 * no stop: nothing counts until a Docked, Location or jump gives the place.
 */
function atStop(s: Stop, place: Place | null): boolean {
  if (!place) return false;
  if (!same(s.system, place.system)) return false;
  return !s.station || same(s.station, place.station);
}

/** Whether a resource an event names (its journal or game name) is the planned one. */
const sameResource = (r: Role, planned: string | undefined) =>
  !!planned && [r.item, r.alt].some((x) => !!x && squash(x) === squash(planned));

/** What the journal says about one action. */
export interface ActionJudgement {
  stop: number;
  action: Action;
  /** Done in the plan, or judged done now. */
  done: boolean;
  /** Judged done now, not yet in the plan: the panel writes it (ActionFinisher). */
  write: { status?: "done"; done_by?: DoneBy[]; key: string } | null;
  /** The events it claims, with the role and amount. */
  claims: DoneBy[];
  /** Index in events of its newest claim, or -1. */
  lastClaim: number;
  /** For a trade: the amount received so far. */
  taken: number;
  /** For an engineer action, the module in the slot now (newest Loadout and later crafts). */
  fitted: Fitted | null;
  /** A done buy, retrieve, engineer or experimental the newest Loadout no longer shows. */
  notFitted: boolean;
}

export interface BuildJudgement {
  plan: Plan;
  /** In plan order: stops in visit order, then actions in stop order. */
  actions: ActionJudgement[];
  /** The ship's ShipID found from the journal for a plan with none: written once. */
  boundId: number | null;
  /** The ship the plan is bound to (ship_id, or found), or null. */
  shipId: number | null;
  /** The events that matched an action, for the mode. */
  matched: Set<JournalEvent>;
  /** Index in events of the newest matched event, or -1. */
  lastMatch: number;
  /** Time of the newest event any action used (epoch ms), or 0: for choosing between plans. */
  actedAt: number;
  /**
   * On foot: the IDs of gear bought for the plan, for the actions with the same gear key that
   * have none yet: the panel writes them (PlanStore.setGearId()).
   */
  gearIds: Array<{ gear: string; suit_id?: number; weapon_id?: number }>;
  /** The stops (plan.stops indexes) the ship was docked or landed at since the plan started. */
  visited: Set<number>;
}

/**
 * When an action counts journal events after (ed-mcp's schema: events after started_at, not at
 * it; a new lap starts at the last lap's newest claim): its own started_at (a lap or a mission
 * save sets it), else the build's, else the plan's (a trade or mission save sets it), else when
 * the plan was made. With no action, the plan's.
 */
const startOf = (plan: Plan, a?: Action) =>
  Date.parse(a?.started_at ?? plan.build?.started_at ?? plan.started_at ?? plan.created_at) || 0;

/** The material count in the inventory, by symbol or name, whatever the case. */
export function materialCount(
  materials: JournalState["materials"],
  name: string | undefined,
  symbol?: string,
): number {
  const keys = [lower(name), lower(symbol)].filter((x): x is string => !!x);
  // "Arsenic" and "arsenic", "Chemical Manipulators" and "chemicalmanipulators".
  const squash = (s: string) => s.replace(/[^a-z0-9]/g, "");
  const want = new Set(keys.flatMap((k) => [k, squash(k)]));
  let n = 0;
  for (const list of Object.values(materials)) {
    for (const m of list) {
      const s = m.symbol.toLowerCase();
      const nm = m.name.toLowerCase();
      if (want.has(s) || want.has(nm) || want.has(squash(nm))) n += m.count;
    }
  }
  return n;
}

const UNLOCKED = (journal: Pick<JournalState, "engineers">, name: string | undefined) =>
  journal.engineers.some((e) => same(e.name, name) && e.progress === "Unlocked");

/** The action kinds of a suit, and of a weapon: a bought one's ID goes to the same gear's. */
const SUIT_KINDS = new Set<string>(["buy_suit", "upgrade_suit", "modify_suit"]);
const WEAPON_KINDS = new Set<string>(["buy_weapon", "upgrade_weapon", "modify_weapon"]);

/**
 * The ID of the suit or weapon an on-foot action is for: its suit_id or weapon_id; else, for gear
 * the player owns (no gear key, which is gear still to buy), the plan's loadout's suit, or the one
 * owned suit of its type, or weapon of its name (in the loadout first). Null when it is not known.
 */
export function gearIdOf(a: Action, plan: Plan, journal: Journal): number | null {
  const suit = SUIT_KINDS.has(a.kind);
  if (!suit && !WEAPON_KINDS.has(a.kind)) return null;
  const own = suit ? a.suit_id : a.weapon_id;
  if (own !== undefined) return own;
  if (a.gear || a.kind === "buy_suit" || a.kind === "buy_weapon") return null;
  const lid = plan.build?.loadout_id;
  const loadout = lid !== undefined ? journal.suit_loadouts?.find((l) => l.id === lid) : undefined;
  const only = <T extends { id: number }>(list: T[]) => (list.length === 1 ? list[0]!.id : null);
  if (suit) {
    const type = suitOf(a.suit)?.type ?? null;
    if (loadout?.suit_id != null) {
      const ls = journal.suits?.find((x) => x.id === loadout.suit_id);
      if (!type || !ls || ls.type === type) return loadout.suit_id;
    }
    return type ? only((journal.suits ?? []).filter((x) => x.type === type)) : null;
  }
  const named = (journal.weapons ?? []).filter((w) => sameWeapon(w.type, w.name, a.weapon));
  const inLoadout = named.filter((w) => loadout?.weapons.some((x) => x.id === w.id));
  return only(inLoadout) ?? only(named);
}

/** The suit or weapon an on-foot action is for, as the journal state has it now. */
function gearOf(a: Action, plan: Plan, journal: Journal) {
  const id = gearIdOf(a, plan, journal);
  if (id === null) return null;
  return SUIT_KINDS.has(a.kind)
    ? (journal.suits?.find((x) => x.id === id) ?? null)
    : (journal.weapons?.find((x) => x.id === id) ?? null);
}

/** An upgrade the suit or weapon shows already, in the newest loadout or upgrade event. */
function gearAt(a: Action, plan: Plan, journal: Journal): boolean {
  if (a.kind !== "upgrade_suit" && a.kind !== "upgrade_weapon") return false;
  const g = gearOf(a, plan, journal);
  return !!g && (g.grade ?? 0) >= targetGrade(a);
}

/** Whether an action judged from the journal state (BY_STATE) is done now. */
function stateDone(a: Action, plan: Plan, journal: Journal): boolean {
  switch (a.kind) {
    case "collect_material":
      return materialCount(journal.materials, a.material) >= (a.count ?? 1);
    case "unlock_engineer":
      return UNLOCKED(journal, a.engineer);
    case "modify_suit":
    case "modify_weapon":
      return !!gearOf(a, plan, journal)?.mods.some((m) => sameMod(m, a.modification));
    case "collect_resource":
      return resourceCount(journal, a.resource) >= (a.count ?? 1);
    default:
      return false;
  }
}

type Journal = Pick<JournalState, "materials" | "engineers"> & {
  events: JournalEvent[];
  /**
   * The ship flown now: a bought hull whose delivery is before the journal's window; and its
   * hold's size, for a buy that fills it.
   */
  ship?: Pick<JournalState["ship"], "id" | "type"> & { cargo_capacity?: number | null };
  /** The hold now, for a buy that fills it and a sale that empties it. */
  cargo?: JournalState["cargo"];
  /** On foot: the suits and weapons (grades and modifications), the locker and the backpack. */
  suits?: JournalState["suits"];
  weapons?: JournalState["weapons"];
  suit_loadouts?: JournalState["suit_loadouts"];
  locker?: JournalState["locker"];
  backpack?: JournalState["backpack"];
};

/** The newest judgement of each plan, by plan ID. */
const cache = new Map<string, { key: string; result: BuildJudgement }>();

/**
 * What a judgement depends on in the journal, cheaply: the events (append-only, so their count and
 * the newest one), the inventory's counts, the engineers unlocked and the ship flown.
 */
function journalKey(journal: Journal): string {
  const counts = Object.values(journal.materials)
    .map((list) => `${list.length}:${list.reduce((n, m) => n + m.count, 0)}`)
    .join(",");
  const unlocked = journal.engineers.filter((e) => e.progress === "Unlocked").length;
  const last = journal.events.at(-1);
  return [
    journal.events.length,
    last ? JSON.stringify(last) : "",
    counts,
    unlocked,
    journal.ship?.id ?? "",
    journal.ship?.type ?? "",
    journal.ship?.cargo_capacity ?? "",
    (journal.cargo ?? []).map((c) => `${c.name}:${c.count}:${c.mission_id}:${c.stolen}`).join(","),
    [...(journal.suits ?? []), ...(journal.weapons ?? [])]
      .map((g) => `${g.id}:${g.grade}:${g.mods.join("+")}`)
      .join(","),
    journal.locker?.as_of ?? "",
    journal.backpack?.as_of ?? "",
  ].join("|");
}

/**
 * What a judgement depends on in a plan, cheaply: its ID and updated_at (every store write sets
 * it), and each stop's and action's status and claims, for a plan changed in memory.
 */
const planKey = (plan: Plan) =>
  [
    plan.id,
    plan.updated_at,
    plan.build?.ship_id ?? "",
    plan.lap ?? "",
    plan.started_at ?? "",
    ...plan.stops.map(
      (s) =>
        s.status +
        (s.actions ?? []).map((a) => `${a.id}:${a.status}:${a.done_by?.length ?? "-"}`).join(","),
    ),
  ].join("|");

/**
 * Judges a build plan's actions from the journal (see "Actions" in the build panel spec). Kept
 * for the same journal, plan and inventory: the panel, its mode and ActionFinisher all ask on every
 * poll. The plan is keyed by its content, so the same plan read again is not judged again.
 */
export function judgeBuild(plan: Plan, journal: Journal): BuildJudgement {
  const key = `${planKey(plan)}#${journalKey(journal)}`;
  const kept = cache.get(plan.id);
  if (kept?.key === key) return kept.result;
  const result = judge(plan, journal);
  // One judgement kept for each plan: the newest.
  cache.set(plan.id, { key, result });
  return result;
}

function judge(plan: Plan, journal: Journal): BuildJudgement {
  const events = journal.events;
  const started = startOf(plan);
  const updated = Date.parse(plan.updated_at) || Infinity;
  const hasBuyShip = plan.stops.some((s) => s.actions?.some((a) => a.kind === "buy_ship"));
  // The plan's ship: its ship_id; else none until a bought hull is delivered (a buy_ship plan);
  // else the first ship of its type (or of any type, when it names none) an action is done on.
  let boundId: number | null = plan.build?.ship_id ?? null;
  const shipType = lower(plan.build?.ship);
  // A hull marked bought whose delivery (ShipyardNew) is before the journal's window: the ship
  // flown now, when it is of that type.
  const hull = plan.stops
    .flatMap((s) => s.actions ?? [])
    .find((a) => a.kind === "buy_ship" && a.status === "done");
  const hullType = lower(hull?.ship ?? plan.build?.ship);
  if (
    boundId === null &&
    hull &&
    hullType &&
    !events.some((e) => e.event === "ShipyardNew" && lower(e.ShipType) === hullType) &&
    journal.ship?.id != null &&
    lower(journal.ship.type) === hullType
  )
    boundId = journal.ship.id;
  const fromPlan = plan.build?.ship_id !== undefined;
  // The hull type a done buy_ship waits for ("" for any), until its ShipyardNew binds it.
  let armed: string | null = null;
  const armFor = (a: Action) => lower(a.ship ?? plan.build?.ship) ?? "";
  const shipOk = (ship: ShipOf | null) => {
    if (!ship) return true;
    if (boundId !== null) return ship.id === boundId;
    if (hasBuyShip) return false;
    return !shipType || ship.type === shipType;
  };

  type Entry = ActionJudgement & {
    mode: "reserved" | "adopt" | "open" | "skip";
    /** When it counts events from (startOf()), and how much it takes (needOf()). */
    start: number;
    need: number;
    /** A CargoDepot showed all of its mission's cargo collected or delivered. */
    full: boolean;
    /** The docking (dock.id) of its newest claim, or null. */
    claimDock: number | null;
    /** A buy_suit or buy_weapon: the SuitID or SuitModuleID its claim bought. */
    gotId: number | null;
    /** An upgrade or modification: the ID of its suit or weapon (gearIdOf()), or null. */
    gearId: number | null;
  };
  const list: Entry[] = [];
  for (const si of visitOrder(plan)) {
    for (const a of plan.stops[si]!.actions ?? []) {
      const mode =
        a.status === "skipped" || !judged(a)
          ? "skip"
          : a.status === "done"
            ? a.done_by
              ? "reserved"
              : BY_STATE.has(a.kind)
                ? "skip"
                : "adopt"
            : "open";
      list.push({
        stop: si,
        action: a,
        done: a.status !== "todo",
        write: null,
        claims: [],
        lastClaim: -1,
        taken: 0,
        fitted: null,
        notFitted: false,
        mode,
        start: startOf(plan, a),
        need: needOf(a),
        full: false,
        claimDock: null,
        gotId: null,
        gearId: gearIdOf(a, plan, journal),
      });
    }
  }
  // Actions marked done by hand take the events before they were marked first; then the open
  // actions, in plan order.
  const opens = list.filter((x) => x.mode === "open");
  const adoptThenOpen = [...list.filter((x) => x.mode === "adopt"), ...opens];
  // done_by claims already in the plan, by event and role: what they took.
  const reserved = new Map<string, { entry: (typeof list)[number]; amount: number }[]>();
  for (const entry of list) {
    if (entry.mode !== "reserved") continue;
    for (const c of entry.action.done_by ?? []) {
      const k = `${refKey(c)}|${c.role}`;
      reserved.set(k, [...(reserved.get(k) ?? []), { entry, amount: c.amount ?? 1 }]);
    }
  }

  const matched = new Set<JournalEvent>();
  const visited = new Set<number>();
  let lastMatch = -1;
  let actedAt = 0;
  const count = new Map<string, number>();
  let flying: ShipOf = { id: null, type: null };
  // Where the ship is docked, for the actions done at a stop's station: unknown until an event says.
  let place: Place | null = null;
  // The docking the ship is in, numbered, or null when not docked: a relog while docked (Location,
  // Docked true, at the same station) is the same docking.
  let dock: { id: number; station: string | null } | null = null;
  let docks = 0;
  // The earliest any action counts from: an event before it is no action's.
  const earliest = Math.min(started, ...list.map((x) => x.start));
  // The modules fitted, by ShipID and slot; and the index of each ship's newest Loadout.
  const fittedBy = new Map<number, Map<string, Fitted>>();
  const loadoutAt = new Map<number, number>();
  const mark = (i: number, e: JournalEvent) => {
    matched.add(e);
    lastMatch = Math.max(lastMatch, i);
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const ck = `${e.timestamp}|${e.event}`;
    const n = count.get(ck) ?? 0;
    count.set(ck, n + 1);
    const ref: EventRef = { at: e.timestamp, event: e.event, n };
    const t = Date.parse(e.timestamp);
    const f = flown(e);
    if (f) flying = f;
    const moving = moved(e, place);
    if (moving !== undefined) place = moving;
    // Docked at a stop since the plan started (or there when it started), or come to a
    // settlement stop's landing area.
    const here =
      e.event === "ApproachSettlement"
        ? { system: str(e.StarSystem) ?? place?.system ?? null, station: str(e.Name) }
        : place;
    if (here?.station && t > started && visited.size < plan.stops.length)
      for (const si of visitOrder(plan))
        if (!visited.has(si) && atStop(plan.stops[si]!, here)) visited.add(si);
    if (e.event === "Docked" || (e.event === "Location" && e.Docked === true)) {
      const station = str(e.StationName);
      if (!(e.event === "Location" && dock && same(dock.station, station)))
        dock = { id: ++docks, station };
    } else if (
      e.event === "Undocked" ||
      e.event === "FSDJump" ||
      e.event === "Died" ||
      (e.event === "CarrierJump" && e.Docked !== true) ||
      (e.event === "Location" && e.Docked !== true)
    )
      dock = null;
    if (e.event === "Loadout" && f?.id != null) {
      const slots = new Map<string, Fitted>();
      for (const m of objs(e.Modules)) {
        const slot = lower(m.Slot);
        if (slot) slots.set(slot, fittedOf(m));
      }
      fittedBy.set(f.id, slots);
      loadoutAt.set(f.id, i);
    }
    if (e.event === "EngineerCraft" && flying.id !== null) {
      const slots = fittedBy.get(flying.id) ?? new Map<string, Fitted>();
      const slot = lower(e.Slot);
      if (slot) {
        const was = slots.get(slot);
        slots.set(slot, {
          item: mod(e.Module) ?? was?.item ?? null,
          blueprint: str(e.BlueprintName),
          level: num(e.Level),
          quality: num(e.Quality),
          experimental:
            lower(e.ApplyExperimentalEffect) ??
            lower(e.ExperimentalEffect) ??
            was?.experimental ??
            null,
        });
      }
      fittedBy.set(flying.id, slots);
    }
    // A bought hull is the plan's ship once delivered: another ship delivered meanwhile is not.
    if (
      e.event === "ShipyardNew" &&
      armed !== null &&
      boundId === null &&
      (armed === "" || lower(e.ShipType) === armed)
    ) {
      boundId = num(e.NewShipID);
      armed = null;
    }
    // A single engineer's progress unlocking an engineer the plan asks for turns the mode on.
    if (
      e.event === "EngineerProgress" &&
      !Array.isArray(e.Engineers) &&
      e.Progress === "Unlocked" &&
      t > started &&
      list.some(
        (x) => x.action.kind === "unlock_engineer" && same(x.action.engineer, str(e.Engineer)),
      )
    )
      mark(i, e);

    for (const r of rolesOf(e, flying, place)) {
      let left = r.amount;
      for (const res of reserved.get(`${refKey(ref)}|${r.name}`) ?? []) {
        left -= res.amount;
        res.entry.claims.push({
          ...ref,
          role: r.name,
          ...(BY_SUM.has(res.entry.action.kind) ? { amount: res.amount } : {}),
        });
        res.entry.lastClaim = i;
        res.entry.taken += res.amount;
        if (r.gearId != null) res.entry.gotId = r.gearId;
        if (boundId === null && !hasBuyShip && r.ship?.id != null && shipOk(r.ship))
          boundId = r.ship.id;
        if (res.entry.action.kind === "buy_ship" && boundId === null)
          armed = armFor(res.entry.action);
        mark(i, e);
        if (!Number.isNaN(t)) actedAt = Math.max(actedAt, t);
      }
      if (left <= 0 || Number.isNaN(t) || t <= earliest || !shipOk(r.ship)) continue;
      // Actions marked done by hand take the events before they were marked first; then the
      // open actions, in plan order.
      const order = t <= updated ? adoptThenOpen : opens;
      for (const entry of order) {
        const need = entry.need;
        if (entry.full || entry.taken >= need || t <= entry.start) continue;
        if (!matches(entry.action, r, plan, plan.stops[entry.stop]!, boundId, entry.gearId))
          continue;
        const take = Math.min(left, need - entry.taken);
        if (r.all) entry.full = true;
        entry.taken += take;
        entry.claims.push({
          ...ref,
          role: r.name,
          ...(BY_SUM.has(entry.action.kind) ? { amount: take } : {}),
        });
        entry.lastClaim = i;
        entry.claimDock = dock?.id ?? null;
        if (r.gearId != null) entry.gotId = r.gearId;
        left -= take;
        mark(i, e);
        actedAt = Math.max(actedAt, t);
        if (boundId === null && !hasBuyShip && r.ship?.id != null) boundId = r.ship.id;
        if (entry.action.kind === "buy_ship" && entry.taken >= need && boundId === null)
          armed = armFor(entry.action);
        if (left <= 0 || !BY_SUM.has(entry.action.kind)) break;
        // The rest of a CargoDepot's count is that mission's: no other action's.
        if (r.all) break;
      }
    }
    // A craft at a lower grade than an open engineer action asks for: its progress, for the mode.
    if (e.event === "EngineerCraft" && !matched.has(e) && t > started && shipOk(flying)) {
      const slot = str(e.Slot);
      const bp = str(e.BlueprintName);
      if (
        list.some(
          (x) =>
            x.mode === "open" &&
            x.action.kind === "engineer" &&
            same(x.action.slot, slot) &&
            same(x.action.blueprint, bp),
        )
      )
        mark(i, e);
    }
  }

  const fittedNow = boundId !== null ? fittedBy.get(boundId) : undefined;
  // The plan and its lap (and start), for a write that names no event: an action marked by hand on
  // lap 2 is not lap 1's, which was written already.
  const lapKey = `${plan.id}|${plan.lap ?? 1}|${plan.started_at ?? ""}`;
  for (const entry of list) {
    const a = entry.action;
    const slot = lower(a.slot);
    if (a.kind === "engineer" || a.kind === "experimental")
      entry.fitted = slot ? (fittedNow?.get(slot) ?? null) : null;
    if (entry.mode === "open") {
      let doneNow = false;
      if (BY_STATE.has(a.kind)) {
        doneNow = stateDone(a, plan, journal);
        if (doneNow) entry.write = { status: "done", key: `${lapKey}|${a.id}` };
      } else if (
        entry.full ||
        entry.taken >= entry.need ||
        // The hold as it is now says what was done at the stop only in the docking of the claims.
        (entry.claimDock !== null && entry.claimDock === dock?.id && holdDone(entry, journal))
      ) {
        doneNow = true;
        const lastRef = entry.claims.at(-1)!;
        entry.write = {
          status: "done",
          done_by: entry.claims,
          key: `${plan.id}|${a.id}|${refKey(lastRef)}`,
        };
      } else if (gearAt(a, plan, journal)) {
        // On foot the loadout is the record: an upgrade the suit or weapon shows already is done,
        // with no event to name (its UpgradeSuit before the plan, say).
        doneNow = true;
        entry.write = { status: "done", key: `${lapKey}|${a.id}` };
      }
      entry.done = doneNow;
    } else if (entry.mode === "adopt") {
      // Written once, even empty, so the real event is not counted again for the next action.
      entry.write = { done_by: entry.claims, key: `${lapKey}|${a.id}|adopt` };
    }
    if (entry.done && boundId !== null)
      entry.notFitted = notFitted(entry, fittedNow, loadoutAt.get(boundId));
  }
  // A bought suit's or weapon's ID, for the actions sharing its gear key that have none. A buy
  // marked done with no event (by hand, or bought before the plan) takes the newest such buy.
  const gearIds: BuildJudgement["gearIds"] = [];
  for (const entry of list) {
    const a = entry.action;
    if (!a.gear || !entry.done) continue;
    if (entry.gotId === null && (a.kind === "buy_suit" || a.kind === "buy_weapon")) {
      for (let i = events.length - 1; i >= 0 && entry.gotId === null; i--) {
        for (const r of rolesOf(events[i]!, flying, null)) {
          if (r.gearId != null && matches(a, r, plan, plan.stops[entry.stop]!, boundId)) {
            entry.gotId = r.gearId;
            break;
          }
        }
      }
    }
    if (entry.gotId === null) continue;
    const field = a.kind === "buy_suit" ? "suit_id" : a.kind === "buy_weapon" ? "weapon_id" : null;
    if (!field) continue;
    const kinds = field === "suit_id" ? SUIT_KINDS : WEAPON_KINDS;
    const waiting = list.some(
      (y) => y.action.gear === a.gear && kinds.has(y.action.kind) && y.action[field] === undefined,
    );
    if (waiting) gearIds.push({ gear: a.gear, [field]: entry.gotId });
  }
  return {
    plan,
    gearIds,
    visited,
    actions: list.map(
      ({ mode: _m, start: _s, need: _n, full: _f, claimDock: _d, gotId: _g, gearId: _i, ...x }) =>
        x,
    ),
    boundId: !fromPlan && boundId !== null ? boundId : null,
    shipId: boundId,
    matched,
    lastMatch,
    actedAt,
  };
}

/**
 * A buy or sale under its count, done as the hold shows: a buy that filled the hold (the plan's
 * tons did not fit, with limpets aboard, say) and a sale that left none of it aboard (less was
 * bought than planned). Only once some of it was bought or sold, and (the caller checks) while
 * still docked where it was: the hold now says nothing about a stop left behind.
 */
function holdDone(x: ActionJudgement, journal: Journal): boolean {
  const a = x.action;
  const cargo = journal.cargo;
  if (x.taken <= 0 || !cargo) return false;
  if (a.kind === "buy_commodity") {
    const capacity = journal.ship?.cargo_capacity ?? null;
    // Full, with the goods aboard. A hold of 0 (no Loadout read yet, or no racks) is not full.
    return (
      capacity !== null &&
      capacity > 0 &&
      !!a.commodity &&
      held(cargo, a.commodity) > 0 &&
      used(cargo) >= capacity
    );
  }
  if (a.kind === "sell_commodity") return !!a.commodity && held(cargo, a.commodity) === 0;
  return false;
}

/**
 * The Loadout as a cross-check: a done action whose module the ship's newest Loadout (written
 * after the action) no longer shows. Not judged without such a Loadout.
 */
function notFitted(
  entry: ActionJudgement,
  fitted: Map<string, Fitted> | undefined,
  loadout: number | undefined,
): boolean {
  const a = entry.action;
  if (!fitted || loadout === undefined || loadout < entry.lastClaim) return false;
  const slot = lower(a.slot);
  const all = [...fitted.values()];
  switch (a.kind) {
    case "buy_module":
      // With no slot it may have been bought into storage (ModuleBuyAndStore): not fitted at all.
      if (!slot || entry.claims.some((c) => c.event === "ModuleBuyAndStore")) return false;
      return fitted.get(slot)?.item !== mod(a.module);
    case "retrieve_module": {
      const m = mod(a.module);
      const here = slot ? fitted.get(slot) : null;
      if (slot) return !here || here.item !== m;
      return !all.some((x) => x.item === m);
    }
    case "engineer": {
      const here = slot ? fitted.get(slot) : null;
      return !here || !same(here.blueprint, a.blueprint) || (here.level ?? 0) < targetGrade(a);
    }
    case "experimental": {
      const here = slot ? fitted.get(slot) : null;
      return !here || here.experimental !== lower(a.experimental);
    }
    default:
      return false;
  }
}

// ---------- Engineering: rolls left ----------

/** Rolls for grades 1 to 5 when the plan gives none, as ed-mcp's materials_plan has it. */
export const DEFAULT_ROLLS = [1, 2, 3, 4, 5];

/**
 * The rolls an engineer action still needs, by grade: to fill the grade reached (its rolls times
 * the quality left, rounded up), each grade above up to the one below the target, and one roll of
 * the target, which finishes the action at any quality. A module with no blueprint, or another,
 * starts again at G1.
 */
export function rollsLeft(
  a: Action,
  fitted: Fitted | null,
  rollsPerGrade: number[] = DEFAULT_ROLLS,
): Map<number, number> {
  const target = targetGrade(a);
  const out = new Map<number, number>();
  const per = (g: number) => rollsPerGrade[g - 1] ?? DEFAULT_ROLLS[g - 1]!;
  const sameBp = !!fitted && same(fitted.blueprint, a.blueprint) && (fitted.level ?? 0) > 0;
  const g = sameBp ? fitted!.level! : 0;
  if (g >= target) return out;
  if (g > 0) {
    const fill = Math.ceil(per(g) * (1 - (fitted!.quality ?? 0)) - 1e-9);
    if (fill > 0) out.set(g, fill);
  }
  for (let k = Math.max(1, g + 1); k < target; k++) if (per(k) > 0) out.set(k, per(k));
  out.set(target, 1);
  return out;
}

type NeedMaterial = NonNullable<NonNullable<Action["needs"]>["materials"]>[number];

/** The materials an action still needs: an engineer action's rolls left times each grade's. */
export function materialsLeft(
  a: Action,
  fitted: Fitted | null,
  rollsPerGrade?: number[],
): NeedMaterial[] {
  if (a.kind !== "engineer" || !a.needs_by_grade) return a.needs?.materials ?? [];
  const total = new Map<string, NeedMaterial>();
  for (const [g, rolls] of rollsLeft(a, fitted, rollsPerGrade)) {
    const per = a.needs_by_grade[String(g)] ?? a.needs_by_grade[`G${g}`];
    for (const m of per?.materials ?? []) {
      const k = (m.symbol ?? m.name).toLowerCase();
      const was = total.get(k);
      total.set(k, { ...m, count: (was?.count ?? 0) + m.count * rolls });
    }
  }
  return [...total.values()];
}
