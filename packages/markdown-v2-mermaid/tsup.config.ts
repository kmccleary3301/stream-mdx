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
  external: ["react", "react-dom", "mermaid"],
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".mjs",
    };
  },
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});

