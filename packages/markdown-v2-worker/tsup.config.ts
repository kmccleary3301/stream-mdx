import { join } from "node:path";
import { defineConfig } from "tsup";

import { applyWorkerRealmAliases, assertWorkerRealmBoundary, workerMdxBundlePackages } from "./tsup.worker-realm";

const resolve = (p: string) => join(__dirname, p);
const sourcemap = process.env.SOURCEMAP === "1" || process.env.SOURCEMAP === "true";

export default defineConfig({
  entry: [
    resolve("src/index.ts"),
    resolve("src/direct.ts"),
    resolve("src/worker-client.ts"),
    resolve("src/mdx-compile.ts"),
    resolve("src/streaming/custom-matcher.ts"),
    resolve("src/node/index.ts"),
    resolve("src/node/worker-thread-entry.ts"),
    // `src/engine/index.ts` (the public worker entry) is built by
    // `tsup.worker-engine.config.ts`, which bundles the MDX pipeline with the
    // DOM-free decoder for the worker realm.
  ],
  dts: true,
  splitting: false,
  sourcemap,
  clean: true,
  format: ["esm", "cjs"],
  outDir: join(__dirname, "dist"),
  target: "es2020",
  tsconfig: join(__dirname, "tsconfig.build.json"),
  // Direct and MDX helper entries need the same DOM-free, ESM-only pipeline
  // as the public engine, including when consumers load their CJS builds.
  noExternal: workerMdxBundlePackages,
  esbuildOptions(options) {
    applyWorkerRealmAliases(options);
  },
  external: [
    "@lezer/markdown",
    "@lezer/lr",
    "@stream-mdx/core",
    "@stream-mdx/plugins",
    "@stream-mdx/react",
    "@shikijs/engine-javascript",
    "@shikijs/engine-oniguruma",
    "character-entities",
    "shiki",
  ],
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".mjs",
    };
  },
  async onSuccess() {
    await assertWorkerRealmBoundary(
      ["index", "direct", "mdx-compile"].flatMap((entry) => ["mjs", "cjs"].map((extension) => resolve(`dist/${entry}.${extension}`))),
    );
  },
});
