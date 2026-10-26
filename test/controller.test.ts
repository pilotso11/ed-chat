import { describe, expect, it } from "vitest";
import {
  INITIAL_STATE,
  canOpenChat,
  currentApproval,
  currentChips,
  reduce,
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
    const req = { id: "r1", toolName: "Bash", summary: "{}" };
    const s = run([{ type: "approval", request: req }]);
    expect(currentApproval(s)).toEqual(req);
    expect(currentApproval(run([{ type: "approvalSettled", id: "other" }], s))).toEqual(req);
    expect(currentApproval(run([{ type: "approvalSettled", id: "r1" }], s))).toBeNull();
  });

  it("queues approvals that arrive together", () => {
    const r1 = { id: "r1", toolName: "Bash", summary: "1" };
    const r2 = { id: "r2", toolName: "Read", summary: "2" };
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
  const req = { id: "r", toolName: "Bash", summary: "" };
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
    const req = { id: "r", toolName: "Bash", summary: "" };
    expect(windowProps(run([{ type: "approval", request: req }], hidden)).show).toBe(true);
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
