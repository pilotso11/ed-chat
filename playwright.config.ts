import { defineConfig } from "@playwright/test";

// Launches the built app (npm run build first: npm run test:e2e does both).
export default defineConfig({
  testDir: "e2e",
  // Refuses to start while Elite is running (see e2e/global-setup.ts).
  globalSetup: "./e2e/global-setup.ts",
  // One app at a time: each run owns global hotkeys and its windows.
  workers: 1,
  // A test.only left in must not shrink CI to one test.
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
});
