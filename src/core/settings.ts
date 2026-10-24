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

const key = z.string().min(1);

// zod 4: .default() skips inner defaults, .prefault() parses them.
const HotkeysSchema = z.strictObject({
  scope: z.enum(["game", "always"]).default("game"),
  openChat: key.default("Ctrl+Shift+Space"),
  toggleOverlay: key.default("Ctrl+Shift+O"),
  toggleIcon: key.default("`"),
  showHistory: key.default("Ctrl+Shift+H"),
  approve: key.default("Ctrl+Shift+Y"),
  deny: key.default("Ctrl+Shift+N"),
  cancel: key.default("Ctrl+Shift+X"),
  copyChip: key.refine((s) => s.includes("{n}"), "must contain {n}").default("Ctrl+Shift+{n}"),
  moveUp: key.default("Ctrl+Alt+Up"),
  moveDown: key.default("Ctrl+Alt+Down"),
  moveLeft: key.default("Ctrl+Alt+Left"),
  moveRight: key.default("Ctrl+Alt+Right"),
  nextDisplay: key.default("Ctrl+Alt+M"),
});

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
      maxLines: z.number().int().min(2).max(8).default(4),
      fadeSeconds: z.number().min(0).default(20),
      width: z.number().int().min(200).max(1200).default(420),
    })
    .prefault({}),
  chat: z.strictObject({ lines: z.number().int().min(4).max(40).default(14) }).prefault({}),
  style: z.strictObject({ fontSize: z.number().min(8).max(48).default(14) }).prefault({}),
  position: PositionSchema.prefault({}),
  safety: z.strictObject({ blockWhenInDanger: z.boolean().default(true) }).prefault({}),
  approval: z
    .strictObject({ timeoutSeconds: z.number().int().min(5).max(3600).default(120) })
    .prefault({}),
  claude: z
    .strictObject({
      path: z.string().min(1).nullable().default(null),
      permissionMode: z.enum(["auto", "default"]).default("auto"),
      extraArgs: z.array(z.string()).default([]),
    })
    .prefault({}),
  journalDir: z.string().min(1).nullable().default(null),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export type ParseResult = { ok: true; settings: Settings } | { ok: false; error: string };

export function parseSettings(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON (${(err as Error).message})` };
  }
  const r = SettingsSchema.safeParse(raw);
  if (r.success) return { ok: true, settings: r.data };
  const issue = r.error.issues[0]!;
  const where = issue.path.length ? issue.path.join(".") : "(top level)";
  return { ok: false, error: `${where}: ${issue.message}` };
}

export function defaultSettingsText(): string {
  return JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n";
}
