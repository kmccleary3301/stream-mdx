import { join } from "node:path";
import { defineConfig } from "tsup";

const resolve = (p: string) => join(__dirname, p);
const sourcemap = process.env.SOURCEMAP === "1" || process.env.SOURCEMAP === "true";

export default defineConfig({
  entry: [resolve("src/index.ts")],
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
  external: ["react", "react-dom", "react/jsx-runtime", "@stream-mdx/core", "@stream-mdx/react"],
  // Bundle the ESM-only pipeline and its transitive imports for the advertised CJS entry.
  noExternal: [
    "unified",
    "remark-parse",
    "remark-gfm",
    "remark-math",
    "remark-rehype",
    "hast-util-to-jsx-runtime",
  ],
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".mjs",
    };
  },
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
