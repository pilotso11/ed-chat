// Line-delimited JSON-RPC as `codex app-server` speaks it. Requests carry id and method,
// responses id and result or error, notifications method only, and server requests id and
// method. No message carries a jsonrpc field.

export type RequestId = string | number;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcHandlers {
  onNotification: (method: string, params: unknown) => void;
  /** A request from the server. Answer it with respond() or respondError(). */
  onRequest: (id: RequestId, method: string, params: unknown) => void;
  /** A line that is not JSON, or not a message this client knows. */
  onJunk?: (line: string) => void;
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export class RpcClient {
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<RequestId, Pending>();
  private closed: Error | null = null;

  constructor(
    private readonly write: (line: string) => void,
    private readonly handlers: RpcHandlers,
  ) {}

  /** Feeds text from the server's stdout; messages are handled as each line completes. */
  feed(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.handleLine(line);
    }
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (r: unknown) => void, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send(params === undefined ? { method } : { method, params });
  }

  respond(id: RequestId, result: unknown): void {
    if (!this.closed) this.send({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    if (!this.closed) this.send({ id, error: { code, message } });
  }

  /** The server has gone: every request still waiting fails with err. */
  close(err: Error): void {
    if (this.closed) return;
    this.closed = err;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.reject(err);
  }

  private send(msg: unknown): void {
    this.write(JSON.stringify(msg) + "\n");
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.handlers.onJunk?.(line);
      return;
    }
    if (!isRecord(msg)) {
      this.handlers.onJunk?.(line);
      return;
    }
    const { id, method } = msg;
    const hasId = typeof id === "string" || typeof id === "number";
    if (typeof method === "string") {
      if (hasId) this.handlers.onRequest(id, method, msg.params);
      else this.handlers.onNotification(method, msg.params);
      return;
    }
    const p = hasId ? this.pending.get(id) : undefined;
    if (!p) {
      this.handlers.onJunk?.(line);
      return;
    }
    this.pending.delete(id as RequestId);
    if (isRecord(msg.error)) {
      const code = typeof msg.error.code === "number" ? msg.error.code : 0;
      const message =
        typeof msg.error.message === "string" ? msg.error.message : `${p.method} failed`;
      p.reject(new RpcError(code, message, msg.error.data));
    } else {
      p.resolve(msg.result);
    }
  }
}
