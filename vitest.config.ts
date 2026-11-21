import { defineConfig } from "vitest/config";

const WELL_TESTED = { lines: 90, statements: 90, functions: 90, branches: 85 };

export default defineConfig({
  test: {
    // Renderer tests (.tsx) run in jsdom, set per file.
    include: ["test/**/*.test.{ts,tsx}"],
    // For the renderer tests: cleanup between tests, and what jsdom lacks.
    setupFiles: ["test/renderer/setup.ts"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // The renderer entries only mount a component into the page.
      exclude: ["src/renderer/main.tsx", "src/renderer/hud.tsx"],
      reporter: ["text-summary", "json-summary", "html"],
      // The Electron main process runs only in Electron; the Playwright tests in e2e/ cover it.
      // The logic in src/core and the React components (test/renderer) must stay well tested.
      thresholds: {
        "src/core/**": WELL_TESTED,
        "src/renderer/**": WELL_TESTED,
      },
    },
  },
});
