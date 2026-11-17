// The settings that only the player may change are locked in the app, not only in the prompt:
// a change to them in settings.json waits until the player applies it. Claude can edit the
// file, and text from the game reaches Claude, so the prompt alone is not enough.
//
// The values are kept as settings.json writes them, not as parsed settings: a key that the
// file does not set is absent, so Undo can remove it again and the default applies.
import { PLAYER_ONLY_PATHS } from "./settingsDictionary.js";

/** Each player-only setting as settings.json sets it. A setting the file leaves out is absent. */
export type PlayerOnlyValues = Record<string, unknown>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function getAt(o: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), o);
}

/** Sets the value at path, creating groups on the way; undefined deletes the key. */
function setAt(o: Obj, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let at = o;
  for (const k of keys) {
    if (!isObj(at[k])) {
      if (value === undefined) return;
      at[k] = {};
    }
    at = at[k] as Obj;
  }
  if (value === undefined) delete at[last];
  else at[last] = structuredClone(value);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The player-only settings in settings.json text. Text that is not a JSON object sets none. */
export function playerOnlyValues(text: string): PlayerOnlyValues {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const values: PlayerOnlyValues = {};
  for (const p of PLAYER_ONLY_PATHS) {
    const v = getAt(raw, p);
    if (v !== undefined) values[p] = structuredClone(v);
  }
  return values;
}

/** The player-only settings that differ between the two. */
export function changedPaths(from: PlayerOnlyValues, to: PlayerOnlyValues): string[] {
  return PLAYER_ONLY_PATHS.filter((p) => !same(from[p], to[p]));
}

/** settings.json text with the player-only settings set to these values, the rest kept. */
export function withValues(text: string, values: PlayerOnlyValues): string {
  const raw = JSON.parse(text) as unknown;
  if (!isObj(raw)) throw new Error("settings.json is not an object");
  for (const p of PLAYER_ONLY_PATHS) setAt(raw, p, values[p]);
  return JSON.stringify(raw, null, 2) + "\n";
}

// In full: the player decides on these values, so none of a value may be hidden.
const show = (v: unknown) => (v === undefined ? "(default)" : JSON.stringify(v));

/** One line per changed value, for the question to the player. */
export function describeChanges(
  from: PlayerOnlyValues,
  to: PlayerOnlyValues,
  paths: string[],
): string[] {
  return paths.flatMap((p) => {
    const a = from[p];
    const b = to[p];
    if (isObj(a) || isObj(b)) {
      const x = isObj(a) ? a : {};
      const y = isObj(b) ? b : {};
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])];
      return keys
        .filter((k) => !same(x[k], y[k]))
        .map((k) => `${p}.${k}: ${show(x[k])} → ${show(y[k])}`);
    }
    return [`${p}: ${show(a)} → ${show(b)}`];
  });
}
