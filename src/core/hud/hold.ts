import type { JournalState } from "ed-mcp/journal";
import { commodityKey } from "./mining.js";

// The hold, for the trade panel and the judge of buy and sell actions.

type Cargo = JournalState["cargo"];

/** Cargo the ship may trade: not limpets, not a mission's, not stolen (a black market's). */
export const tradable = (c: Cargo[number]) =>
  c.count > 0 && c.mission_id === null && !c.stolen && commodityKey(c.name) !== "drones";

/** Tons of a commodity aboard that the ship may trade. */
export function held(cargo: Cargo, commodity: string): number {
  const key = commodityKey(commodity);
  return cargo
    .filter((c) => tradable(c) && commodityKey(c.name) === key)
    .reduce((n, c) => n + c.count, 0);
}

/** Tons aboard, of everything: what fills the hold. */
export const used = (cargo: Cargo) => cargo.reduce((n, c) => n + c.count, 0);
