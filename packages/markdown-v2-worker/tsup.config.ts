import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Options } from "tsup";
import { defineConfig } from "tsup";

import { applyWorkerRealmAliases, assertWorkerRealmBoundary, workerMdxBundlePackages } from "./tsup.worker-realm";

const resolve = (p: string) => join(__dirname, p);
const sourcemap = process.env.SOURCEMAP === "1" || process.env.SOURCEMAP === "true";

const sharedConfig: Options = {
  dts: true,
  splitting: false,
  sourcemap,
  clean: false,
  format: ["esm", "cjs"],
  outDir: resolve("dist"),
  target: "es2020",
  tsconfig: resolve("tsconfig.build.json"),
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
};

export default defineConfig(async () => {
  // Configurations and their DTS tasks run concurrently. Clean once before any
  // build starts so neither platform can remove the other platform's outputs.
  await rm(resolve("dist"), { recursive: true, force: true });

  return [
    {
      ...sharedConfig,
      entry: [
        resolve("src/index.ts"),
        resolve("src/direct.ts"),
        resolve("src/worker-client.ts"),
        resolve("src/mdx-compile.ts"),
      ],
      // These public entries are also imported by browser clients. Resolve the
      // MDX pipeline's actual browser variants, not vfile's Node builtins.
      platform: "browser",
      noExternal: workerMdxBundlePackages,
      esbuildOptions(options) {
        applyWorkerRealmAliases(options);
      },
      async onSuccess() {
        await assertWorkerRealmBoundary(
          ["index", "direct", "mdx-compile"].flatMap((entry) => ["mjs", "cjs"].map((extension) => resolve(`dist/${entry}.${extension}`))),
        );
      },
    },
    {
      ...sharedConfig,
      entry: {
        "node/index": resolve("src/node/index.ts"),
        "node/worker-thread-entry": resolve("src/node/worker-thread-entry.ts"),
      },
      platform: "node",
    },
    // The public engine entry is built afterward by tsup.worker-engine.config.ts
    // with the same browser-safe MDX pipeline and without cleaning this output.
  ];
});
