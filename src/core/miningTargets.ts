/**
 * The mining targets that apply unless hud.mining.targets changes them: the least percentage of
 * each commodity in a rock worth mining. In a module of its own, since both the settings schema
 * and the settings dictionary read it.
 */
export const DEFAULT_MINING_TARGETS: Readonly<Record<string, number>> = {
  Platinum: 20,
  Painite: 25,
  Osmium: 25,
  "Low Temperature Diamonds": 25,
  Bromellite: 25,
  Tritium: 30,
};
