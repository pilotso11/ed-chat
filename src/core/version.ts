import edMcpPackage from "ed-mcp/package.json" with { type: "json" };
import { AGENTS, type AgentId } from "./backend.js";
import type { EdMcpState } from "./backends/claude/command.js";
import { isOlder, parseCliVersion } from "./cli.js";

/** The ed-mcp that ED Chat bundles for the activity panel. */
export const BUNDLED_ED_MCP: string = edMcpPackage.version;

/** Each assistant CLI's version; null or missing: not found or not checked yet. */
export type CliVersions = Partial<Record<AgentId, string | null>>;

export interface Versions extends CliVersions {
  app: string;
  /** The assistant that runs. Default claude. */
  agent?: AgentId;
  /** How the assistant's own ed-mcp started, from the CLI's last ready message. */
  edMcpStatus: EdMcpState | null;
  /** The latest ed-mcp on npm: what `npx ed-mcp@latest` runs. "checking" while it loads. */
  edMcpLatest: string | "checking" | null;
}

function newer(a: string, b: string): boolean {
  const x = parseCliVersion(a);
  const y = parseCliVersion(b);
  return !!x && !!y && isOlder(y, x);
}

// At startup the CLI lists the servers it will start, not yet whether each one works.
const STATUS: Record<Exclude<EdMcpState, "missing">, string> = {
  ok: "added",
  failed: "failed to start",
  needsAuth: "needs authentication",
};
const status = (s: EdMcpState, cli: string): string =>
  s === "missing" ? `not added to ${cli}` : STATUS[s];

/** The /version reply: one line per program. */
export function versionText(v: Versions): string {
  const latest =
    v.edMcpLatest === "checking"
      ? "checking npm…"
      : v.edMcpLatest === null
        ? "could not read the latest from npm"
        : `latest on npm ${v.edMcpLatest}`;
  const id = v.agent ?? "claude";
  const agent = AGENTS[id];
  const lines = [
    `ED Chat ${v.app}`,
    `${agent.cli} ${v[id] ?? "not found"}`,
    `ed-mcp for ${agent.name}: ${v.edMcpStatus ? status(v.edMcpStatus, agent.cli) : "not started yet"}, ${latest}`,
    `ed-mcp in ED Chat: ${BUNDLED_ED_MCP} (activity panel)`,
  ];
  if (v.edMcpLatest && v.edMcpLatest !== "checking" && newer(v.edMcpLatest, BUNDLED_ED_MCP))
    lines.push("A newer ED Chat release may carry the newer ed-mcp.");
  return lines.join("\n");
}

const NPM_LATEST = "https://registry.npmjs.org/ed-mcp/latest";

/** The latest ed-mcp version on npm, or null when npm cannot be reached. */
export async function fetchLatestEdMcp(
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<string | null> {
  try {
    const res = await fetchFn(NPM_LATEST, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && parseCliVersion(body.version) ? body.version : null;
  } catch {
    return null;
  }
}
