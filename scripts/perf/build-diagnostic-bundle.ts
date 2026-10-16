import { build, type Plugin } from "esbuild";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../..");
const outDir = join(scriptDir, "diagnostic-dist");

mkdirSync(outDir, { recursive: true });

function resolveSourceFile(baseDir: string, subpath?: string): string | null {
  const target = subpath ? join(baseDir, subpath) : join(baseDir, "index");
  const candidates = [
    `${target}.ts`,
    `${target}.tsx`,
    join(target, "index.ts"),
    join(target, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const sourceAliasPlugin: Plugin = {
  name: "stream-mdx-source-alias",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@stream-mdx\// }, (args) => {
      const specifier = args.path;
      const parts = specifier.split("/");
      const pkg = parts[1];
      const subpath = parts.slice(2).join("/");

      let pkgDir: string | undefined;
      switch (pkg) {
        case "core":
          pkgDir = join(root, "packages/markdown-v2-core/src");
          break;
        case "worker":
          pkgDir = join(root, "packages/markdown-v2-worker/src");
          break;
        case "react":
          pkgDir = join(root, "packages/markdown-v2-react/src");
          break;
        case "plugins":
          pkgDir = join(root, "packages/markdown-v2-plugins/src");
          break;
        default:
          return null;
      }

      const resolved = resolveSourceFile(pkgDir, subpath);
      if (resolved) {
        return { path: resolved };
      }
      return null;
    });
  },
};

async function buildDiagnosticBundle(): Promise<void> {
  await build({
    entryPoints: [join(scriptDir, "diagnostic-bundle-entry.ts")],
    outfile: join(outDir, "index.mjs"),
    bundle: true,
    format: "esm",
    target: "es2020",
    platform: "node",
    sourcemap: true,
    define: {
      __STREAM_MDX_COUNTERS__: "true",
      "process.env.NODE_ENV": '"development"',
    },
    plugins: [sourceAliasPlugin],
    external: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "shiki",
      "@shikijs/engine-javascript",
      "@shikijs/engine-oniguruma",
      "@lezer/markdown",
      "@lezer/common",
      "@lezer/lr",
      "jsdom",
      "katex",
    ],
    loader: {
      ".ts": "ts",
      ".tsx": "tsx",
    },
    jsx: "automatic",
  });
  writeFileSync(join(outDir, "index.d.mts"), 'export * from "../diagnostic-bundle-entry";\n', "utf8");
  console.log(`Diagnostic bundle successfully built at: ${join(outDir, "index.mjs")}`);
}

buildDiagnosticBundle().catch((error) => {
  console.error("Diagnostic bundle build failed:", error);
  process.exit(1);
});
