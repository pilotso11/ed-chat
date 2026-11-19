import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { ApprovalBroker } from "../../approvals.js";
import { APPROVAL_SERVER } from "./command.js";

export interface ApprovalServerOptions {
  onError?: (err: unknown) => void;
}

/**
 * Claude asks for approval through an MCP tool (--permission-prompt-tool). This is that MCP
 * server, on 127.0.0.1 with a random port and token. The broker holds the player's side and
 * belongs to the caller, who answers through it.
 */
export class ApprovalServer {
  private server?: http.Server;
  private port = 0;
  private readonly token = randomBytes(24).toString("hex");
  constructor(
    private readonly broker: ApprovalBroker,
    private readonly opts: ApprovalServerOptions = {},
  ) {}

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
    this.broker.denyAll();
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
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
        const d = await this.broker.ask(tool_name, input ?? {}, { signal: extra.signal });
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
}
