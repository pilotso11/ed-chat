import { configDefaults, defineConfig } from "vitest/config";

const WELL_TESTED = { lines: 90, statements: 90, functions: 90, branches: 85 };

export default defineConfig({
  test: {
    testTimeout: 10_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "test/renderer/**"],
        },
      },
      {
        extends: true,
        test: {
          // The React components, in jsdom, with cleanup between tests and what jsdom lacks.
          name: "renderer",
          include: ["test/renderer/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["test/renderer/setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // The renderer entries only mount a component into the page.
      exclude: ["src/renderer/main.tsx", "src/renderer/hud.tsx", "src/renderer/settings.tsx"],
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
