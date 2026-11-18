// What every assistant backend gives the overlay. The controller, HUD and history know only
// these types; each backend turns its own CLI's protocol into them.

export interface McpServerInfo {
  name: string;
  status: string;
}

export type SessionEvent =
  | {
      type: "ready";
      sessionId: string | null;
      tools: string[];
      mcpServers: McpServerInfo[];
      permissionMode: string | null;
    }
  | { type: "text"; delta: string }
  | { type: "toolStart"; id: string; name: string }
  | { type: "toolEnd"; id: string; name: string; isError: boolean }
  | {
      type: "result";
      isError: boolean;
      durationMs: number | null;
      text: string | null;
      sessionId: string | null;
      denials: string[];
    }
  | { type: "unknown"; raw: unknown };

export type BackendEvent =
  | SessionEvent
  | { type: "spawned" }
  // The conversation saved from the last run could not be resumed; a new one has started.
  | { type: "resumeFailed"; stderrTail: string[] }
  | { type: "exit"; code: number | null; stderrTail: string[] }
  | { type: "gaveUp"; stderrTail: string[] }
  | { type: "spawnError"; message: string };

export interface BackendCommand {
  command: string;
  args: string[];
  shell: boolean;
}

export interface AgentBackend {
  start(): void;
  send(text: string): boolean;
  cancel(): void;
  newSession(): void;
  stop(): void;
  /** Takes effect at the next spawn. */
  configure(c: BackendCommand): void;
  onEvent(listener: (e: BackendEvent) => void): () => void;
  readonly busy: boolean;
  readonly sessionId: string | null;
}

export type AgentId = "claude";

export interface AgentInfo {
  /** The assistant's name in notices: "Claude stopped". */
  name: string;
  /** The CLI program. */
  cli: string;
  /** What the player installs. */
  product: string;
  /** The setting that points ED Chat at the CLI. */
  pathSetting: string;
}

export const AGENTS: Record<AgentId, AgentInfo> = {
  claude: { name: "Claude", cli: "claude", product: "Claude Code", pathSetting: "claude.path" },
};
