import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentBackend, BackendCommand, BackendEvent, SessionEvent } from "../../backend.js";
import { quoteForCmd } from "../../cli.js";
import { CrashTracker } from "../../crashTracker.js";
import { permissionModeOf, type ThreadSettings } from "./command.js";
import { CodexEvents, turnOf } from "./events.js";
import { RpcClient, RpcError, type RequestId } from "./rpc.js";

/** A shell command or a file change that Codex wants the player to allow. */
export interface CodexApproval {
  toolName: "shell" | "edit";
  summary: string;
  shell: boolean;
  /** Aborted when Codex no longer waits: the turn ended or the request was resolved. */
  signal: AbortSignal;
}
export type CodexDecision = "accept" | "acceptForSession" | "decline";
export type Approver = (r: CodexApproval) => Promise<CodexDecision>;

export interface CodexSessionOptions {
  command: string;
  args: string[];
  shell?: boolean;
  /** The process's own folder. The thread's cwd is in thread. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** A thread from an earlier run, resumed with thread/resume. */
  resumeId?: string | null;
  thread: ThreadSettings;
  approve: Approver;
  /** ED Chat's version, for initialize. */
  clientVersion?: string;
  /** How long a stopped turn may take to end before the process is restarted. */
  interruptGraceMs?: number;
  /** How long a process may take to answer the handshake and open a thread. */
  startTimeoutMs?: number;
}

const cut = (s: string, max = 200) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
// thread/resume for a thread with no saved rollout: -32600 "no rollout found for thread id …".
const isGone = (e: RpcError) => e.code === -32600 && /no rollout/i.test(e.message);

/**
 * `codex app-server`: one process, one thread. send is turn/start, cancel is turn/interrupt, and
 * newSession is a new thread in the same process. A process that exits is started again at the
 * next message and resumes the thread.
 */
export class CodexSession implements AgentBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rpc: RpcClient | null = null;
  private readonly expected = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly listeners = new Set<(e: BackendEvent) => void>();
  private readonly crashes: CrashTracker;
  private readonly events = new CodexEvents();
  private stderr: string[] = [];
  private cmd: BackendCommand;
  private thread: ThreadSettings;
  private _busy = false;
  private _threadId: string | null;
  /** initialize has been answered in this process. */
  private initialized = false;
  /** The thread can take turns. */
  private threadReady = false;
  /** Bumped at every new process or thread, so late answers for an old one are dropped. */
  private gen = 0;
  // The message waiting for the thread, or in flight; sent again when a failed resume starts a
  // new thread.
  private pending: string | null = null;
  private turnId: string | null = null;
  private cancelling = false;
  private interruptTimer: NodeJS.Timeout | undefined;
  // A process that does not open a thread in time is restarted, like a turn that will not stop.
  private startTimer: NodeJS.Timeout | undefined;
  // Each open approval request, with the process it came from, so a withdrawn card is
  // declined there.
  private readonly approvals = new Map<RequestId, { ctl: AbortController; rpc: RpcClient }>();
  // Paths of each file change, for the approval card: the request itself names none.
  private readonly fileChanges = new Map<string, string[]>();
  // Threads that /new left: what still arrives for them is dropped, even before the new thread
  // has an id.
  private readonly leftThreads = new Set<string>();
  // An MCP status change came during a turn; ready is sent when the turn ends.
  private readyHeld = false;
  // Turns that have ended in this process. A late or repeated end for one of them can come
  // before the next turn's id is known, so it is matched by id, not by the running turn.
  private readonly endedTurns = new Set<string>();

  constructor(private readonly opts: CodexSessionOptions) {
    this.cmd = { command: opts.command, args: opts.args, shell: opts.shell ?? false };
    this.thread = opts.thread;
    this.crashes = new CrashTracker({ max: 3, windowMs: 60_000, now: opts.now ?? Date.now });
    this._threadId = opts.resumeId ?? null;
  }

  get busy(): boolean {
    return this._busy;
  }

  get sessionId(): string | null {
    return this._threadId;
  }

  onEvent(listener: (e: BackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Takes effect at the next spawn. */
  configure(c: BackendCommand): void {
    this.cmd = c;
  }

  /** Takes effect at the next thread/start or thread/resume. */
  configureThread(t: ThreadSettings): void {
    this.thread = t;
  }

  start(): void {
    if (!this.child && !this.crashes.gaveUp) this.spawnChild();
  }

  send(text: string): boolean {
    if (this._busy || this.crashes.gaveUp) return false;
    this._busy = true;
    this.pending = text;
    if (!this.child) this.spawnChild();
    else if (this.threadReady) this.startTurn(text);
    return true;
  }

  cancel(): void {
    if (!this._busy) return;
    this.pending = null;
    this.abortApprovals();
    // Not started yet: nothing to stop. Reported after the caller's own "cancelled".
    if (!this.turnId && !this.threadReady) {
      this._busy = false;
      queueMicrotask(() => this.emit({ type: "spawned" }));
      return;
    }
    this.cancelling = true;
    if (this.turnId) this.interrupt();
    // turn/start is in flight: interrupted as soon as its id is known, and restarted if it
    // never comes.
    else this.armGrace();
  }

  newSession(): void {
    // The old thread's turn is stopped, and anything it still sends is dropped.
    if (this._threadId) {
      this.leftThreads.add(this._threadId);
      // A turn/start still in flight is interrupted when its answer comes (startTurn).
      if (this.turnId && this.rpc) this.interruptLeft(this.rpc, this._threadId, this.turnId);
    }
    this.endTurn();
    this.abortApprovals();
    this.readyHeld = false;
    this._threadId = null;
    this.threadReady = false;
    this.events.threadId = null;
    this.events.resetTurn();
    this.crashes.reset();
    if (!this.child) {
      this.spawnChild();
      return;
    }
    const gen = ++this.gen;
    if (this.rpc) this.armStart(this.rpc);
    if (this.initialized) void this.openThread(gen);
  }

  stop(): void {
    this.kill();
    this.endTurn();
    this.abortApprovals();
  }

  private emit(e: BackendEvent): void {
    for (const l of this.listeners) l(e);
  }

  private endTurn(): void {
    if (this.turnId) this.endedTurns.add(this.turnId);
    if (this.endedTurns.size > 100) this.endedTurns.delete(this.endedTurns.values().next().value!);
    clearTimeout(this.interruptTimer);
    this.interruptTimer = undefined;
    this._busy = false;
    this.pending = null;
    this.turnId = null;
    this.cancelling = false;
  }

  // Withdraws the cards, and declines the requests in a process that is still running: Codex
  // would otherwise wait for an answer that never comes.
  private abortApprovals(): void {
    for (const [id, a] of this.approvals) {
      a.ctl.abort();
      if (a.rpc === this.rpc) a.rpc.respond(id, { decision: "decline" });
    }
    this.approvals.clear();
  }

  private emitHeldReady(): void {
    if (!this.readyHeld || !this.threadReady) return;
    this.readyHeld = false;
    this.emit(this.events.ready());
  }

  // Covers the handshake and the thread call: no answer in time ends the process, which is
  // reported like an exit, so the overlay does not wait for ever. The next message restarts it.
  private armStart(rpc: RpcClient): void {
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => {
      if (this.rpc === rpc && !this.threadReady)
        this.fail(rpc, new Error("codex did not open a conversation in time"));
    }, this.opts.startTimeoutMs ?? 60_000);
  }

  private interruptLeft(rpc: RpcClient, threadId: string, turnId: string): void {
    rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {});
  }

  private kill(): void {
    clearTimeout(this.startTimer);
    const c = this.child;
    this.rpc?.close(new Error("stopped"));
    this.rpc = null;
    this.initialized = false;
    this.threadReady = false;
    this.gen++;
    if (!c) return;
    this.expected.add(c);
    this.child = null;
    // With a .cmd shim, kill() would stop cmd.exe and leave codex running.
    if (process.platform === "win32" && c.pid) {
      spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true }).on(
        "error",
        () => {},
      );
    } else {
      c.kill();
    }
  }

  private spawnChild(): void {
    const { command, shell, args } = this.cmd;
    const child = spawn(
      shell ? quoteForCmd(command) : command,
      shell ? args.map(quoteForCmd) : args,
      { cwd: this.opts.cwd, env: this.opts.env ?? process.env, shell, windowsHide: true },
    );
    this.gen++;
    this.child = child;
    this.stderr = [];
    this.leftThreads.clear();
    this.endedTurns.clear();
    // A new process reports its own MCP statuses; the old ones may no longer hold.
    this.events.resetProcess();
    this.readyHeld = false;
    this.initialized = false;
    this.threadReady = false;
    const rpc = new RpcClient((line) => child.stdin.write(line), {
      onNotification: (m, p) => {
        if (this.rpc === rpc) this.onNotification(m, p);
      },
      onRequest: (id, m, p) => {
        if (this.rpc === rpc) this.onServerRequest(rpc, id, m, p);
      },
      onJunk: (line) => {
        if (this.rpc === rpc) this.emit({ type: "unknown", raw: line });
      },
    });
    this.rpc = rpc;
    this.armStart(rpc);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child === child) rpc.feed(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.stderr = [...this.stderr, ...chunk.split(/\r?\n/).filter(Boolean)].slice(-20);
    });
    // EPIPE after the process has gone; the close handler reports it.
    child.stdin.on("error", () => {});
    child.on("spawn", () => {
      if (this.child !== child) return;
      this.emit({ type: "spawned" });
      void this.handshake(rpc);
    });
    child.on("error", (err) => {
      this.expected.add(child);
      if (this.child !== child) return;
      this.child = null;
      rpc.close(err);
      this.rpc = null;
      this.endTurn();
      this.abortApprovals();
      this.emit({ type: "spawnError", message: err.message });
    });
    // close, not exit: exit can fire before the last stderr chunk arrives.
    child.on("close", (code) => {
      rpc.close(new Error(`codex exited with code ${code}`));
      if (this.child === child) {
        this.child = null;
        this.rpc = null;
        this.initialized = false;
        this.threadReady = false;
      }
      if (this.expected.has(child)) return;
      this.endTurn();
      this.abortApprovals();
      this.reportExit(code);
    });
  }

  private reportExit(code: number | null, extra: string[] = []): void {
    const stderrTail = [...this.stderr, ...extra].slice(-5);
    this.stderr = [];
    if (this.crashes.record()) this.emit({ type: "gaveUp", stderrTail });
    else this.emit({ type: "exit", code, stderrTail });
  }

  private async handshake(rpc: RpcClient): Promise<void> {
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "ed-chat", title: "ED Chat", version: this.opts.clientVersion ?? "0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      if (this.rpc !== rpc) return;
      rpc.notify("initialized");
      this.initialized = true;
      await this.openThread(this.gen);
    } catch (err) {
      this.fail(rpc, err);
    }
  }

  /** The process cannot be used: it is stopped and reported like an exit. */
  private fail(rpc: RpcClient, err: unknown): void {
    if (this.rpc !== rpc) return;
    this.kill();
    this.endTurn();
    this.abortApprovals();
    this.reportExit(null, [err instanceof Error ? err.message : String(err)]);
  }

  private async openThread(gen: number): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;
    const params = { ...this.thread };
    let res: unknown;
    // Which call gave the thread, for the error when it names none.
    let call = "thread/start";
    try {
      if (this._threadId) {
        const resume = () => rpc.request("thread/resume", { threadId: this._threadId, ...params });
        try {
          try {
            res = await resume();
          } catch (err) {
            // A process that went keeps the thread for the restart. "no rollout found" means
            // the thread is gone. Any other refusal may pass, so it is tried once more.
            if (gen !== this.gen || !(err instanceof RpcError) || isGone(err)) throw err;
            res = await resume();
          }
          call = "thread/resume";
        } catch (err) {
          if (gen !== this.gen || !(err instanceof RpcError)) throw err;
          // The thread cannot be resumed: a new one starts with the message the player sent.
          this._threadId = null;
          this.emit({ type: "resumeFailed", stderrTail: [err.message] });
        }
      }
      if (gen !== this.gen) return;
      if (!res) res = await rpc.request("thread/start", params);
    } catch (err) {
      if (gen === this.gen) this.fail(rpc, err);
      return;
    }
    const r = isRecord(res) ? res : {};
    const thread = isRecord(r.thread) ? r.thread : {};
    const id = str(thread.id);
    if (gen !== this.gen) {
      // /new asked for another thread while this one was opening: what it sends is dropped.
      if (id && this.rpc === rpc) this.leftThreads.add(id);
      return;
    }
    if (!id) {
      this.fail(rpc, new Error(`${call} gave no thread id`));
      return;
    }
    this._threadId = id;
    this.events.threadId = id;
    this.events.permissionMode = permissionModeOf(r.approvalPolicy);
    this.threadReady = true;
    clearTimeout(this.startTimer);
    // This ready carries every status so far: one held from before is not sent again.
    this.readyHeld = false;
    this.emit(this.events.ready());
    if (this._busy && this.pending !== null) this.startTurn(this.pending);
  }

  private startTurn(text: string): void {
    const rpc = this.rpc;
    if (!rpc || !this._threadId) return;
    const gen = this.gen;
    const threadId = this._threadId;
    this.events.resetTurn();
    this.fileChanges.clear();
    rpc
      .request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
      })
      .then(
        (res) => {
          const turn = isRecord(res) && isRecord(res.turn) ? res.turn : {};
          const turnId = str(turn.id);
          // /new came before this answer: the old thread's turn is stopped now.
          if (this.leftThreads.has(threadId)) {
            if (turnId && this.rpc === rpc) this.interruptLeft(rpc, threadId, turnId);
            return;
          }
          if (gen !== this.gen || !this._busy) return;
          this.turnStarted(turnId);
        },
        (err: unknown) => {
          if (gen !== this.gen || this.rpc !== rpc) return;
          // Refused before it started, so no turn/completed follows.
          const cancelled = this.cancelling;
          this.endTurn();
          if (cancelled) this.emit({ type: "spawned" });
          else
            this.emit({
              type: "result",
              isError: true,
              durationMs: null,
              text: err instanceof Error ? err.message : String(err),
              sessionId: this._threadId,
              denials: [],
            });
          this.emitHeldReady();
        },
      );
  }

  private turnStarted(id: string | null): void {
    // A turn that has ended (its start or answer came late) is not the running one.
    if (!id || this.turnId === id || this.endedTurns.has(id)) return;
    this.turnId = id;
    if (this.cancelling) this.interrupt();
  }

  private interrupt(): void {
    const rpc = this.rpc;
    if (!rpc || !this._threadId || !this.turnId) return;
    rpc
      .request("turn/interrupt", { threadId: this._threadId, turnId: this.turnId })
      .catch(() => {});
    this.armGrace();
  }

  // A turn that does not stop is ended with its process; the thread resumes at the restart.
  // Armed once per stop: pressing stop again, or the turn id arriving, does not push it back.
  private armGrace(): void {
    if (this.interruptTimer) return;
    this.interruptTimer = setTimeout(() => {
      if (!this.cancelling) return;
      this.kill();
      this.endTurn();
      this.abortApprovals();
      this.events.resetTurn();
      this.spawnChild();
    }, this.opts.interruptGraceMs ?? 5_000);
  }

  private onNotification(method: string, params: unknown): void {
    const p = isRecord(params) ? params : {};
    if (this.isLeft(p)) return;
    switch (method) {
      case "turn/started": {
        const turn = isRecord(p.turn) ? p.turn : {};
        if (this._busy) this.turnStarted(str(turn.id));
        return;
      }
      case "turn/completed": {
        const t = turnOf(params);
        if (!t || !this._busy) return;
        // Another turn's end (an earlier one, late) leaves the running turn alone.
        if (t.id && (this.endedTurns.has(t.id) || (this.turnId && t.id !== this.turnId))) return;
        // Its id is kept even when it ended before its turn/start answer gave it.
        if (t.id) this.endedTurns.add(t.id);
        const cancelled = this.cancelling || t.status === "interrupted";
        this.abortApprovals();
        this.endTurn();
        // A stopped turn has no reply: the overlay goes back to idle.
        if (cancelled) {
          this.events.resetTurn();
          this.emit({ type: "spawned" });
        } else this.emit(this.events.result(t));
        this.emitHeldReady();
        return;
      }
      case "serverRequest/resolved": {
        const id = p.requestId;
        if (typeof id === "string" || typeof id === "number") {
          this.approvals.get(id)?.ctl.abort();
          this.approvals.delete(id);
        }
        return;
      }
      case "item/started": {
        const item = isRecord(p.item) ? p.item : null;
        if (
          item?.type === "fileChange" &&
          typeof item.id === "string" &&
          Array.isArray(item.changes)
        )
          this.fileChanges.set(
            item.id,
            item.changes.flatMap((c) =>
              isRecord(c) && typeof c.path === "string" ? [c.path] : [],
            ),
          );
        break;
      }
    }
    for (const e of this.events.map(method, params)) {
      // ready means idle to the overlay: a status change during a turn waits for its end.
      if (e.type === "ready" && this._busy) {
        this.readyHeld = true;
        continue;
      }
      // The player stopped the reply: what is still arriving for it is not shown.
      if (this.cancelling && e.type !== "unknown") continue;
      this.emit(e as SessionEvent);
    }
  }

  // A message for a thread that /new left behind, or for one that is not this session's.
  private isLeft(p: Record<string, unknown>): boolean {
    const threadId = str(p.threadId);
    if (!threadId) return false;
    if (this.leftThreads.has(threadId)) return true;
    return !!this._threadId && threadId !== this._threadId;
  }

  private onServerRequest(rpc: RpcClient, id: RequestId, method: string, params: unknown): void {
    const p = isRecord(params) ? params : {};
    // For a thread that /new left, or a reply the player stopped: nothing to show.
    if ((this.isLeft(p) || this.cancelling) && method.endsWith("/requestApproval")) {
      rpc.respond(id, { decision: "decline" });
      return;
    }
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const command = str(p.command);
        const cwd = str(p.cwd);
        const where = cwd && cwd !== this.thread.cwd ? ` (in ${cwd})` : "";
        const summary = command ? command + where : (str(p.reason) ?? "a shell command");
        this.ask(rpc, id, { toolName: "shell", summary: cut(summary), shell: true });
        return;
      }
      case "item/fileChange/requestApproval": {
        const itemId = str(p.itemId);
        const paths = (itemId && this.fileChanges.get(itemId)) || [];
        const root = str(p.grantRoot);
        const summary = root
          ? `write access to ${root}`
          : paths.length
            ? paths.join(", ")
            : (str(p.reason) ?? "file changes");
        this.ask(rpc, id, { toolName: "edit", summary: cut(summary), shell: false });
        return;
      }
      // ed-mcp does not use elicitation; nothing else is answered for now.
      case "mcpServer/elicitation/request":
        rpc.respond(id, { action: "decline", content: null, _meta: null });
        return;
      default:
        rpc.respondError(id, -32601, `ED Chat does not handle ${method}`);
    }
  }

  private ask(rpc: RpcClient, id: RequestId, r: Omit<CodexApproval, "signal">): void {
    const ctl = new AbortController();
    this.approvals.set(id, { ctl, rpc });
    this.opts
      .approve({ ...r, signal: ctl.signal })
      .catch((): CodexDecision => "decline")
      .then((decision) => {
        // Only its own entry: a new process can reuse the id for another request.
        if (this.approvals.get(id)?.ctl === ctl) this.approvals.delete(id);
        // Codex stopped waiting, or the process has gone.
        if (ctl.signal.aborted || this.rpc !== rpc) return;
        rpc.respond(id, { decision });
      });
  }
}
