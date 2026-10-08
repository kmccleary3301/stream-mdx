import { join } from "node:path";
import { defineConfig } from "tsup";

import { applyWorkerRealmAliases, assertWorkerRealmBoundary } from "./tsup.worker-realm";

const sourcemap = process.env.SOURCEMAP === "1" || process.env.SOURCEMAP === "true";

export default defineConfig({
  entry: {
    "markdown-worker": join(__dirname, "src/worker.ts"),
  },
  format: ["esm"],
  platform: "browser",
  target: "es2020",
  splitting: false,
  sourcemap,
  dts: false,
  minify: false,
  clean: true,
  outDir: join(__dirname, "dist/hosted"),
  // NOTE: This must be a single self-contained file for static hosting (no bare
  // module specifiers like `import "character-entities"`).
  noExternal: [/.*/],
  external: [],
  esbuildOptions(options) {
    applyWorkerRealmAliases(options);
  },
  outExtension() {
    return { js: ".js" };
  },
  async onSuccess() {
    await assertWorkerRealmBoundary([join(__dirname, "dist/hosted/markdown-worker.js")]);
  },
});


