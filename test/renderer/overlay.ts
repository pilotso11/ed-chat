import { act, cleanup } from "@testing-library/react";
import { afterEach, vi, type Mock } from "vitest";
import type { HudView } from "../../src/core/hud/hud.js";
import type { ViewModel } from "../../src/core/view.js";
import type { OverlayApi } from "../../src/shared/ipc.js";

// The renderer's only link to main is window.overlay (src/preload). These tests replace it with
// mocks: a view is pushed in as main pushes it, and the calls to main are checked.

type Mocked<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer R ? Mock<(...a: A) => R> : T[K];
};

export interface FakeOverlay extends Mocked<OverlayApi> {
  /** Pushes a view to the chat window, as main does. */
  view(v: ViewModel): void;
  /** Pushes a view to the panel window. */
  hud(v: HudView): void;
}

export function fakeOverlay(): FakeOverlay {
  let onView: ((v: ViewModel) => void) | undefined;
  let onHud: ((v: HudView) => void) | undefined;
  const o: FakeOverlay = {
    onView: vi.fn((cb) => void (onView = cb)),
    onHud: vi.fn((cb) => void (onHud = cb)),
    send: vi.fn(async () => true),
    closeChat: vi.fn(),
    copyChip: vi.fn(),
    reportHeight: vi.fn(),
    chord: vi.fn(),
    hover: vi.fn(),
    expand: vi.fn(),
    holdCard: vi.fn(),
    copyNotice: vi.fn(),
    showNotices: vi.fn(),
    closeKeys: vi.fn(),
    showMore: vi.fn(),
    answerApproval: vi.fn(),
    reportHudSize: vi.fn(),
    view: (v) => act(() => onView!(v)),
    hud: (v) => act(() => onHud!(v)),
  };
  window.overlay = o;
  return o;
}

// jsdom has no ResizeObserver; this one reports each observed element once, as a browser does
// when observing starts.
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element) {
    this.cb([{ target: el } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

export function baseView(over: Partial<ViewModel> = {}): ViewModel {
  return {
    show: true,
    agentName: "Claude",
    mode: "strip",
    status: "● idle",
    auto: false,
    notice: null,
    keys: null,
    pinned: null,
    chips: [],
    card: null,
    chat: null,
    approval: null,
    icon: null,
    ui: {
      fontSize: 14,
      backgroundOpacity: 0.6,
      width: 520,
      maxLines: 6,
      chatLines: 12,
      growsUp: false,
      align: "start",
      copyChipKey: "Ctrl+Alt+1-9",
    },
    ...over,
  };
}
