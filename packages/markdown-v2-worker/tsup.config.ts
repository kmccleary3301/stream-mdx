import { join } from "node:path";
import { defineConfig } from "tsup";

const resolve = (p: string) => join(__dirname, p);

export default defineConfig({
  entry: [resolve("src/index.ts"), resolve("src/worker-client.ts"), resolve("src/streaming/custom-matcher.ts")],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  format: ["esm", "cjs"],
  outDir: join(__dirname, "dist"),
  target: "es2020",
  tsconfig: join(__dirname, "tsconfig.build.json"),
  external: [
    "@lezer/markdown",
    "@lezer/lr",
    "@stream-mdx/core",
    "@stream-mdx/plugins",
    "@stream-mdx/react",
    "@mdx-js/mdx",
    "@shikijs/engine-javascript",
    "@shikijs/engine-oniguruma",
    "character-entities",
    "rehype-slug",
    "remark-gfm",
    "remark-math",
    "shiki",
  ],
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".mjs",
    };
  },
});
