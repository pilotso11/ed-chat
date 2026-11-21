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
  // PATH holds no other assistant, so there is no notice about one. The app looks for Codex
  // before it starts Claude, so by "idle" above any such notice would already show.
  await expect(t.chat.locator(".notices")).not.toContainText("Codex");
});

test("sends a message to Claude and shows the reply", async () => {
  t = await launch({ fixture: "recorded-text.jsonl" });
  // The session starts once the CLI's version is checked; until then a message is refused.
  await expect.poll(() => t!.chat.evaluate(() => window.overlay.send("what is 2 + 2?"))).toBe(true);
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
