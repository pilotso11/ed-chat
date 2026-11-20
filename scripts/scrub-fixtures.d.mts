// Types for scrub-fixtures.mjs, for the tests.
export interface Scrubber {
  text(s: string): string;
  json<T>(v: T): T;
  /** The names and FIDs still in the text. */
  leaks(s: string): string[];
}
export function makeScrubber(who: {
  home?: string;
  user?: string;
  commander?: string;
  fid?: string;
  commanders?: string[];
  fids?: string[];
}): Scrubber;
export function commandersFromJournals(dir: string): { name: string; fid?: string }[];
export function scrubClaudeLine(
  j: Record<string, unknown>,
  scrub: Scrubber,
): Record<string, unknown>;
export function scrubCodexLines(lines: string[], scrub: Scrubber): string[];
export function commanderFromJournal(dir: string): { name: string; fid?: string } | null;
