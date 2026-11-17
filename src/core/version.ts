import edMcpPackage from "ed-mcp/package.json" with { type: "json" };
import { isOlder, parseCliVersion, type EdMcpState } from "./claudeCommand.js";

/** The ed-mcp that ED Chat bundles for the activity panel. */
export const BUNDLED_ED_MCP: string = edMcpPackage.version;

export interface Versions {
  app: string;
  /** null: not checked yet. */
  claude: string | null;
  /** How Claude's own ed-mcp started, from the CLI's last ready message. */
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
const STATUS: Record<EdMcpState, string> = {
  ok: "added",
  missing: "not added to claude",
  failed: "failed to start",
  needsAuth: "needs authentication",
};

/** The /version reply: one line per program. */
export function versionText(v: Versions): string {
  const latest =
    v.edMcpLatest === "checking"
      ? "checking npm…"
      : v.edMcpLatest === null
        ? "npm not reachable"
        : `latest on npm ${v.edMcpLatest}`;
  const lines = [
    `ED Chat ${v.app}`,
    `claude ${v.claude ?? "not found"}`,
    `ed-mcp for Claude: ${v.edMcpStatus ? STATUS[v.edMcpStatus] : "not started yet"}, ${latest}`,
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
