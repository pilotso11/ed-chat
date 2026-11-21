import {
  type PlayerOnlyValues,
  changedPaths,
  describeChanges,
  playerOnlyValues,
  valuesWith,
  withValues,
} from "./playerOnly.js";
import type { Settings } from "./settings.js";
import { PLAYER_ONLY_PATHS } from "./settingsDictionary.js";

/** Whether settings.json text is a JSON object. */
function parses(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return !!v && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((p) => b.includes(p));

export interface PlayerOnlyHost {
  /** settings.json as last read, without a BOM. */
  fileText(): string;
  /** The settings in this text, or null when it is not valid. */
  parse(text: string): Settings | null;
  /** Use these settings now. */
  apply(settings: Settings): void;
  /** Replaces settings.json. Throws when it cannot. */
  write(text: string): Promise<void>;
  /** Shows the changes; true when the player applies them. */
  ask(lines: string[]): Promise<boolean>;
  /** A change waits for the player's answer, or no longer does. */
  waiting(on: boolean): void;
  /** Keeps the applied values across restarts, with the player-only paths they cover. */
  save(values: PlayerOnlyValues, paths: readonly string[]): void;
  log(level: "info" | "warn", text: string): void;
}

/**
 * Keeps the player-only settings at the values the player last applied. A change to them in
 * settings.json, by the player or by the assistant, waits for the player's answer; the other
 * settings in the same save apply at once.
 */
export class PlayerOnlyGuard {
  private asking = false;
  private applied: PlayerOnlyValues;

  /**
   * applied: the values saved at the last run, or null on the first run of this version.
   * covers: the player-only paths those values cover; a version can add some.
   */
  constructor(
    private readonly host: PlayerOnlyHost,
    applied: PlayerOnlyValues | null,
    covers: readonly string[],
  ) {
    // The first run of this version has nothing saved, so it trusts the file it starts with.
    // A setting that became player-only since the values were saved is trusted the same way,
    // at start only, or an upgrade would take back what the player had set. When the file does
    // not parse then, its values are not trusted: the player is asked about them instead.
    const text = host.fileText();
    const file = playerOnlyValues(text);
    this.applied = applied ?? file;
    if (applied && parses(text))
      for (const p of PLAYER_ONLY_PATHS.filter((p) => !covers.includes(p)))
        this.applied = valuesWith(this.applied, p, file[p]);
    if (!applied || !sameSet(covers, PLAYER_ONLY_PATHS)) this.save();
  }

  private save(): void {
    this.host.save(this.applied, PLAYER_ONLY_PATHS);
  }

  /** The values in use. */
  get values(): PlayerOnlyValues {
    return this.applied;
  }

  /** The settings to use: those in the file, with the player-only ones as last applied. */
  effective(): Settings | null {
    try {
      return this.host.parse(withValues(this.host.fileText(), this.applied));
    } catch {
      return null;
    }
  }

  /** Call after each good read of settings.json. */
  fileChanged(): void {
    const s = this.effective();
    if (s) this.host.apply(s);
    this.check();
  }

  /** Asks about a change still waiting, for example one made while ED Chat was closed. */
  check(): void {
    if (this.asking || !this.pending().length) return;
    void this.askLoop();
  }

  /**
   * ED Chat writes settings.json for the player, for example the permission mode the player
   * chose at first start. The new values are trusted before the write, so the file watcher
   * does not ask about them.
   */
  async playerWrite(text: string, path: string, value: unknown): Promise<void> {
    const before = this.applied;
    // Only the value ED Chat sets is trusted: a change in the file that still waits for the
    // player's answer stays in the file, and still waits.
    this.trust(valuesWith(this.applied, path, value));
    try {
      await this.host.write(text);
    } catch (err) {
      this.trust(before);
      throw err;
    }
  }

  private pending(): string[] {
    return changedPaths(this.applied, playerOnlyValues(this.host.fileText()));
  }

  private trust(values: PlayerOnlyValues): void {
    this.applied = values;
    this.save();
  }

  private async askLoop(): Promise<void> {
    this.asking = true;
    this.host.waiting(true);
    try {
      for (;;) {
        const shown = playerOnlyValues(this.host.fileText());
        const paths = changedPaths(this.applied, shown);
        if (!paths.length) return;
        const ok = await this.host.ask(describeChanges(this.applied, shown, paths));
        // The answer is for the values shown. If the file changed again while the question
        // was open, the player is asked about what it holds now.
        if (changedPaths(shown, playerOnlyValues(this.host.fileText())).length) continue;
        if (ok) {
          this.host.log("info", `player-only settings applied: ${paths.join(", ")}`);
          this.trust(shown);
          const s = this.effective();
          if (s) this.host.apply(s);
        } else {
          this.host.log("info", `player-only settings undone: ${paths.join(", ")}`);
          // The watcher then reads the file back and applies the rest of it.
          await this.host.write(withValues(this.host.fileText(), this.applied));
        }
        return;
      }
    } catch (err) {
      this.host.log("warn", `settings.json: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.asking = false;
      this.host.waiting(false);
    }
  }
}
