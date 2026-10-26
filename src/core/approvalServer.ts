import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { APPROVAL_SERVER } from "./claudeCommand.js";

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

export interface ApprovalServerOptions {
  timeoutMs: number;
  onRequest: (r: ApprovalRequest) => void;
  onSettled: (id: string, outcome: Outcome) => void;
  onError?: (err: unknown) => void;
  now?: () => number;
}

const SHELL_TOOLS = ["Bash", "PowerShell"];

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

export class ApprovalServer {
  private server?: http.Server;
  private port = 0;
  private readonly token = randomBytes(24).toString("hex");
  private readonly pending = new Map<string, (d: Outcome) => void>();
  private timeoutMs: number;
  /** Tools the player allowed for the rest of this conversation. */
  private readonly allowed = new Set<string>();

  constructor(private readonly opts: ApprovalServerOptions) {
    this.timeoutMs = opts.timeoutMs;
  }

  async start(): Promise<number> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Port 0: the system picks a free port.
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const settle of [...this.pending.values()]) settle("deny");
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
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

  answer(id: string, d: ApprovalDecision): boolean {
    const settle = this.pending.get(id);
    if (!settle) return false;
    settle(d);
    return true;
  }

  mcpConfig() {
    return {
      mcpServers: {
        [APPROVAL_SERVER]: {
          type: "http" as const,
          url: `http://127.0.0.1:${this.port}/mcp`,
          headers: { Authorization: `Bearer ${this.token}` },
        },
      },
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return;
    }
    // Stateless: one MCP server per request, so no session bookkeeping.
    const mcp = this.build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      this.opts.onError?.(err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  private build(): McpServer {
    const mcp = new McpServer({ name: APPROVAL_SERVER, version: "1.0.0" });
    mcp.registerTool(
      "approve",
      {
        description: "Ask the player to allow or deny a tool call.",
        inputSchema: {
          tool_name: z.string(),
          input: z.record(z.string(), z.unknown()).optional(),
          tool_use_id: z.string().optional(),
        },
      },
      async ({ tool_name, input }, extra) => {
        const d = await this.ask(tool_name, input ?? {}, extra.signal);
        const payload =
          d === "allow"
            ? { behavior: "allow", updatedInput: input ?? {} }
            : {
                behavior: "deny",
                message: d === "timeout" ? "Player did not answer" : "Player denied",
              };
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
      },
    );
    return mcp;
  }

  private ask(toolName: string, input: unknown, signal: AbortSignal): Promise<Outcome> {
    if (signal.aborted) return Promise.resolve("cancelled");
    if (this.allowed.has(toolName)) return Promise.resolve("allow");
    const id = randomUUID();
    return new Promise((resolve) => {
      const settle = (d: Outcome) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (!this.pending.delete(id)) return;
        this.opts.onSettled(id, d);
        resolve(d);
      };
      const onAbort = () => settle("cancelled");
      // A turn must never wait forever for a player who is busy flying.
      const timer = setTimeout(() => settle("timeout"), this.timeoutMs);
      // The CLI may disconnect (Ctrl-C, crash, its own tool timeout) while the card is up.
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, settle);
      const now = this.opts.now?.() ?? Date.now();
      this.opts.onRequest({
        id,
        toolName,
        summary: summarize(toolName, input),
        shell: SHELL_TOOLS.includes(toolName),
        deadline: now + this.timeoutMs,
      });
    });
  }
}
