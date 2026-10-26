import { unwatchFile, watchFile } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Turn } from "./controller.js";
import {
  DEFAULTS_FILE,
  DEFAULT_SETTINGS,
  PositionSchema,
  SCHEMA_FILE,
  defaultSettingsText,
  newSettingsText,
  parseSettings,
  settingsSchemaText,
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

  // The schema and a copy of every default, rewritten each start so they match this version.
  // A failure is reported, not thrown: the overlay works without them.
  private async writeDefaultsReference(): Promise<string | null> {
    const dir = path.dirname(this.file);
    for (const [name, text] of [
      [SCHEMA_FILE, settingsSchemaText()],
      [DEFAULTS_FILE, defaultSettingsText()],
    ] as const) {
      try {
        await writeFile(path.join(dir, name), text);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return `⚠ ${name}: ${code ?? String(err)}`;
      }
    }
    return null;
  }

  // A settings.json from before the schema link, or a hand-made one, gets the link too, so
  // editors complete it. Only the first line changes; the rest keeps the player's layout.
  // A failure is ignored: the link only helps editing.
  private async addSchemaLink(text: string): Promise<void> {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || "$schema" in raw) return;
    const empty = Object.keys(raw).length === 0;
    const linked = text.replace("{", `{\n  "$schema": "./${SCHEMA_FILE}"${empty ? "" : ","}`);
    try {
      await writeFile(this.file, linked);
      this.lastText = linked;
    } catch {
      // Read-only file: keep it as it is.
    }
  }

  /** settings.json could not be read or parsed; a reference-file error does not count. */
  get broken(): boolean {
    return this.lastError !== null || this.lastText === null;
  }

  /** The file as last read, without a BOM. */
  get text(): string {
    return this.lastText ?? "";
  }

  /** Sets one value in settings.json and keeps the rest of the file. */
  async set(group: string, key: string, value: unknown): Promise<void> {
    // Throws on a broken file, which must not be replaced with one value.
    const raw = JSON.parse(this.text) as Record<string, unknown>;
    const g = raw[group];
    raw[group] = { ...(g && typeof g === "object" ? g : {}), [key]: value };
    await writeFile(this.file, JSON.stringify(raw, null, 2) + "\n");
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
      text = newSettingsText();
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
    if (this.firstLoad) await this.addSchemaLink(text);
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
