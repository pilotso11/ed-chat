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
 * AltGr types a character, so it is not a chord. A Latin letter is the one the keyboard layout
 * types (e.key), as in the bindings, not the US position of the key (e.code), so AZERTY and
 * QWERTZ match. A digit comes from its position, as Windows matches digit hotkeys: on AZERTY
 * the 1 key types "&" without Shift. On a non-Latin layout (Cyrillic, Greek) a letter key also
 * comes from its position, because Windows matches it there by the US letter: Ч is the X key.
 */
export function chordFromKey(k: KeyPress): string | null {
  if (!k.ctrl || !k.alt || k.altGraph) return null;
  const digit = /^Digit(\d)$/.exec(k.code)?.[1];
  const latin = /^[a-z]$/i.test(k.key) ? k.key.toUpperCase() : undefined;
  // Only for a letter outside A–Z: a Latin layout's punctuation key at a letter position (the
  // "," key is KeyM on AZERTY) is not that letter to Windows.
  const nonLatin = /^\p{L}$/u.test(k.key) && !latin;
  const position = nonLatin ? /^Key([A-Z])$/.exec(k.code)?.[1] : undefined;
  const key =
    digit ??
    latin ??
    (k.key === "+" ? "Plus" : (position ?? (k.key.length === 1 ? k.key.toUpperCase() : null)));
  if (!key) return null;
  return `Ctrl+Alt+${k.shift ? "Shift+" : ""}${key}`;
}
