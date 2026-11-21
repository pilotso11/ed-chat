import { afterEach, vi } from "vitest";

// Runs before every test file (vitest.config.ts setupFiles); only the jsdom ones need it.
if (typeof window !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  const { FakeResizeObserver } = await import("./overlay.js");
  // jsdom has no ResizeObserver.
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  afterEach(() => {
    cleanup();
    // Every component has unmounted: an observer still running was never disconnected.
    const left = FakeResizeObserver.observing();
    FakeResizeObserver.active.clear();
    vi.useRealTimers();
    delete (window as { overlay?: unknown }).overlay;
    if (left) throw new Error(`${left} element(s) still observed after unmount`);
  });
}
