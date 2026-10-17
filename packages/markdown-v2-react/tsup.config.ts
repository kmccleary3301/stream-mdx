import { join } from "node:path";
import { defineConfig } from "tsup";

const resolve = (p: string) => join(__dirname, p);
const sourcemap = process.env.SOURCEMAP === "1" || process.env.SOURCEMAP === "true";

const clientEntries = [
  "src/index.ts",
  "src/streaming-markdown.tsx",
  "src/renderer.tsx",
  "src/renderer/hooks.ts",
  "src/renderer/patch-commit-scheduler.ts",
  "src/renderer/patch-batching.ts",
  "src/renderer/patch-coalescing.ts",
  "src/renderer/store.ts",
  "src/renderer/virtualized-code.tsx",
  "src/components/index.ts",
  "src/components/bottom-stick-scroll-area.tsx",
  "src/components/diff-renderer.tsx",
  "src/components/katex-math.tsx",
  "src/utils/inline-html.ts",
  "src/math/display-wrapper.tsx",
  "src/contexts/math-tracker.ts",
  "src/trusted-mdx/index.ts",
  "src/trusted-mdx/native-children-slot.tsx",
].map(resolve);

const serverEntries = [resolve("src/server.tsx"), resolve("src/trusted-mdx/server.tsx")];

const sharedConfig = {
  dts: false,
  sourcemap,
  splitting: false,
  format: ["esm", "cjs"],
  outDir: join(__dirname, "dist"),
  target: "es2020",
  tsconfig: join(__dirname, "tsconfig.build.json"),
  external: [
    "react",
    "react-dom",
    "@stream-mdx/core",
    "@stream-mdx/worker",
    "@stream-mdx/react/_internal/trusted-mdx-native-children",
    "katex",
  ],
  outExtension({ format }: { format: "cjs" | "esm" }) {
    return {
      js: format === "cjs" ? ".cjs" : ".mjs",
    };
  },
  esbuildOptions(options: { jsx?: string }) {
    options.jsx = "automatic";
  },
};

export default defineConfig([
  {
    ...sharedConfig,
    entry: clientEntries,
    // One declaration writer owns the shared output directory for both realms.
    dts: { entry: [...clientEntries, ...serverEntries] },
    banner: {
      js: '"use client";',
    },
  },
  {
    ...sharedConfig,
    entry: serverEntries,
  },
]);
