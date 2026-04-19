import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    emptyOutDir: true,
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      input: {
        background: resolve(rootDir, "src/background/index.ts"),
        category: resolve(rootDir, "category.html"),
        content: resolve(rootDir, "src/content/index.ts"),
        dashboard: resolve(rootDir, "dashboard.html"),
        note: resolve(rootDir, "note.html"),
        options: resolve(rootDir, "options.html"),
        piles: resolve(rootDir, "piles.html"),
        prompts: resolve(rootDir, "prompts.html"),
        popup: resolve(rootDir, "popup.html")
      },
      output: {
        assetFileNames: "assets/[name][extname]",
        chunkFileNames: "assets/[name].js",
        entryFileNames: "assets/[name].js"
      }
    }
  }
});
