import { bindings, hasModifier, normalizeKey } from "./hotkeys.js";
import {
  DEFAULT_SETTINGS,
  NUMPAD_CHIP,
  keyList,
  parseSettings,
  settingsSchemaText,
  type Settings,
} from "./settings.js";
import { SETTINGS_DICTIONARY, type JsonSchemaNode } from "./settingsDictionary.js";
import { getAt, isObj, sameValue, setAt } from "./paths.js";

export { getAt };

// The settings window: its form, built from the settings schema so a new setting shows up in
// it without more UI work, and the settings.json text it saves, which keeps only the values
// that differ from the defaults.

export type FieldKind =
  | { type: "boolean" }
  | { type: "choice"; options: (string | number)[] }
  /** above: the value must be more than this (a zod .positive()). */
  | { type: "number"; integer: boolean; min?: number; max?: number; above?: number }
  | { type: "text"; nullable: boolean }
  /** One key or a list of keys; chip keys contain {n} for the digit. */
  | { type: "keys"; chip: boolean }
  /** "primary" or a monitor number. */
  | { type: "display" }
  /** A list of strings, one to a line. */
  | { type: "list" }
  /** Anything else, edited as JSON. */
  | { type: "json" };

export interface FormField {
  /** The dotted path in settings.json, such as "style.fontSize". */
  path: string;
  label: string;
  help: string;
  kind: FieldKind;
  default: unknown;
  /** Only the player may change it: the assistant must not. */
  playerOnly: boolean;
}

export interface FormSection {
  path: string;
  title: string;
  help: string;
  fields: FormField[];
  sections: FormSection[];
}

/** Settings at the top level that are not a group go in this section, first. */
export const GENERAL = "general";

// The order of the sections; a group missing here comes after them, in schema order.
const ORDER = [
  GENERAL,
  "style",
  "strip",
  "card",
  "chat",
  "position",
  "startup",
  "hotkeys",
  "hud",
  "approval",
  "safety",
  "claude",
  "codex",
];

// Labels that the key name alone does not give well.
const LABELS: Record<string, string> = {
  [GENERAL]: "General",
  hud: "Activity panel",
  "hud.modes": "Panel modes",
  "hud.position": "Panel position",
  "hud.massacre": "Massacre",
  "hud.mining": "Mining",
  "hud.build": "Build",
  agent: "Assistant",
  resumeHours: "Resume within (hours)",
  journalDir: "Journal folder",
  claude: "Claude Code",
  codex: "Codex",
  edMcpDataDir: "ed-mcp data folder",
  valuableMin: "Least mapped value (credits)",
  bioMin: "Least biological value (credits)",
  minPerKill: "Least pay per kill (credits)",
  spansh: "Look up systems on Spansh",
  sellRadiusLy: "Buyer search radius (ly)",
  carrierRadiusLy: "Carrier search radius (ly)",
  maxPriceAgeDays: "Oldest price (days)",
  useCarrier: "Sell from your carrier",
  carrierMarkets: "Include other carriers",
  targets: "Mining targets (%)",
  doneShown: "Done actions shown",
  outfittingVisit: "Outfitting visit",
  copyChip: "Copy chip",
  copyChipNumpad: "Copy chips with Ctrl+numpad",
  showMore: "Step (reply, whole reply, chat)",
  extraArgs: "Extra arguments",
  timeoutSeconds: "Timeout (seconds)",
  fadeSeconds: "Fade after (seconds)",
  showKeys: "Show the hotkeys at start",
  offsetX: "Offset X (px)",
  offsetY: "Offset Y (px)",
  width: "Width (px)",
  backgroundOpacity: "Background opacity",
  blockWhenInDanger: "Block the chat in danger",
  permissionMode: "Permission mode",
};

/** "showHistory" → "Show history". */
function words(key: string): string {
  const s = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const labelOf = (path: string) =>
  LABELS[path] ?? LABELS[path.slice(path.lastIndexOf(".") + 1)] ?? words(path.split(".").pop()!);

const isPlayerOnly = (path: string) => {
  const parts = path.split(".");
  return parts.some((_, i) => SETTINGS_DICTIONARY[parts.slice(0, i + 1).join(".")]?.playerOnly);
};

type Node = JsonSchemaNode & {
  default?: unknown;
  enum?: (string | number)[];
  const?: string | number;
  anyOf?: Node[];
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  items?: Node;
  additionalProperties?: unknown;
  properties?: Record<string, Node>;
};

// The JSON schema's own "safe integer" bound is no limit worth showing.
const bound = (n: number | undefined) =>
  n === undefined || Math.abs(n) >= Number.MAX_SAFE_INTEGER ? undefined : n;

function kindOf(path: string, n: Node): FieldKind {
  if (path.startsWith("hotkeys.") && n.anyOf?.some((a) => a.type === "array"))
    return { type: "keys", chip: path === "hotkeys.copyChip" };
  if (n.type === "boolean") return { type: "boolean" };
  if (n.enum) return { type: "choice", options: n.enum };
  if (n.type === "number" || n.type === "integer")
    return {
      type: "number",
      integer: n.type === "integer",
      min: bound(n.minimum),
      max: bound(n.maximum),
      ...(n.exclusiveMinimum !== undefined ? { above: n.exclusiveMinimum } : {}),
    };
  if (n.type === "string") return { type: "text", nullable: false };
  if (n.type === "array" && n.items?.type === "string") return { type: "list" };
  const any = n.anyOf ?? [];
  if (any.length && any.every((a) => a.const !== undefined))
    return { type: "choice", options: any.map((a) => a.const!) };
  if (any.some((a) => a.const === "primary") && any.some((a) => a.type === "integer"))
    return { type: "display" };
  if (
    any.length === 2 &&
    any.some((a) => a.type === "null") &&
    any.some((a) => a.type === "string")
  )
    return { type: "text", nullable: true };
  return { type: "json" };
}

const isGroupNode = (n: Node) => n.type === "object" && !!n.properties;

function section(path: string, n: Node): FormSection {
  const s: FormSection = {
    path,
    title: labelOf(path),
    help: SETTINGS_DICTIONARY[path]?.text ?? "",
    fields: [],
    sections: [],
  };
  for (const [key, child] of Object.entries(n.properties ?? {})) {
    const p = `${path}.${key}`;
    if (isGroupNode(child)) s.sections.push(section(p, child));
    else s.fields.push(field(p, child));
  }
  return s;
}

function field(path: string, n: Node): FormField {
  return {
    path,
    label: labelOf(path),
    help: SETTINGS_DICTIONARY[path]?.text ?? "",
    kind: kindOf(path, n),
    default: getAt(DEFAULT_SETTINGS, path),
    playerOnly: isPlayerOnly(path),
  };
}

let built: FormSection[] | null = null;

/**
 * The settings window's sections, in order, each with its fields and its own sections. Built
 * once: the schema does not change while ED Chat runs. Read only.
 */
export function settingsForm(): FormSection[] {
  return (built ??= buildForm());
}

function buildForm(): FormSection[] {
  const schema = JSON.parse(settingsSchemaText()) as Node;
  const general: FormSection = {
    path: GENERAL,
    title: labelOf(GENERAL),
    help: "",
    fields: [],
    sections: [],
  };
  const groups: FormSection[] = [general];
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (key === "$schema") continue;
    if (isGroupNode(child)) groups.push(section(key, child));
    else general.fields.push(field(key, child));
  }
  const rank = (s: FormSection) => {
    const i = ORDER.indexOf(s.path);
    return i < 0 ? ORDER.length : i;
  };
  return groups
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map((x) => x.s);
}

/** Every field of these sections, in order. */
export function allFields(sections: FormSection[]): FormField[] {
  return sections.flatMap((s) => [...s.fields, ...allFields(s.sections)]);
}

/**
 * Kept in the file even at the default: whether the file sets it is itself a setting. ED Chat
 * asks for the permission mode at first start only when the file does not set it.
 */
const KEEP_AT_DEFAULT = new Set(["claude.permissionMode", "codex.permissionMode"]);

export interface Change {
  path: string;
  value: unknown;
}

/**
 * settings.json text with these changes made and the rest of the file kept. A value equal to
 * its default is taken out of the file, so a later release's default applies to it. Throws
 * when the file is not a JSON object, which must never be replaced.
 */
export function textWithChanges(fileText: string, changes: Change[]): string {
  const raw = JSON.parse(fileText) as unknown;
  if (!isObj(raw)) throw new Error("settings.json is not an object");
  for (const c of changes) {
    const drop =
      sameValue(c.value, getAt(DEFAULT_SETTINGS, c.path)) && !KEEP_AT_DEFAULT.has(c.path);
    setAt(raw, c.path, drop ? undefined : c.value);
  }
  return JSON.stringify(raw, null, 2) + "\n";
}

/** What settings.json would hold, and the paths of the player-only values in it. */
export type SaveResult =
  | { ok: true; text: string; settings: Settings; playerOnly: Change[] }
  | { ok: false; error: string; path?: string };

/** The text to save for these changes, checked against the schema before anything is written. */
export function saveText(fileText: string, changes: Change[]): SaveResult {
  // Only the form's own fields: a path such as "__proto__.x" must never reach setAt.
  const known = new Set(allFields(settingsForm()).map((f) => f.path));
  const unknown = changes.find((c) => !known.has(c.path));
  if (unknown) return { ok: false, error: `${unknown.path}: not a setting`, path: unknown.path };
  let text: string;
  try {
    text = textWithChanges(fileText, changes);
  } catch (err) {
    return { ok: false, error: `settings.json: ${(err as Error).message}` };
  }
  const r = parseSettings(text);
  if (!r.ok) return { ok: false, error: r.error, path: r.path };
  // The value as written: a default is absent, so the player-only check sees the file as it is.
  const written = JSON.parse(text) as unknown;
  const playerOnly = changes
    .filter((c) => isPlayerOnly(c.path))
    .map((c) => ({ path: c.path, value: getAt(written, c.path) }));
  return { ok: true, text, settings: r.settings, playerOnly };
}

/** Every setting at its default: the changes that Reset all saves. */
export function resetAll(sections: FormSection[]): Change[] {
  return allFields(sections).map((f) => ({ path: f.path, value: f.default }));
}

/**
 * The problem with each hotkey field, by path: a key another action already has, or one that
 * Windows would not register (failed, from the last activation, such as a key another app holds).
 */
export function keyProblems(h: Settings["hotkeys"], failed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const nameOf = (n: string) => (n.startsWith("copyChip") ? "copyChip" : n);
  const add = (name: string, text: string) => {
    const p = `hotkeys.${nameOf(name)}`;
    if (!out[p]?.includes(text)) out[p] = out[p] ? `${out[p]}; ${text}` : text;
  };
  const owner = new Map<string, string>();
  const all = (() => {
    try {
      return bindings(h);
    } catch {
      return [];
    }
  })();
  const failedSet = new Set(failed.map(normalizeKey));
  for (const b of all) {
    const k = normalizeKey(b.accelerator);
    const first = owner.get(k);
    if (first !== undefined && nameOf(first) !== nameOf(b.name)) {
      add(b.name, `${b.accelerator} is also ${labelOf(`hotkeys.${nameOf(first)}`)}`);
      add(first, `${b.accelerator} is also ${labelOf(`hotkeys.${nameOf(b.name)}`)}`);
    } else if (first === undefined) owner.set(k, b.name);
    if (failedSet.has(k)) add(b.name, `${b.accelerator} is in use by another app`);
    if (h.scope === "always" && !hasModifier(b.accelerator))
      add(b.name, `${b.accelerator} has no modifier, so scope always leaves it off`);
  }
  if (h.copyChipNumpad && keyList(h.copyChip).includes(NUMPAD_CHIP))
    add("copyChip", `${NUMPAD_CHIP} is set twice`);
  return out;
}

/** A key as the window reads it from a key press. */
export interface KeyInput {
  key: string;
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

const NAMED: Record<string, string> = {
  Enter: "Enter",
  NumpadEnter: "Enter",
  Space: "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
  PrintScreen: "PrintScreen",
  Pause: "Pause",
};

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/**
 * The Electron accelerator for a key press, such as "Ctrl+Alt+X", or null while only modifiers
 * are held. A letter is the one the layout types, as in chordFromKey; a digit and punctuation
 * come from the key's position, so Shift+1 is "Shift+1", not "!".
 */
export function acceleratorFromKey(k: KeyInput): string | null {
  if (
    MODIFIER_CODES.test(k.code) ||
    ["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(k.key)
  )
    return null;
  const letter = /^Key([A-Z])$/.exec(k.code)?.[1];
  const latin = /^[a-z]$/i.test(k.key) ? k.key.toUpperCase() : undefined;
  const key =
    (letter && (latin ?? letter)) ??
    /^Digit(\d)$/.exec(k.code)?.[1] ??
    (/^Numpad(\d)$/.exec(k.code)?.[1] && `num${k.code.slice(-1)}`) ??
    (/^F\d{1,2}$/.test(k.code) ? k.code : undefined) ??
    NAMED[k.code] ??
    (k.key === "+" ? "Plus" : k.key.length === 1 ? k.key.toUpperCase() : null);
  if (!key) return null;
  const mods = [k.ctrl && "Ctrl", k.alt && "Alt", k.shift && "Shift", k.meta && "Super"].filter(
    Boolean,
  );
  return [...mods, key].join("+");
}

/**
 * The chip pattern for a key press with a digit, such as "Ctrl+Alt+{n}", or null for any
 * other key. The digit pressed stands for all nine.
 */
export function chipPatternFromKey(k: KeyInput): string | null {
  const a = acceleratorFromKey(k);
  if (!a) return null;
  const m = /^(.*\+)?(num)?[1-9]$/.exec(a);
  if (!m) return null;
  return `${m[1] ?? ""}${m[2] ?? ""}{n}`;
}
