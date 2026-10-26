import { describe, expect, it } from "vitest";
import { chordFromKey, type KeyPress } from "../src/core/chord.js";

const press = (over: Partial<KeyPress>): KeyPress => ({
  key: "x",
  code: "KeyX",
  ctrl: true,
  alt: true,
  shift: false,
  altGraph: false,
  ...over,
});

describe("chordFromKey", () => {
  it("names a Ctrl+Alt chord by the letter the layout types", () => {
    expect(chordFromKey(press({}))).toBe("Ctrl+Alt+X");
    // AZERTY: M sits where US has the semicolon.
    expect(chordFromKey(press({ key: "m", code: "Semicolon" }))).toBe("Ctrl+Alt+M");
    // QWERTZ: Z sits where US has Y.
    expect(chordFromKey(press({ key: "z", code: "KeyY" }))).toBe("Ctrl+Alt+Z");
    expect(chordFromKey(press({ key: "+", code: "Equal" }))).toBe("Ctrl+Alt+Plus");
  });

  it("takes the digit from its position when Shift changes the character", () => {
    expect(chordFromKey(press({ key: "!", code: "Digit1", shift: true }))).toBe("Ctrl+Alt+Shift+1");
    expect(chordFromKey(press({ key: "X", shift: true }))).toBe("Ctrl+Alt+Shift+X");
  });

  it("ignores AltGr, other modifiers and modifier keys alone", () => {
    expect(chordFromKey(press({ altGraph: true }))).toBeNull();
    expect(chordFromKey(press({ alt: false }))).toBeNull();
    expect(chordFromKey(press({ ctrl: false }))).toBeNull();
    expect(chordFromKey(press({ key: "Control", code: "ControlLeft" }))).toBeNull();
  });
});
