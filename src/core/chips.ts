export interface Chip {
  n: number;
  text: string;
}

const MARK = /⟦([^⟦⟧\n]+)⟧/g;
const MAX_CHIPS = 9;

export function parseChips(text: string): { plain: string; chips: Chip[] } {
  const chips: Chip[] = [];
  const plain = text.replace(MARK, (_m, inner: string) => {
    const name = inner.trim();
    if (name && chips.length < MAX_CHIPS && !chips.some((c) => c.text === name)) {
      chips.push({ n: chips.length + 1, text: name });
    }
    return name;
  });
  return { plain, chips };
}

export function firstLine(plain: string): string | null {
  return (
    plain
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? null
  );
}
