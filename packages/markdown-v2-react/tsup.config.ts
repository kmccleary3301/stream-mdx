import { join } from "node:path";
import { defineConfig } from "tsup";

const resolve = (p: string) => join(__dirname, p);
const sourcemap = process.env.SOURCEMAP === "1" || process.env.SOURCEMAP === "true";

const entries = [
  "src/index.ts",
  "src/streaming-markdown.tsx",
  "src/renderer.tsx",
  "src/renderer/hooks.ts",
  "src/renderer/patch-commit-scheduler.ts",
  "src/renderer/patch-batching.ts",
  "src/renderer/patch-coalescing.ts",
  "src/renderer/store.ts",
  "src/renderer/node-views.tsx",
  "src/renderer/virtualized-code.tsx",
  "src/components/index.ts",
  "src/components/bottom-stick-scroll-area.tsx",
  "src/mdx-client.ts",
  "src/mdx-coordinator.ts",
  "src/utils/inline-html.ts",
  "src/math/display-wrapper.tsx",
  "src/contexts/math-tracker.ts",
].map(resolve);

export default defineConfig({
  entry: entries,
  dts: true,
  sourcemap,
  splitting: false,
  clean: true,
  banner: {
    js: '"use client";',
  },
  format: ["esm", "cjs"],
  outDir: join(__dirname, "dist"),
  target: "es2020",
  tsconfig: join(__dirname, "tsconfig.build.json"),
  external: ["react", "react-dom", "@stream-mdx/core", "@stream-mdx/worker"],
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".mjs",
    };
  },
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
