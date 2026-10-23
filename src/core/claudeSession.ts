import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { quoteForCmd } from "./claudeCommand.js";
import { CrashTracker } from "./crashTracker.js";
import { StreamParser, type SessionEvent } from "./streamJson.js";

export type BackendEvent =
  | SessionEvent
  | { type: "spawned" }
  | { type: "exit"; code: number | null; stderrTail: string[] }
  | { type: "gaveUp"; stderrTail: string[] }
  | { type: "spawnError"; message: string };

export interface ClaudeBackend {
  start(): void;
  send(text: string): boolean;
  cancel(): void;
  newSession(): void;
  stop(): void;
  configure(c: { command: string; args: string[]; shell: boolean }): void;
  onEvent(listener: (e: BackendEvent) => void): () => void;
  readonly busy: boolean;
  readonly sessionId: string | null;
}

export interface ClaudeSessionOptions {
  command: string;
  args: string[];
  shell?: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export class ClaudeSession implements ClaudeBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly expected = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly listeners = new Set<(e: BackendEvent) => void>();
  private readonly crashes: CrashTracker;
  private stderr: string[] = [];
  private _busy = false;
  private _sessionId: string | null = null;
  private cmd: { command: string; args: string[]; shell: boolean };

  constructor(private readonly opts: ClaudeSessionOptions) {
    this.cmd = { command: opts.command, args: opts.args, shell: opts.shell ?? false };
    this.crashes = new CrashTracker({ max: 3, windowMs: 60_000, now: opts.now ?? Date.now });
  }

  get busy(): boolean {
    return this._busy;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  onEvent(listener: (e: BackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Takes effect at the next spawn. */
  configure(c: { command: string; args: string[]; shell: boolean }): void {
    this.cmd = c;
  }

  start(): void {
    if (!this.child && !this.crashes.gaveUp) this.spawnChild();
  }

  send(text: string): boolean {
    if (this._busy || this.crashes.gaveUp) return false;
    if (!this.child) this.spawnChild();
    const message = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
    this.child!.stdin.write(JSON.stringify(message) + "\n");
    this._busy = true;
    return true;
  }

  cancel(): void {
    this._busy = false;
    if (!this.child) return;
    this.kill();
    this.spawnChild();
  }

  newSession(): void {
    this.kill();
    this._busy = false;
    this._sessionId = null;
    this.crashes.reset();
    this.spawnChild();
  }

  stop(): void {
    this.kill();
    this._busy = false;
  }

  private emit(e: BackendEvent): void {
    for (const l of this.listeners) l(e);
  }

  private kill(): void {
    const c = this.child;
    if (!c) return;
    this.expected.add(c);
    this.child = null;
    // With a .cmd shim, kill() would stop cmd.exe and leave claude running.
    if (process.platform === "win32" && c.pid) {
      spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true });
    } else {
      c.kill();
    }
  }

  private spawnChild(): void {
    const { command, shell } = this.cmd;
    const args = this._sessionId ? [...this.cmd.args, "--resume", this._sessionId] : this.cmd.args;
    const child = spawn(
      shell ? quoteForCmd(command) : command,
      shell ? args.map(quoteForCmd) : args,
      {
        cwd: this.opts.cwd,
        env: this.opts.env ?? process.env,
        shell,
        windowsHide: true,
      },
    );
    this.child = child;
    // The CLI prints init only after the first message, so a running process already counts as idle.
    child.on("spawn", () => {
      if (this.child === child) this.emit({ type: "spawned" });
    });
    const parser = new StreamParser();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      for (const e of parser.feed(chunk)) this.handle(e);
    });
    child.stderr.on("data", (chunk: string) => {
      this.stderr = [...this.stderr, ...chunk.split(/\r?\n/).filter(Boolean)].slice(-20);
    });
    // EPIPE after the process has gone; the exit handler reports it.
    child.stdin.on("error", () => {});
    child.on("error", (err) => {
      this.expected.add(child);
      if (this.child === child) this.child = null;
      this._busy = false;
      this.emit({ type: "spawnError", message: err.message });
    });
    // close, not exit: exit can fire before the last stderr chunk arrives.
    child.on("close", (code) => {
      if (this.child === child) this.child = null;
      if (this.expected.has(child)) return;
      this._busy = false;
      const stderrTail = this.stderr.slice(-5);
      this.stderr = [];
      if (this.crashes.record()) this.emit({ type: "gaveUp", stderrTail });
      else this.emit({ type: "exit", code, stderrTail });
    });
  }

  private handle(e: SessionEvent): void {
    if (e.type === "ready" && e.sessionId) this._sessionId = e.sessionId;
    if (e.type === "result") {
      this._busy = false;
      if (e.sessionId) this._sessionId = e.sessionId;
    }
    this.emit(e);
  }
}
