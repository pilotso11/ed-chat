import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { FakeResizeObserver } from "./overlay.js";

// The renderer project's setup file (vitest.config.ts): every test here runs in jsdom.

// jsdom has no ResizeObserver.
globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

afterEach(() => {
  let left = 0;
  try {
    cleanup();
    // Every component has unmounted: an observer still running was never disconnected.
    left = FakeResizeObserver.observing();
  } finally {
    // Also when an unmount threw: the next test must start clean.
    FakeResizeObserver.active.clear();
    vi.useRealTimers();
    delete (window as { overlay?: unknown }).overlay;
  }
  if (left) throw new Error(`${left} element(s) still observed after unmount`);
});
