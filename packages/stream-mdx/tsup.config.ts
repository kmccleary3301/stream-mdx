import { join } from "node:path";
import { defineConfig } from "tsup";

const resolve = (p: string) => join(__dirname, p);
const sourcemap = process.env.SOURCEMAP === "1" || process.env.SOURCEMAP === "true";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/core.ts",
    "src/react.ts",
    "src/worker.ts",
    "src/worker/mdx-compile.ts",
    "src/plugins.ts",
    "src/plugins/base.ts",
    "src/plugins/callouts.ts",
    "src/plugins/document.ts",
    "src/plugins/footnotes.ts",
    "src/plugins/html.ts",
    "src/plugins/math.ts",
    "src/plugins/math/renderer.ts",
    "src/plugins/mdx.ts",
    "src/plugins/registry.ts",
    "src/plugins/tables.ts",
  ].map(resolve),
  dts: true,
  sourcemap,
  splitting: false,
  clean: true,
  format: ["esm", "cjs"],
  outDir: join(__dirname, "dist"),
  target: "es2020",
  tsconfig: join(__dirname, "tsconfig.build.json"),
  external: [
    "react",
    "react-dom",
    "@stream-mdx/core",
    "@stream-mdx/core/*",
    "@stream-mdx/react",
    "@stream-mdx/react/*",
    "@stream-mdx/worker",
    "@stream-mdx/worker/*",
    "@stream-mdx/plugins",
    "@stream-mdx/plugins/*",
  ],
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".mjs",
    };
  },
});
