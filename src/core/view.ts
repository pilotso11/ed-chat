import { growsUp } from "./anchor.js";
import { parseChips, type Chip } from "./chips.js";
import type { OverlayState, Turn } from "./controller.js";
import type { Settings } from "./settings.js";

export interface ViewModel {
  show: boolean;
  mode: "strip" | "card" | "chat";
  status: string;
  notice: string | null;
  pinned: string | null;
  chips: Chip[];
  card: { text: string; chips: Chip[] } | null;
  chat: { history: Turn[]; streaming: string | null; input: boolean; moving: boolean } | null;
  approval: { toolName: string; summary: string; approveKey: string; denyKey: string } | null;
  ui: {
    fontSize: number;
    width: number;
    maxLines: number;
    chatLines: number;
    growsUp: boolean;
    copyChipKey: string;
  };
}

export function shortTool(name: string): string {
  return name.split("__").at(-1) ?? name;
}

export function statusText(s: OverlayState): string {
  const state =
    s.session === "starting"
      ? "● starting"
      : s.session === "stopped"
        ? "⚠ stopped"
        : s.tool
          ? `🔧 ${shortTool(s.tool)}…`
          : s.session === "thinking"
            ? "● thinking"
            : s.blocked
              ? `🛡 blocked: ${shortTool(s.blocked)}`
              : "● idle";
  const ship = s.flags?.inDanger ? "   ⛔ in danger" : s.flags?.docked ? "   ⚓ docked" : "";
  return state + ship;
}

export function buildView(s: OverlayState, settings: Settings): ViewModel {
  const open = s.chatOpen || s.historyOpen;
  const mode = open ? "chat" : s.cardOpen ? "card" : "strip";
  const reply = parseChips(s.reply);
  const scale = settings.style.fontSize / 14;
  return {
    show: s.visible || s.chatOpen || s.approval !== null,
    mode,
    status: statusText(s),
    notice: Object.values(s.notices).at(-1) ?? null,
    pinned: settings.strip.lines === 2 ? s.pinned : null,
    chips: settings.strip.keepChips ? s.chips : [],
    card: mode === "card" ? { text: reply.plain, chips: reply.chips } : null,
    chat: open
      ? {
          history: s.history.map((t) =>
            t.role === "assistant" ? { ...t, text: parseChips(t.text).plain } : t,
          ),
          streaming: s.session === "thinking" ? reply.plain : null,
          input: s.chatOpen,
          moving: s.flags ? !s.flags.docked : false,
        }
      : null,
    approval: s.approval
      ? {
          toolName: shortTool(s.approval.toolName),
          summary: s.approval.summary,
          approveKey: settings.hotkeys.approve,
          denyKey: settings.hotkeys.deny,
        }
      : null,
    ui: {
      fontSize: settings.style.fontSize,
      width: Math.round(settings.card.width * scale),
      maxLines: settings.card.maxLines,
      chatLines: settings.chat.lines,
      growsUp: growsUp(settings.position.anchor),
      copyChipKey: settings.hotkeys.copyChip.replace("{n}", "n"),
    },
  };
}
