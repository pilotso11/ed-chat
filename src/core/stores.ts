import { unwatchFile, watchFile } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Turn } from "./controller.js";
import {
  DEFAULT_SETTINGS,
  PositionSchema,
  defaultSettingsText,
  parseSettings,
  type Position,
  type Settings,
} from "./settings.js";

export interface LoadResult {
  changed: boolean;
  error: string | null;
}

export class SettingsStore {
  private current: Settings = DEFAULT_SETTINGS;
  private lastText: string | null = null;
  private lastError: string | null = null;
  private firstLoad = true;

  constructor(private readonly file: string) {}

  get settings(): Settings {
    return this.current;
  }

  // A reference copy of every default, rewritten each start so it matches this version.
  // A failure is reported, not thrown: the overlay works without the reference.
  private async writeDefaultsReference(): Promise<string | null> {
    const ref = path.join(path.dirname(this.file), "settings.defaults.json");
    try {
      await writeFile(ref, defaultSettingsText());
      return null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return `⚠ settings.defaults.json: ${code ?? String(err)}`;
    }
  }

  async load(): Promise<LoadResult> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT")
        return { changed: false, error: `⚠ settings.json: ${code ?? String(err)}` };
      // Only overrides go in settings.json, so a later release's defaults still apply.
      text = "{}\n";
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, text);
    }
    const refError = this.firstLoad ? await this.writeDefaultsReference() : null;
    // Some Windows editors save UTF-8 with a BOM, which JSON.parse rejects.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text === this.lastText) return { changed: false, error: this.lastError };
    this.lastText = text;
    const r = parseSettings(text);
    if (!r.ok) {
      // Keep the last good settings: a half-saved file must not unbind every hotkey.
      this.lastError = `⚠ settings.json: ${r.error}`;
      return { changed: false, error: this.lastError };
    }
    this.lastError = null;
    const changed = this.firstLoad || JSON.stringify(r.settings) !== JSON.stringify(this.current);
    this.firstLoad = false;
    this.current = r.settings;
    return { changed, error: refError };
  }

  // Polling, because editors often save by replacing the file, which fs.watch can lose.
  watch(cb: (r: LoadResult) => void, intervalMs = 1_000): void {
    watchFile(this.file, { interval: intervalMs }, () => {
      this.load().then(cb, (err: unknown) =>
        cb({
          changed: false,
          error: `⚠ settings.json: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    });
  }

  unwatch(): void {
    unwatchFile(this.file);
  }
}

export interface SavedState {
  position?: Position;
  positionBase?: string;
  iconMode?: boolean;
}

const SavedStateSchema = z.object({
  position: PositionSchema.optional(),
  positionBase: z.string().optional(),
  iconMode: z.boolean().optional(),
});

// A hotkey-chosen position is kept until the player edits position in settings.json.
export function effectivePosition(
  settingsPos: Position,
  saved: SavedState,
): { position: Position; saved: SavedState } {
  if (saved.position && saved.positionBase === JSON.stringify(settingsPos)) {
    return { position: saved.position, saved };
  }
  const { position: _p, positionBase: _b, ...rest } = saved;
  return { position: settingsPos, saved: rest };
}

export function savePosition(
  settingsPos: Position,
  saved: SavedState,
  position: Position,
): SavedState {
  return { ...saved, position, positionBase: JSON.stringify(settingsPos) };
}

export class StateStore {
  constructor(private readonly file: string) {}

  async read(): Promise<SavedState> {
    try {
      const r = SavedStateSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      return r.success ? r.data : {};
    } catch {
      return {};
    }
  }

  async write(s: SavedState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2) + "\n");
    await rename(tmp, this.file);
  }
}

export class HistoryStore {
  private file: string | null = null;

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  newSession(): void {
    this.file = path.join(this.dir, `${this.now().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  }

  async append(t: Turn): Promise<void> {
    if (!this.file) this.newSession();
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file!, JSON.stringify({ at: this.now().toISOString(), ...t }) + "\n");
  }
}
