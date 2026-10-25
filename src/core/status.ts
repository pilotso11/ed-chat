import { readFile } from "node:fs/promises";

export interface ShipFlags {
  docked: boolean;
  inDanger: boolean;
}

const DOCKED = 1 << 0;
const IN_DANGER = 1 << 22;
const BEING_INTERDICTED = 1 << 23;

export function decodeStatus(text: string): ShipFlags | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (j === null || typeof j !== "object") return null;
  const flags = (j as { Flags?: unknown }).Flags;
  // The game writes no Flags at the main menu.
  if (flags === undefined) return { docked: false, inDanger: false };
  if (typeof flags !== "number") return null;
  return {
    docked: (flags & DOCKED) !== 0,
    inDanger: (flags & (IN_DANGER | BEING_INTERDICTED)) !== 0,
  };
}

export type FullscreenMode = "windowed" | "fullscreen" | "borderless";

const MODES: Record<string, FullscreenMode> = {
  "0": "windowed",
  "1": "fullscreen",
  "2": "borderless",
};

export function fullscreenMode(xml: string): FullscreenMode | null {
  const m = /<FullScreen>\s*(\d+)\s*<\/FullScreen>/.exec(xml);
  return m ? (MODES[m[1]!] ?? null) : null;
}

// The game rewrites Status.json several times a second, which fs.watch reports unreliably.
export class StatusWatcher {
  private timer?: NodeJS.Timeout;
  private last: ShipFlags | null = null;
  private lastText?: string;

  constructor(
    private readonly file: string,
    private readonly onChange: (f: ShipFlags) => void,
    private readonly opts: { intervalMs?: number; read?: (file: string) => Promise<string> } = {},
  ) {}

  get flags(): ShipFlags | null {
    return this.last;
  }

  async poll(): Promise<void> {
    let text: string;
    try {
      text = await (this.opts.read ?? ((f: string) => readFile(f, "utf8")))(this.file);
    } catch {
      return;
    }
    if (text === this.lastText) return;
    const f = decodeStatus(text);
    if (!f) return;
    this.lastText = text;
    if (this.last && this.last.docked === f.docked && this.last.inDanger === f.inDanger) return;
    this.last = f;
    this.onChange(f);
  }

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs ?? 500);
    void this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
