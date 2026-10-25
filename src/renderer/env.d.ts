import type { OverlayApi } from "../shared/ipc.js";

declare global {
  interface Window {
    overlay: OverlayApi;
  }
}
