import { describe, expect, it } from "vitest";
import {
  ANSWER_GUARD_MS,
  INITIAL_STATE,
  answerAllowed,
  canOpenChat,
  currentApproval,
  currentChips,
  nextStep,
  reduce,
  stepAction,
  windowProps,
  type Action,
  type OverlayState,
} from "../src/core/controller.js";

const run = (actions: Action[], from: OverlayState = INITIAL_STATE) => actions.reduce(reduce, from);
const ready: Action = {
  type: "backend",
  event: { type: "ready", sessionId: "s", tools: [], mcpServers: [], permissionMode: "auto" },
};
const text = (delta: string): Action => ({ type: "backend", event: { type: "text", delta } });
const result = (
  over: Partial<{ isError: boolean; text: string | null; denials: string[] }> = {},
): Action => ({
  type: "backend",
  event: {
    type: "result",
    isError: false,
    durationMs: 1,
    text: null,
    sessionId: "s",
    denials: [],
    ...over,
  },
});

describe("reduce", () => {
  it("goes idle on ready", () => {
    expect(run([ready]).session).toBe("idle");
  });

  it("goes idle once the CLI has spawned, and clears the Claude notice", () => {
    const spawned: Action = { type: "backend", event: { type: "spawned" } };
    const exit: Action = { type: "backend", event: { type: "exit", code: 1, stderrTail: [] } };
    expect(run([spawned]).session).toBe("idle");
    expect(run([exit, spawned]).notices.claude).toBeUndefined();
    expect(run([{ type: "sent", text: "a" }, spawned]).session).toBe("thinking");
    expect(run([ready, { type: "newSession" }, spawned]).session).toBe("idle");
    expect(run([ready, { type: "sent", text: "a" }, { type: "cancelled" }, spawned]).session).toBe(
      "idle",
    );
  });

  it("streams a reply into the card, then pins it with its chips", () => {
    let s = run([ready, { type: "openChat" }, { type: "sent", text: "where?" }]);
    // Main closes the chat after focus is back, so stream events cannot overtake "sent".
    expect(s).toMatchObject({ chatOpen: true, cardOpen: true, session: "thinking", reply: "" });
    s = run([{ type: "closeChat" }], s);
    expect(s.history).toEqual([{ role: "user", text: "where?" }]);
    s = run([text("Go to ⟦Hip 3922⟧\nthen dock")], s);
    expect(currentChips(s)).toEqual([{ n: 1, text: "Hip 3922" }]);
    s = run([result()], s);
    expect(s).toMatchObject({
      session: "idle",
      pinned: "Go to Hip 3922",
      chips: [{ n: 1, text: "Hip 3922" }],
    });
    expect(s.history.at(-1)).toEqual({ role: "assistant", text: "Go to ⟦Hip 3922⟧\nthen dock" });
    expect(run([{ type: "cardTimeout" }], s).cardOpen).toBe(false);
  });

  it("keeps the old chips while the next reply streams", () => {
    const s = run([
      ready,
      { type: "sent", text: "a" },
      text("⟦Sol⟧"),
      result(),
      { type: "sent", text: "b" },
    ]);
    expect(s.chips).toEqual([{ n: 1, text: "Sol" }]);
    expect(currentChips(s)).toEqual([]);
  });

  it("does not close the card while thinking", () => {
    const s = run([ready, { type: "sent", text: "a" }, { type: "cardTimeout" }]);
    expect(s.cardOpen).toBe(true);
  });

  it("closes the card after a turn that ends without a result", () => {
    const sent = run([ready, { type: "sent", text: "a" }]);
    const exit: Action = { type: "backend", event: { type: "exit", code: 1, stderrTail: [] } };
    for (const end of [{ type: "cancelled" } as const, exit]) {
      expect(run([end, { type: "cardTimeout" }], sent).cardOpen).toBe(false);
    }
  });

  it("stays thinking when a restarted CLI reports ready", () => {
    expect(run([{ type: "sent", text: "a" }, ready]).session).toBe("thinking");
  });

  it("shows the running tool", () => {
    const start: Action = {
      type: "backend",
      event: { type: "toolStart", id: "1", name: "mcp__ed-mcp__spansh_route" },
    };
    const end: Action = {
      type: "backend",
      event: { type: "toolEnd", id: "1", name: "x", isError: false },
    };
    expect(run([ready, { type: "sent", text: "a" }, start]).tool).toBe("mcp__ed-mcp__spansh_route");
    expect(run([ready, { type: "sent", text: "a" }, start, end]).tool).toBeNull();
  });

  it("shows an error result's message in the card", () => {
    const s = run([
      ready,
      { type: "sent", text: "a" },
      result({ isError: true, text: "Please run /login" }),
    ]);
    expect(s.reply).toBe("Please run /login");
    expect(s.cardOpen).toBe(true);
  });

  it("records the first denied tool", () => {
    expect(run([ready, { type: "sent", text: "a" }, result({ denials: ["Bash"] })]).blocked).toBe(
      "Bash",
    );
  });

  it("reports exits, give-ups and spawn errors as notices", () => {
    const exit: Action = {
      type: "backend",
      event: { type: "exit", code: 1, stderrTail: ["x", "boom"] },
    };
    expect(run([exit]).notices.claude).toBe("⚠ Claude stopped: boom");
    expect(run([exit]).session).toBe("stopped");
    const gave: Action = { type: "backend", event: { type: "gaveUp", stderrTail: [] } };
    expect(run([gave]).notices.claude).toBe("⚠ Claude keeps stopping");
    const missing: Action = {
      type: "backend",
      event: { type: "spawnError", message: "spawn claude ENOENT" },
    };
    expect(run([missing]).notices.claude).toBe(
      "⚠ claude not found: install Claude Code or set claude.path",
    );
    expect(run([missing, ready]).notices.claude).toBeUndefined();
  });

  it("sets and clears notices", () => {
    const s = run([{ type: "notice", key: "a", text: "⚠ x" }]);
    expect(s.notices).toEqual({ a: "⚠ x" });
    expect(run([{ type: "notice", key: "a", text: null }], s).notices).toEqual({});
  });

  it("tracks approvals by id", () => {
    const req = { id: "r1", toolName: "Bash", summary: "{}", shell: false, deadline: 0 };
    const s = run([{ type: "approval", request: req }]);
    expect(currentApproval(s)).toEqual(req);
    expect(currentApproval(run([{ type: "approvalSettled", id: "other" }], s))).toEqual(req);
    expect(currentApproval(run([{ type: "approvalSettled", id: "r1" }], s))).toBeNull();
  });

  it("queues approvals that arrive together", () => {
    const r1 = { id: "r1", toolName: "Bash", summary: "1", shell: false, deadline: 0 };
    const r2 = { id: "r2", toolName: "Read", summary: "2", shell: false, deadline: 0 };
    const s = run([
      { type: "approval", request: r1 },
      { type: "approval", request: r2 },
    ]);
    expect(currentApproval(s)).toEqual(r1);
    expect(currentApproval(run([{ type: "approvalSettled", id: "r2" }], s))).toEqual(r1);
    const next = run([{ type: "approvalSettled", id: "r1" }], s);
    expect(currentApproval(next)).toEqual(r2);
    expect(currentApproval(run([{ type: "approvalSettled", id: "r2" }], next))).toBeNull();
  });

  it("clears the conversation on newSession", () => {
    const s = run([
      ready,
      { type: "sent", text: "a" },
      text("⟦Sol⟧"),
      result(),
      { type: "newSession" },
    ]);
    expect(s).toMatchObject({
      reply: "",
      chips: [],
      pinned: null,
      history: [],
      session: "starting",
      cardOpen: false,
    });
  });

  it("returns to starting on cancel", () => {
    expect(run([ready, { type: "sent", text: "a" }, { type: "cancelled" }]).session).toBe(
      "starting",
    );
  });
});

describe("icon mode", () => {
  const req = { id: "r", toolName: "Bash", summary: "", shell: false, deadline: 0 };
  it("toggles with the hotkey", () => {
    expect(run([{ type: "toggleIcon" }]).iconMode).toBe(true);
    expect(run([{ type: "toggleIcon" }, { type: "toggleIcon" }]).iconMode).toBe(false);
  });

  it("keeps the icon preference through a reply, an approval, the chat and the history", () => {
    const icon: Action = { type: "toggleIcon" };
    expect(run([ready, icon, text("hi")]).iconMode).toBe(true);
    expect(run([icon, { type: "approval", request: req }]).iconMode).toBe(true);
    expect(run([icon, { type: "openChat" }]).iconMode).toBe(true);
    expect(run([icon, { type: "toggleHistory" }]).iconMode).toBe(true);
    const faded = run([
      ready,
      icon,
      { type: "sent", text: "a" },
      text("x"),
      result(),
      { type: "cardTimeout" },
    ]);
    expect(faded).toMatchObject({ iconMode: true, cardOpen: false });
  });

  it("marks a cancelled reply until the next send", () => {
    const s = run([ready, { type: "sent", text: "a" }, { type: "cancelled" }]);
    expect(s.cancelled).toBe(true);
    expect(run([{ type: "sent", text: "b" }], s).cancelled).toBe(false);
  });

  it("stays an icon for notices and ship flags", () => {
    const s = run([
      { type: "toggleIcon" },
      { type: "notice", key: "a", text: "⚠ x" },
      { type: "flags", flags: { docked: true, inDanger: false } },
    ]);
    expect(s.iconMode).toBe(true);
  });
});

describe("windowProps", () => {
  it("is interactive only with the chat open", () => {
    expect(windowProps(INITIAL_STATE)).toEqual({ show: true, interactive: false });
    expect(windowProps(run([{ type: "openChat" }]))).toEqual({ show: true, interactive: true });
    expect(windowProps(run([{ type: "toggleHistory" }]))).toEqual({
      show: true,
      interactive: false,
    });
  });

  it("hides, but still shows a pending approval", () => {
    const hidden = run([{ type: "toggleVisible" }]);
    expect(windowProps(hidden).show).toBe(false);
    const req = { id: "r", toolName: "Bash", summary: "", shell: false, deadline: 0 };
    expect(windowProps(run([{ type: "approval", request: req }], hidden)).show).toBe(true);
  });

  it("shows the hotkey list while minimized to the tray", () => {
    const hidden = run([{ type: "toggleVisible" }]);
    expect(windowProps(run([{ type: "keys", rows: [] }], hidden)).show).toBe(true);
    expect(windowProps(run([{ type: "keys", rows: null }], hidden)).show).toBe(false);
  });
});

describe("canOpenChat", () => {
  it("blocks only when in danger and blocking is on", () => {
    const danger = run([{ type: "flags", flags: { docked: false, inDanger: true } }]);
    expect(canOpenChat(danger, true)).toBe(false);
    expect(canOpenChat(danger, false)).toBe(true);
    expect(canOpenChat(INITIAL_STATE, true)).toBe(true);
  });
});

describe("answerAllowed", () => {
  const shown = { id: "r", at: 1_000 };
  it("ignores an allow that comes before the card can be read", () => {
    expect(answerAllowed("approve", "r", shown, 1_000 + ANSWER_GUARD_MS - 1)).toBe(false);
    expect(answerAllowed("alwaysAllow", "r", shown, 1_000)).toBe(false);
    expect(answerAllowed("approve", "r", shown, 1_000 + ANSWER_GUARD_MS)).toBe(true);
  });

  it("always takes a deny", () => {
    expect(answerAllowed("deny", "r", shown, 1_000)).toBe(true);
  });

  it("does not hold back an answer to a request that is not the one just shown", () => {
    expect(answerAllowed("approve", "other", shown, 1_000)).toBe(true);
    expect(answerAllowed("approve", "r", null, 1_000)).toBe(true);
  });
});

describe("nextStep", () => {
  const replied = run([ready, { type: "sent", text: "a" }, text("long reply"), result()]);
  const faded = run([{ type: "cardTimeout" }], replied);

  it("walks card, whole reply, chat, then back to rest", () => {
    expect(nextStep(faded)).toBe("card");
    const card = run([{ type: "showCard" }], faded);
    expect(card).toMatchObject({ cardOpen: true, cardFull: false });
    expect(nextStep(card)).toBe("full");
    const full = run([{ type: "showMore" }], card);
    expect(nextStep(full)).toBe("chat");
    expect(nextStep(run([{ type: "openChat" }], full))).toBe("rest");
  });

  it("starts again once the card has faded", () => {
    const full = run([{ type: "showCard" }, { type: "showMore" }, { type: "cardTimeout" }], faded);
    expect(nextStep(full)).toBe("card");
  });

  it("first shows a minimized overlay", () => {
    expect(nextStep(run([{ type: "toggleVisible" }], faded))).toBe("show");
  });

  it("goes straight to the chat when there is no reply yet", () => {
    expect(nextStep(run([ready]))).toBe("chat");
    expect(nextStep(run([ready, { type: "toggleVisible" }]))).toBe("chat");
    expect(run([{ type: "showCard" }], run([ready])).cardOpen).toBe(false);
  });

  it("closes the chat from any state, even one opened another way", () => {
    expect(nextStep(run([ready, { type: "openChat" }]))).toBe("rest");
  });

  it("adds the input to the history panel, then closes both", () => {
    const history = run([{ type: "toggleHistory" }], replied);
    expect(nextStep(history)).toBe("chat");
    expect(nextStep(run([{ type: "openChat" }], history))).toBe("rest");
  });

  it("goes to the chat while a message is sending and no reply has arrived", () => {
    expect(nextStep(run([ready, { type: "sent", text: "a" }]))).toBe("chat");
  });

  // Walks each press the way main does: nextStep picks the step, then its action runs.
  const press = (st: OverlayState): OverlayState => reduce(st, stepAction(st));

  it("brings back a minimized overlay and minimizes it again at rest", () => {
    let st = run([{ type: "toggleVisible" }], faded);
    st = press(st);
    expect(st).toMatchObject({ visible: true, cardOpen: true, cardFull: false });
    st = press(press(st));
    expect(st.chatOpen).toBe(true);
    st = press(st);
    expect(st).toMatchObject({ visible: false, chatOpen: false, cardOpen: false });
    expect(st.stepHidden).toBe(false);
  });

  it("from minimized with no reply, opens the chat and minimizes again at rest", () => {
    const st = press(run([ready, { type: "toggleVisible" }]));
    expect(st).toMatchObject({ chatOpen: true, visible: true });
    expect(press(st).visible).toBe(false);
  });

  it("leaves the overlay shown when the player restored it by hand", () => {
    let st = run([{ type: "toggleVisible" }], faded);
    st = press(st);
    st = run([{ type: "toggleVisible" }, { type: "toggleVisible" }], st);
    st = press(press(press(st)));
    expect(st).toMatchObject({ chatOpen: false, visible: true });
  });

  it("leaves a shown overlay shown at rest", () => {
    expect(press(run([{ type: "openChat", step: true }], faded)).visible).toBe(true);
  });

  it("closes the history panel and the chat at rest", () => {
    const st = run([{ type: "toggleHistory" }, { type: "openChat", step: true }], replied);
    expect(press(st)).toMatchObject({ historyOpen: false, chatOpen: false });
  });

  it("keeps the card of a reply still arriving when the chat closes", () => {
    let st = run([ready, { type: "sent", text: "a" }, text("part"), { type: "openChat" }]);
    expect(nextStep(st)).toBe("rest");
    st = press(st);
    expect(st).toMatchObject({ session: "thinking", chatOpen: false, cardOpen: true });
  });

  it("stays shown at rest when focus did not go back to the game", () => {
    const st = run([{ type: "openChat", step: true }], run([ready, { type: "toggleVisible" }]));
    expect(run([{ type: "stepRest", keepShown: true }], st)).toMatchObject({
      visible: true,
      chatOpen: false,
      stepHidden: false,
    });
  });

  it("reads keepCard at the press, so main can wait before dispatching", () => {
    const streaming = run([ready, { type: "sent", text: "a" }, text("part"), { type: "openChat" }]);
    expect(stepAction(streaming)).toEqual({ type: "stepRest", keepCard: true });
    expect(stepAction(run([{ type: "openChat" }], faded))).toEqual({
      type: "stepRest",
      keepCard: false,
    });
  });

  it("keeps the card at rest while the reply is still arriving, without keepCard", () => {
    const streaming = run([ready, { type: "sent", text: "a" }, text("part"), { type: "openChat" }]);
    expect(run([{ type: "stepRest" }], streaming).cardOpen).toBe(true);
  });

  it("keeps a card whose reply was arriving at the press", () => {
    const shown = run([{ type: "showCard" }], faded);
    expect(run([{ type: "stepRest", keepCard: true }], shown).cardOpen).toBe(true);
    expect(run([{ type: "stepRest" }], shown).cardOpen).toBe(false);
  });

  it("does not minimize at rest after the player picks icon mode", () => {
    let st = press(run([{ type: "toggleVisible" }], faded));
    st = run([{ type: "toggleIcon" }], st);
    st = press(press(press(st)));
    expect(st).toMatchObject({ chatOpen: false, visible: true });
  });

  it("closes a chat that was minimized to the tray", () => {
    expect(nextStep(run([ready, { type: "openChat" }, { type: "toggleVisible" }]))).toBe("rest");
  });

  it("expands the card while a reply is still arriving", () => {
    const streaming = run([ready, { type: "sent", text: "a" }, text("part")]);
    expect(streaming).toMatchObject({ session: "thinking", cardOpen: true, cardFull: false });
    expect(nextStep(streaming)).toBe("full");
  });
});
