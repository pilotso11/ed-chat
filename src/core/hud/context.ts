import type { HudView, ShipStatus } from "./hud.js";
import { footerText } from "./panels.js";

/** Where the player is, from the journal and Status.json. */
export interface Whereabouts {
  system: string | null;
  station: string | null;
  docked: boolean;
}

const MARK: Record<string, string> = { current: "now", next: "next", label: "", more: "" };

// Names from Spansh reach the panel rows. A name holding ] or a line break could end the note
// early and add text Claude trusts, so those are replaced, and each field is kept short.
const MAX_FIELD = 160;
function clean(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v
    .replace(/[\[\]]/g, (c) => (c === "[" ? "(" : ")"))
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .trim();
  return s ? s.slice(0, MAX_FIELD) : null;
}

/**
 * A short note of the game as the panel sees it now, sent with each message so Claude does not
 * plan from an older turn: where the player is, the panel's rows and the route. Null when nothing
 * is known yet.
 */
export function gameContext(
  where: Whereabouts | null,
  status: ShipStatus | null,
  view: HudView | null,
): string | null {
  const lines: string[] = [];
  if (where?.system) {
    const station = clean(where.station);
    const at = !where.docked ? "in" : station ? `docked at ${station} in` : "docked in";
    const near = !where.docked && status?.body ? `, near ${clean(status.body)}` : "";
    lines.push(`Location: ${at} ${clean(where.system)}${near}.`);
  }
  const p = view?.panel;
  if (p) {
    const head = [p.title, p.subtitle, p.right].map(clean).filter(Boolean).join(" · ");
    const rows = p.rows.map((r) =>
      [r.text, r.detail, r.right].map(clean).filter(Boolean).join(" · "),
    );
    lines.push(
      `Panel: ${head}`,
      ...rows.map((r) => `- ${r}`),
      ...p.footer.map((f) => `- ${clean(footerText(f))}`),
    );
  }
  if (view?.route?.length) {
    const stops = view.route.map((r) =>
      [MARK[r.kind], clean(r.text), clean(r.right)].filter(Boolean).join(" "),
    );
    lines.push(`Route: ${stops.join("; ")}`);
  }
  if (!lines.length) return null;
  // The latest the journal knows, which stays true after the game closes: the ship is still there.
  return `[Game state, the latest from the journal, newer than anything earlier in the conversation:\n${lines.join("\n")}]`;
}

/** The feed polls each second: when it has not read the game for this long, it has stopped. */
export const NOTE_MAX_AGE_MS = 10_000;

/** Whether the feed's data is fresh enough to send as now. */
export function noteIsFresh(enabled: boolean, readAt: number, now: number): boolean {
  return enabled && readAt > 0 && now - readAt < NOTE_MAX_AGE_MS;
}

/** The message as sent to Claude: the game note, then what the player typed. */
export function withGameContext(text: string, context: string | null): string {
  return context ? `${context}\n\n${text}` : text;
}
