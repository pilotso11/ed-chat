import type { OverlayApi } from "../shared/ipc.js";
import type { SettingsApi } from "../shared/settingsIpc.js";

declare global {
  interface Window {
    overlay: OverlayApi;
    /** Only in the settings window. */
    settingsApi: SettingsApi;
  }
}
