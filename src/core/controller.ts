import type { ApprovalRequest } from "./approvalServer.js";
import { firstLine, parseChips, type Chip } from "./chips.js";
import type { BackendEvent } from "./claudeSession.js";
import type { ShipFlags } from "./status.js";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface OverlayState {
  visible: boolean;
  chatOpen: boolean;
  historyOpen: boolean;
  cardOpen: boolean;
  session: "starting" | "idle" | "thinking" | "stopped";
  tool: string | null;
  blocked: string | null;
  reply: string;
  chips: Chip[];
  pinned: string | null;
  history: Turn[];
  approvals: ApprovalRequest[];
  flags: ShipFlags | null;
  notices: Record<string, string>;
  /** The resting state is a small icon; replies, approvals and the chat leave it. */
  iconMode: boolean;
}

export const INITIAL_STATE: OverlayState = {
  visible: true,
  chatOpen: false,
  historyOpen: false,
  cardOpen: false,
  session: "starting",
  tool: null,
  blocked: null,
  reply: "",
  chips: [],
  pinned: null,
  history: [],
  approvals: [],
  flags: null,
  notices: {},
  iconMode: false,
};

export type Action =
  | { type: "toggleVisible" }
  | { type: "toggleIcon" }
  | { type: "setIcon"; on: boolean }
  | { type: "openChat" }
  | { type: "closeChat" }
  | { type: "toggleHistory" }
  | { type: "sent"; text: string }
  | { type: "backend"; event: BackendEvent }
  | { type: "cardTimeout" }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approvalSettled"; id: string }
  | { type: "flags"; flags: ShipFlags | null }
  | { type: "notice"; key: string; text: string | null }
  | { type: "newSession" }
  | { type: "cancelled" };

function withNotice(s: OverlayState, key: string, text: string | null): OverlayState {
  const { [key]: _old, ...rest } = s.notices;
  return { ...s, notices: text === null ? rest : { ...rest, [key]: text } };
}

const tail = (lines: string[]) => (lines.length ? `: ${lines.at(-1)}` : "");

function onBackend(s: OverlayState, e: BackendEvent): OverlayState {
  switch (e.type) {
    case "spawned":
    case "ready":
      return withNotice(
        { ...s, session: s.session === "thinking" ? "thinking" : "idle" },
        "claude",
        null,
      );
    case "text":
      return { ...s, reply: s.reply + e.delta, session: "thinking", iconMode: false };
    case "toolStart":
      return { ...s, tool: e.name };
    case "toolEnd":
      return { ...s, tool: null };
    case "result": {
      // An error result carries the CLI's own message, which is shown unchanged.
      const reply = e.isError ? (e.text ?? "Claude returned an error.") : s.reply || (e.text ?? "");
      const { plain, chips } = parseChips(reply);
      return {
        ...s,
        session: "idle",
        tool: null,
        reply,
        chips,
        pinned: firstLine(plain),
        blocked: e.denials[0] ?? null,
        cardOpen: true,
        history: [...s.history, { role: "assistant", text: reply }],
      };
    }
    case "exit":
      return withNotice(
        { ...s, session: "stopped", tool: null },
        "claude",
        `⚠ Claude stopped${tail(e.stderrTail)}`,
      );
    case "gaveUp":
      return withNotice(
        { ...s, session: "stopped", tool: null },
        "claude",
        `⚠ Claude keeps stopping${tail(e.stderrTail)}`,
      );
    case "spawnError":
      return withNotice(
        { ...s, session: "stopped", tool: null },
        "claude",
        e.message.includes("ENOENT")
          ? "⚠ claude not found: install Claude Code or set claude.path"
          : `⚠ Can't start claude: ${e.message}`,
      );
    case "unknown":
      return s;
  }
}

export function reduce(s: OverlayState, a: Action): OverlayState {
  switch (a.type) {
    case "toggleVisible":
      return { ...s, visible: !s.visible };
    case "toggleIcon":
      return { ...s, iconMode: !s.iconMode, visible: true };
    case "setIcon":
      return { ...s, iconMode: a.on };
    case "openChat":
      return { ...s, chatOpen: true, visible: true, iconMode: false };
    case "closeChat":
      return { ...s, chatOpen: false };
    case "toggleHistory":
      return { ...s, historyOpen: !s.historyOpen, visible: true, iconMode: false };
    case "sent":
      return {
        ...s,
        chatOpen: false,
        cardOpen: true,
        session: "thinking",
        reply: "",
        blocked: null,
        history: [...s.history, { role: "user", text: a.text }],
      };
    case "backend":
      return onBackend(s, a.event);
    case "cardTimeout":
      return s.session === "thinking" ? s : { ...s, cardOpen: false };
    case "approval":
      return { ...s, approvals: [...s.approvals, a.request], iconMode: false };
    case "approvalSettled":
      return { ...s, approvals: s.approvals.filter((r) => r.id !== a.id) };
    case "flags":
      return { ...s, flags: a.flags };
    case "notice":
      return withNotice(s, a.key, a.text);
    case "newSession":
      return withNotice(
        {
          ...s,
          reply: "",
          chips: [],
          pinned: null,
          history: [],
          session: "starting",
          tool: null,
          blocked: null,
          cardOpen: false,
        },
        "claude",
        null,
      );
    case "cancelled":
      return { ...s, session: "starting", tool: null };
  }
}

export interface WindowProps {
  show: boolean;
  interactive: boolean;
}

export function windowProps(s: OverlayState): WindowProps {
  return {
    show: s.visible || s.chatOpen || s.approvals.length > 0,
    interactive: s.chatOpen,
  };
}

/** The approval that is shown and that the hotkeys answer; later ones wait their turn. */
export function currentApproval(s: OverlayState): ApprovalRequest | null {
  return s.approvals[0] ?? null;
}

export function canOpenChat(s: OverlayState, blockWhenInDanger: boolean): boolean {
  return !(blockWhenInDanger && s.flags?.inDanger);
}

/** The chips that copyChip numbers refer to: the streaming reply's, else the last reply's. */
export function currentChips(s: OverlayState): Chip[] {
  return s.session === "thinking" ? parseChips(s.reply).chips : s.chips;
}
