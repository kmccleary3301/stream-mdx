import { join } from "node:path";
import { defineConfig } from "tsup";

const resolve = (path: string) => join(__dirname, path);
const sourcemap = process.env.SOURCEMAP === "1" || process.env.SOURCEMAP === "true";

export default defineConfig({
  entry: { index: resolve("src/index.ts") },
  dts: true,
  sourcemap,
  splitting: false,
  clean: true,
  minifySyntax: true,
  format: ["esm", "cjs"],
  outDir: join(__dirname, "dist"),
  target: "es2020",
  platform: "browser",
  tsconfig: resolve("tsconfig.build.json"),
  noExternal: ["esbuild-wasm"],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".mjs",
    };
  },
});
