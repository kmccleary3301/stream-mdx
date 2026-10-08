import { join } from "node:path";
import { defineConfig } from "tsup";

const resolve = (p: string) => join(__dirname, p);
const sourcemap = process.env.SOURCEMAP === "1" || process.env.SOURCEMAP === "true";

const sharedConfig = {
  entry: [resolve("src/index.ts")],
  dts: true,
  sourcemap,
  splitting: false,
  banner: {
    js: '"use client";',
  },
  outDir: join(__dirname, "dist"),
  target: "es2020",
  tsconfig: join(__dirname, "tsconfig.build.json"),
  external: ["react", "react-dom", "react/jsx-runtime", "@stream-mdx/core", "@stream-mdx/react"],
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
    format: ["esm"],
    clean: true,
    // Let browser consumers resolve the dependencies' browser export conditions.
  },
  {
    ...sharedConfig,
    format: ["cjs"],
    // Bundle the ESM-only pipeline and its transitive imports for the advertised CJS entry.
    noExternal: [
      "unified",
      "remark-parse",
      "remark-gfm",
      "remark-math",
      "remark-rehype",
      "hast-util-to-jsx-runtime",
    ],
  },
]);
