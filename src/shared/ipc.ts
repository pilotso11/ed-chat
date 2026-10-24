import type { ViewModel } from "../core/view.js";

export const IPC = {
  view: "overlay:view",
  send: "overlay:send",
  closeChat: "overlay:closeChat",
  copyChip: "overlay:copyChip",
  height: "overlay:height",
} as const;

export interface OverlayApi {
  onView(cb: (v: ViewModel) => void): void;
  /** Resolves true when main took the message, so the input can be cleared. */
  send(text: string): Promise<boolean>;
  closeChat(): void;
  copyChip(n: number): void;
  reportHeight(h: number): void;
}
