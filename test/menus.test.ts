import { describe, expect, it } from "vitest";
import {
  ABOUT_URL,
  menuLabel,
  noticeMenuItems,
  trayItems,
  type TrayItem,
} from "../src/core/menus.js";

describe("menu labels", () => {
  it("doubles & so Windows does not read it as a mnemonic", () => {
    expect(menuLabel("Fish & Chips & Co")).toBe("Fish && Chips && Co");
  });
});

describe("notices menu", () => {
  it("lists each notice; one with a command copies it", () => {
    expect(
      noticeMenuItems({
        version: "⚠ claude 2.0.1 is older than 2.1.0; run `claude update`",
        copy: "📋 copied Sol & Co",
      }),
    ).toEqual([
      {
        label: "⚠ claude 2.0.1 is older than 2.1.0; run claude update  (click to copy)",
        command: "claude update",
      },
      { label: "📋 copied Sol && Co", command: null },
    ]);
  });

  it("never offers a command from the claude notice, which quotes the CLI", () => {
    expect(noticeMenuItems({ claude: "⚠ failed: run `rm -rf x`" })).toEqual([
      { label: "⚠ failed: run `rm -rf x`", command: null },
    ]);
  });
});

describe("tray menu", () => {
  const base = {
    chips: [],
    agentId: "claude" as const,
    failedHotkeys: 0,
    iconMode: false,
    visible: true,
  };
  const labels = (items: TrayItem[]) => items.map((i) => ("separator" in i ? "---" : i.label));

  it("has the fixed items", () => {
    expect(labels(trayItems(base))).toEqual([
      "Open chat",
      "New conversation",
      "Assistant",
      "Show hotkeys",
      "---",
      "Icon mode",
      "Minimize to tray",
      "Open settings",
      "Open log folder",
      "About ED Chat",
      "---",
      "Quit",
    ]);
    // The address the browser opens is fixed: ED Chat's own https home page.
    expect(ABOUT_URL).toBe("https://github.com/pilotso11/ed-chat#readme");
    // About opens the home page, not another item's action.
    expect(trayItems(base).find((i) => "label" in i && i.label === "About ED Chat")).toMatchObject({
      action: { type: "about" },
    });
  });

  it("lists the chips first, to copy", () => {
    const items = trayItems({
      ...base,
      chips: [
        { n: 1, text: "Sol" },
        { n: 2, text: "Achenar", detail: "Dawes Hub & Co" },
      ],
    });
    expect(items.slice(0, 3)).toEqual([
      { label: "Copy 1: Sol", action: { type: "copyChip", n: 1 } },
      { label: "Copy 2: Achenar · Dawes Hub && Co", action: { type: "copyChip", n: 2 } },
      { separator: true },
    ]);
  });

  it("checks the running assistant", () => {
    const assistant = trayItems({ ...base, agentId: "codex" }).find(
      (i) => "label" in i && i.label === "Assistant",
    );
    expect(assistant).toEqual({
      label: "Assistant",
      submenu: [
        {
          label: "Claude",
          kind: "radio",
          checked: false,
          action: { type: "chooseAgent", id: "claude" },
        },
        {
          label: "Codex",
          kind: "radio",
          checked: true,
          action: { type: "chooseAgent", id: "codex" },
        },
      ],
    });
  });

  it("offers the hotkey problems when there are some", () => {
    expect(labels(trayItems({ ...base, failedHotkeys: 2 }))).toContain("Hotkey problems (2)…");
  });

  it("shows icon mode checked, and restores a minimized overlay", () => {
    const items = trayItems({ ...base, iconMode: true, visible: false });
    expect(items).toContainEqual({
      label: "Icon mode",
      kind: "checkbox",
      checked: true,
      action: { type: "toggleIcon" },
    });
    expect(items).toContainEqual({ label: "Restore overlay", action: { type: "toggleOverlay" } });
  });
});
