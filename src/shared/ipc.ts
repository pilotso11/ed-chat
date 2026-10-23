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
  send(text: string): void;
  closeChat(): void;
  copyChip(n: number): void;
  reportHeight(h: number): void;
}
