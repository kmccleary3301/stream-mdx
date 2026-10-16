import { build, type Plugin } from "esbuild";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyWorkerRealmAliases } from "../../packages/markdown-v2-worker/tsup.worker-realm";

const scriptDir = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../..");
const outputDir = join(root, "apps/docs/out/stream-mdx-progress-observation");

mkdirSync(outputDir, { recursive: true });

function resolveSourceFile(baseDir: string, subpath?: string): string | null {
  const target = subpath ? join(baseDir, subpath) : join(baseDir, "index");
  const candidates = [`${target}.ts`, `${target}.tsx`, join(target, "index.ts"), join(target, "index.tsx")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const sourceAliasPlugin: Plugin = {
  name: "stream-mdx-progress-observation-source-alias",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@stream-mdx\// }, (args) => {
      const [_, packageName, ...subpathParts] = args.path.split("/");
      const subpath = subpathParts.join("/");
      const packageDirs: Record<string, string> = {
        core: join(root, "packages/markdown-v2-core/src"),
        plugins: join(root, "packages/markdown-v2-plugins/src"),
        react: join(root, "packages/markdown-v2-react/src"),
        worker: join(root, "packages/markdown-v2-worker/src"),
      };
      const packageDir = packageDirs[packageName ?? ""];
      if (!packageDir) return null;
      const resolved = resolveSourceFile(packageDir, subpath || undefined);
      return resolved ? { path: resolved } : null;
    });
  },
};

const workerRealmAliases: { alias?: Record<string, string> } = {};
applyWorkerRealmAliases(workerRealmAliases);

async function buildProgressObservationAssets(): Promise<void> {
  await build({
    entryPoints: [join(scriptDir, "progress-observation-worker.ts")],
    outfile: join(outputDir, "worker.js"),
    bundle: true,
    format: "esm",
    target: "es2020",
    platform: "browser",
    sourcemap: false,
    jsx: "automatic",
    plugins: [sourceAliasPlugin],
    alias: workerRealmAliases.alias,
    define: {
      __STREAM_MDX_COUNTERS__: "true",
      "process.env.NODE_ENV": '"production"',
    },
  });

  await build({
    entryPoints: [join(scriptDir, "progress-observation-browser.ts")],
    outfile: join(outputDir, "browser.js"),
    bundle: true,
    format: "esm",
    target: "es2020",
    platform: "browser",
    sourcemap: false,
    jsx: "automatic",
    plugins: [sourceAliasPlugin],
    define: {
      __STREAM_MDX_COUNTERS__: "false",
      "process.env.NODE_ENV": '"production"',
    },
  });

  copyFileSync(join(scriptDir, "progress-observation-static/index.html"), join(outputDir, "index.html"));
  console.log(`Progress observation assets built in ${outputDir}`);
}

buildProgressObservationAssets().catch((error: unknown) => {
  console.error("Progress observation asset build failed:", error);
  process.exitCode = 1;
});
