import { z } from "zod";

export const ANCHORS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
export type Anchor = (typeof ANCHORS)[number];

// One key, or several keys for the same action.
const accel = z.string().min(1);
const keys = z.union([accel, z.array(accel).min(1)]);
const chipPattern = accel.refine((s) => s.includes("{n}"), "must contain {n}");
const chipKeys = z.union([chipPattern, z.array(chipPattern).min(1)]);
export type Keys = z.infer<typeof keys>;

export const keyList = (k: Keys): string[] => (typeof k === "string" ? [k] : k);

// zod 4: .default() skips inner defaults, .prefault() parses them.
const HotkeysSchema = z.strictObject({
  scope: z.enum(["game", "always"]).default("game"),
  openChat: keys.default("Ctrl+Alt+C"),
  toggleIcon: keys.default("Ctrl+Alt+Enter"),
  showMore: keys.default("Ctrl+`"),
  showHistory: keys.default("Ctrl+Shift+H"),
  approve: keys.default("Ctrl+Shift+Y"),
  deny: keys.default("Ctrl+Shift+N"),
  alwaysAllow: keys.default("Ctrl+Shift+A"),
  cancel: keys.default("Ctrl+Alt+X"),
  copyChip: chipKeys.default("Ctrl+Shift+{n}"),
  copyChipNumpad: z.boolean().default(false),
  moveUp: keys.default("Ctrl+Alt+Up"),
  moveDown: keys.default("Ctrl+Alt+Down"),
  moveLeft: keys.default("Ctrl+Alt+Left"),
  moveRight: keys.default("Ctrl+Alt+Right"),
  nextDisplay: keys.default("Ctrl+Alt+M"),
});

// Windows turns Shift+numpad digit into End, Down and so on, so the numpad keys use Ctrl only.
export const NUMPAD_CHIP = "Ctrl+num{n}";

export const PositionSchema = z.strictObject({
  anchor: z.enum(ANCHORS).default("bottom-left"),
  offsetX: z.number().int().min(0).default(24),
  offsetY: z.number().int().min(0).default(24),
  display: z.union([z.literal("primary"), z.number().int().min(0)]).default("primary"),
});
export type Position = z.infer<typeof PositionSchema>;

export const SettingsSchema = z.strictObject({
  hotkeys: HotkeysSchema.prefault({}),
  strip: z
    .strictObject({
      lines: z.union([z.literal(1), z.literal(2)]).default(2),
      keepChips: z.boolean().default(true),
      startAsIcon: z.boolean().default(false),
    })
    .prefault({}),
  card: z
    .strictObject({
      maxLines: z.number().int().min(2).max(10).default(4),
      fadeSeconds: z.number().min(0).default(20),
      width: z.number().int().min(200).max(1200).default(420),
    })
    .prefault({}),
  chat: z.strictObject({ lines: z.number().int().min(4).max(40).default(14) }).prefault({}),
  style: z
    .strictObject({
      fontSize: z.number().min(8).max(48).default(14),
      backgroundOpacity: z.number().min(0).max(1).default(0.78),
    })
    .prefault({}),
  position: PositionSchema.prefault({}),
  startup: z.strictObject({ showKeys: z.boolean().default(true) }).prefault({}),
  safety: z.strictObject({ blockWhenInDanger: z.boolean().default(true) }).prefault({}),
  approval: z
    .strictObject({
      timeoutSeconds: z.number().int().min(5).max(3600).default(120),
      sound: z.boolean().default(true),
    })
    .prefault({}),
  claude: z
    .strictObject({
      path: z.string().min(1).nullable().default(null),
      permissionMode: z.enum(["auto", "default"]).default("auto"),
      extraArgs: z.array(z.string()).default([]),
      resumeHours: z.number().min(0).max(720).default(12),
    })
    .prefault({}),
  journalDir: z.string().min(1).nullable().default(null),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

// Settings that later releases removed. An older settings.json still holds them, and an
// unknown key is an error, so they are dropped before the check.
const REMOVED: [string, string][] = [["hotkeys", "toggleOverlay"]];

function dropRemoved(raw: unknown): void {
  for (const [group, key] of REMOVED) {
    const g = (raw as Record<string, unknown> | null)?.[group];
    if (g && typeof g === "object" && !Array.isArray(g)) delete (g as Record<string, unknown>)[key];
  }
}

/** Whether the player's own settings.json sets this value, as opposed to the default. */
export function setsKey(text: string, group: string, key: string): boolean {
  try {
    const g = (JSON.parse(text) as Record<string, unknown>)[group];
    return !!g && typeof g === "object" && key in g;
  } catch {
    return false;
  }
}

export type ParseResult = { ok: true; settings: Settings } | { ok: false; error: string };

export function parseSettings(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON (${(err as Error).message})` };
  }
  // "$schema" points editors at settings.schema.json; it is not a setting.
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "$schema" in raw) {
    const { $schema: _s, ...rest } = raw as Record<string, unknown>;
    raw = rest;
  }
  dropRemoved(raw);
  const r = SettingsSchema.safeParse(raw);
  if (r.success) return { ok: true, settings: r.data };
  const issue = r.error.issues[0]!;
  const where = issue.path.length ? issue.path.join(".") : "(top level)";
  return { ok: false, error: `${where}: ${issue.message}` };
}

export const SCHEMA_FILE = "settings.schema.json";
export const DEFAULTS_FILE = "settings.defaults.json";

export function defaultSettingsText(): string {
  return JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n";
}

/**
 * A new settings.json holds only the schema link. Every value comes from the defaults in
 * code, so a later release can change a default for everyone who has not set that key.
 */
export function newSettingsText(): string {
  return JSON.stringify({ $schema: `./${SCHEMA_FILE}` }, null, 2) + "\n";
}

export function settingsSchemaText(): string {
  const schema = z.toJSONSchema(SettingsSchema, { io: "input" }) as {
    properties?: Record<string, unknown>;
  };
  schema.properties = { $schema: { type: "string" }, ...schema.properties };
  return JSON.stringify(schema, null, 2) + "\n";
}
