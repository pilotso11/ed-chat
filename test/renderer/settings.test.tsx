import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../src/core/settings.js";
import { settingsForm } from "../../src/core/settingsForm.js";
import { SettingsApp } from "../../src/renderer/SettingsApp.js";
import type {
  SettingsApi,
  SettingsSaveResult,
  SettingsSnapshot,
} from "../../src/shared/settingsIpc.js";

// The settings window's only link to main is window.settingsApi (src/preload/settings.ts).

const sections = settingsForm();

function fakeApi(over: Partial<SettingsSnapshot> = {}) {
  let changed: (() => void) | undefined;
  const snap: SettingsSnapshot = {
    sections,
    values: structuredClone(DEFAULT_SETTINGS),
    fileError: null,
    failedKeys: [],
    displays: 2,
    ...over,
  };
  const api = {
    snap,
    load: vi.fn(async () => structuredClone(api.snap)),
    save: vi.fn<SettingsApi["save"]>(async () => ({ ok: true }) as SettingsSaveResult),
    openFile: vi.fn(),
    onChanged: vi.fn((cb: () => void) => void (changed = cb)),
    changed: () => act(() => changed!()),
  };
  window.settingsApi = api;
  return api;
}

async function setup(over: Partial<SettingsSnapshot> = {}) {
  const api = fakeApi(over);
  const r = render(<SettingsApp />);
  await screen.findByRole("heading", { name: "General" });
  return { api, ...r };
}

const field = (path: string) => document.querySelector<HTMLElement>(`[data-path="${path}"]`)!;
const control = <T extends Element>(path: string, sel = "input, select, textarea") =>
  field(path).querySelector<T>(sel)!;
/** A button by its text: quicker than a role query in a form this size. */
const button = (name: string, within: ParentNode = document) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent === name);
  if (!b) throw new Error(`no button ${name}`);
  return b;
};
const saveButton = () => button("Save");
const save = async () => {
  await act(async () => {
    fireEvent.click(saveButton());
  });
};

describe("settings window", () => {
  it("says it is loading until main answers", async () => {
    fakeApi();
    render(<SettingsApp />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    await screen.findByRole("heading", { name: "General" });
  });

  it("shows every section, in the list and the form", async () => {
    await setup();
    const nav = document.querySelector("nav")!;
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(sections.map((s) => s.title));
    expect(field("style.theme")).toBeTruthy();
    expect(field("hud.mining.targets")).toBeTruthy();
    // Only the player may change some settings.
    expect(field("hotkeys.approve").querySelector(".lock")).toBeTruthy();
    expect(field("style.theme").querySelector(".lock")).toBeNull();
  });

  it("scrolls to a section from the list", async () => {
    await setup();
    const scroll = vi.fn();
    document.getElementById("s-hud")!.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole("link", { name: "Activity panel" }));
    expect(scroll).toHaveBeenCalled();
  });

  it("shows the error, not the form, for a settings.json that does not parse", async () => {
    const api = fakeApi({ fileError: "⚠ settings.json: not valid JSON" });
    render(<SettingsApp />);
    await screen.findByText("⚠ settings.json: not valid JSON");
    expect(document.querySelector("[data-path]")).toBeNull();
    fireEvent.click(button("Open settings.json"));
    expect(api.openFile).toHaveBeenCalled();
  });

  it("opens settings.json", async () => {
    const { api } = await setup();
    fireEvent.click(button("Open settings.json"));
    expect(api.openFile).toHaveBeenCalled();
  });

  it("saves only the changed values, then shows them in use", async () => {
    const { api } = await setup();
    expect(saveButton()).toHaveProperty("disabled", true);
    fireEvent.click(control("strip.keepChips"));
    fireEvent.change(control("style.theme"), { target: { value: "blue" } });
    fireEvent.change(control("strip.lines"), { target: { value: "1" } });
    fireEvent.change(control("claude.model"), { target: { value: "opus" } });
    fireEvent.change(control("codex.model"), { target: { value: "  " } });
    fireEvent.change(control("position.display"), { target: { value: "1" } });
    fireEvent.change(control("hud.position.display"), { target: { value: "primary" } });
    fireEvent.change(control("claude.extraArgs"), { target: { value: "--a\n\n --b \n" } });
    fireEvent.change(control("hud.mining.targets"), { target: { value: '{"Platinum": 30}' } });
    fireEvent.change(control("card.width"), { target: { value: "500" } });
    expect(field("style.theme").className).toContain("edited");
    await save();
    expect(api.save.mock.calls[0]![0]).toEqual([
      { path: "strip.keepChips", value: false },
      { path: "style.theme", value: "blue" },
      { path: "strip.lines", value: 1 },
      { path: "claude.model", value: "opus" },
      { path: "codex.model", value: null },
      { path: "position.display", value: 1 },
      { path: "claude.extraArgs", value: ["--a", "--b"] },
      { path: "hud.mining.targets", value: { Platinum: 30 } },
      { path: "card.width", value: 500 },
    ]);
    expect(screen.getByRole("status").textContent).toMatch(/Saved/);
    expect(api.load).toHaveBeenCalledTimes(2);
    expect(saveButton()).toHaveProperty("disabled", true);
  });

  it("drops an edit set back to the value in use", async () => {
    await setup();
    fireEvent.change(control("style.theme"), { target: { value: "blue" } });
    expect(saveButton()).toHaveProperty("disabled", false);
    fireEvent.change(control("style.theme"), { target: { value: "game" } });
    expect(saveButton()).toHaveProperty("disabled", true);
  });

  it("will not save a number or JSON that is not valid", async () => {
    await setup();
    const check = (path: string, value: string, error: string) => {
      fireEvent.change(control(path), { target: { value } });
      expect(field(path).querySelector(".error")?.textContent).toBe(error);
      expect(saveButton()).toHaveProperty("disabled", true);
    };
    check("card.maxLines", "", "Enter a number");
    check("card.maxLines", "3.5", "Enter a whole number");
    check("card.maxLines", "11", "From 2 to 10");
    check("hud.valuableMin", "-1", "From 0 to ∞");
    check("hud.mining.sellRadiusLy", "0", "More than 0, up to 1000");
    check("hud.mining.targets", "{", "Not valid JSON");
    fireEvent.click(button("Revert"));
    expect(document.querySelector(".field .error")).toBeNull();
    expect(control<HTMLInputElement>("card.maxLines").value).toBe("4");
  });

  it("shows why main did not save, at the setting", async () => {
    const { api } = await setup();
    api.save.mockResolvedValueOnce({
      ok: false,
      error: "hotkeys.copyChip.0: must contain {n}",
      path: "hotkeys.copyChip.0",
    });
    fireEvent.change(control("style.theme"), { target: { value: "blue" } });
    await save();
    expect(screen.getByRole("status").textContent).toBe(
      "Not saved: hotkeys.copyChip.0: must contain {n}",
    );
    expect(field("hotkeys.copyChip").querySelector(".error")?.textContent).toMatch(/\{n\}/);
    // The edit stays, to fix and save again.
    expect(saveButton()).toHaveProperty("disabled", false);
  });

  it("saves once while a save is running, and shows a save that failed", async () => {
    const { api } = await setup();
    let finish!: (r: SettingsSaveResult) => void;
    api.save.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    fireEvent.change(control("style.theme"), { target: { value: "blue" } });
    fireEvent.click(saveButton());
    expect(saveButton()).toHaveProperty("disabled", true);
    fireEvent.click(saveButton());
    expect(api.save).toHaveBeenCalledTimes(1);
    // An edit made while the save runs stays, to save next.
    fireEvent.change(control("card.width"), { target: { value: "500" } });
    await act(async () => finish({ ok: true }));
    expect(field("card.width").className).toContain("edited");
    expect(field("style.theme").className).not.toContain("edited");
    fireEvent.change(control("style.theme"), { target: { value: "green" } });
    api.save.mockRejectedValueOnce(new Error("main is gone"));
    await save();
    expect(screen.getByRole("status").textContent).toBe("Not saved: main is gone");
    expect(saveButton()).toHaveProperty("disabled", false);
  });

  it("resets a setting, or all of them, to the default", async () => {
    const values: Settings = structuredClone(DEFAULT_SETTINGS);
    values.style.theme = "green";
    values.card.width = 600;
    const { api } = await setup({ values });
    const reset = button("Reset", field("style.theme"));
    expect(button("Reset", field("strip.lines"))).toHaveProperty("disabled", true);
    fireEvent.click(reset);
    expect(control<HTMLSelectElement>("style.theme").value).toBe("game");
    fireEvent.click(button("Revert"));
    fireEvent.click(button("Reset all"));
    expect(screen.getByRole("status").textContent).toMatch(/Save to keep it/);
    await save();
    expect(api.save.mock.calls[0]![0]).toEqual([
      { path: "style.theme", value: "game" },
      { path: "card.width", value: 420 },
    ]);
  });

  it("resets a number being typed", async () => {
    await setup();
    fireEvent.change(control("card.maxLines"), { target: { value: "x" } });
    fireEvent.click(button("Reset", field("card.maxLines")));
    expect(control<HTMLInputElement>("card.maxLines").value).toBe("4");
    expect(field("card.maxLines").querySelector(".error")).toBeNull();
  });

  it("reloads when settings.json changes, and keeps the edits", async () => {
    const { api } = await setup();
    fireEvent.change(control("style.theme"), { target: { value: "blue" } });
    api.snap.values.card.width = 700;
    api.changed();
    await waitFor(() => expect(control<HTMLInputElement>("card.width").value).toBe("700"));
    expect(control<HTMLSelectElement>("style.theme").value).toBe("blue");
  });

  it("shows the new value of a field typed back to the old one, when the file changes", async () => {
    const { api } = await setup();
    // Typed, but the same as the value in use: no edit.
    fireEvent.change(control("card.width"), { target: { value: "420.0" } });
    expect(saveButton()).toHaveProperty("disabled", true);
    api.snap.values.card.width = 700;
    api.changed();
    await waitFor(() => expect(control<HTMLInputElement>("card.width").value).toBe("700"));
  });

  it("finds settings by name, help text or path", async () => {
    await setup();
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "carrier" } });
    expect(field("hud.mining.useCarrier")).toBeTruthy();
    expect(field("style.theme")).toBeNull();
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(["Activity panel"]);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No setting matches “zzz”.")).toBeTruthy();
  });

  it("warns of a key that two actions share, or that another app holds", async () => {
    await setup({ failedKeys: ["Ctrl+Alt+H"] });
    expect(field("hotkeys.showHistory").querySelector(".warn")?.textContent).toBe(
      "⚠ Ctrl+Alt+H is in use by another app",
    );
    expect(field("hotkeys.deny").querySelector(".warn")).toBeNull();
  });
});

describe("hotkey fields", () => {
  const keyDown = (el: Element, key: string, code: string, mods: object = {}) =>
    fireEvent.keyDown(el, { key, code, ...mods });

  it("captures the keys pressed", async () => {
    const { api } = await setup();
    const button = within(field("hotkeys.deny")).getByRole("button", { name: "Ctrl+Alt+N" });
    fireEvent.click(button);
    expect(button.textContent).toMatch(/Press keys/);
    // Modifiers alone do nothing yet.
    keyDown(button, "Control", "ControlLeft", { ctrlKey: true });
    expect(button.textContent).toMatch(/Press keys/);
    keyDown(button, "y", "KeyY", { ctrlKey: true, altKey: true });
    // Now it clashes with approve.
    expect(field("hotkeys.deny").querySelector(".warn")?.textContent).toMatch(/is also Approve/);
    await save();
    expect(api.save.mock.calls[0]![0]).toEqual([{ path: "hotkeys.deny", value: "Ctrl+Alt+Y" }]);
  });

  it("cancels with Esc, or when it loses focus", async () => {
    await setup();
    const button = within(field("hotkeys.deny")).getByRole("button", { name: "Ctrl+Alt+N" });
    fireEvent.click(button);
    keyDown(button, "Escape", "Escape");
    expect(button.textContent).toBe("Ctrl+Alt+N");
    fireEvent.click(button);
    fireEvent.blur(button);
    expect(button.textContent).toBe("Ctrl+Alt+N");
    // A key with no capture going on is the button's own.
    keyDown(button, "x", "KeyX", { ctrlKey: true, altKey: true });
    expect(button.textContent).toBe("Ctrl+Alt+N");
    expect(saveButton()).toHaveProperty("disabled", true);
  });

  it("adds and removes keys", async () => {
    const { api } = await setup();
    const f = field("hotkeys.cancel");
    fireEvent.click(within(f).getByRole("button", { name: "+ Add key" }));
    const capture = within(f).getByRole("button", { name: /Press keys/ });
    keyDown(capture, "F13", "F13");
    expect(within(f).getByRole("button", { name: "F13" })).toBeTruthy();
    // The same key twice is kept once.
    fireEvent.click(within(f).getByRole("button", { name: "+ Add key" }));
    keyDown(within(f).getByRole("button", { name: /Press keys/ }), "F13", "F13");
    api.snap.values.hotkeys.cancel = ["Ctrl+Alt+X", "F13"];
    await save();
    expect(api.save.mock.calls[0]![0]).toEqual([
      { path: "hotkeys.cancel", value: ["Ctrl+Alt+X", "F13"] },
    ]);
    await waitFor(() => expect(within(f).getByRole("button", { name: "F13" })).toBeTruthy());
    fireEvent.click(within(f).getByRole("button", { name: "+ Add key" }));
    fireEvent.blur(within(f).getByRole("button", { name: /Press keys/ }));
    fireEvent.click(within(f).getByRole("button", { name: "Remove Ctrl+Alt+X" }));
    expect(within(f).queryByRole("button", { name: /Remove/ })).toBeNull();
    await save();
    expect(api.save.mock.calls[1]![0]).toEqual([{ path: "hotkeys.cancel", value: "F13" }]);
  });

  it("takes a digit for the chip keys, and says so for any other key", async () => {
    const { api } = await setup();
    const f = field("hotkeys.copyChip");
    const button = within(f).getByRole("button", { name: "Ctrl+Alt+{n}" });
    fireEvent.click(button);
    keyDown(button, "x", "KeyX", { ctrlKey: true, shiftKey: true });
    expect(f.querySelector(".hint")?.textContent).toMatch(/press a digit/);
    keyDown(button, "Shift", "ShiftLeft", { ctrlKey: true, shiftKey: true });
    keyDown(button, "!", "Digit1", { ctrlKey: true, shiftKey: true });
    expect(f.querySelector(".hint")).toBeNull();
    await save();
    expect(api.save.mock.calls[0]![0]).toEqual([
      { path: "hotkeys.copyChip", value: "Ctrl+Shift+{n}" },
    ]);
  });
});
