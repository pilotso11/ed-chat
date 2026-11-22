/** Reading fields of journal events and Spansh records, which are untyped JSON. */
export type Obj = Record<string, unknown>;
export const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
export const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
export const objs = (v: unknown): Obj[] =>
  Array.isArray(v) ? v.filter((x): x is Obj => typeof x === "object" && x !== null) : [];

/** Two names of one thing (a system, a station, a label), whatever their case. */
export const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
