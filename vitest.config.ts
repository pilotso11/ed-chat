import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Renderer tests (.tsx) run in jsdom, set per file.
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text-summary", "json-summary", "html"],
      // The Electron main process runs only in Electron; the Playwright tests in e2e/ cover it.
      // The logic in src/core and the React components (test/renderer) must stay well tested.
      thresholds: {
        "src/core/**": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/renderer/{App,HudPanel}.tsx": {
          lines: 90,
          statements: 90,
          functions: 90,
          branches: 85,
        },
      },
    },
  },
});
