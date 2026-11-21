import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text-summary", "json-summary", "html"],
      // The Electron main process and the renderer run only in Electron; the Playwright tests in
      // e2e/ cover them. The logic in src/core must stay well tested.
      thresholds: {
        "src/core/**": { lines: 90, statements: 90, functions: 90, branches: 85 },
      },
    },
  },
});
