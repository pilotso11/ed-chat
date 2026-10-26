import type { ApprovalRequest } from "./approvalServer.js";
import { firstLine, parseChips, type Chip } from "./chips.js";
import type { BackendEvent } from "./claudeSession.js";
import type { KeyRow } from "./hotkeys.js";
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
  /** The card shows the whole reply, not the first card.maxLines lines. */
  cardFull: boolean;
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
  /** The player prefers the small icon at rest. Replies, approvals and the chat show over it. */
  iconMode: boolean;
  /** The player stopped the reply; Claude restarts. */
  cancelled: boolean;
  /** The hotkey list, shown at startup and from the tray. */
  keys: KeyRow[] | null;
}

export const INITIAL_STATE: OverlayState = {
  visible: true,
  chatOpen: false,
  historyOpen: false,
  cardOpen: false,
  cardFull: false,
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
  cancelled: false,
  keys: null,
};

export type Action =
  | { type: "toggleVisible" }
  | { type: "toggleIcon" }
  | { type: "openChat" }
  | { type: "closeChat" }
  | { type: "toggleHistory" }
  | { type: "sent"; text: string }
  | { type: "backend"; event: BackendEvent }
  | { type: "cardTimeout" }
  | { type: "showMore" }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approvalSettled"; id: string }
  | { type: "flags"; flags: ShipFlags | null }
  | { type: "notice"; key: string; text: string | null }
  | { type: "newSession" }
  | { type: "cancelled" }
  | { type: "keys"; rows: KeyRow[] | null };

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
      return { ...s, reply: s.reply + e.delta, session: "thinking" };
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
    case "openChat":
      return { ...s, chatOpen: true, visible: true };
    case "closeChat":
      return { ...s, chatOpen: false };
    case "toggleHistory":
      return { ...s, historyOpen: !s.historyOpen, visible: true };
    // The chat stays open: main closes it once focus is back with the game.
    case "sent":
      return {
        ...s,
        cardOpen: true,
        cardFull: false,
        session: "thinking",
        cancelled: false,
        reply: "",
        blocked: null,
        history: [...s.history, { role: "user", text: a.text }],
      };
    case "backend":
      return onBackend(s, a.event);
    case "cardTimeout":
      return s.session === "thinking" ? s : { ...s, cardOpen: false, cardFull: false };
    // Opens the last reply in full, or switches between full and short.
    case "showMore":
      if (!s.reply) return s;
      return s.cardOpen
        ? { ...s, cardFull: !s.cardFull }
        : { ...s, cardOpen: true, cardFull: true };
    case "approval":
      return { ...s, approvals: [...s.approvals, a.request] };
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
          cancelled: false,
          tool: null,
          blocked: null,
          cardOpen: false,
        },
        "claude",
        null,
      );
    case "cancelled":
      return { ...s, session: "starting", tool: null, cancelled: true };
    case "keys":
      return { ...s, keys: a.rows };
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

export const ANSWER_GUARD_MS = 750;

/**
 * Whether an answer to approval `id` counts. An allow that comes within ANSWER_GUARD_MS of the
 * card appearing is ignored: the key was on its way before the player could read the card.
 * Deny always counts.
 */
export function answerAllowed(
  answer: "approve" | "deny" | "alwaysAllow",
  id: string,
  shown: { id: string; at: number } | null,
  now: number,
): boolean {
  if (answer === "deny") return true;
  return !(shown?.id === id && now - shown.at < ANSWER_GUARD_MS);
}
