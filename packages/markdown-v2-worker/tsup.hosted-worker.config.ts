import { join } from "node:path";
import { defineConfig } from "tsup";

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
  outExtension() {
    return { js: ".js" };
  },
});


