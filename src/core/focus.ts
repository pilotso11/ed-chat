export interface Win32 {
  foreground(): number;
  isWindow(h: number): boolean;
  setForeground(h: number): boolean;
  processName(h: number): string | null;
  /**
   * Sends an input event that moves nothing, so Windows lets this process set the foreground
   * window again. PowerToys does the same; the game sees no key or click.
   */
  unlockForeground(): void;
}

/** What happened when focus was checked after the chat closed. */
export type Settled =
  { result: "ok" } | { result: "retried" } | { result: "failed"; foreground: string | null };

export const GAME_EXE = "EliteDangerous64.exe";

export interface Foreground {
  hwnd: number;
  isGame: boolean;
  isOverlay: boolean;
  processName: string | null;
}

// Polling avoids passing a WinEvent callback through FFI; 250 ms is fast enough for hotkey scope and topmost.
export class FocusManager {
  private saved = 0;
  private restored = 0;
  private lastGame = 0;
  private lastHwnd = -1;
  private last: Foreground = { hwnd: 0, isGame: false, isOverlay: false, processName: null };
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly w: Win32,
    private readonly o: {
      overlayHwnd: () => number;
      onChange: (f: Foreground) => void;
      intervalMs?: number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  get current(): Foreground {
    return this.last;
  }

  poll(): void {
    const hwnd = this.w.foreground();
    if (hwnd === this.lastHwnd) return;
    this.lastHwnd = hwnd;
    const isOverlay = hwnd !== 0 && hwnd === this.o.overlayHwnd();
    const name = hwnd === 0 || isOverlay ? null : this.w.processName(hwnd);
    this.last = {
      hwnd,
      isOverlay,
      isGame: name?.toLowerCase() === GAME_EXE.toLowerCase(),
      processName: name,
    };
    if (this.last.isGame) this.lastGame = hwnd;
    this.o.onChange(this.last);
  }

  start(): void {
    this.timer = setInterval(() => this.poll(), this.o.intervalMs ?? 250);
    this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * Remembers the window to give focus back to. A tray click has already taken focus from the
   * game, so preferGame picks the game when it is still open.
   */
  save(preferGame = false): void {
    const h = this.w.foreground();
    if (h === this.o.overlayHwnd()) return;
    const game = this.lastGame && this.w.isWindow(this.lastGame) ? this.lastGame : 0;
    this.saved = (preferGame || !h) && game ? game : h;
  }

  private sleep(ms: number): Promise<void> {
    return (this.o.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms);
  }

  /** False only when Windows refused to give the saved window focus. */
  async restore(): Promise<boolean> {
    const h = this.saved;
    this.saved = 0;
    if (!h || !this.w.isWindow(h)) return true;
    this.restored = h;
    if (this.w.setForeground(h)) return true;
    await this.sleep(100);
    this.w.unlockForeground();
    return this.w.setForeground(h);
  }

  /**
   * Checks, after the chat has closed, that the restored window really has focus. Windows can
   * report success and still leave the game in the background, so this checks and tries once more.
   */
  async settle(): Promise<Settled | null> {
    const h = this.restored;
    this.restored = 0;
    if (!h || !this.w.isWindow(h)) return null;
    await this.sleep(150);
    if (this.w.foreground() === h) return { result: "ok" };
    this.w.unlockForeground();
    this.w.setForeground(h);
    await this.sleep(100);
    const now = this.w.foreground();
    if (now === h) return { result: "retried" };
    const isOverlay = now !== 0 && now === this.o.overlayHwnd();
    return {
      result: "failed",
      foreground: isOverlay ? "ED Chat" : now ? this.w.processName(now) : null,
    };
  }
}
