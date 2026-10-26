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
}
