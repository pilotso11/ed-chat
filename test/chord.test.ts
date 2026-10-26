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

  it("takes a non-Latin letter key from its position, as Windows matches it", () => {
    // Russian: the X key types ч; Greek: the X key types χ.
    expect(chordFromKey(press({ key: "ч", code: "KeyX" }))).toBe("Ctrl+Alt+X");
    expect(chordFromKey(press({ key: "Χ", code: "KeyX", shift: true }))).toBe("Ctrl+Alt+Shift+X");
    // A Latin layout's own punctuation key keeps its character.
    expect(chordFromKey(press({ key: "ù", code: "Quote" }))).toBe("Ctrl+Alt+Ù");
    // AZERTY: the "," key sits at KeyM, but Windows does not treat it as M.
    expect(chordFromKey(press({ key: ",", code: "KeyM" }))).toBe("Ctrl+Alt+,");
  });

  it("takes a digit from its position, as Windows matches digit hotkeys", () => {
    // AZERTY: the 1 key types "&" without Shift.
    expect(chordFromKey(press({ key: "&", code: "Digit1" }))).toBe("Ctrl+Alt+1");
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
