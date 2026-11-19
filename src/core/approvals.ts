import { randomUUID } from "node:crypto";

// The player's side of tool approvals: the queue of cards, the timeout and "allow until /new".
// Each backend brings its own way of being asked: Claude through an MCP tool, Codex through
// JSON-RPC requests.

export interface ApprovalRequest {
  id: string;
  toolName: string;
  summary: string;
  /** The tool runs a shell command. */
  shell: boolean;
  /** When the request is denied for want of an answer, in ms since the epoch. */
  deadline: number;
}
export type ApprovalDecision = "allow" | "deny";
export type Outcome = ApprovalDecision | "timeout" | "cancelled";

export interface ApprovalBrokerOptions {
  timeoutMs: number;
  onRequest: (r: ApprovalRequest) => void;
  onSettled: (id: string, outcome: Outcome) => void;
  now?: () => number;
}

export const SHELL_TOOLS = ["Bash", "PowerShell"];

const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

/** What the tool will do, short enough for three lines of the approval card. */
export function summarize(toolName: string, input: unknown, max = 200): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (SHELL_TOOLS.includes(toolName) && typeof i.command === "string") return cut(i.command, max);
  if (typeof i.file_path === "string") return cut(i.file_path, max);
  const parts = Object.entries(i).map(
    ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
  );
  return cut(parts.join(", "), max);
}

export interface AskOptions {
  /** The backend gave up on the request, for example the CLI disconnected. */
  signal?: AbortSignal;
  /** Overrides summarize(), for a backend whose input has its own shape. */
  summary?: string;
  /** Overrides the SHELL_TOOLS check. */
  shell?: boolean;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, (d: Outcome) => void>();
  private timeoutMs: number;
  /** Tools the player allowed for the rest of this conversation. */
  private readonly allowed = new Set<string>();

  constructor(private readonly opts: ApprovalBrokerOptions) {
    this.timeoutMs = opts.timeoutMs;
  }

  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }

  /** Allows this tool without asking until clearAllowed(), for example at /new. */
  allowTool(toolName: string): void {
    this.allowed.add(toolName);
  }

  clearAllowed(): void {
    this.allowed.clear();
  }

  isAllowed(toolName: string): boolean {
    return this.allowed.has(toolName);
  }

  answer(id: string, d: ApprovalDecision): boolean {
    const settle = this.pending.get(id);
    if (!settle) return false;
    settle(d);
    return true;
  }

  /** Denies every open request, for example when the backend stops. */
  denyAll(): void {
    for (const settle of [...this.pending.values()]) settle("deny");
  }

  ask(toolName: string, input: unknown, o: AskOptions = {}): Promise<Outcome> {
    const { signal } = o;
    if (signal?.aborted) return Promise.resolve("cancelled");
    if (this.allowed.has(toolName)) return Promise.resolve("allow");
    const id = randomUUID();
    return new Promise((resolve) => {
      const settle = (d: Outcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (!this.pending.delete(id)) return;
        this.opts.onSettled(id, d);
        resolve(d);
      };
      const onAbort = () => settle("cancelled");
      // A turn must never wait forever for a player who is busy flying.
      const timer = setTimeout(() => settle("timeout"), this.timeoutMs);
      // The CLI may disconnect (Ctrl-C, crash, its own tool timeout) while the card is up.
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, settle);
      const now = this.opts.now?.() ?? Date.now();
      this.opts.onRequest({
        id,
        toolName,
        summary: o.summary ?? summarize(toolName, input),
        shell: o.shell ?? SHELL_TOOLS.includes(toolName),
        deadline: now + this.timeoutMs,
      });
    });
  }
}
