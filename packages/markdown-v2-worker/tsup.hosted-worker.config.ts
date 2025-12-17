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
  // NOTE: Do not externalize deps; this must be a self-contained file for static hosting.
  external: [],
  outExtension() {
    return { js: ".js" };
  },
});


