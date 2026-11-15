import { describe, expect, it } from "vitest";
import { FocusManager, type Foreground, type Win32 } from "../src/core/focus.js";

function fakeWin32() {
  const w = {
    fg: 0,
    windows: new Set([10, 20, 99]),
    names: new Map([
      [10, "EliteDangerous64.exe"],
      [20, "notepad.exe"],
    ]),
    refuse: 0,
    calls: [] as number[],
    unlocks: 0,
    // Windows reports success but the window stays in the background, this many times.
    ignore: 0,
  };
  const api: Win32 = {
    foreground: () => w.fg,
    isWindow: (h) => w.windows.has(h),
    setForeground: (h) => {
      w.calls.push(h);
      if (w.refuse > 0) {
        w.refuse--;
        return false;
      }
      if (w.ignore > 0) {
        w.ignore--;
        return true;
      }
      w.fg = h;
      return true;
    },
    processName: (h) => w.names.get(h) ?? null,
    unlockForeground: () => {
      w.unlocks++;
    },
  };
  return { w, api };
}

const setup = () => {
  const { w, api } = fakeWin32();
  const seen: Foreground[] = [];
  const f = new FocusManager(api, {
    overlayHwnd: () => 99,
    onChange: (x) => seen.push(x),
    sleep: async () => {},
  });
  return { w, f, seen };
};

describe("FocusManager", () => {
  it("reports foreground changes once each", () => {
    const { w, f, seen } = setup();
    w.fg = 10;
    f.poll();
    f.poll();
    w.fg = 99;
    f.poll();
    w.fg = 20;
    f.poll();
    expect(seen).toEqual([
      { hwnd: 10, isGame: true, isOverlay: false, processName: "EliteDangerous64.exe" },
      { hwnd: 99, isGame: false, isOverlay: true, processName: null },
      { hwnd: 20, isGame: false, isOverlay: false, processName: "notepad.exe" },
    ]);
  });

  it("restores the saved window", async () => {
    const { w, f } = setup();
    w.fg = 10;
    f.save();
    w.fg = 99;
    expect(await f.restore()).toBe(true);
    expect(w.fg).toBe(10);
  });

  it("does not save the overlay itself", async () => {
    const { w, f } = setup();
    w.fg = 99;
    f.save();
    expect(await f.restore()).toBe(true);
    expect(w.calls).toEqual([]);
  });

  it("retries once, then reports failure", async () => {
    const { w, f } = setup();
    w.fg = 10;
    f.save();
    w.refuse = 1;
    expect(await f.restore()).toBe(true);
    f.save();
    w.refuse = 2;
    expect(await f.restore()).toBe(false);
  });

  it("gives focus back to the game after a tray click took it", async () => {
    const { w, f } = setup();
    w.windows.add(30);
    w.fg = 10;
    f.poll();
    w.fg = 30; // the taskbar
    f.poll();
    f.save(true);
    w.fg = 99;
    expect(await f.restore()).toBe(true);
    expect(w.fg).toBe(10);
  });

  it("restores the window in front when the game is not running", async () => {
    const { w, f } = setup();
    w.fg = 10;
    f.poll();
    w.windows.delete(10);
    w.fg = 20;
    f.save(true);
    expect(await f.restore()).toBe(true);
    expect(w.calls).toEqual([20]);
  });

  it("falls back to the game when no window is in front", async () => {
    const { w, f } = setup();
    w.fg = 10;
    f.poll();
    w.fg = 0;
    f.save();
    expect(await f.restore()).toBe(true);
    expect(w.fg).toBe(10);
  });

  it("skips a window that has gone", async () => {
    const { w, f } = setup();
    w.fg = 20;
    f.save();
    w.windows.delete(20);
    expect(await f.restore()).toBe(true);
    expect(w.calls).toEqual([]);
  });

  describe("settle", () => {
    const opened = async (w: ReturnType<typeof fakeWin32>["w"], f: FocusManager) => {
      w.fg = 10;
      f.poll();
      f.save();
      w.fg = 99;
    };

    it("is ok when the game has focus after the chat closes", async () => {
      const { w, f } = setup();
      await opened(w, f);
      expect(await f.restore()).toBe(true);
      expect(await f.settle()).toEqual({ result: "ok" });
      expect(w.unlocks).toBe(0);
    });

    it("unlocks and tries again when Windows reported success but kept the game behind", async () => {
      const { w, f } = setup();
      await opened(w, f);
      w.ignore = 1;
      expect(await f.restore()).toBe(true);
      expect(w.fg).toBe(99);
      expect(await f.settle()).toEqual({ result: "retried" });
      expect(w.unlocks).toBe(1);
      expect(w.fg).toBe(10);
    });

    it("names the window in front when the second try fails too", async () => {
      const { w, f } = setup();
      await opened(w, f);
      w.ignore = 2;
      await f.restore();
      expect(await f.settle()).toEqual({ result: "failed", foreground: "ED Chat" });
    });

    it("does nothing when nothing was restored", async () => {
      const { f } = setup();
      expect(await f.settle()).toBeNull();
    });

    it("unlocks before the second try when Windows refused the first", async () => {
      const { w, f } = setup();
      await opened(w, f);
      w.refuse = 1;
      expect(await f.restore()).toBe(true);
      expect(w.unlocks).toBe(1);
      expect(w.fg).toBe(10);
    });
  });
});
