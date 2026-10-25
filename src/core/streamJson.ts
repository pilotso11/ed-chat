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

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// The only code that knows the CLI's output format.
export class StreamParser {
  private buf = "";
  private readonly toolNames = new Map<string, string>();

  feed(chunk: string): SessionEvent[] {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    const out: SessionEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let j: unknown;
      try {
        j = JSON.parse(line);
      } catch {
        out.push({ type: "unknown", raw: line.trim() });
        continue;
      }
      out.push(...this.map(j));
    }
    return out;
  }

  private map(j: unknown): SessionEvent[] {
    const m = obj(j);
    if (!m) return [{ type: "unknown", raw: j }];
    switch (m.type) {
      case "system":
        if (m.subtype !== "init") break;
        return [
          {
            type: "ready",
            sessionId: str(m.session_id),
            tools: list(m.tools).filter((t): t is string => typeof t === "string"),
            mcpServers: list(m.mcp_servers).flatMap((s) => {
              const name = str(obj(s)?.name);
              return name ? [{ name, status: str(obj(s)?.status) ?? "unknown" }] : [];
            }),
            permissionMode: str(m.permissionMode),
          },
        ];
      case "stream_event": {
        const e = obj(m.event);
        const d = obj(e?.delta);
        if (e?.type === "content_block_delta" && d?.type === "text_delta") {
          const text = str(d.text);
          if (text) return [{ type: "text", delta: text }];
        }
        // Other stream events (message_start, block stops) carry nothing the overlay shows.
        return [];
      }
      case "assistant":
        return this.blocks(m).flatMap((b) => {
          const id = str(b.id);
          const name = str(b.name);
          if (b.type !== "tool_use" || !id || !name) return [];
          this.toolNames.set(id, name);
          return [{ type: "toolStart" as const, id, name }];
        });
      case "user":
        return this.blocks(m).flatMap((b) => {
          const id = str(b.tool_use_id);
          if (b.type !== "tool_result" || !id) return [];
          const name = this.toolNames.get(id) ?? "unknown";
          this.toolNames.delete(id);
          return [{ type: "toolEnd" as const, id, name, isError: b.is_error === true }];
        });
      case "result":
        return [
          {
            type: "result",
            isError: m.is_error === true,
            durationMs: typeof m.duration_ms === "number" ? m.duration_ms : null,
            text: str(m.result),
            sessionId: str(m.session_id),
            denials: list(m.permission_denials).flatMap((d) => {
              const n = str(obj(d)?.tool_name);
              return n ? [n] : [];
            }),
          },
        ];
    }
    return [{ type: "unknown", raw: m }];
  }

  private blocks(m: Obj): Obj[] {
    return list(obj(m.message)?.content).flatMap((b) => {
      const o = obj(b);
      return o ? [o] : [];
    });
  }
}
