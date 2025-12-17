import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function run(command: string, args: string[], options: { cwd: string }) {
  execFileSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_loglevel: process.env.npm_config_loglevel ?? "warn",
    },
  });
}

function findSinglePack(packsDir: string, predicate: (name: string) => boolean): string {
  const matches = fs
    .readdirSync(packsDir)
    .filter((name) => name.endsWith(".tgz"))
    .filter((name) => predicate(name));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly 1 pack match, found ${matches.length}: ${matches.join(", ")}`);
  }
  return path.join(packsDir, matches[0]);
}

function copyDir(src: string, dest: string) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (entry) => {
      const base = path.basename(entry);
      return base !== "node_modules" && base !== ".next" && base !== "dist" && base !== ".turbo";
    },
  });
}

function rewriteNextPackageJson(options: {
  pkgPath: string;
  streamMdxTarball: string;
  scopedTarballs: Record<string, string>;
}) {
  const raw = fs.readFileSync(options.pkgPath, "utf8");
  const parsed = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };

  parsed.dependencies = parsed.dependencies ?? {};
  parsed.dependencies["stream-mdx"] = `file:${options.streamMdxTarball}`;
  delete parsed.dependencies["@stream-mdx/core"];
  delete parsed.dependencies["@stream-mdx/plugins"];
  delete parsed.dependencies["@stream-mdx/worker"];
  delete parsed.dependencies["@stream-mdx/react"];

  parsed.overrides = parsed.overrides ?? {};
  for (const [name, tarball] of Object.entries(options.scopedTarballs)) {
    parsed.overrides[name] = `file:${tarball}`;
  }

  fs.writeFileSync(options.pkgPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeViteSmokeApp(options: {
  viteDir: string;
  streamMdxTarball: string;
  scopedTarballs: Record<string, string>;
}) {
  fs.mkdirSync(options.viteDir, { recursive: true });
  fs.mkdirSync(path.join(options.viteDir, "src"), { recursive: true });

  writeJson(path.join(options.viteDir, "package.json"), {
    name: "stream-mdx-vite-smoke",
    private: true,
    type: "module",
    scripts: {
      build: "vite build",
    },
    dependencies: {
      react: "18.3.1",
      "react-dom": "18.3.1",
      "stream-mdx": `file:${options.streamMdxTarball}`,
    },
    devDependencies: {
      "@types/node": "^22.10.2",
      "@types/react": "^18.3.12",
      "@types/react-dom": "^18.3.1",
      "@vitejs/plugin-react": "4.3.4",
      typescript: "^5.7.2",
      vite: "6.0.5",
    },
    overrides: Object.fromEntries(Object.entries(options.scopedTarballs).map(([name, tarball]) => [name, `file:${tarball}`])),
  });

  writeJson(path.join(options.viteDir, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2020",
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "Bundler",
      jsx: "react-jsx",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: ["node"],
    },
    include: ["src"],
  });

  fs.writeFileSync(
    path.join(options.viteDir, "vite.config.ts"),
    `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`,
  );

  fs.writeFileSync(
    path.join(options.viteDir, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>stream-mdx vite smoke</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  );

  fs.writeFileSync(
    path.join(options.viteDir, "src/main.tsx"),
    `import React from "react";
import ReactDOM from "react-dom/client";
import { StreamingMarkdown } from "stream-mdx";

function App() {
  return (
    <div style={{ padding: 24 }}>
      <StreamingMarkdown text={"# Hello\\n\\nStreaming **markdown**"} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
  );
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stream-mdx-pack-smoke-"));
  const packsDir = path.join(tmpRoot, "packs");
  const nextDir = path.join(tmpRoot, "next");
  const viteDir = path.join(tmpRoot, "vite");
  fs.mkdirSync(packsDir, { recursive: true });

  console.log(`[pack-smoke] tmp: ${tmpRoot}`);

  run("npm", ["-w", "@stream-mdx/core", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/plugins", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/worker", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/react", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "stream-mdx", "pack", "--pack-destination", packsDir], { cwd: repoRoot });

  const tarStream = findSinglePack(packsDir, (name) => /^stream-mdx-\d/.test(name));
  const tarCore = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-core-"));
  const tarPlugins = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-plugins-"));
  const tarWorker = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-worker-"));
  const tarReact = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-react-"));

  copyDir(path.join(repoRoot, "examples", "streaming-markdown-starter"), nextDir);

  rewriteNextPackageJson({
    pkgPath: path.join(nextDir, "package.json"),
    streamMdxTarball: tarStream,
    scopedTarballs: {
      "@stream-mdx/core": tarCore,
      "@stream-mdx/plugins": tarPlugins,
      "@stream-mdx/worker": tarWorker,
      "@stream-mdx/react": tarReact,
    },
  });

  run("npm", ["install", "--no-fund", "--no-audit"], { cwd: nextDir });
  run("npm", ["run", "build"], { cwd: nextDir });

  writeViteSmokeApp({
    viteDir,
    streamMdxTarball: tarStream,
    scopedTarballs: {
      "@stream-mdx/core": tarCore,
      "@stream-mdx/plugins": tarPlugins,
      "@stream-mdx/worker": tarWorker,
      "@stream-mdx/react": tarReact,
    },
  });

  run("npm", ["install", "--no-fund", "--no-audit"], { cwd: viteDir });
  run("npm", ["run", "build"], { cwd: viteDir });

  if (process.env.KEEP_PACK_SMOKE_TMP !== "1") {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } else {
    console.log(`[pack-smoke] KEEP_PACK_SMOKE_TMP=1, leaving ${tmpRoot}`);
  }
}

main();
