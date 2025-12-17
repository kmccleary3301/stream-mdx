import { join } from "node:path";
import { defineConfig } from "tsup";

const resolve = (p: string) => join(__dirname, p);
const sourcemap = process.env.SOURCEMAP === "1" || process.env.SOURCEMAP === "true";

const entries = [
  "src/index.ts",
  "src/types.ts",
  "src/utils.ts",
  "src/code-highlighting.ts",
  "src/inline-parser.ts",
  "src/mixed-content.ts",
  "src/worker-html-sanitizer.ts",
  "src/perf/backpressure.ts",
  "src/perf/patch-batching.ts",
  "src/perf/patch-coalescing.ts",
  "src/security.ts",
  "src/streaming/custom-matcher.ts",
  "src/streaming/inline-streaming.ts",
].map(resolve);

export default defineConfig({
  entry: entries,
  dts: true,
  splitting: false,
  sourcemap,
  clean: true,
  format: ["esm", "cjs"],
  outDir: join(__dirname, "dist"),
  target: "es2020",
  tsconfig: join(__dirname, "tsconfig.build.json"),
  external: ["@lezer/markdown", "dompurify", "rehype-parse", "rehype-sanitize", "rehype-stringify", "unified"],
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".mjs",
    };
  },
});
