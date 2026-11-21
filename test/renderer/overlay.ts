import { act } from "@testing-library/react";
import { vi, type Mock } from "vitest";
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

/**
 * jsdom has no ResizeObserver, and lays nothing out. test/renderer/setup.ts installs this one.
 * Observing an element reports it once, at once: a browser reports it after the next layout, so
 * the tests check what is reported, not when. After that, a size change is a test calling
 * resize(), which reports every element still observed.
 */
export class FakeResizeObserver {
  static active = new Set<FakeResizeObserver>();
  readonly targets = new Set<Element>();
  constructor(readonly cb: ResizeObserverCallback) {}
  observe(el: Element) {
    // As in a browser, observing an element again does nothing.
    if (this.targets.has(el)) return;
    this.targets.add(el);
    FakeResizeObserver.active.add(this);
    // Components observe in a layout effect, inside act.
    this.cb([{ target: el } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
    FakeResizeObserver.active.delete(this);
  }
  static observing(): number {
    let n = 0;
    for (const o of FakeResizeObserver.active) n += o.targets.size;
    return n;
  }
}

/** Every observed element changed size. */
export function resize(): void {
  act(() => {
    for (const o of [...FakeResizeObserver.active]) {
      const entries = [...o.targets].map((target) => ({ target }) as ResizeObserverEntry);
      if (entries.length) o.cb(entries, o as unknown as ResizeObserver);
    }
  });
}

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
