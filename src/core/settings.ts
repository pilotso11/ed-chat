import { z } from "zod";
import { DEFAULT_MINING_TARGETS } from "./miningTargets.js";
import { FONT_NAMES, THEME_NAMES } from "./theme.js";
import { annotateSchema, type JsonSchemaNode } from "./settingsDictionary.js";

export { DEFAULT_MINING_TARGETS };

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
  openChat: keys.default("Ctrl+Alt+Enter"),
  toggleIcon: keys.default("Ctrl+Alt+Shift+Enter"),
  showMore: keys.default("Ctrl+`"),
  showHistory: keys.default("Ctrl+Alt+H"),
  approve: keys.default("Ctrl+Alt+Y"),
  deny: keys.default("Ctrl+Alt+N"),
  alwaysAllow: keys.default("Ctrl+Alt+A"),
  cancel: keys.default("Ctrl+Alt+X"),
  copyChip: chipKeys.default("Ctrl+Alt+{n}"),
  copyChipNumpad: z.boolean().default(false),
  moveUp: keys.default("Ctrl+Alt+Up"),
  moveDown: keys.default("Ctrl+Alt+Down"),
  moveLeft: keys.default("Ctrl+Alt+Left"),
  moveRight: keys.default("Ctrl+Alt+Right"),
  nextDisplay: keys.default("Ctrl+Alt+M"),
  hudToggle: keys.default("Ctrl+Alt+P"),
  hudMode: keys.default("Ctrl+Alt+Shift+P"),
  hudMove: keys.default("Ctrl+Alt+Home"),
  routeNext: keys.default("Ctrl+Alt+PageDown"),
  routePrev: keys.default("Ctrl+Alt+PageUp"),
  bookmark: keys.default("Ctrl+Alt+B"),
});

// Windows turns Shift+numpad digit into End, Down and so on, so the numpad keys use Ctrl only.
export const NUMPAD_CHIP = "Ctrl+num{n}";

const positionSchema = (anchor: Anchor, offsetY: number) =>
  z.strictObject({
    anchor: z.enum(ANCHORS).default(anchor),
    offsetX: z.number().int().min(0).default(24),
    offsetY: z.number().int().min(0).default(offsetY),
    display: z.union([z.literal("primary"), z.number().int().min(0)]).default("primary"),
  });
export const PositionSchema = positionSchema("bottom-left", 24);
export type Position = z.infer<typeof PositionSchema>;

export const HUD_MODES = [
  "massacre",
  "exploration",
  "exobiology",
  "mining",
  "passenger",
  "trade",
  "route",
] as const;
export type HudModeId = (typeof HUD_MODES)[number];

const HudSchema = z.strictObject({
  enabled: z.boolean().default(true),
  position: positionSchema("top-right", 120).prefault({}),
  width: z.number().int().min(200).max(1200).default(380),
  fontSize: z.number().min(8).max(48).default(15),
  backgroundOpacity: z.number().min(0).max(1).default(0.55),
  modes: z
    .strictObject({
      massacre: z.boolean().default(true),
      exploration: z.boolean().default(true),
      exobiology: z.boolean().default(true),
      mining: z.boolean().default(true),
      passenger: z.boolean().default(true),
      trade: z.boolean().default(true),
      route: z.boolean().default(true),
    })
    .prefault({}),
  // Bodies worth less than this when mapped are left off the exploration panel. Those with
  // geological signals are only counted, on one line.
  valuableMin: z.number().int().min(0).default(500_000),
  // Look up each system's planets on Spansh when you arrive, to call out Earth-like, water and
  // ammonia worlds and terraformables before they are scanned.
  spansh: z.boolean().default(true),
  // Show surface bookmarks (the bookmark key) on the body and in the system.
  bookmarks: z.boolean().default(true),
  // Planets with biological signals worth less than this are left off the exploration panel.
  // Before the species are known, a planet is judged by the least its genera can be worth.
  bioMin: z.number().int().min(0).default(5_000_000),
  massacre: z
    .strictObject({
      // Credits a kill: a target whose missions still to finish pay less than this a kill left is
      // marked ⚠. 0 turns it off.
      minPerKill: z.number().min(0).default(1_000_000),
    })
    .prefault({}),
  mining: z
    .strictObject({
      // The least percentage of each commodity in a prospected rock that is worth mining. Entries
      // change or add to DEFAULT_MINING_TARGETS one commodity at a time; null removes one.
      targets: z
        .record(z.string().min(1), z.number().min(0).max(100).nullable())
        .default({ ...DEFAULT_MINING_TARGETS }),
      // Sell from your fleet carrier: buyers are searched around the carrier, for what is in the
      // hold and what was moved to the carrier in the last 12 hours.
      useCarrier: z.boolean().default(false),
      // Include other players' fleet carriers as buyers.
      carrierMarkets: z.boolean().default(false),
      sellRadiusLy: z.number().positive().max(1000).default(100),
      carrierRadiusLy: z.number().positive().max(1000).default(500),
      // Buyers whose Spansh market data is older than this are left out.
      maxPriceAgeDays: z.number().positive().max(90).default(7),
    })
    .prefault({}),
  // The ed-mcp sync folder, for the activity note and plans. null: read it from the ed-mcp
  // that the assistant runs (edMcp.ts), else ed-mcp's own config folder.
  edMcpDataDir: z.string().min(1).nullable().default(null),
});

// How ED Chat starts each CLI: the same fields for both; model differs by its default. null
// leaves the CLI's own default.
const cliSchema = (model: string) =>
  z.strictObject({
    path: z.string().min(1).nullable().default(null),
    permissionMode: z.enum(["auto", "default"]).default("auto"),
    model: z.string().min(1).nullable().default(model),
    extraArgs: z.array(z.string()).default([]),
  });

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
      // standard: Segoe UI. compact: a narrower face, for more text in the same width.
      font: z.enum(FONT_NAMES).default("standard"),
      // The overlay's colour. game follows the HUD colour in the game's own settings, and is
      // orange, the game's default, when there is none.
      theme: z.enum(THEME_NAMES).default("game"),
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
  // Which assistant runs. Only the player changes it: it decides which company gets the chat.
  agent: z.enum(["claude", "codex"]).default("claude"),
  resumeHours: z.number().min(0).max(720).default(12),
  // Sonnet is quick and cheap enough for short in-game answers; Opus is a setting away.
  claude: cliSchema("sonnet").prefault({}),
  codex: cliSchema("gpt-6.1-terra").prefault({}),
  journalDir: z.string().min(1).nullable().default(null),
  hud: HudSchema.prefault({}),
});
export type Settings = z.infer<typeof SettingsSchema>;
export type CliSettings = Settings["claude"];

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

// Settings that later releases removed. An older settings.json still holds them, and an
// unknown key is an error, so they are dropped before the check.
const REMOVED: [string, string][] = [["hotkeys", "toggleOverlay"]];

const isGroup = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function dropRemoved(raw: unknown): void {
  for (const [group, key] of REMOVED) {
    const g = (raw as Record<string, unknown> | null)?.[group];
    if (isGroup(g)) delete g[key];
  }
}

// claude.resumeHours moved to the top level when Codex came; an older file still loads. The
// top-level value wins when both are set.
function moveResumeHours(raw: unknown): void {
  if (!isGroup(raw) || !isGroup(raw.claude) || !("resumeHours" in raw.claude)) return;
  if (!("resumeHours" in raw)) raw.resumeHours = raw.claude.resumeHours;
  delete raw.claude.resumeHours;
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
  moveResumeHours(raw);
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
  const schema = z.toJSONSchema(SettingsSchema, { io: "input" }) as JsonSchemaNode;
  schema.properties = { $schema: { type: "string" }, ...schema.properties };
  annotateSchema(schema);
  return JSON.stringify(schema, null, 2) + "\n";
}
