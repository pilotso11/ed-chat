import type { HudView, ShipStatus } from "./hud.js";

/** Where the player is, from the journal and Status.json. */
export interface Whereabouts {
  system: string | null;
  station: string | null;
  docked: boolean;
}

const MARK: Record<string, string> = { current: "now", next: "next", label: "", more: "" };

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
    const at = where.docked && where.station ? `docked at ${where.station} in` : "in";
    const near = !where.docked && status?.body ? `, near ${status.body}` : "";
    lines.push(`Location: ${at} ${where.system}${near}.`);
  }
  const p = view?.panel;
  if (p) {
    const head = [p.title, p.subtitle, p.right].filter(Boolean).join(" · ");
    const rows = p.rows.map((r) => [r.text.trim(), r.detail, r.right].filter(Boolean).join(" · "));
    lines.push(`Panel: ${head}`, ...rows.map((r) => `- ${r}`), ...p.footer.map((f) => `- ${f}`));
  }
  if (view?.route?.length) {
    const stops = view.route.map((r) => [MARK[r.kind], r.text, r.right].filter(Boolean).join(" "));
    lines.push(`Route: ${stops.join("; ")}`);
  }
  if (!lines.length) return null;
  return `[Game now, from the journal, newer than anything earlier in the conversation:\n${lines.join("\n")}]`;
}

/** The message as sent to Claude: the game note, then what the player typed. */
export function withGameContext(text: string, context: string | null): string {
  return context ? `${context}\n\n${text}` : text;
}
