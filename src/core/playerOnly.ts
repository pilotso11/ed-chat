// The settings that only the player may change are locked in the app, not only in the prompt:
// a change to them in settings.json waits until the player applies it. Claude can edit the
// file, and text from the game reaches Claude, so the prompt alone is not enough.
import type { Settings } from "./settings.js";
import { PLAYER_ONLY_PATHS } from "./settingsDictionary.js";

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

/** The player-only settings that differ between the two. */
export function playerOnlyChanges(from: Settings, to: Settings): string[] {
  return PLAYER_ONLY_PATHS.filter((p) => !same(getAt(from, p), getAt(to, p)));
}

/** The new settings, with the player-only ones as they were. */
export function keepPlayerOnly(next: Settings, applied: Settings): Settings {
  const s = structuredClone(next) as unknown as Obj;
  for (const p of PLAYER_ONLY_PATHS) setAt(s, p, getAt(applied, p));
  return s as unknown as Settings;
}

const show = (v: unknown) => {
  const t = v === undefined ? "(default)" : JSON.stringify(v);
  return t.length > 80 ? t.slice(0, 79) + "…" : t;
};

/** One line per changed value, for the question to the player. */
export function describeChanges(from: Settings, to: Settings, paths: string[]): string[] {
  return paths.flatMap((p) => {
    const a = getAt(from, p);
    const b = getAt(to, p);
    if (isObj(a) && isObj(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      return keys
        .filter((k) => !same(a[k], b[k]))
        .map((k) => `${p}.${k}: ${show(a[k])} → ${show(b[k])}`);
    }
    return [`${p}: ${show(a)} → ${show(b)}`];
  });
}

/**
 * settings.json text with the given settings put back as they were in the earlier text. A
 * setting the earlier file did not set is removed, so it takes its default again.
 * A broken earlier file counts as an empty one.
 */
export function restorePaths(text: string, earlierText: string, paths: string[]): string {
  const raw = JSON.parse(text) as unknown;
  let earlier: unknown;
  try {
    earlier = JSON.parse(earlierText);
  } catch {
    // ED Chat started with a broken file: the settings go back to their defaults.
    earlier = {};
  }
  if (!isObj(raw)) throw new Error("settings.json is not an object");
  for (const p of paths) setAt(raw, p, getAt(earlier, p));
  return JSON.stringify(raw, null, 2) + "\n";
}
