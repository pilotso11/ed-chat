// Turns app-server notifications into the overlay's SessionEvents. The protocol changes between
// Codex versions (see `codex app-server generate-ts`), so only the fields used here are read.
import type { McpServerInfo, SessionEvent } from "../../backend.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The name shown in the status line and approval card, or null for an item that is not a tool. */
export function toolName(item: unknown): string | null {
  if (!isRecord(item)) return null;
  switch (item.type) {
    // The same shape as Claude's, so shortTool() shows the tool's own name.
    case "mcpToolCall":
      return `mcp__${str(item.server) ?? "?"}__${str(item.tool) ?? "?"}`;
    case "commandExecution":
      return "shell";
    case "fileChange":
      return "edit";
    case "webSearch":
      return "web_search";
    case "dynamicToolCall":
      return str(item.tool) ?? "tool";
    default:
      return null;
  }
}

const failed = (item: Record<string, unknown>) =>
  item.status === "failed" || item.status === "declined" || isRecord(item.error);

// Codex's MCP startup states, in the words the shared ed-mcp check reads.
const MCP_STATUS: Record<string, string> = {
  starting: "pending",
  ready: "connected",
  failed: "failed",
  cancelled: "failed",
};

export interface TurnResult {
  id: string | null;
  status: string;
  durationMs: number | null;
  error: string | null;
}

export function turnOf(params: unknown): TurnResult | null {
  const turn = isRecord(params) && isRecord(params.turn) ? params.turn : null;
  if (!turn) return null;
  const error = isRecord(turn.error) ? str(turn.error.message) : null;
  return {
    id: str(turn.id) || null,
    status: str(turn.status) ?? "completed",
    durationMs: typeof turn.durationMs === "number" ? turn.durationMs : null,
    error,
  };
}

/** The state that the mapping needs across notifications: one thread, one turn at a time. */
export class CodexEvents {
  threadId: string | null = null;
  permissionMode: string | null = null;
  private readonly mcp = new Map<string, string>();
  private readonly tools = new Map<string, string>();
  private readonly streamed = new Set<string>();
  private lastText: string | null = null;
  private wroteText = false;
  private denials: string[] = [];

  /** Forgets everything from a process that has gone, MCP statuses included. */
  resetProcess(): void {
    this.mcp.clear();
    this.threadId = null;
    this.resetTurn();
  }

  /** Forgets the turn: a new turn, or a new thread. */
  resetTurn(): void {
    this.tools.clear();
    this.streamed.clear();
    this.lastText = null;
    this.wroteText = false;
    this.denials = [];
  }

  ready(): SessionEvent {
    const mcpServers: McpServerInfo[] = [...this.mcp].map(([name, status]) => ({ name, status }));
    return {
      type: "ready",
      sessionId: this.threadId,
      tools: [],
      mcpServers,
      permissionMode: this.permissionMode,
    };
  }

  result(t: TurnResult): SessionEvent {
    // Anything but completed is an error the player hears about: failed, a stop the player did
    // not ask for, or a status a newer Codex adds.
    const isError = t.status !== "completed";
    const said =
      t.status === "failed"
        ? "Codex returned an error."
        : t.status === "interrupted"
          ? "Codex stopped the reply."
          : `Codex ended the reply: ${t.status}.`;
    const e: SessionEvent = {
      type: "result",
      isError,
      durationMs: t.durationMs,
      text: isError ? (t.error ?? said) : null,
      sessionId: this.threadId,
      denials: this.denials,
    };
    this.resetTurn();
    return e;
  }

  /** Text from a new message starts on a new line, so commentary and the answer do not run together. */
  private text(itemId: string | null, delta: string): SessionEvent {
    const sep = this.wroteText && itemId !== this.lastText ? "\n" : "";
    this.lastText = itemId;
    this.wroteText = true;
    return { type: "text", delta: sep + delta };
  }

  map(method: string, params: unknown): SessionEvent[] {
    const p = isRecord(params) ? params : {};
    switch (method) {
      case "item/agentMessage/delta": {
        const delta = str(p.delta);
        if (!delta) return [];
        const itemId = str(p.itemId);
        if (itemId) this.streamed.add(itemId);
        return [this.text(itemId, delta)];
      }
      case "item/started": {
        const item = isRecord(p.item) ? p.item : null;
        const name = toolName(item);
        const id = item && str(item.id);
        if (!name || !id) return [];
        this.tools.set(id, name);
        return [{ type: "toolStart", id, name }];
      }
      case "item/completed": {
        const item = isRecord(p.item) ? p.item : null;
        if (!item) return [];
        const id = str(item.id);
        // A message that came whole, with no deltas.
        if (item.type === "agentMessage") {
          const text = str(item.text);
          return id && !this.streamed.has(id) && text ? [this.text(id, text)] : [];
        }
        const name = (id && this.tools.get(id)) ?? toolName(item);
        if (!name || !id) return [];
        this.tools.delete(id);
        if (item.status === "declined") this.denials.push(name);
        return [{ type: "toolEnd", id, name, isError: failed(item) }];
      }
      case "mcpServer/startupStatus/updated": {
        const name = str(p.name);
        const status = str(p.status);
        if (!name || !status) return [];
        this.mcp.set(name, MCP_STATUS[status] ?? status);
        // ED Chat reads the servers from ready; a thread that has started hears the change.
        return this.threadId ? [this.ready()] : [];
      }
      default:
        return [{ type: "unknown", raw: { method, params } }];
    }
  }
}
