import type { JournalState } from "ed-mcp/journal";

// On foot: the names of suits, weapons, modifications and resources, as a plan may give them and
// as the journal writes them, and the counts in the ship locker and backpack.

/** Lower case, letters and digits only: "Extra Ammo Capacity" and "extraammocapacity". */
export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The suits' journal types by their game names. */
const SUITS: Record<string, string> = {
  dominator: "tacticalsuit",
  maverick: "utilitysuit",
  artemis: "explorationsuit",
  flightsuit: "flightsuit",
  remlok: "flightsuit",
};

/** A suit's game name for its journal type ("tacticalsuit" is the Dominator). */
export const SUIT_NAMES: Record<string, string> = {
  tacticalsuit: "Dominator",
  utilitysuit: "Maverick",
  explorationsuit: "Artemis",
  flightsuit: "Flight Suit",
};

/**
 * A suit as a plan names it, as its journal type and the grade in the name, if any: "Dominator",
 * "tacticalsuit", "TacticalSuit_Class3" or "Dominator G3".
 */
export function suitOf(name: string | undefined): { type: string; grade: number | null } | null {
  if (!name) return null;
  const cls = /_class(\d)$/i.exec(name);
  const g = cls ?? /\bg(\d)$/i.exec(name.trim());
  const base = squash(name.replace(/_class\d$/i, "").replace(/\bg\d$/i, ""));
  return { type: SUITS[base] ?? base, grade: g ? Number(g[1]) : null };
}

/**
 * The modifications' game names by their journal symbols, from the journals read for the spec and
 * the game's list. A plan may give either.
 */
const MODS: Record<string, string> = {
  suit_increasedammoreserves: "Extra Ammo Capacity",
  suit_increasedsprintduration: "Increased Sprint Duration",
  suit_quieterfootsteps: "Quieter Footsteps",
  suit_backpackcapacity: "Extra Backpack Capacity",
  suit_increasedshieldregen: "Faster Shield Regen",
  suit_increasedbatterycapacity: "Improved Battery Capacity",
  suit_reducedtoolbatteryconsumption: "Reduced Tool Battery Consumption",
  suit_nightvision: "Night Vision",
  suit_increasedmeleedamage: "Added Melee Damage",
  suit_improvedjumpassist: "Improved Jump Assist",
  suit_enhancedtracking: "Enhanced Tracking",
  suit_increasedo2capacity: "Increased Air Reserves",
  suit_damageresistance: "Damage Resistance",
  suit_combatmovementspeed: "Combat Movement Speed",
  weapon_range: "Greater Range",
  weapon_clipsize: "Magazine Size",
  weapon_suppression_pressurised: "Noise Suppressor",
  weapon_suppression_unpressurised: "Audio Masking",
  weapon_backpackreloading: "Stowed Reloading",
  weapon_handling: "Faster Handling",
  weapon_stability: "Stability",
  weapon_headshotdamage: "Headshot Damage",
  weapon_scope: "Scope",
  weapon_reloadspeed: "Reload Speed",
  weapon_accuracy: "Improved Hip Fire Accuracy",
};

/** Whether a modification the journal names (a symbol) is the one a plan names. */
export function sameMod(symbol: string, planned: string | undefined): boolean {
  if (!planned) return false;
  const want = squash(planned);
  const s = symbol.toLowerCase();
  const bare = s.replace(/^(suit|weapon)_/, "");
  return [s, bare, MODS[s] ?? ""].some((x) => x && squash(x) === want);
}

/** Whether a weapon in the journal (its type, and its game name when known) is the planned one. */
export function sameWeapon(type: string | null, name: string | null, planned: string | undefined) {
  if (!planned) return false;
  const want = squash(planned);
  return [type, name].some((x) => !!x && squash(x) === want);
}

/**
 * How many of a resource the ship locker and backpack hold together, by journal name or game
 * name, whatever the case.
 */
export function resourceCount(
  journal: { locker?: JournalState["locker"]; backpack?: JournalState["backpack"] },
  name: string | undefined,
): number {
  if (!name) return 0;
  const want = squash(name);
  let n = 0;
  for (const box of [journal.locker, journal.backpack]) {
    if (!box) continue;
    for (const list of [box.items, box.components, box.consumables, box.data]) {
      for (const r of list) {
        if (squash(r.name) === want || (r.name_localised && squash(r.name_localised) === want))
          n += r.count;
      }
    }
  }
  return n;
}
