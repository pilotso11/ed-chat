// Values in settings.json by dotted path, such as "hud.mining.targets".

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export function getAt(o: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), o);
}

/**
 * Sets the value at path, creating groups on the way. undefined deletes the key, and each group
 * that this leaves empty, so a setting put back to its default leaves no "{}" behind.
 */
export function setAt(o: Obj, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const chain: Obj[] = [o];
  for (const k of keys) {
    const at = chain.at(-1)!;
    if (!isObj(at[k])) {
      if (value === undefined) return;
      at[k] = {};
    }
    chain.push(at[k] as Obj);
  }
  if (value !== undefined) {
    chain.at(-1)![last] = structuredClone(value);
    return;
  }
  delete chain.at(-1)![last];
  for (let i = keys.length - 1; i >= 0; i--) {
    if (Object.keys(chain[i + 1]!).length) break;
    delete chain[i]![keys[i]!];
  }
}

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
