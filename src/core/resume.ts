/** The Claude conversation that ED Chat resumes on its next start. */
export interface SavedSession {
  id: string;
  /** When the conversation last finished a turn, as an ISO time. */
  lastUsed: string;
  /** The history file the conversation writes to, so a resumed start keeps one file. */
  history?: string;
}

/**
 * The conversation to resume on start, or null for a new one. A conversation older than
 * `hours` is not resumed: after a long break the player has usually moved on, and the saved
 * activity note still tells Claude what they were doing. 0 turns resume off.
 */
export function resumeId(saved: SavedSession | undefined, now: Date, hours: number): string | null {
  if (!saved || hours <= 0) return null;
  const age = now.getTime() - Date.parse(saved.lastUsed);
  return Number.isFinite(age) && age >= 0 && age < hours * 3_600_000 ? saved.id : null;
}
