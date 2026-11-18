import { existsSync } from "node:fs";
import path from "node:path";

export interface ResolvedCommand {
  command: string;
  shell: boolean;
}

export const isCmdShim = (p: string) => /\.(cmd|bat)$/i.test(p);

export interface CliLookup {
  /** File names to look for on PATH, in order. */
  names: string[];
  /**
   * Install locations to try after PATH. ED Chat started from a shortcut may not see a PATH
   * change made after login, and some installers do not change PATH at all.
   */
  defaultPaths?: string[];
}

/** The configured path, then each name on PATH, then the default install locations. */
export function resolveCli(
  lookup: CliLookup,
  configured: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): ResolvedCommand | null {
  if (configured)
    return exists(configured) ? { command: configured, shell: isCmdShim(configured) } : null;
  const win = platform === "win32";
  const dirs = (env.PATH ?? env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
  const join = win ? path.win32.join : path.posix.join;
  for (const name of lookup.names) {
    for (const d of dirs) {
      const p = join(d, name);
      if (exists(p)) return { command: p, shell: isCmdShim(p) };
    }
  }
  for (const p of lookup.defaultPaths ?? []) {
    if (exists(p)) return { command: p, shell: isCmdShim(p) };
  }
  return null;
}

export function quoteForCmd(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

export type Version = [number, number, number];

export function parseCliVersion(out: string): Version | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isOlder(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}
