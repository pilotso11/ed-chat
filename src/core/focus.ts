export interface Win32 {
  foreground(): number;
  isWindow(h: number): boolean;
  setForeground(h: number): boolean;
  processName(h: number): string | null;
}

export const GAME_EXE = "EliteDangerous64.exe";

export interface Foreground {
  hwnd: number;
  isGame: boolean;
  isOverlay: boolean;
}

// Polling avoids passing a WinEvent callback through FFI; 250 ms is fast enough for hotkey scope and topmost.
export class FocusManager {
  private saved = 0;
  private lastHwnd = -1;
  private last: Foreground = { hwnd: 0, isGame: false, isOverlay: false };
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
    this.last = { hwnd, isOverlay, isGame: name?.toLowerCase() === GAME_EXE.toLowerCase() };
    this.o.onChange(this.last);
  }

  start(): void {
    this.timer = setInterval(() => this.poll(), this.o.intervalMs ?? 250);
    this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  save(): void {
    const h = this.w.foreground();
    if (h !== this.o.overlayHwnd()) this.saved = h;
  }

  /** False only when Windows refused to give the saved window focus. */
  async restore(): Promise<boolean> {
    const h = this.saved;
    this.saved = 0;
    if (!h || !this.w.isWindow(h)) return true;
    if (this.w.setForeground(h)) return true;
    await (this.o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(100);
    return this.w.setForeground(h);
  }
}
