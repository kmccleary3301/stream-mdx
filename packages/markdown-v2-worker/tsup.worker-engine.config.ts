import { join } from "node:path";
import { defineConfig } from "tsup";

import { applyWorkerRealmAliases, assertWorkerRealmBoundary, workerMdxBundlePackages } from "./tsup.worker-realm";

const sourcemap = process.env.SOURCEMAP === "1" || process.env.SOURCEMAP === "true";

/**
 * Build for the public worker entry (`@stream-mdx/worker/engine`).
 *
 * This entry runs inside a real Worker realm and is re-bundled by consumers
 * with browser-targeted tooling (docs/PLUGIN_ABI.md, "Custom bundled worker
 * entry"). The MDX compile pipeline is bundled here with
 * `decode-named-character-reference` aliased to the package's DOM-free owner,
 * so consumer bundlers can never elect the upstream DOM decoder for a worker
 * without a `document`. Everything else stays external. `npm run build` runs
 * this config after `tsup.config.ts`, which no longer builds this entry.
 */
export default defineConfig({
  entry: {
    "engine/index": join(__dirname, "src/engine/index.ts"),
  },
  dts: true,
  splitting: false,
  sourcemap,
  clean: false,
  minifySyntax: true,
  format: ["esm", "cjs"],
  outDir: join(__dirname, "dist"),
  target: "es2020",
  platform: "browser",
  tsconfig: join(__dirname, "tsconfig.build.json"),
  define: {
    __STREAM_MDX_COUNTERS__: "false",
  },
  noExternal: workerMdxBundlePackages,
  esbuildOptions(options) {
    applyWorkerRealmAliases(options);
  },
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".mjs",
    };
  },
  async onSuccess() {
    await assertWorkerRealmBoundary([join(__dirname, "dist/engine/index.mjs"), join(__dirname, "dist/engine/index.cjs")]);
  },
});
