import type { ApprovalRequest } from "./approvals.js";
import { firstLine, parseChips, type Chip } from "./chips.js";
import { AGENTS, notFoundText, type AgentId, type BackendEvent } from "./backend.js";
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
  /** How many turns at the start of history came from a resumed conversation's file. */
  resumedTurns: number;
  approvals: ApprovalRequest[];
  flags: ShipFlags | null;
  notices: Record<string, string>;
  /** The player prefers the small icon at rest. Replies, approvals and the chat show over it. */
  iconMode: boolean;
  /** Which assistant runs: its name goes in the notices. */
  agent: AgentId;
  /** The player stopped the reply; the assistant restarts. */
  cancelled: boolean;
  /** The hotkey list, shown at startup and from the tray. */
  keys: KeyRow[] | null;
  /** The step key brought back a minimized overlay; its press at rest minimizes it again. */
  stepHidden: boolean;
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
  resumedTurns: 0,
  approvals: [],
  flags: null,
  notices: {},
  iconMode: false,
  agent: "claude",
  cancelled: false,
  stepHidden: false,
  keys: null,
};

export type Action =
  | { type: "toggleVisible" }
  | { type: "toggleIcon" }
  /** step: opened by the step key, which minimizes again at rest an overlay it brought back. */
  | { type: "openChat"; step?: boolean }
  | { type: "stepShow" }
  /** keepCard: a reply was arriving at the press, so its card stays even if it ends first. */
  /** keepShown: focus did not go back to the game, so the overlay stays to say so. */
  | { type: "stepRest"; keepCard?: boolean; keepShown?: boolean }
  /** escape: the player closed the chat with Esc, which also undoes the step key's restore. */
  /** replyAtPress: a reply was arriving when Esc was pressed (read before the focus wait). */
  | { type: "closeChat"; escape?: boolean; keepShown?: boolean; replyAtPress?: boolean }
  | { type: "toggleHistory" }
  | { type: "sent"; text: string }
  | { type: "backend"; event: BackendEvent }
  | { type: "cardTimeout" }
  | { type: "showMore" }
  | { type: "showCard" }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approvalSettled"; id: string }
  | { type: "flags"; flags: ShipFlags | null }
  | { type: "notice"; key: string; text: string | null }
  | { type: "newSession" }
  /** Another assistant runs now, with its resumed turns, if any. */
  | { type: "switchAgent"; agent: AgentId; history: Turn[] }
  | { type: "cancelled" }
  | { type: "keys"; rows: KeyRow[] | null }
  // An answer from ED Chat itself, such as /version, shown in the reply card. replaces: update
  // that earlier answer only if it is still the card's text.
  | { type: "localReply"; text: string; replaces?: string };

function withNotice(s: OverlayState, key: string, text: string | null): OverlayState {
  const { [key]: _old, ...rest } = s.notices;
  return { ...s, notices: text === null ? rest : { ...rest, [key]: text } };
}

const tail = (lines: string[]) => (lines.length ? `: ${lines.at(-1)}` : "");

function onBackend(s: OverlayState, e: BackendEvent): OverlayState {
  const agent = AGENTS[s.agent];
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
      const reply = e.isError
        ? (e.text ?? `${agent.name} returned an error.`)
        : s.reply || (e.text ?? "");
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
        `⚠ ${agent.name} stopped${tail(e.stderrTail)}`,
      );
    case "gaveUp":
      return withNotice(
        { ...s, session: "stopped", tool: null },
        "claude",
        `⚠ ${agent.name} keeps stopping${tail(e.stderrTail)}`,
      );
    case "spawnError":
      return withNotice(
        { ...s, session: "stopped", tool: null },
        "claude",
        e.message.includes("ENOENT")
          ? notFoundText(agent)
          : `⚠ Can't start ${agent.cli}: ${e.message}`,
      );
    // The earlier turns belong to the conversation that could not be resumed.
    case "resumeFailed":
      return { ...s, history: s.history.slice(s.resumedTurns), resumedTurns: 0 };
    case "unknown":
      return s;
  }
}

/**
 * Whether going back to rest (the step key's last press, or Esc) minimizes again an overlay
 * the step key brought back. replyAtPress: a reply was arriving at the press. A message sent
 * after it (Enter during the focus handoff) is a reply the player just asked for, so the
 * overlay stays shown and a later rest minimizes it. keepShown: Windows refused focus, so the
 * overlay stays shown for good, to say so.
 */
function afterRest(
  s: OverlayState,
  replyAtPress: boolean,
  keepShown: boolean,
): Pick<OverlayState, "visible" | "stepHidden"> {
  const sentSince = s.session === "thinking" && !replyAtPress;
  const minimize = s.stepHidden && !keepShown && !sentSince;
  return {
    visible: minimize ? false : s.visible,
    stepHidden: sentSince ? s.stepHidden : false,
  };
}

/** Notices about a key the player just pressed. They show even over the icon or while minimized. */
export const ATTENTION_NOTICES = ["chat", "focus"];
export const hasAttention = (s: OverlayState) => ATTENTION_NOTICES.some((k) => k in s.notices);

export function reduce(s: OverlayState, a: Action): OverlayState {
  switch (a.type) {
    case "toggleVisible":
      return { ...s, visible: !s.visible, stepHidden: false };
    // The player chose a visible overlay, so the step key no longer minimizes it at rest.
    case "toggleIcon":
      return { ...s, iconMode: !s.iconMode, visible: true, stepHidden: false };
    case "openChat":
      return {
        ...s,
        chatOpen: true,
        visible: true,
        stepHidden: s.stepHidden || (a.step === true && !s.visible),
      };
    // The step key's first press on a minimized overlay: the overlay and the last reply.
    case "stepShow":
      return s.reply
        ? { ...s, visible: true, cardOpen: true, cardFull: false, stepHidden: true }
        : s;
    // The step key's press at rest: the chat, history and card close, and an overlay the step
    // key brought back is minimized again. A reply still arriving keeps its card.
    case "stepRest": {
      const keep = a.keepCard === true || s.session === "thinking";
      const card = keep ? {} : { cardOpen: false, cardFull: false };
      return {
        ...s,
        ...card,
        ...afterRest(s, a.keepCard === true, a.keepShown === true),
        chatOpen: false,
        historyOpen: false,
      };
    }
    // Esc is a way back to rest like the step key's last press, so it minimizes again an
    // overlay the step key brought back. Enter keeps it shown for the reply; the step key's
    // press at rest minimizes it later.
    // A message sent during Esc's focus wait keeps the overlay shown for its reply, as in
    // stepRest.
    case "closeChat": {
      if (a.escape !== true) return { ...s, chatOpen: false };
      return {
        ...s,
        ...afterRest(s, a.replyAtPress === true, a.keepShown === true),
        chatOpen: false,
      };
    }
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
    // Brings back the last reply's short card.
    case "showCard":
      return s.reply ? { ...s, cardOpen: true, cardFull: false, visible: true } : s;
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
          resumedTurns: 0,
          session: "starting",
          cancelled: false,
          tool: null,
          blocked: null,
          cardOpen: false,
        },
        "claude",
        null,
      );
    case "switchAgent":
      return {
        ...reduce(s, { type: "newSession" }),
        agent: a.agent,
        history: a.history,
        resumedTurns: a.history.length,
      };
    case "cancelled":
      return { ...s, session: "starting", tool: null, cancelled: true };
    case "keys":
      return { ...s, keys: a.rows };
    // A reply still arriving keeps the card. An update changes the text only: a card the
    // player closed, or that faded, stays closed, and shows the new text when brought back.
    case "localReply": {
      if (s.session === "thinking") return s;
      const local = { reply: a.text, chips: [], pinned: firstLine(a.text) };
      if (a.replaces === undefined)
        return { ...s, ...local, cardOpen: true, cardFull: true, visible: true };
      return s.reply === a.replaces ? { ...s, ...local } : s;
    }
  }
}

export interface WindowProps {
  show: boolean;
  interactive: boolean;
}

export function windowProps(s: OverlayState): WindowProps {
  return {
    // Show hotkeys works while minimized to the tray, when the strip is gone. A refused chat
    // ("in danger") or focus shows for its few seconds too, so the key does not look broken.
    show: s.visible || s.chatOpen || s.approvals.length > 0 || s.keys !== null || hasAttention(s),
    interactive: s.chatOpen,
  };
}

/**
 * What the step key (Ctrl+`) does next. Each press shows one more: the overlay, the last
 * reply, the whole reply, then the chat. A press in the chat goes back to rest. The step
 * follows what is on screen, so after the card fades the next press starts again.
 */
export type Step = "show" | "card" | "full" | "chat" | "rest";

export function nextStep(s: OverlayState): Step {
  if (s.chatOpen) return "rest";
  // The history panel is the chat without its input, so the next step adds the input.
  if (s.historyOpen) return "chat";
  // With no reply yet there is nothing to show but the chat, minimized or not.
  if (!s.visible) return s.reply ? "show" : "chat";
  // While a message is sending, no reply has arrived yet: nothing to show but the chat.
  if (!s.reply) return "chat";
  if (s.cardOpen) return s.cardFull ? "chat" : "full";
  return "card";
}

/**
 * The action for the step key's next press, read before main waits on anything. For rest,
 * main first gives focus back to the game, while the overlay still holds the foreground, and
 * adds keepShown when Windows refused. keepCard is read now: a reply that ends during that
 * wait must keep its card.
 */
export function stepAction(s: OverlayState): Action {
  switch (nextStep(s)) {
    case "show":
      return { type: "stepShow" };
    case "card":
      return { type: "showCard" };
    case "full":
      return { type: "showMore" };
    case "chat":
      return { type: "openChat", step: true };
    case "rest":
      return { type: "stepRest", keepCard: s.session === "thinking" };
  }
}

/**
 * The action for Esc in the chat, read at the press before main waits for focus to go back.
 * Main adds keepShown when Windows refused.
 */
export function escapeAction(s: OverlayState): Extract<Action, { type: "closeChat" }> {
  return { type: "closeChat", escape: true, replyAtPress: s.session === "thinking" };
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
