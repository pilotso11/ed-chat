import { column, growsUp } from "./anchor.js";
import { parseChips, type Chip } from "./chips.js";
import {
  currentApproval,
  currentChips,
  hasAttention,
  windowProps,
  type OverlayState,
  type Turn,
} from "./controller.js";
import { chipKeyLabel, keyLabel, type KeyRow } from "./hotkeys.js";
import type { Settings } from "./settings.js";

export interface Notice {
  text: string;
  /** A command in backticks in the text; a click on the notice copies it. */
  command: string | null;
  /** How many other notices wait behind this one. */
  more: number;
}

export interface ViewModel {
  show: boolean;
  mode: "icon" | "strip" | "card" | "chat";
  status: string;
  auto: boolean;
  notice: Notice | null;
  keys: KeyRow[] | null;
  pinned: string | null;
  chips: Chip[];
  card: { text: string; chips: Chip[]; full: boolean } | null;
  chat: {
    history: Turn[];
    streaming: string | null;
    chips: Chip[];
    input: boolean;
    canSend: boolean;
  } | null;
  approval: {
    id: string;
    toolName: string;
    summary: string;
    shell: boolean;
    deadline: number;
    timeoutMs: number;
    /** "1 of 3" when more requests wait. */
    position: string | null;
    approveKey: string;
    denyKey: string;
    alwaysKey: string;
  } | null;
  icon: { dot: boolean; danger: boolean } | null;
  ui: {
    fontSize: number;
    backgroundOpacity: number;
    width: number;
    maxLines: number;
    chatLines: number;
    growsUp: boolean;
    align: "start" | "center" | "end";
    copyChipKey: string;
  };
}

export function shortTool(name: string): string {
  return name.split("__").at(-1) ?? name;
}

export function statusText(s: OverlayState): string {
  const state =
    s.session === "starting"
      ? s.cancelled
        ? "■ stopped"
        : "● starting"
      : s.session === "stopped"
        ? "⚠ stopped"
        : s.tool
          ? `🔧 ${shortTool(s.tool)}…`
          : s.session === "thinking"
            ? s.reply
              ? "● receiving"
              : "● sending"
            : s.blocked
              ? `🛡 blocked: ${shortTool(s.blocked)}`
              : "● idle";
  const ship = s.flags?.inDanger ? "   ⛔ in danger" : s.flags?.docked ? "   ⚓ docked" : "";
  return state + ship;
}

const ALIGN = { left: "start", center: "center", right: "end" } as const;

// Problems that stop the overlay working come first. Other keys are short flashes, such as
// "copied", which show first while they last.
const PERSISTENT = ["claude", "settings", "hotkeys", "edmcp", "mode", "version", "scope"];

// Only notices with fixed text offer a command to copy. The claude notice quotes the CLI's
// stderr, which text from the model can reach, so it must never hand the player a command.
const COMMAND_NOTICES = ["edmcp", "version"];

/** The command a click on the notice copies, or null. */
export function noticeCommand(key: string, text: string): string | null {
  return COMMAND_NOTICES.includes(key) ? (/`([^`]+)`/.exec(text)?.[1] ?? null) : null;
}

export function pickNotice(notices: Record<string, string>): Notice | null {
  const keys = Object.keys(notices);
  if (!keys.length) return null;
  const flashes = keys.filter((k) => !PERSISTENT.includes(k));
  const top = flashes.at(-1) ?? PERSISTENT.find((k) => k in notices)!;
  const text = notices[top]!;
  const command = noticeCommand(top, text);
  return { text, command, more: keys.length - 1 };
}

export function buildView(s: OverlayState, settings: Settings): ViewModel {
  const open = s.chatOpen || s.historyOpen;
  // A refused chat or focus shows the strip for its notice's few seconds, also in icon mode:
  // the icon has no room for text, and the key must not look broken.
  const iconRest = s.iconMode && !hasAttention(s);
  const mode = open ? "chat" : s.cardOpen ? "card" : iconRest ? "icon" : "strip";
  const reply = parseChips(s.reply);
  const scale = settings.style.fontSize / 14;
  const approval = currentApproval(s);
  return {
    show: windowProps(s).show,
    mode,
    icon:
      mode === "icon"
        ? {
            dot: s.chips.length > 0 || Object.keys(s.notices).length > 0,
            danger: s.flags?.inDanger === true,
          }
        : null,
    status: statusText(s),
    auto: settings.claude.permissionMode === "auto" && !("mode" in s.notices),
    notice: pickNotice(s.notices),
    keys: s.keys,
    pinned: settings.strip.lines === 2 ? s.pinned : null,
    chips: settings.strip.keepChips ? s.chips : [],
    card: mode === "card" ? { text: reply.plain, chips: reply.chips, full: s.cardFull } : null,
    chat: open
      ? {
          history: s.history.map((t) =>
            t.role === "assistant" ? { ...t, text: parseChips(t.text).plain } : t,
          ),
          streaming: s.session === "thinking" ? reply.plain : null,
          chips: currentChips(s),
          input: s.chatOpen,
          canSend: s.session !== "thinking",
        }
      : null,
    approval: approval
      ? {
          id: approval.id,
          toolName: shortTool(approval.toolName),
          summary: approval.summary,
          shell: approval.shell,
          deadline: approval.deadline,
          timeoutMs: settings.approval.timeoutSeconds * 1000,
          position: s.approvals.length > 1 ? `1 of ${s.approvals.length}` : null,
          approveKey: keyLabel(settings.hotkeys.approve),
          denyKey: keyLabel(settings.hotkeys.deny),
          alwaysKey: keyLabel(settings.hotkeys.alwaysAllow),
        }
      : null,
    ui: {
      fontSize: settings.style.fontSize,
      backgroundOpacity: settings.style.backgroundOpacity,
      width: Math.round(settings.card.width * scale),
      maxLines: settings.card.maxLines,
      chatLines: settings.chat.lines,
      growsUp: growsUp(settings.position.anchor),
      align: ALIGN[column(settings.position.anchor)],
      copyChipKey: chipKeyLabel(settings.hotkeys),
    },
  };
}
