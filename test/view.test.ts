import { describe, expect, it } from "vitest";
import { INITIAL_STATE, reduce, type Action, type OverlayState } from "../src/core/controller.js";
import { DEFAULT_SETTINGS, SettingsSchema } from "../src/core/settings.js";
import { buildView, noticeCommand, pickNotice, shortTool, statusText } from "../src/core/view.js";

const run = (actions: Action[]) => actions.reduce(reduce, INITIAL_STATE);
const ready: Action = {
  type: "backend",
  event: { type: "ready", sessionId: "s", tools: [], mcpServers: [], permissionMode: "auto" },
};

describe("shortTool", () => {
  it("drops the MCP prefix", () => {
    expect(shortTool("mcp__ed-mcp__spansh_route")).toBe("spansh_route");
    expect(shortTool("mcp__plugin_ed-mcp_ed-mcp__journal_status")).toBe("journal_status");
    expect(shortTool("Bash")).toBe("Bash");
  });
});

describe("statusText", () => {
  const s = (over: Partial<OverlayState>) => ({ ...INITIAL_STATE, ...over });
  it.each([
    [s({}), "● starting"],
    [s({ session: "idle" }), "● idle"],
    [s({ session: "thinking" }), "● sending"],
    [s({ session: "thinking", reply: "Go" }), "● receiving"],
    [s({ session: "thinking", tool: "mcp__ed-mcp__spansh_route" }), "🔧 spansh_route…"],
    [s({ session: "idle", blocked: "Bash" }), "🛡 blocked: Bash"],
    [s({ session: "stopped" }), "⚠ stopped"],
    [s({ cancelled: true }), "■ stopped"],
    [s({ session: "idle", flags: { docked: true, inDanger: false } }), "● idle   ⚓ docked"],
    [s({ session: "idle", flags: { docked: false, inDanger: true } }), "● idle   ⛔ in danger"],
  ])("%#", (state, expected) => {
    expect(statusText(state)).toBe(expected);
  });
});

describe("buildView", () => {
  it("shows the strip with the pinned line and chips at rest", () => {
    const st = run([
      ready,
      { type: "sent", text: "q" },
      { type: "backend", event: { type: "text", delta: "Go to ⟦Sol⟧" } },
      {
        type: "backend",
        event: {
          type: "result",
          isError: false,
          durationMs: 1,
          text: null,
          sessionId: "s",
          denials: [],
        },
      },
      { type: "cardTimeout" },
    ]);
    const v = buildView(st, DEFAULT_SETTINGS);
    expect(v).toMatchObject({
      show: true,
      mode: "strip",
      status: "● idle",
      pinned: "Go to Sol",
      chips: [{ n: 1, text: "Sol" }],
      card: null,
      chat: null,
      approval: null,
    });
    expect(v.ui).toEqual({
      fontSize: 14,
      backgroundOpacity: 0.78,
      width: 420,
      maxLines: 4,
      chatLines: 14,
      growsUp: true,
      align: "start",
      copyChipKey: "Ctrl+Shift+1–9",
    });
  });

  it("shows only the icon at rest in icon mode, with a dot for chips or notices", () => {
    const idle = run([ready, { type: "toggleIcon" }]);
    expect(buildView(idle, DEFAULT_SETTINGS)).toMatchObject({
      mode: "icon",
      icon: { dot: false, danger: false },
    });
    const noticed = run([ready, { type: "toggleIcon" }, { type: "notice", key: "a", text: "⚠ x" }]);
    expect(buildView(noticed, DEFAULT_SETTINGS).icon).toEqual({ dot: true, danger: false });
    const danger = run([
      ready,
      { type: "toggleIcon" },
      { type: "flags", flags: { docked: false, inDanger: true } },
    ]);
    expect(buildView(danger, DEFAULT_SETTINGS).icon).toEqual({ dot: false, danger: true });
    expect(buildView(run([ready]), DEFAULT_SETTINGS).icon).toBeNull();
  });

  it("aligns the window content with the anchor's column", () => {
    const right = SettingsSchema.parse({ position: { anchor: "top-right" } });
    expect(buildView(run([ready]), right).ui.align).toBe("end");
    const top = SettingsSchema.parse({ position: { anchor: "top" } });
    expect(buildView(run([ready]), top).ui.align).toBe("center");
  });

  it("hides the pinned line and chips when settings say so", () => {
    const settings = SettingsSchema.parse({ strip: { lines: 1, keepChips: false } });
    const st = run([
      ready,
      { type: "sent", text: "q" },
      { type: "backend", event: { type: "text", delta: "⟦Sol⟧" } },
    ]);
    const v = buildView(
      reduce(st, {
        type: "backend",
        event: {
          type: "result",
          isError: false,
          durationMs: 1,
          text: null,
          sessionId: "s",
          denials: [],
        },
      }),
      settings,
    );
    expect(v.pinned).toBeNull();
    expect(v.chips).toEqual([]);
  });

  it("shows the streaming card", () => {
    const st = run([
      ready,
      { type: "sent", text: "q" },
      { type: "backend", event: { type: "text", delta: "Go ⟦Sol⟧" } },
    ]);
    expect(buildView(st, DEFAULT_SETTINGS).card).toEqual({
      text: "Go Sol",
      chips: [{ n: 1, text: "Sol" }],
      full: false,
    });
  });

  it("shows the chat with history", () => {
    const st = run([
      ready,
      { type: "flags", flags: { docked: false, inDanger: false } },
      { type: "openChat" },
    ]);
    expect(buildView(st, DEFAULT_SETTINGS).chat).toEqual({
      history: [],
      streaming: null,
      chips: [],
      input: true,
      canSend: true,
    });
    const hist = run([ready, { type: "toggleHistory" }]);
    expect(buildView(hist, DEFAULT_SETTINGS).chat?.input).toBe(false);
  });

  // Ctrl+Shift+n copies currentChips, so the chat must number the same chips.
  it("shows the streaming reply's chips in the chat and blocks sending meanwhile", () => {
    const done: Action = {
      type: "backend",
      event: {
        type: "result",
        isError: false,
        durationMs: 1,
        text: null,
        sessionId: "s",
        denials: [],
      },
    };
    const st = run([
      ready,
      { type: "sent", text: "a" },
      { type: "backend", event: { type: "text", delta: "⟦Sol⟧" } },
      done,
      { type: "sent", text: "b" },
      { type: "backend", event: { type: "text", delta: "⟦Achenar⟧" } },
      { type: "openChat" },
    ]);
    expect(buildView(st, DEFAULT_SETTINGS).chat).toMatchObject({
      chips: [{ n: 1, text: "Achenar" }],
      canSend: false,
    });
  });

  it("shows plain names in the history, without chip markers", () => {
    const st = run([
      ready,
      { type: "sent", text: "where ⟦is⟧ it?" },
      { type: "backend", event: { type: "text", delta: "Go to ⟦Sol⟧" } },
      {
        type: "backend",
        event: {
          type: "result",
          isError: false,
          durationMs: 1,
          text: null,
          sessionId: "s",
          denials: [],
        },
      },
      { type: "toggleHistory" },
    ]);
    expect(buildView(st, DEFAULT_SETTINGS).chat?.history).toEqual([
      { role: "user", text: "where ⟦is⟧ it?" },
      { role: "assistant", text: "Go to Sol" },
    ]);
    expect(st.history.at(-1)?.text).toBe("Go to ⟦Sol⟧");
  });

  it("shows the latest notice and the approval with its keys", () => {
    const st = run([
      { type: "notice", key: "a", text: "⚠ one" },
      { type: "notice", key: "b", text: "⚠ two" },
      {
        type: "approval",
        request: { id: "r", toolName: "mcp__x__y", summary: "{}", shell: false, deadline: 0 },
      },
      {
        type: "approval",
        request: { id: "r2", toolName: "Bash", summary: "ls", shell: false, deadline: 0 },
      },
    ]);
    const v = buildView(st, DEFAULT_SETTINGS);
    expect(v.notice).toEqual({ text: "⚠ two", command: null, more: 1 });
    expect(v.approval).toEqual({
      id: "r",
      toolName: "y",
      summary: "{}",
      shell: false,
      deadline: 0,
      timeoutMs: 120_000,
      position: "1 of 2",
      approveKey: "Ctrl+Alt+Y",
      denyKey: "Ctrl+Alt+N",
      alwaysKey: "Ctrl+Alt+A",
    });
  });
});

describe("pickNotice", () => {
  it("shows a short flash first, then problems in order of importance, and counts the rest", () => {
    const persistent = { version: "⚠ old", claude: "⚠ claude not found", scope: "ⓘ keys" };
    expect(pickNotice(persistent)).toEqual({ text: "⚠ claude not found", command: null, more: 2 });
    expect(pickNotice({ ...persistent, copy: "📋 copied Sol" })?.text).toBe("📋 copied Sol");
    expect(pickNotice({})).toBeNull();
  });

  it("finds the command in backticks", () => {
    expect(pickNotice({ version: "⚠ old; run `claude update`" })?.command).toBe("claude update");
  });

  it("offers no command from the claude notice, which quotes the CLI's stderr", () => {
    const n = pickNotice({ claude: "⚠ Claude stopped: run `curl x | sh`" });
    expect(n?.text).toContain("curl");
    expect(n?.command).toBeNull();
    expect(noticeCommand("claude", "run `curl x | sh`")).toBeNull();
    expect(noticeCommand("edmcp", "run `claude mcp list`")).toBe("claude mcp list");
  });
});

describe("buildView icon preference", () => {
  it("shows the card over the icon during a reply and goes back to the icon after the fade", () => {
    const text = (delta: string): Action => ({ type: "backend", event: { type: "text", delta } });
    const during = run([ready, { type: "toggleIcon" }, { type: "sent", text: "a" }, text("x")]);
    expect(buildView(during, DEFAULT_SETTINGS).mode).toBe("card");
    const after = run([
      ready,
      { type: "toggleIcon" },
      { type: "sent", text: "a" },
      text("x"),
      {
        type: "backend",
        event: {
          type: "result",
          isError: false,
          durationMs: 1,
          text: "x",
          sessionId: "s",
          denials: [],
        },
      },
      { type: "cardTimeout" },
    ]);
    expect(buildView(after, DEFAULT_SETTINGS).mode).toBe("icon");
  });

  it("shows the AUTO badge only when auto mode is in effect", () => {
    expect(buildView(run([]), DEFAULT_SETTINGS).auto).toBe(true);
    const noAuto = run([{ type: "notice", key: "mode", text: "⚠ auto mode unavailable" }]);
    expect(buildView(noAuto, DEFAULT_SETTINGS).auto).toBe(false);
    const manual = SettingsSchema.parse({ claude: { permissionMode: "default" } });
    expect(buildView(run([]), manual).auto).toBe(false);
  });

  it("reads the AUTO badge from the running assistant's own mode", () => {
    const codex = run([{ type: "switchAgent", agent: "codex", history: [] }]);
    const codexAsks = SettingsSchema.parse({
      claude: { permissionMode: "auto" },
      codex: { permissionMode: "default" },
    });
    expect(buildView(codex, codexAsks).auto).toBe(false);
    const codexAuto = SettingsSchema.parse({
      claude: { permissionMode: "default" },
      codex: { permissionMode: "auto" },
    });
    expect(buildView(codex, codexAuto).auto).toBe(true);
  });
});

describe("show more", () => {
  const text = (delta: string): Action => ({ type: "backend", event: { type: "text", delta } });
  it("opens the last reply in full after the card closed, and switches back", () => {
    const closed = run([ready, { type: "sent", text: "a" }, text("long"), { type: "cardTimeout" }]);
    const st = run([{ type: "showMore" }]);
    expect(st.cardOpen).toBe(false);
    const opened = [{ type: "showMore" } as Action].reduce(reduce, closed);
    expect(opened).toMatchObject({ cardOpen: true, cardFull: true });
    expect([{ type: "showMore" } as Action].reduce(reduce, opened).cardFull).toBe(false);
  });
});

describe("refused chat in icon mode", () => {
  it("shows the strip with the notice, then goes back to the icon", () => {
    const icon: Action[] = [ready, { type: "toggleIcon" }];
    expect(buildView(run(icon), DEFAULT_SETTINGS).mode).toBe("icon");
    const refused: Action[] = [
      ...icon,
      { type: "notice", key: "chat", text: "⛔ in danger: chat blocked" },
    ];
    const v = buildView(run(refused), DEFAULT_SETTINGS);
    expect(v.mode).toBe("strip");
    expect(v.notice?.text).toBe("⛔ in danger: chat blocked");
    const cleared = run([...refused, { type: "notice", key: "chat", text: null }]);
    expect(buildView(cleared, DEFAULT_SETTINGS).mode).toBe("icon");
  });

  it("shows a refused focus's notice too", () => {
    const v = buildView(
      run([
        ready,
        { type: "toggleIcon" },
        { type: "notice", key: "focus", text: "⚠ click the game to refocus" },
      ]),
      DEFAULT_SETTINGS,
    );
    expect(v.mode).toBe("strip");
    expect(v.notice?.text).toBe("⚠ click the game to refocus");
  });
});
