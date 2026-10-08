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

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function resolveOnlyTarget(): "next" | "vite" | "node" | "all" {
  const raw = (getArg("--only") ?? process.env.PACK_SMOKE_ONLY ?? "all").toLowerCase();
  if (raw === "next" || raw === "vite" || raw === "node" || raw === "all") return raw;
  throw new Error(`Invalid --only value "${raw}". Expected next, vite, node, or all.`);
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

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function rewriteNextPackageJson(options: {
  pkgPath: string;
  streamMdxTarball: string;
  scopedTarballs: Record<string, string>;
  optionalTarballs: Record<string, string>;
}) {
  const raw = fs.readFileSync(options.pkgPath, "utf8");
  const parsed = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };

  parsed.dependencies = parsed.dependencies ?? {};
  parsed.dependencies["stream-mdx"] = `file:${options.streamMdxTarball}`;
  delete parsed.dependencies["@stream-mdx/core"];
  delete parsed.dependencies["@stream-mdx/plugins"];
  delete parsed.dependencies["@stream-mdx/worker"];
  delete parsed.dependencies["@stream-mdx/react"];

  parsed.optionalDependencies = parsed.optionalDependencies ?? {};
  for (const [name, tarball] of Object.entries(options.optionalTarballs)) {
    parsed.optionalDependencies[name] = `file:${tarball}`;
  }

  parsed.overrides = parsed.overrides ?? {};
  for (const [name, tarball] of Object.entries(options.scopedTarballs)) {
    parsed.overrides[name] = `file:${tarball}`;
  }
  for (const [name, tarball] of Object.entries(options.optionalTarballs)) {
    parsed.overrides[name] = `file:${tarball}`;
  }

  writeJson(options.pkgPath, parsed);
}

function rewriteNextDemoComponent(demoPath: string) {
  const content = `"use client";

import { useMemo, useRef, useState } from "react";
import { StreamingMarkdown, type RendererMetrics, type StreamingMarkdownHandle } from "stream-mdx";
import { MermaidBlock } from "@stream-mdx/mermaid";
import { createUnifiedRenderer } from "@stream-mdx/unified";

const ARTICLE = \`# Streaming Markdown Starter

This starter demonstrates the ref-driven \\\`<StreamingMarkdown>\\\` component with optional Mermaid codeRenderer and unified blockRenderer.

\`\`\`mermaid
graph TD;
  A[Start] --> B[Processing];
  B --> C[Done];
\`\`\`

## Features

- Worker & main-thread engine execution
- Mermaid diagram rendering via codeRenderers
- Unified remark/rehype plugin pipeline via blockRenderer
- Instrumentation surfaced via \\\`onMetrics\\\`
\`;

// Real small remark and rehype plugins
const smallRemarkPlugin = () => (tree: unknown) => tree;
const smallRehypePlugin = () => (tree: unknown) => tree;

const unifiedRenderer = createUnifiedRenderer({
  remarkPlugins: [smallRemarkPlugin],
  rehypePlugins: [smallRehypePlugin],
});

export default function StreamingDemo() {
  const streamingRef = useRef<StreamingMarkdownHandle>(null);
  const [text, setText] = useState(ARTICLE);
  const [lastMetrics, setLastMetrics] = useState<RendererMetrics | null>(null);

  const codeRenderers = useMemo(
    () => ({
      mermaid: MermaidBlock,
    }),
    [],
  );

  return (
    <section className="space-y-4">
      <textarea
        className="h-48 w-full rounded border border-gray-300 p-3 font-mono text-sm"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />

      <div className="rounded border border-gray-200 bg-white p-4 shadow-sm">
        <StreamingMarkdown
          ref={streamingRef}
          text={text}
          engine="main-thread"
          codeRenderers={codeRenderers}
          blockRenderer={unifiedRenderer}
          features={{ math: true, mdx: true, tables: true, html: true }}
          prewarmLangs={["tsx", "python"]}
          onMetrics={(metric) => {
            setLastMetrics(metric);
          }}
        />
      </div>

      <pre className="rounded border border-gray-200 bg-gray-50 p-3 text-gray-600 text-xs">
        {JSON.stringify({ lastMetrics }, null, 2)}
      </pre>
    </section>
  );
}
`;

  fs.writeFileSync(demoPath, content, "utf8");
}

function writeViteSmokeApp(options: {
  viteDir: string;
  streamMdxTarball: string;
  scopedTarballs: Record<string, string>;
  optionalTarballs: Record<string, string>;
  themeTarball?: string;
}) {
  fs.mkdirSync(options.viteDir, { recursive: true });
  fs.mkdirSync(path.join(options.viteDir, "src"), { recursive: true });

  const overrides: Record<string, string> = {
    "stream-mdx": `file:${options.streamMdxTarball}`,
    ...Object.fromEntries(
      Object.entries(options.scopedTarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
    ),
    ...Object.fromEntries(
      Object.entries(options.optionalTarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
    ),
  };
  if (options.themeTarball) {
    overrides["@stream-mdx/theme-tailwind"] = `file:${options.themeTarball}`;
  }

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
      ...(options.themeTarball ? { "@stream-mdx/theme-tailwind": `file:${options.themeTarball}` } : {}),
    },
    optionalDependencies: {
      ...Object.fromEntries(
        Object.entries(options.optionalTarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
      ),
    },
    devDependencies: {
      "@types/node": "^22.10.2",
      "@types/react": "^18.3.12",
      "@types/react-dom": "^18.3.1",
      "@vitejs/plugin-react": "4.3.4",
      typescript: "^5.7.2",
      vite: "6.0.5",
    },
    overrides,
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
import "@stream-mdx/theme-tailwind/theme.css";
import { StreamingMarkdown } from "stream-mdx";
import { MermaidBlock } from "@stream-mdx/mermaid";
import { createUnifiedRenderer } from "@stream-mdx/unified";

const smallRemarkPlugin = () => (tree: unknown) => tree;
const smallRehypePlugin = () => (tree: unknown) => tree;

const blockRenderer = createUnifiedRenderer({
  remarkPlugins: [smallRemarkPlugin],
  rehypePlugins: [smallRehypePlugin],
});

function App() {
  return (
    <div style={{ padding: 24 }}>
      <StreamingMarkdown
        engine="main-thread"
        codeRenderers={{ mermaid: MermaidBlock }}
        blockRenderer={blockRenderer}
        text={"# Hello from Vite Smoke\\\\n\\\\n\`\`\`mermaid\\\\ngraph TD;\\\\n  A-->B;\\\\n\`\`\`"}
      />
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

function verifyInstalledNodeSandbox(options: {
  sandboxDir: string;
  streamMdxTarball: string;
  scopedTarballs: Record<string, string>;
  optionalTarballs: Record<string, string>;
  themeTarball: string;
}) {
  fs.mkdirSync(options.sandboxDir, { recursive: true });

  const overrides: Record<string, string> = {
    "stream-mdx": `file:${options.streamMdxTarball}`,
    ...Object.fromEntries(
      Object.entries(options.scopedTarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
    ),
    ...Object.fromEntries(
      Object.entries(options.optionalTarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
    ),
    "@stream-mdx/theme-tailwind": `file:${options.themeTarball}`,
  };

  writeJson(path.join(options.sandboxDir, "package.json"), {
    name: "stream-mdx-node-sandbox",
    private: true,
    type: "module",
    dependencies: {
      react: "18.3.1",
      "react-dom": "18.3.1",
      "stream-mdx": `file:${options.streamMdxTarball}`,
    },
    optionalDependencies: {
      ...Object.fromEntries(
        Object.entries(options.optionalTarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
      ),
    },
    overrides,
  });

  console.log("[pack-smoke:node-sandbox] Running npm install in sandbox...");
  run("npm", ["install", "--no-fund", "--no-audit"], { cwd: options.sandboxDir });

  // ESM Verification Script
  const esmVerifier = `import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

console.log("[pack-smoke:node-sandbox] Starting ESM verification...");

// 1. Verify Node version satisfies declared supported version (>=20)
const [major] = process.versions.node.split(".").map(Number);
assert(major >= 20, \`Declared supported Node version is >=20, running \${process.version}\`);
console.log(\`[pack-smoke:node-sandbox] Node engine check: \${process.version} satisfies >=20\`);

// 2. Verify optional @stream-mdx/mermaid ESM entry
const mermaidMod = await import("@stream-mdx/mermaid");
assert(typeof mermaidMod.MermaidBlock === "function", "@stream-mdx/mermaid must export MermaidBlock component");
console.log("[pack-smoke:node-sandbox] ESM import @stream-mdx/mermaid verified: MermaidBlock is present and callable");

// 3. Verify optional @stream-mdx/unified ESM entry with plugins
const unifiedMod = await import("@stream-mdx/unified");
assert(typeof unifiedMod.createUnifiedRenderer === "function", "@stream-mdx/unified must export createUnifiedRenderer");

const smallRemark = () => (tree) => tree;
const smallRehype = () => (tree) => tree;
const renderer = unifiedMod.createUnifiedRenderer({
  remarkPlugins: [smallRemark],
  rehypePlugins: [smallRehype],
});
assert(typeof renderer === "function", "createUnifiedRenderer must return a callable block renderer");
assert(Array.isArray(renderer.options.remarkPlugins), "renderer.options.remarkPlugins must be an array");
assert(Array.isArray(renderer.options.rehypePlugins), "renderer.options.rehypePlugins must be an array");
assert(typeof renderer.clearCache === "function", "renderer.clearCache must be callable");
console.log("[pack-smoke:node-sandbox] ESM import @stream-mdx/unified verified: createUnifiedRenderer callable with real plugins");

// 4. Verify engine entry points: @stream-mdx/worker/engine and stream-mdx/worker/engine
const workerEngineMod = await import("@stream-mdx/worker/engine");
assert(typeof workerEngineMod.MarkdownEngine === "function", "@stream-mdx/worker/engine must export MarkdownEngine");
assert(typeof workerEngineMod.createInlineEngineWorker === "function", "@stream-mdx/worker/engine must export createInlineEngineWorker");
assert(typeof workerEngineMod.serveMarkdownWorker === "function", "@stream-mdx/worker/engine must export serveMarkdownWorker");

const inlineWorker = workerEngineMod.createInlineEngineWorker();
assert(typeof inlineWorker.postMessage === "function", "createInlineEngineWorker must return worker with postMessage");
if (typeof inlineWorker.terminate === "function") inlineWorker.terminate();

const engine = new workerEngineMod.MarkdownEngine({ post: () => {} });
assert(typeof engine.handle === "function", "MarkdownEngine instance must have handle method");
console.log("[pack-smoke:node-sandbox] ESM import @stream-mdx/worker/engine verified: MarkdownEngine & createInlineEngineWorker callable");

const streamWorkerEngineMod = await import("stream-mdx/worker/engine");
assert(typeof streamWorkerEngineMod.MarkdownEngine === "function", "stream-mdx/worker/engine must export MarkdownEngine");
assert(typeof streamWorkerEngineMod.createInlineEngineWorker === "function", "stream-mdx/worker/engine must export createInlineEngineWorker");
console.log("[pack-smoke:node-sandbox] ESM import stream-mdx/worker/engine verified");

// 5. Verify main and core exports
const streamMdxMod = await import("stream-mdx");
assert(typeof streamMdxMod.StreamingMarkdown === "function", "stream-mdx must export StreamingMarkdown");

const reactMod = await import("@stream-mdx/react");
assert(typeof reactMod.StreamingMarkdown === "function", "@stream-mdx/react must export StreamingMarkdown");

// 6. Systematic check of all declared ESM exports across installed packages
const packagesToCheck = [
  "stream-mdx",
  "@stream-mdx/core",
  "@stream-mdx/plugins",
  "@stream-mdx/worker",
  "@stream-mdx/react",
  "@stream-mdx/mermaid",
  "@stream-mdx/unified",
];

for (const pkgName of packagesToCheck) {
  const pkgJsonPath = path.resolve(\`node_modules/\${pkgName}/package.json\`);
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(\`Package \${pkgName} missing from node_modules!\`);
  }
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));

  // Check peer dependencies
  if (pkgJson.peerDependencies) {
    for (const [peerName, peerRange] of Object.entries(pkgJson.peerDependencies)) {
      const isOptional = pkgJson.peerDependenciesMeta?.[peerName]?.optional === true;
      const peerPkgJsonPath = path.resolve(\`node_modules/\${peerName}/package.json\`);
      if (!fs.existsSync(peerPkgJsonPath) && !isOptional) {
        throw new Error(\`Package \${pkgName} requires peer dependency \${peerName}@\${peerRange}, but it is missing!\`);
      }
    }
  }

  // Check all advertised ESM exports
  if (pkgJson.exports) {
    for (const [subpath, target] of Object.entries(pkgJson.exports)) {
      if (typeof target === "string" && (target.endsWith(".css") || target.includes("hosted"))) {
        continue;
      }
      const hasImport = typeof target === "object" && target !== null && "import" in target;
      if (hasImport) {
        const importSpecifier = subpath === "." ? pkgName : \`\${pkgName}/\${subpath.replace(/^\\.\\//, "")}\`;
        try {
          const mod = await import(importSpecifier);
          assert(mod && typeof mod === "object", \`Export \${importSpecifier} must resolve to module object\`);
        } catch (err) {
          throw new Error(\`Failed to import advertised ESM export "\${importSpecifier}": \${err.message}\`);
        }
      }
    }
  }
}

console.log("[pack-smoke:node-sandbox] All advertised ESM export subpaths verified successfully");
`;

  fs.writeFileSync(path.join(options.sandboxDir, "verify-esm.mjs"), esmVerifier, "utf8");
  run("node", ["verify-esm.mjs"], { cwd: options.sandboxDir });

  // CJS Verification Script
  const cjsVerifier = `const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

console.log("[pack-smoke:node-sandbox] Starting advertised CJS verification...");

// 1. Verify @stream-mdx/mermaid CJS entry
const mermaidCjs = require("@stream-mdx/mermaid");
assert(typeof mermaidCjs.MermaidBlock === "function", "@stream-mdx/mermaid must export MermaidBlock in CJS");
console.log("[pack-smoke:node-sandbox] CJS require @stream-mdx/mermaid verified: MermaidBlock is present and callable");

// 2. Verify @stream-mdx/unified CJS entry
const unifiedCjs = require("@stream-mdx/unified");
assert(typeof unifiedCjs.createUnifiedRenderer === "function", "@stream-mdx/unified must export createUnifiedRenderer in CJS");

const smallRemark = () => (tree) => tree;
const smallRehype = () => (tree) => tree;
const renderer = unifiedCjs.createUnifiedRenderer({
  remarkPlugins: [smallRemark],
  rehypePlugins: [smallRehype],
});
assert(typeof renderer === "function", "createUnifiedRenderer in CJS must return a callable block renderer");
assert(Array.isArray(renderer.options.remarkPlugins), "renderer.options.remarkPlugins must be an array in CJS");
console.log("[pack-smoke:node-sandbox] CJS require @stream-mdx/unified verified: createUnifiedRenderer callable with real plugins");

// 3. Verify @stream-mdx/worker/engine and stream-mdx/worker/engine CJS entries
const workerEngineCjs = require("@stream-mdx/worker/engine");
assert(typeof workerEngineCjs.MarkdownEngine === "function", "@stream-mdx/worker/engine must export MarkdownEngine class in CJS");
assert(typeof workerEngineCjs.createInlineEngineWorker === "function", "@stream-mdx/worker/engine must export createInlineEngineWorker in CJS");

const inlineWorker = workerEngineCjs.createInlineEngineWorker();
assert(typeof inlineWorker.postMessage === "function", "createInlineEngineWorker in CJS must return worker with postMessage");
if (typeof inlineWorker.terminate === "function") inlineWorker.terminate();

const engine = new workerEngineCjs.MarkdownEngine({ post: () => {} });
assert(typeof engine.handle === "function", "MarkdownEngine in CJS must have handle method");
console.log("[pack-smoke:node-sandbox] CJS require @stream-mdx/worker/engine verified: MarkdownEngine & createInlineEngineWorker callable");

const streamWorkerEngineCjs = require("stream-mdx/worker/engine");
assert(typeof streamWorkerEngineCjs.MarkdownEngine === "function", "stream-mdx/worker/engine must export MarkdownEngine in CJS");
console.log("[pack-smoke:node-sandbox] CJS require stream-mdx/worker/engine verified");

// 4. Verify core, react, and stream-mdx CJS entries
const coreCjs = require("@stream-mdx/core");
assert(coreCjs && typeof coreCjs === "object", "@stream-mdx/core required successfully in CJS");

const reactCjs = require("@stream-mdx/react");
assert(typeof reactCjs.StreamingMarkdown === "function", "@stream-mdx/react StreamingMarkdown in CJS");

const streamMdxCjs = require("stream-mdx");
assert(typeof streamMdxCjs.StreamingMarkdown === "function", "stream-mdx StreamingMarkdown in CJS");

// 5. Systematic check of advertised CJS entries across installed packages
const packagesToCheck = [
  "stream-mdx",
  "@stream-mdx/core",
  "@stream-mdx/plugins",
  "@stream-mdx/worker",
  "@stream-mdx/react",
  "@stream-mdx/mermaid",
  "@stream-mdx/unified",
];

for (const pkgName of packagesToCheck) {
  const pkgJsonPath = path.resolve(\`node_modules/\${pkgName}/package.json\`);
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  if (pkgJson.exports) {
    for (const [subpath, target] of Object.entries(pkgJson.exports)) {
      if (typeof target === "string" && (target.endsWith(".css") || target.includes("hosted"))) {
        continue;
      }
      const hasRequire = typeof target === "object" && target !== null && "require" in target;
      if (hasRequire) {
        const reqSpecifier = subpath === "." ? pkgName : \`\${pkgName}/\${subpath.replace(/^\\.\\//, "")}\`;
        try {
          const mod = require(reqSpecifier);
          assert(mod && (typeof mod === "object" || typeof mod === "function"), \`Export \${reqSpecifier} must require object or function\`);
        } catch (err) {
          throw new Error(\`Failed to require advertised CJS export "\${reqSpecifier}": \${err.message}\`);
        }
      }
    }
  }
}

console.log("[pack-smoke:node-sandbox] All advertised CJS export subpaths verified successfully");
`;

  fs.writeFileSync(path.join(options.sandboxDir, "verify-cjs.cjs"), cjsVerifier, "utf8");
  run("node", ["verify-cjs.cjs"], { cwd: options.sandboxDir });
}

function main() {
  const onlyTarget = resolveOnlyTarget();
  const runNode = onlyTarget === "all" || onlyTarget === "node";
  const runNext = onlyTarget === "all" || onlyTarget === "next";
  const runVite = onlyTarget === "all" || onlyTarget === "vite";
  const repoRoot = path.resolve(__dirname, "..");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stream-mdx-pack-smoke-"));
  const packsDir = path.join(tmpRoot, "packs");
  const nodeSandboxDir = path.join(tmpRoot, "node-sandbox");
  const nextDir = path.join(tmpRoot, "next");
  const viteDir = path.join(tmpRoot, "vite");
  fs.mkdirSync(packsDir, { recursive: true });

  console.log(`[pack-smoke] tmp: ${tmpRoot}`);

  run("npm", ["-w", "@stream-mdx/core", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/plugins", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/worker", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/react", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/mermaid", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/unified", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/theme-tailwind", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "stream-mdx", "pack", "--pack-destination", packsDir], { cwd: repoRoot });

  const tarStream = findSinglePack(packsDir, (name) => /^stream-mdx-\d/.test(name));
  const tarCore = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-core-"));
  const tarPlugins = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-plugins-"));
  const tarWorker = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-worker-"));
  const tarReact = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-react-"));
  const tarMermaid = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-mermaid-"));
  const tarUnified = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-unified-"));
  const tarTheme = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-theme-tailwind-"));

  const scopedTarballs: Record<string, string> = {
    "@stream-mdx/core": tarCore,
    "@stream-mdx/plugins": tarPlugins,
    "@stream-mdx/worker": tarWorker,
    "@stream-mdx/react": tarReact,
  };

  const optionalTarballs: Record<string, string> = {
    "@stream-mdx/mermaid": tarMermaid,
    "@stream-mdx/unified": tarUnified,
  };

  if (runNode) {
    verifyInstalledNodeSandbox({
      sandboxDir: nodeSandboxDir,
      streamMdxTarball: tarStream,
      scopedTarballs,
      optionalTarballs,
      themeTarball: tarTheme,
    });
  }

  if (runNext) {
    copyDir(path.join(repoRoot, "examples", "streaming-markdown-starter"), nextDir);

    rewriteNextPackageJson({
      pkgPath: path.join(nextDir, "package.json"),
      streamMdxTarball: tarStream,
      scopedTarballs,
      optionalTarballs,
    });

    rewriteNextDemoComponent(path.join(nextDir, "components", "StreamingDemo.tsx"));

    run("npm", ["install", "--no-fund", "--no-audit"], { cwd: nextDir });
    run("npm", ["run", "build"], { cwd: nextDir });
  }

  if (runVite) {
    writeViteSmokeApp({
      viteDir,
      streamMdxTarball: tarStream,
      scopedTarballs,
      optionalTarballs,
      themeTarball: tarTheme,
    });

    run("npm", ["install", "--no-fund", "--no-audit"], { cwd: viteDir });
    run("npm", ["run", "build"], { cwd: viteDir });
  }

  if (process.env.KEEP_PACK_SMOKE_TMP !== "1") {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } else {
    console.log(`[pack-smoke] KEEP_PACK_SMOKE_TMP=1, leaving ${tmpRoot}`);
  }
}

main();
