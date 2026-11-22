import { AGENTS, type AgentId } from "./backend.js";
import { chipLabel, type Chip } from "./chips.js";
import { noticeCommand } from "./view.js";

// The tray menu and the notices menu, as data; main builds the Electron menus from them.

/** A menu label treats & as a mnemonic marker. */
export const menuLabel = (s: string) => s.replace(/&/g, "&&");

/** Every notice, one to an item; one with a command copies it on a click. */
export function noticeMenuItems(
  notices: Record<string, string>,
): { label: string; command: string | null }[] {
  return Object.entries(notices).map(([key, text]) => {
    const command = noticeCommand(key, text);
    return {
      label: menuLabel(command ? `${text.replace(/`/g, "")}  (click to copy)` : text),
      command,
    };
  });
}

export type TrayAction =
  | { type: "copyChip"; n: number }
  | { type: "openChat" }
  | { type: "newConversation" }
  | { type: "chooseAgent"; id: AgentId }
  | { type: "showKeys" }
  | { type: "hotkeyProblems" }
  | { type: "toggleIcon" }
  | { type: "toggleOverlay" }
  | { type: "openSettings" }
  | { type: "openLogs" }
  | { type: "clearBookmarks"; all: boolean }
  | { type: "about" }
  | { type: "quit" };

/** ED Chat's home page, which the tray's About item opens in the browser. */
export const ABOUT_URL = "https://github.com/pilotso11/ed-chat#readme";

export type TrayItem =
  | { separator: true }
  | { label: string; submenu: TrayItem[] }
  | { label: string; action: TrayAction; kind?: "radio" | "checkbox"; checked?: boolean };

/** Built when the tray opens, so the chips and the problems are current. */
export function trayItems(s: {
  chips: Chip[];
  agentId: AgentId;
  failedHotkeys: number;
  iconMode: boolean;
  visible: boolean;
  /**
   * Surface bookmarks still to do, in this system and in all; the Bookmarks menu shows when
   * there are any, and its "here" item when this system has some.
   */
  bookmarks?: { here: number; all: number };
}): TrayItem[] {
  const { here, all: bookmarks } = s.bookmarks ?? { here: 0, all: 0 };
  return [
    ...s.chips.map((c): TrayItem => ({
      label: menuLabel(`Copy ${c.n}: ${chipLabel(c)}`),
      action: { type: "copyChip", n: c.n },
    })),
    ...(s.chips.length ? [{ separator: true as const }] : []),
    { label: "Open chat", action: { type: "openChat" } },
    { label: "New conversation", action: { type: "newConversation" } },
    {
      label: "Assistant",
      submenu: (Object.keys(AGENTS) as AgentId[]).map((id): TrayItem => ({
        label: menuLabel(AGENTS[id].name),
        kind: "radio",
        checked: s.agentId === id,
        action: { type: "chooseAgent", id },
      })),
    },
    { label: "Show hotkeys", action: { type: "showKeys" } },
    ...(bookmarks
      ? [
          {
            label: "Bookmarks",
            submenu: [
              ...(here
                ? [
                    {
                      label: "Clear bookmarks here",
                      action: { type: "clearBookmarks", all: false } as const,
                    },
                  ]
                : []),
              {
                label: `Clear all bookmarks (${bookmarks})…`,
                action: { type: "clearBookmarks", all: true },
              },
            ] satisfies TrayItem[],
          },
        ]
      : []),
    ...(s.failedHotkeys
      ? [
          {
            label: `Hotkey problems (${s.failedHotkeys})…`,
            action: { type: "hotkeyProblems" } as const,
          },
        ]
      : []),
    { separator: true },
    { label: "Icon mode", kind: "checkbox", checked: s.iconMode, action: { type: "toggleIcon" } },
    // Minimized, the overlay still shows the chat and approvals, and the hotkeys still work.
    {
      label: s.visible ? "Minimize to tray" : "Restore overlay",
      action: { type: "toggleOverlay" },
    },
    { label: "Open settings", action: { type: "openSettings" } },
    { label: "Open log folder", action: { type: "openLogs" } },
    { label: "About ED Chat", action: { type: "about" } },
    { separator: true },
    { label: "Quit", action: { type: "quit" } },
  ];
}
