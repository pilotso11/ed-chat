import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launch, type TestApp } from "./app.js";

// The built app in Electron, with a fake Claude CLI and temporary folders (see app.ts).

let t: TestApp | undefined;
test.afterEach(async () => {
  await t?.close();
  t = undefined;
});

test("starts with the status strip and the first-run hotkeys card", async () => {
  t = await launch();
  await expect(t.chat.locator(".strip .state")).toContainText("idle");
  await expect(t.chat.locator(".keys-card .title")).toHaveText("ED Chat hotkeys");
  // The test's settings.json is read: Claude runs in auto mode.
  await expect(t.chat.locator(".strip .badge")).toHaveText("AUTO");
  await expect(t.chat.locator(".strip .badge")).toHaveAttribute(
    "title",
    "Claude runs most tools without asking",
  );
});

test("sends a message to Claude and shows the reply", async () => {
  t = await launch({ fixture: "recorded-text.jsonl" });
  // Idle once startup finishes (startAgent): main listens for sends, and the session exists.
  // Sent before then, the send is refused, or fails with no handler registered: main opens the
  // window before it awaits the agent configs and the approval server, then registers handlers.
  await expect(t.chat.locator(".strip .state")).toContainText("idle");
  expect(await t.chat.evaluate(() => window.overlay.send("what is 2 + 2?"))).toBe(true);
  // The reply shows on the strip, under the status line.
  await expect(t.chat.locator("#root")).toContainText("2 + 2 = 4");
});

// A few minutes ago, so ed-mcp reads the journal as current.
const start = Date.now() - 5 * 60_000;
let n = 0;
const ev = (event: string, extra: Record<string, unknown> = {}) => ({
  timestamp: new Date(start + n++ * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
  event,
  ...extra,
});
const SYSTEM = "Test Sector AB-C d1";
const ADDRESS = 123456789;

test("shows the activity panel for a body being sampled", async () => {
  const organic = (type: string) =>
    ev("ScanOrganic", {
      ScanType: type,
      Genus: "$Codex_Ent_Stratum_Genus_Name;",
      Genus_Localised: "Stratum",
      Species: "$Codex_Ent_Stratum_07_Name;",
      Species_Localised: "Stratum Tectonicas",
      SystemAddress: ADDRESS,
      Body: 3,
    });
  t = await launch({
    journal: [
      ev("Fileheader", { part: 1, gameversion: "4.0.0.1", build: "r1" }),
      ev("LoadGame", { Commander: "Tester", Ship: "anaconda", ShipID: 1, Credits: 1000 }),
      ev("FSDJump", { StarSystem: SYSTEM, SystemAddress: ADDRESS, StarPos: [100, 0, 100] }),
      ev("Scan", {
        ScanType: "Detailed",
        BodyName: `${SYSTEM} 3`,
        BodyID: 3,
        StarSystem: SYSTEM,
        SystemAddress: ADDRESS,
        PlanetClass: "Rocky body",
        Landable: true,
        WasDiscovered: true,
        WasFootfalled: false,
      }),
      organic("Log"),
      organic("Sample"),
    ],
  });
  await expect(t.hud.locator(".panel .title")).toHaveText("EXOBIOLOGY");
  await expect(t.hud.locator(".panel .row").first()).toContainText("Stratum Tectonicas");
  await expect(t.hud.locator(".panel .row").first()).toContainText("2/3");
});

test("survives the Claude version check answering after the windows are gone", async () => {
  // Quitting closes the windows first; a CLI answering in between must not draw to them. The
  // fake holds its answer until the windows are destroyed, with the app still running, so the
  // late answer always lands. close() fails on any main-process error, such as drawing to a
  // destroyed window.
  t = await launch({ holdVersion: true });
  // A closed window quits the app; the quit is held open here, as a slow quit is, so the late
  // answer arrives while the app is still running with its windows gone.
  await t.app.evaluate(({ app, BrowserWindow }) => {
    const g = globalThis as { holdQuit?: boolean };
    g.holdQuit = true;
    app.on("before-quit", (e) => {
      if (g.holdQuit) e.preventDefault();
    });
    app.on("window-all-closed", () => {});
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await t.releaseVersion();
  await t.app.evaluate(() => {
    (globalThis as { holdQuit?: boolean }).holdQuit = false;
  });
});

for (const which of ["chat", "panel"] as const) {
  test(`quits when the ${which} window is closed`, async () => {
    // A process left running with one window would have no tray icon and no hotkeys.
    t = await launch();
    const page = which === "chat" ? "/index.html" : "/hud.html";
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) =>
      t!.app.process().once("exit", (code, signal) => r({ code, signal })),
    );
    await t.app.evaluate(({ BrowserWindow }, page) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith(page));
      if (!w) throw new Error(`no window for ${page}`);
      // After this call returns: the app quits, and Playwright cannot finish a call to a gone app.
      setTimeout(() => w.close(), 0);
    }, page);
    let timer: NodeJS.Timeout | undefined;
    const stillRunning = new Promise<never>((_r, reject) => {
      timer = setTimeout(
        () => reject(new Error("the app kept running with a window closed")),
        15_000,
      );
    });
    try {
      // A clean quit, not a crash.
      expect(await Promise.race([exited, stillRunning])).toEqual({ code: 0, signal: null });
    } finally {
      clearTimeout(timer);
    }
  });
}

for (const command of ["/quit", "/exit"]) {
  test(`quits on ${command} typed in the chat`, async () => {
    t = await launch();
    // Started, so main is listening for the chat's sends.
    await expect(t.chat.locator(".strip .state")).toContainText("idle");
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) =>
      t!.app.process().once("exit", (code, signal) => r({ code, signal })),
    );
    // As the chat's submit sends typed text. After this call returns, as for a closed window: the
    // app quits, and Playwright cannot finish a call to a gone app.
    await t.chat.evaluate((c) => {
      setTimeout(() => void window.overlay.send(c), 0);
    }, command);
    let timer: NodeJS.Timeout | undefined;
    const stillRunning = new Promise<never>((_r, reject) => {
      timer = setTimeout(() => reject(new Error(`the app kept running after ${command}`)), 15_000);
    });
    try {
      expect(await Promise.race([exited, stillRunning])).toEqual({ code: 0, signal: null });
    } finally {
      clearTimeout(timer);
    }
  });
}

test("/settings opens the settings window, which saves only the changed value", async () => {
  t = await launch();
  await expect(t.chat.locator(".strip .state")).toContainText("idle");
  expect(await t.chat.evaluate(() => window.overlay.send("/settings"))).toBe(true);
  const settings = await t.page("/settings.html");
  await settings.waitForLoadState();
  await expect(settings.locator("h2").first()).toHaveText("General");
  const strong = () =>
    t!.chat.evaluate(() =>
      document.querySelector<HTMLElement>(".overlay")!.style.getPropertyValue("--strong-rgb"),
    );
  const before = await strong();
  const theme = settings.locator('[data-path="style.theme"] select');
  await theme.selectOption("blue");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.locator(".banner")).toContainText("Saved");
  const file = JSON.parse(await readFile(path.join(t.dataDir, "settings.json"), "utf8")) as Record<
    string,
    unknown
  >;
  // The new value, and the test's own values kept; no default written.
  expect(file.style).toEqual({ theme: "blue" });
  expect((file.claude as Record<string, unknown>).permissionMode).toBe("auto");
  expect(file.strip).toBeUndefined();
  // The overlay uses it at once, with no restart: its colour changes.
  await expect.poll(strong).not.toBe(before);
  if (process.env.SETTINGS_SHOT) await settings.screenshot({ path: process.env.SETTINGS_SHOT });
});
