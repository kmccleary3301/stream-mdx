import { join } from "node:path";
import { defineConfig } from "tsup";

const resolve = (value: string) => join(__dirname, value);

const entries = [
  "src/index.ts",
  "src/plugins/registry.ts",
  "src/plugins/base.ts",
  "src/plugins/document.ts",
  "src/plugins/callouts/index.ts",
  "src/plugins/footnotes/index.ts",
  "src/plugins/html/index.ts",
  "src/plugins/math/index.ts",
  "src/plugins/math/renderer.tsx",
  "src/plugins/math/streaming.ts",
  "src/plugins/math/streaming-v2.ts",
  "src/plugins/math/tokenizer.ts",
  "src/plugins/mdx/index.ts",
  "src/plugins/tables/index.ts",
].map((entry) => resolve(entry));

export default defineConfig({
  entry: entries,
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  format: ["esm", "cjs"],
  outDir: join(__dirname, "dist"),
  target: "es2020",
  tsconfig: join(__dirname, "tsconfig.build.json"),
  external: ["react", "react-dom", "@stream-mdx/core", "@stream-mdx/react"],
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".mjs",
    };
  },
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
