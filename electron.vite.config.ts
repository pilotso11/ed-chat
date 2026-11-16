import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: resolve("src/main/index.ts") },
      // ed-mcp/journal is one self-contained file: bundled, so the installer needs no ed-mcp.
      externalizeDeps: { exclude: ["ed-mcp"] },
    },
  },
  preload: {
    // Sandboxed preload scripts must be CommonJS.
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          hud: resolve("src/renderer/hud.html"),
        },
      },
    },
  },
});
