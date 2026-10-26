import type { ViewModel } from "../core/view.js";

export const IPC = {
  view: "overlay:view",
  send: "overlay:send",
  closeChat: "overlay:closeChat",
  copyChip: "overlay:copyChip",
  height: "overlay:height",
  chord: "overlay:chord",
  hover: "overlay:hover",
  expand: "overlay:expand",
  holdCard: "overlay:holdCard",
  copyNotice: "overlay:copyNotice",
  showNotices: "overlay:showNotices",
  closeKeys: "overlay:closeKeys",
} as const;

export interface OverlayApi {
  onView(cb: (v: ViewModel) => void): void;
  /** Resolves true when main took the message, so the input can be cleared. */
  send(text: string): Promise<boolean>;
  closeChat(): void;
  copyChip(n: number): void;
  reportHeight(h: number): void;
  /** A Ctrl+Alt chord pressed in the chat input, such as "Ctrl+Alt+X". */
  chord(accelerator: string): void;
  /** The pointer is over a chip or the icon, so the window must take the click instead of the game. */
  hover(over: boolean): void;
  /** Leave icon mode. */
  expand(): void;
  /** The pointer is on the reply card, so it must not fade. */
  holdCard(hold: boolean): void;
  /** Copy the command in the shown notice. */
  copyNotice(): void;
  /** List every notice in a menu. */
  showNotices(): void;
  closeKeys(): void;
}
