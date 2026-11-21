import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ViewModel } from "../../src/core/view.js";
import { App } from "../../src/renderer/App.js";
import { baseView, fakeOverlay, FakeResizeObserver, layOut, resize } from "./overlay.js";

function setup(v?: Partial<ViewModel>) {
  const overlay = fakeOverlay();
  const { container, unmount } = render(<App />);
  if (v) overlay.view(baseView(v));
  const $ = <E extends Element = HTMLElement>(sel: string) => container.querySelector<E>(sel);
  return { overlay, container, unmount, $ };
}

const approval: NonNullable<ViewModel["approval"]> = {
  id: "req-1",
  toolName: "Bash",
  summary: "npm test",
  shell: true,
  deadline: 0,
  timeoutMs: 60_000,
  position: "1 of 2",
  approveKey: "Ctrl+Alt+Y",
  denyKey: "Ctrl+Alt+N",
  alwaysKey: "Ctrl+Alt+A",
};

describe("status strip", () => {
  it("shows nothing until main sends a view", () => {
    const { container, overlay } = setup();
    expect(container.innerHTML).toBe("");
    expect(overlay.onView).toHaveBeenCalledOnce();
  });

  it("shows the status and the AUTO badge with the agent's name", () => {
    const { $ } = setup({ status: "● idle", auto: true, agentName: "Codex" });
    expect($(".strip .state")?.textContent).toBe("● idleAUTO");
    expect($(".badge")?.title).toBe("Codex runs most tools without asking");
    expect($(".strip")?.hidden).toBe(false);
  });

  it("reports its height on each change once it shows, until unmounted", () => {
    layOut(520, 64);
    const { overlay, unmount } = setup();
    // Nothing to measure before the first view.
    expect(FakeResizeObserver.observing()).toBe(0);
    overlay.view(baseView());
    // A new view does not observe again.
    overlay.view(baseView({ status: "● sending" }));
    expect(FakeResizeObserver.observing()).toBe(1);
    expect(overlay.reportHeight.mock.calls).toEqual([[64]]);
    layOut(520, 90);
    resize();
    expect(overlay.reportHeight.mock.calls).toEqual([[64], [90]]);
    unmount();
    expect(FakeResizeObserver.observing()).toBe(0);
  });

  it("has no badge when not in auto mode", () => {
    const { $ } = setup({ auto: false });
    expect($(".badge")).toBeNull();
  });

  it("applies the style settings", () => {
    const { $ } = setup({
      ui: {
        ...baseView().ui,
        fontSize: 18,
        backgroundOpacity: 0.3,
        maxLines: 4,
        chatLines: 9,
        growsUp: true,
      },
    });
    const root = $(".overlay")!;
    expect(root.style.getPropertyValue("--font")).toBe("18px");
    expect(root.style.getPropertyValue("--bg-alpha")).toBe("0.3");
    expect(root.style.getPropertyValue("--max-lines")).toBe("4");
    expect(root.style.getPropertyValue("--chat-lines")).toBe("9");
    expect(root.style.flexDirection).toBe("column-reverse");
  });

  it("shows the pinned line and the chips in strip mode only", () => {
    const chips = [
      { n: 1, text: "Sol" },
      { n: 2, text: "Achenar", detail: "Dawes Hub" },
    ];
    const { $, overlay, container } = setup({ pinned: "sell cargo", chips });
    expect($(".pinned")?.textContent).toBe("▸ sell cargo");
    expect($(".chips")?.title).toBe("Click or Ctrl+Alt+1-9 copies chip n");
    const buttons = container.querySelectorAll<HTMLButtonElement>(".chip");
    expect([...buttons].map((b) => b.textContent)).toEqual(["1 Sol", "2 Achenar · Dawes Hub"]);
    fireEvent.click(buttons[1]!);
    expect(overlay.copyChip).toHaveBeenCalledWith(2);

    overlay.view(baseView({ mode: "card", pinned: "sell cargo", chips }));
    expect($(".pinned")).toBeNull();
    expect($(".chips")).toBeNull();
  });
});

describe("notices", () => {
  it("shows a command as code, and a click copies it", () => {
    const { $, overlay } = setup({
      notice: { text: "Run `npx ed-mcp setup` to fix", command: "npx ed-mcp setup", more: 0 },
    });
    const notice = $(".notice")!;
    expect(notice.className).toBe("notice copyable");
    expect(notice.title).toBe("Click to copy the command");
    expect(notice.querySelector("code")?.textContent).toBe("npx ed-mcp setup");
    fireEvent.click(notice);
    expect(overlay.copyNotice).toHaveBeenCalledOnce();
    expect($(".more-notices")).toBeNull();
  });

  it("does nothing on a click without a command; +n lists the others", () => {
    const { $, overlay } = setup({ notice: { text: "copied Sol", command: null, more: 2 } });
    const notice = $(".notice")!;
    expect(notice.className).toBe("notice");
    expect(notice.title).toBe("copied Sol");
    fireEvent.mouseEnter(notice);
    fireEvent.click(notice);
    expect(overlay.copyNotice).not.toHaveBeenCalled();
    // Not a click target: the game keeps the clicks.
    expect(overlay.hover).not.toHaveBeenCalled();
    const more = $(".more-notices")!;
    expect(more.textContent).toBe("+2");
    fireEvent.click(more);
    expect(overlay.showNotices).toHaveBeenCalledOnce();
  });
});

describe("click targets", () => {
  it("takes clicks while any nested target is hovered", () => {
    const { $, overlay } = setup({
      mode: "card",
      card: { text: "Fly to Sol", chips: [{ n: 1, text: "Sol" }], full: false },
    });
    const card = $(".card")!;
    const chip = $(".chip")!;
    fireEvent.mouseEnter(card);
    expect(overlay.hover.mock.calls).toEqual([[true]]);
    expect(overlay.holdCard.mock.calls).toEqual([[true]]);
    // Onto the chip inside the card, and off it again: the window still takes clicks.
    // React reads enter and leave from mouseout and where the pointer went.
    fireEvent.mouseOut(card, { relatedTarget: chip });
    expect(overlay.hover.mock.calls).toEqual([[true]]);
    fireEvent.mouseOut(chip, { relatedTarget: card });
    expect(overlay.hover.mock.calls).toEqual([[true]]);
    fireEvent.mouseLeave(card);
    expect(overlay.hover.mock.calls).toEqual([[true], [false]]);
    expect(overlay.holdCard.mock.calls).toEqual([[true], [false]]);
  });

  it("gives the clicks back when a hovered target goes away", () => {
    const { $, overlay } = setup({
      mode: "card",
      card: { text: "Fly to Sol", chips: [], full: false },
    });
    fireEvent.mouseEnter($(".card")!);
    overlay.view(baseView());
    expect($(".card")).toBeNull();
    expect(overlay.hover.mock.calls).toEqual([[true], [false]]);
    expect(overlay.holdCard.mock.calls).toEqual([[true], [false]]);
  });
});

describe("hotkeys card", () => {
  it("lists the keys, marks the broken ones, and closes on a click", () => {
    const { container, $, overlay } = setup({
      keys: [
        { label: "Open chat", keys: "Ctrl+Alt+C", failed: [], unused: [] },
        { label: "Copy chip", keys: "Ctrl+Alt+1", failed: ["Ctrl+Alt+1"], unused: [] },
        { label: "Approve", keys: "F9", failed: [], unused: ["F9"] },
      ],
    });
    const cells = [...container.querySelectorAll(".keys-card tr")].map((tr) => {
      const [label, keys] = tr.querySelectorAll("td");
      return [label!.textContent, keys!.textContent, keys!.className];
    });
    expect(cells).toEqual([
      ["Open chat", "Ctrl+Alt+C", ""],
      ["Copy chip", "Ctrl+Alt+1 ⚠ not working: Ctrl+Alt+1", "taken"],
      ["Approve", "F9 ⚠ off in always scope: F9", "taken"],
    ]);
    fireEvent.click($(".keys-card")!);
    expect(overlay.closeKeys).toHaveBeenCalledOnce();
  });
});

describe("reply card", () => {
  it("offers more only when the text is cut off", () => {
    const { $, overlay } = setup({
      mode: "card",
      card: { text: "short", chips: [], full: false },
    });
    expect($(".card .more")).toBeNull();

    // jsdom lays nothing out; a text taller than its box is what a long reply looks like.
    const tall = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500);
    try {
      overlay.view(baseView({ mode: "card", card: { text: "long", chips: [], full: false } }));
      expect($(".card .text")?.className).toBe("text");
      expect($(".card .more")?.textContent).toBe("▾ more");
      fireEvent.click($(".card .more")!);
      expect(overlay.showMore).toHaveBeenCalledOnce();
    } finally {
      tall.mockRestore();
    }
  });

  it("offers less on the whole reply", () => {
    const { $ } = setup({ mode: "card", card: { text: "long", chips: [], full: true } });
    expect($(".card .text")?.className).toBe("text full");
    expect($(".card .more")?.textContent).toBe("▴ less");
  });
});

describe("icon mode", () => {
  it("hides the strip and expands on a click", () => {
    const { $, overlay } = setup({
      mode: "icon",
      icon: { dot: true, danger: false },
      ui: { ...baseView().ui, align: "end" },
    });
    expect($(".strip")?.hidden).toBe(true);
    const icon = $(".icon")!;
    expect(icon.className).toBe("icon");
    expect(icon.style.alignSelf).toBe("end");
    expect(icon.textContent).toBe("✦");
    expect(icon.querySelector(".dot")).not.toBeNull();
    fireEvent.click(icon);
    expect(overlay.expand).toHaveBeenCalledOnce();
  });

  it("shows danger instead of the dot", () => {
    const { $ } = setup({ mode: "icon", icon: { dot: true, danger: true } });
    expect($(".icon")?.className).toBe("icon danger");
    expect($(".icon")?.textContent).toBe("⛔");
  });
});

describe("approval card", () => {
  it("shows the request, and each button answers it", () => {
    const { $, container, overlay } = setup({
      approval: { ...approval, deadline: Date.now() + 60_000 },
    });
    expect($(".approval .head")?.textContent).toBe("Claude wants to run Bash1 of 2");
    expect($(".approval .warn")?.textContent).toBe("⚠ runs a shell command");
    expect($(".approval .summary")?.textContent).toBe("npm test");
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".answer")];
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Allow · Ctrl+Alt+Y",
      "Deny · Ctrl+Alt+N",
      "Always · Ctrl+Alt+A",
    ]);
    for (const b of buttons) fireEvent.click(b);
    expect(overlay.answerApproval.mock.calls).toEqual([
      ["req-1", "approve"],
      ["req-1", "deny"],
      ["req-1", "alwaysAllow"],
    ]);
  });

  it("counts down to the deadline, and restarts for a new request", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { $, overlay } = setup({
      approval: { ...approval, shell: false, position: null, deadline: Date.now() + 30_000 },
    });
    expect($(".approval .warn")).toBeNull();
    expect($(".approval .position")).toBeNull();
    const bar = () => $<HTMLDivElement>(".countdown > div")!.style.width;
    expect($(".approval .hint")?.textContent).toBe("denied in 30 s without an answer");
    expect(bar()).toBe("50%");
    act(() => vi.advanceTimersByTime(10_000));
    expect($(".approval .hint")?.textContent).toBe("denied in 20 s without an answer");
    expect($(".countdown")?.getAttribute("title")).toBe("Denied in 20 s without an answer");
    act(() => vi.advanceTimersByTime(40_000));
    // Past the deadline: it stops at zero.
    expect($(".approval .hint")?.textContent).toBe("denied in 0 s without an answer");
    expect(bar()).toBe("0%");

    overlay.view(
      baseView({ approval: { ...approval, id: "req-2", deadline: Date.now() + 60_000 } }),
    );
    expect($(".approval .hint")?.textContent).toBe("denied in 60 s without an answer");
    expect(bar()).toBe("100%");
  });
});

describe("chat", () => {
  const chat = (over: Partial<NonNullable<ViewModel["chat"]>> = {}) =>
    ({
      mode: "chat",
      chat: { history: [], streaming: null, chips: [], input: true, canSend: true, ...over },
    }) satisfies Partial<ViewModel>;

  it("shows the history and the reply as it streams", () => {
    const { container, $ } = setup(
      chat({
        history: [
          { role: "user", text: "where to?" },
          { role: "assistant", text: "Sol" },
        ],
        streaming: "Then Achenar",
        input: false,
      }),
    );
    const turns = [...container.querySelectorAll(".history > div")];
    expect(turns.map((t) => [t.className, t.textContent])).toEqual([
      ["user", "where to?"],
      ["assistant", "Sol"],
      ["assistant", "Then Achenar"],
    ]);
    // History only: no input, and the strip is not a drag handle.
    expect($("textarea")).toBeNull();
    expect($(".strip")?.className).toBe("strip");
  });

  it("focuses the input, and Enter sends the text and clears it", async () => {
    const { $, overlay } = setup(chat());
    expect($(".strip")?.className).toBe("strip drag");
    const input = $<HTMLTextAreaElement>("textarea")!;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "where to?" } });
    // Shift+Enter is a new line, not a send.
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(overlay.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(overlay.send).toHaveBeenCalledWith("where to?");
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("keeps the text when main refuses it", async () => {
    const { $, overlay } = setup(chat());
    overlay.send.mockResolvedValue(false);
    const input = $<HTMLTextAreaElement>("textarea")!;
    fireEvent.change(input, { target: { value: "where to?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    expect(overlay.send).toHaveBeenCalledOnce();
    expect(input.value).toBe("where to?");
  });

  it("does not send while the agent is replying", () => {
    const { $, overlay } = setup({ ...chat({ canSend: false }), agentName: "Codex" });
    const input = $<HTMLTextAreaElement>("textarea")!;
    expect(input.placeholder).toBe("Codex is replying…");
    fireEvent.change(input, { target: { value: "where to?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(overlay.send).not.toHaveBeenCalled();
    expect(input.value).toBe("where to?");
  });

  it("Escape in the input clears it and closes the chat once", () => {
    const { $, overlay } = setup(chat());
    const input = $<HTMLTextAreaElement>("textarea")!;
    fireEvent.change(input, { target: { value: "where to?" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(overlay.closeChat).toHaveBeenCalledOnce();
  });

  it("Escape elsewhere closes the chat, but only while the input is open", () => {
    const { overlay } = setup(chat());
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(overlay.closeChat).toHaveBeenCalledOnce();
    overlay.view(baseView(chat({ input: false })));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(overlay.closeChat).toHaveBeenCalledOnce();
  });
});

describe("hotkeys while the overlay has focus", () => {
  it("sends a Ctrl+Alt chord to main", () => {
    const { overlay } = setup();
    const e = new KeyboardEvent("keydown", {
      key: "x",
      code: "KeyX",
      ctrlKey: true,
      altKey: true,
      cancelable: true,
    });
    window.dispatchEvent(e);
    expect(overlay.chord).toHaveBeenCalledWith("Ctrl+Alt+X");
    expect(e.defaultPrevented).toBe(true);
  });

  it("leaves AltGr and plain keys to typing", () => {
    const { overlay } = setup();
    const altGr = new KeyboardEvent("keydown", {
      key: "@",
      code: "KeyQ",
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
      cancelable: true,
    });
    window.dispatchEvent(altGr);
    fireEvent.keyDown(window, { key: "x", code: "KeyX" });
    expect(overlay.chord).not.toHaveBeenCalled();
    expect(altGr.defaultPrevented).toBe(false);
  });

  it("stops listening when unmounted", () => {
    const { overlay, unmount } = setup();
    unmount();
    fireEvent.keyDown(window, { key: "x", code: "KeyX", ctrlKey: true, altKey: true });
    expect(overlay.chord).not.toHaveBeenCalled();
  });
});
