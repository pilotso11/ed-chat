// Turns vitest's coverage/coverage-summary.json into the file the README's coverage badge reads.
// The release workflow attaches it to each GitHub Release, and shields.io's dynamic JSON badge
// reads `message` from the latest one (its endpoint badge refuses github.com URLs):
//   npx tsx scripts/coverage-badge.ts [summary.json] [out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The badge text for the whole of src: the share of lines the unit tests run, rounded down. */
export function coverageBadge(summary: unknown): { message: string } {
  const pct = (summary as { total?: { lines?: { pct?: unknown } } } | null)?.total?.lines?.pct;
  if (typeof pct !== "number" || !Number.isFinite(pct)) throw new Error("no line coverage");
  return { message: `${Math.floor(pct)}%` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [from = "coverage/coverage-summary.json", to = "coverage/coverage.json"] =
    process.argv.slice(2);
  const badge = coverageBadge(JSON.parse(readFileSync(from, "utf8")));
  writeFileSync(to, JSON.stringify(badge) + "\n");
  console.log(`coverage badge: ${badge.message}`);
}
