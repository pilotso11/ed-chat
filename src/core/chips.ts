export interface Chip {
  n: number;
  /** What the chip copies: a system or station name for the galaxy map. */
  text: string;
  /** The target there, such as a body or station: shown on the chip, not copied. */
  detail?: string;
}

const MARK = /⟦([^⟦⟧\n]+)⟧/g;
/** Splits ⟦system › target⟧ into what to copy and where to go there. */
const DETAIL = "›";
const MAX_CHIPS = 9;

export function parseChips(text: string): { plain: string; chips: Chip[] } {
  const chips: Chip[] = [];
  const plain = text.replace(MARK, (_m, inner: string) => {
    const at = inner.indexOf(DETAIL);
    const name = (at < 0 ? inner : inner.slice(0, at)).trim();
    const detail = at < 0 ? "" : inner.slice(at + 1).trim();
    if (!name) return detail;
    const same = (c: Chip) => c.text === name && (c.detail ?? "") === detail;
    if (chips.length < MAX_CHIPS && !chips.some(same)) {
      chips.push({ n: chips.length + 1, text: name, ...(detail ? { detail } : {}) });
    }
    return detail ? `${name} ${detail}` : name;
  });
  return { plain, chips };
}

/** A chip's label: the name, and the target there when there is one. */
export const chipLabel = (c: Chip): string => (c.detail ? `${c.text} · ${c.detail}` : c.text);

export function firstLine(plain: string): string | null {
  return (
    plain
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? null
  );
}
