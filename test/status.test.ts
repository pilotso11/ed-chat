import { describe, expect, it } from "vitest";
import { StatusWatcher, decodeStatus, fullscreenMode, type ShipFlags } from "../src/core/status.js";

describe("decodeStatus", () => {
  it("reads docked and in danger", () => {
    expect(decodeStatus('{"Flags":1}')).toEqual({ docked: true, inDanger: false });
    expect(decodeStatus(`{"Flags":${1 << 22}}`)).toEqual({ docked: false, inDanger: true });
    expect(decodeStatus(`{"Flags":${1 << 23}}`)).toEqual({ docked: false, inDanger: true });
  });

  // Bit 24 is InMainShip and is set in almost all flight; it must not count as danger.
  // 150994968 is a real Status.json value: shields up, supercruise, main ship, analysis HUD.
  it("ignores InMainShip and other flight bits", () => {
    expect(decodeStatus(`{"Flags":${1 << 24}}`)).toEqual({ docked: false, inDanger: false });
    expect(decodeStatus('{"Flags":150994968}')).toEqual({ docked: false, inDanger: false });
    expect(decodeStatus(`{"Flags":${1 << 21}}`)).toEqual({ docked: false, inDanger: false });
  });

  it("treats a missing Flags as neither", () => {
    expect(decodeStatus('{"event":"Status"}')).toEqual({ docked: false, inDanger: false });
  });

  it("returns null for a half-written file", () => {
    expect(decodeStatus("")).toBeNull();
    expect(decodeStatus('{"Flags":')).toBeNull();
    expect(decodeStatus('{"Flags":"x"}')).toBeNull();
  });
});

describe("fullscreenMode", () => {
  it.each([
    ["0", "windowed"],
    ["1", "fullscreen"],
    ["2", "borderless"],
  ] as const)("%s is %s", (v, mode) => {
    expect(fullscreenMode(`<DisplayConfig><FullScreen>${v}</FullScreen></DisplayConfig>`)).toBe(
      mode,
    );
  });

  it("returns null when the value is missing or unknown", () => {
    expect(fullscreenMode("<DisplayConfig/>")).toBeNull();
    expect(fullscreenMode("<FullScreen>7</FullScreen>")).toBeNull();
  });
});

describe("StatusWatcher", () => {
  it("reports changes and keeps the last good flags", async () => {
    let text = '{"Flags":1}';
    let fail = false;
    const seen: ShipFlags[] = [];
    const w = new StatusWatcher("Status.json", (f) => seen.push(f), {
      read: async () => {
        if (fail) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return text;
      },
    });
    await w.poll();
    await w.poll();
    expect(seen).toEqual([{ docked: true, inDanger: false }]);
    text = "";
    await w.poll();
    fail = true;
    await w.poll();
    expect(w.flags).toEqual({ docked: true, inDanger: false });
    fail = false;
    text = '{"Flags":0}';
    await w.poll();
    expect(seen).toEqual([
      { docked: true, inDanger: false },
      { docked: false, inDanger: false },
    ]);
  });
});
