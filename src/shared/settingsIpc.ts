import type { Settings } from "../core/settings.js";
import type { Change, FormSection } from "../core/settingsForm.js";

// Its own module, apart from ipc.ts: each sandboxed preload must be one file, with no chunk
// shared between them.
// The settings window: a normal window of its own, with its own preload (src/preload/settings.ts).
export const SETTINGS_IPC = {
  load: "settings:load",
  save: "settings:save",
  openFile: "settings:openFile",
  changed: "settings:changed",
} as const;

/** What the settings window shows. */
export interface SettingsSnapshot {
  sections: FormSection[];
  /** The settings in use. */
  values: Settings;
  /** settings.json does not parse: the form is not shown, so a bad hand edit is never overwritten. */
  fileError: string | null;
  /** Hotkeys that did not register at the last activation. */
  failedKeys: string[];
  /** How many monitors there are, for the display fields. */
  displays: number;
}

export type SettingsSaveResult = { ok: true } | { ok: false; error: string; path?: string };

export interface SettingsApi {
  load(): Promise<SettingsSnapshot>;
  save(changes: Change[]): Promise<SettingsSaveResult>;
  /** Opens settings.json in the default editor. */
  openFile(): void;
  /** settings.json changed: by a save, a hand edit or the assistant. */
  onChanged(cb: () => void): void;
}
