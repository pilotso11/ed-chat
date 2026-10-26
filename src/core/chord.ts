export interface KeyPress {
  key: string;
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** AltGr is held. Windows also sets Ctrl and Alt for it. */
  altGraph: boolean;
}

/**
 * The accelerator for a real Ctrl+Alt chord, such as "Ctrl+Alt+X", or null for any other key.
 * AltGr types a character, so it is not a chord. The letter is the one the keyboard layout
 * types (e.key), as in the bindings, not the US position of the key (e.code).
 */
export function chordFromKey(k: KeyPress): string | null {
  if (!k.ctrl || !k.alt || k.altGraph) return null;
  // Shift changes the character a digit key types, so the digit comes from its position.
  const digit = k.shift ? /^Digit(\d)$/.exec(k.code)?.[1] : undefined;
  const key = digit ?? (k.key === "+" ? "Plus" : k.key.length === 1 ? k.key.toUpperCase() : null);
  if (!key) return null;
  return `Ctrl+Alt+${k.shift ? "Shift+" : ""}${key}`;
}
