import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const smokePlugins = {
  "remark-gfm": "4.0.1",
  "rehype-slug": "6.0.0",
};
const smokeMarkdown = [
  "# Pack Smoke",
  "",
  "~~Plugin text~~",
  "",
  "```mermaid",
  "graph TD;",
  "  A[Start] --> B[Done];",
  "```",
].join("\n");

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
  Object.assign(parsed.dependencies, smokePlugins);
  for (const [name, tarball] of Object.entries(options.scopedTarballs)) {
    parsed.dependencies[name] = `file:${tarball}`;
  }

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
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";

const ARTICLE = ${JSON.stringify(smokeMarkdown)};
const unifiedRenderer = createUnifiedRenderer({
  gfm: false,
  remarkPlugins: [remarkGfm],
  rehypePlugins: [rehypeSlug],
  blockTypes: ["heading", "paragraph", "table"],
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
      ...smokePlugins,
      ...Object.fromEntries(
        Object.entries(options.scopedTarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
      ),
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
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";

const blockRenderer = createUnifiedRenderer({
  gfm: false,
  remarkPlugins: [remarkGfm],
  rehypePlugins: [rehypeSlug],
  blockTypes: ["heading", "paragraph", "table"],
});

function App() {
  return (
    <div style={{ padding: 24 }}>
      <StreamingMarkdown
        engine="main-thread"
        codeRenderers={{ mermaid: MermaidBlock }}
        blockRenderer={blockRenderer}
        text={${JSON.stringify(smokeMarkdown)}}
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
  nodeTarballs: Record<string, string>;
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
    ...Object.fromEntries(
      Object.entries(options.nodeTarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
    ),
  };

  writeJson(path.join(options.sandboxDir, "package.json"), {
    name: "stream-mdx-node-sandbox",
    private: true,
    type: "module",
    dependencies: {
      react: "18.3.1",
      "react-dom": "18.3.1",
      "stream-mdx": `file:${options.streamMdxTarball}`,
      ...smokePlugins,
      ...Object.fromEntries(
        Object.entries(options.scopedTarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
      ),
      "@stream-mdx/theme-tailwind": `file:${options.themeTarball}`,
      ...Object.fromEntries(
        Object.entries(options.nodeTarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
      ),
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

  // Both loaders run the same behavior checks against installed public exports.
  const runtimeVerifier = `const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function verify(load, format) {
  const major = Number(process.versions.node.split(".")[0]);
  assert(major >= 20, "Pack smoke requires the declared supported Node >=20");
  console.log("[pack-smoke:" + format + "] Runtime " + process.version);

  const packages = [
    "stream-mdx", "@stream-mdx/core", "@stream-mdx/plugins",
    "@stream-mdx/worker", "@stream-mdx/react",
    "@stream-mdx/mermaid", "@stream-mdx/unified",
    "@stream-mdx/protocol", "@stream-mdx/tui", "@stream-mdx/theme-tailwind",
  ];
  for (const name of packages) {
    const packageDir = path.resolve("node_modules", name);
    assert(!fs.lstatSync(packageDir).isSymbolicLink(), name + " must be installed from a tarball");
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!manifest.peerDependenciesMeta?.[peer]?.optional) {
        assert(fs.existsSync(path.resolve("node_modules", peer, "package.json")),
          name + " requires installed peer " + peer + "@" + range);
      }
    }
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (typeof target !== "object" || target === null || !(format in target)) continue;
      const specifier = subpath === "." ? name : name + "/" + subpath.slice(2);
      const mod = await load(specifier);
      assert(mod && (typeof mod === "object" || typeof mod === "function"),
        specifier + " must load its advertised " + format + " entry");
      console.log("[pack-smoke:" + format + "] Loaded " + specifier);
    }
  }

  const React = await load("react");
  const { renderToStaticMarkup } = await load("react-dom/server");
  const { StreamingMarkdown } = await load("stream-mdx");
  // StreamingMarkdown is a React.forwardRef component, not a bare function.
  assert(StreamingMarkdown && typeof StreamingMarkdown.render === "function",
    "stream-mdx must export its forwardRef StreamingMarkdown component");

  const { MermaidBlock } = await load("@stream-mdx/mermaid");
  assert.equal(typeof MermaidBlock, "function");
  const mermaidHtml = renderToStaticMarkup(React.createElement(MermaidBlock, {
    code: "graph TD; A-->B;", language: "mermaid", isFinalized: true,
    defaultView: "code", renderCode: React.createElement("pre", null, "graph TD; A-->B;"),
  }));
  assert.match(mermaidHtml, /stream-mdx-mermaid-block/);
  assert.match(mermaidHtml, /graph TD; A--&gt;B;/);
  console.log("[pack-smoke:" + format + "] MermaidBlock SSR code fallback executed; SVG requires a browser");

  // This loader-boundary test accepts ESM plugins in both ESM and CJS consumers.
  const { default: remarkGfm } = await import("remark-gfm");
  const { default: rehypeSlug } = await import("rehype-slug");
  const { createUnifiedRenderer } = await load("@stream-mdx/unified");
  const renderer = createUnifiedRenderer({
    gfm: false, remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSlug],
  });
  const renderBlock = (id, type, raw) => renderToStaticMarkup(renderer({
    block: { id, type, isFinalized: true, payload: { raw } },
    element: React.createElement("p", null, "default fallback"),
  }));
  assert.equal(renderBlock("heading", "heading", "# Pack Smoke"),
    '<h1 id="pack-smoke">Pack Smoke</h1>');
  assert.equal(renderBlock("paragraph", "paragraph", "~~Plugin text~~"),
    "<p><del>Plugin text</del></p>");
  renderer.clearCache();
  console.log("[pack-smoke:" + format + "] Unified remark-gfm and rehype-slug transformed rendered HTML");

  const { STREAM_MDX_PROTOCOL_ID, STREAM_MDX_SCHEMA_VERSION } = await load("@stream-mdx/protocol");
  assert.equal(STREAM_MDX_PROTOCOL_ID, "streammdx");
  assert.equal(STREAM_MDX_SCHEMA_VERSION, "2.0");
  const { createSnapshotStore, encodeNdjsonEvent, encodeNdjsonEvents, decodeNdjson, NdjsonDecoder } =
    await load("@stream-mdx/tui");
  const envelope = {
    protocol: STREAM_MDX_PROTOCOL_ID, schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    streamId: "pack-smoke-" + format,
  };

  const { compileMarkdownSnapshot } = await load("@stream-mdx/worker/node");
  // Default worker ownership exercises the installed hosted bundle and thread asset,
  // and lets the public compiler clean up its own physical worker.
  const physicalResult = await compileMarkdownSnapshot({
    text: "# Hosted asset smoke\\n\\nPhysical worker body.\\n",
  });
  assert.equal(physicalResult.fromCache, false);
  assert.equal(physicalResult.blocks.length, 2);
  assert.equal(physicalResult.blocks[0].type, "heading");
  assert.equal(physicalResult.blocks[0].payload.raw.trim(), "Hosted asset smoke");
  assert.equal(physicalResult.blocks[1].type, "paragraph");
  assert.equal(physicalResult.blocks[1].payload.raw.trim(), "Physical worker body.");
  assert(physicalResult.blocks.every((block) => block.isFinalized),
    "The installed physical worker must finalize every compiled block");
  assert.deepEqual(physicalResult.snapshot.getBlocks(), physicalResult.blocks);
  assert.deepEqual(physicalResult.artifact.blocks, physicalResult.blocks);
  console.log("[pack-smoke:" + format + "] Installed physical worker compiled finalized snapshot");

  const { createRendererStore } = await load("@stream-mdx/react/renderer/store");
  const init = { type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "", prewarmLangs: [], docPlugins: {} };
  const append = { type: "APPEND", text: "# Installed engine\\n\\nEngine body.\\n" };
  const apply = (store, message) => {
    if (message.type === "ERROR") throw new Error(message.error.message);
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
  };
  const assertBlocks = (store) => {
    const blocks = store.getBlocks();
    assert.equal(blocks.length, 2, "Engine must parse heading and paragraph");
    assert.equal(blocks[0].type, "heading");
    assert.equal(blocks[0].payload.raw.trim(), "Installed engine");
    assert.equal(blocks[1].type, "paragraph");
    assert.match(blocks[1].payload.raw, /Engine body/);
    assert(blocks.every((block) => block.isFinalized), "Engine must finalize every block");
  };

  for (const specifier of ["@stream-mdx/worker/engine", "stream-mdx/worker/engine"]) {
    const { MarkdownEngine, createInlineEngineWorker, serveMarkdownWorker } = await load(specifier);
    assert.equal(typeof serveMarkdownWorker, "function");
    const store = createRendererStore();
    const events = [{ ...envelope, event: "init" }];
    const engine = new MarkdownEngine({ post: (message) => {
      apply(store, message);
      if (message.type === "INITIALIZED") {
        events.push(JSON.parse(JSON.stringify({ ...envelope, event: "snapshot", snapshot: message.snapshot })));
      }
      if (message.type === "PATCH") {
        // Serialize at emission time so later engine mutations cannot alter the replay.
        events.push(JSON.parse(JSON.stringify({
          ...envelope, event: "patch", tx: message.tx, patches: message.patches,
        })));
      }
    } });
    try {
      await engine.handle(init);
      assert.equal(events[1].event, "snapshot");
      assert.deepEqual(events[1].snapshot.children, []);
      await engine.handle(append);
      await engine.handle({ type: "FINALIZE" });
      assertBlocks(store);
      let replacementSnapshot;
      const replacementEngine = new MarkdownEngine({ post: (message) => {
        if (message.type === "INITIALIZED") replacementSnapshot = message.snapshot;
        if (message.type === "ERROR") throw new Error(message.error.message);
      } });
      try {
        await replacementEngine.handle({ ...init, initialContent: append.text });
      } finally {
        replacementEngine.dispose();
      }
      assert.ok(replacementSnapshot, "engine must publish a root snapshot for replacement");
      const patches = events.filter((event) => event.event === "patch");
      assert(patches.length > 0, "TUI replay must consume actual engine patches");
      const finalTx = patches[patches.length - 1].tx;
      events.push({ ...envelope, event: "done", finalTx, status: "ok" });
      const ndjson = encodeNdjsonEvent(events[0]) + encodeNdjsonEvents(events.slice(1));
      const decoder = new NdjsonDecoder();
      const tuiStore = createSnapshotStore();
      assert.deepEqual(tuiStore.getBlocks(), []);
      const firstLine = ndjson.indexOf("\\n") + 1;
      assert.deepEqual(decoder.push(ndjson.slice(0, firstLine - 1)), [],
        "NDJSON must buffer an incomplete event");
      tuiStore.applyEvents(decoder.push(ndjson.slice(firstLine - 1, firstLine)));
      assert.equal(tuiStore.getMeta().init.protocol, STREAM_MDX_PROTOCOL_ID);
      assert.equal(tuiStore.getMeta().init.schemaVersion, STREAM_MDX_SCHEMA_VERSION);
      // Leave the done event unterminated to exercise flush as well as chunk ingestion.
      const bytes = new TextEncoder().encode(ndjson.slice(firstLine, -1));
      for (let offset = 0; offset < bytes.length; offset += 17) {
        tuiStore.applyEvents(decoder.push(bytes.subarray(offset, offset + 17)));
      }
      assert.equal(tuiStore.getMeta().done, undefined);
      tuiStore.applyEvents(decoder.flush());
      assertBlocks(tuiStore);
      assert.equal(tuiStore.getMeta().lastTx, finalTx);
      assert.deepEqual(tuiStore.getMeta().done, events[events.length - 1]);
      assert.deepEqual(tuiStore.getBlocks(), store.getBlocks(),
        "NDJSON replay must materialize the same blocks as the installed engine");
      const replayStore = createSnapshotStore();
      replayStore.applyEvents(decodeNdjson(ndjson));
      assert.deepEqual(replayStore.getBlocks(), tuiStore.getBlocks());
      tuiStore.applyEvent({ ...envelope, event: "snapshot", snapshot: events[1].snapshot });
      assert.deepEqual(tuiStore.getBlocks(), [], "A snapshot must replace previous engine state");
      tuiStore.applyEvent({ ...envelope, event: "snapshot", snapshot: replacementSnapshot });
      const replacementBlocks = tuiStore.getBlocks();
      assert.equal(replacementBlocks.length, 2);
      assert.equal(replacementBlocks[0].payload.raw.trim(), "Installed engine");
      assert.match(replacementBlocks[1].payload.raw, /Engine body/);
      console.log("[pack-smoke:" + format + "] " + specifier +
        " protocol envelope and TUI chunked NDJSON patch replay/snapshot replacement passed");
    } finally {
      engine.dispose();
    }

    const inlineStore = createRendererStore();
    const worker = createInlineEngineWorker();
    try {
      // Node 20 is supported and does not provide Promise.withResolvers.
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(specifier + " inline engine timed out")), 15000);
        worker.onerror = (event) => { clearTimeout(timeout); reject(event.error ?? new Error(event.message)); };
        worker.onmessage = ({ data }) => {
          try {
            apply(inlineStore, data);
            const blocks = inlineStore.getBlocks();
            if (blocks.length === 2 && blocks.every((block) => block.isFinalized)) {
              assertBlocks(inlineStore);
              clearTimeout(timeout);
              resolve();
            }
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        };
        worker.postMessage(init);
        worker.postMessage(append);
        worker.postMessage({ type: "FINALIZE" });
      });
    } finally {
      worker.terminate();
    }
    console.log("[pack-smoke:" + format + "] " + specifier + " direct and inline engines parsed/finalized");
  }
};
`;

  fs.writeFileSync(path.join(options.sandboxDir, "verify-runtime.cjs"), runtimeVerifier, "utf8");
  fs.writeFileSync(
    path.join(options.sandboxDir, "verify-esm.mjs"),
    'import verify from "./verify-runtime.cjs";\nawait verify((specifier) => import(specifier), "import");\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(options.sandboxDir, "verify-cjs.cjs"),
    'require("./verify-runtime.cjs")(require, "require").catch((error) => { console.error(error); process.exitCode = 1; });\n',
    "utf8",
  );
  const failures: string[] = [];
  for (const file of ["verify-esm.mjs", "verify-cjs.cjs"]) {
    try {
      run(process.execPath, [file], { cwd: options.sandboxDir });
    } catch {
      failures.push(file);
    }
  }
  if (failures.length) throw new Error(`Installed runtime verification failed: ${failures.join(", ")}`);
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
  run("npm", ["-w", "@stream-mdx/protocol", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/tui", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "stream-mdx", "pack", "--pack-destination", packsDir], { cwd: repoRoot });

  const tarStream = findSinglePack(packsDir, (name) => /^stream-mdx-\d/.test(name));
  const tarCore = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-core-"));
  const tarPlugins = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-plugins-"));
  const tarWorker = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-worker-"));
  const tarReact = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-react-"));
  const tarMermaid = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-mermaid-"));
  const tarUnified = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-unified-"));
  const tarTheme = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-theme-tailwind-"));
  const tarProtocol = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-protocol-"));
  const tarTui = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-tui-"));

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

  const failures: string[] = [];
  if (runNode) {
    try {
      verifyInstalledNodeSandbox({
        sandboxDir: nodeSandboxDir,
        streamMdxTarball: tarStream,
        scopedTarballs,
        optionalTarballs,
        themeTarball: tarTheme,
        nodeTarballs: {
          "@stream-mdx/protocol": tarProtocol,
          "@stream-mdx/tui": tarTui,
        },
      });
    } catch (error) {
      console.error("[pack-smoke:node] Failed", error);
      failures.push("node");
    }
  }

  if (runNext) {
    try {
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
      console.log("[pack-smoke:next] Production bundling passed; browser execution is not tested");
    } catch (error) {
      console.error("[pack-smoke:next] Failed", error);
      failures.push("next");
    }
  }

  if (runVite) {
    try {
      writeViteSmokeApp({
        viteDir,
        streamMdxTarball: tarStream,
        scopedTarballs,
        optionalTarballs,
        themeTarball: tarTheme,
      });

      run("npm", ["install", "--no-fund", "--no-audit"], { cwd: viteDir });
      run("npm", ["run", "build"], { cwd: viteDir });
      console.log("[pack-smoke:vite] Production bundling passed; browser execution is not tested");
    } catch (error) {
      console.error("[pack-smoke:vite] Failed", error);
      failures.push("vite");
    }
  }

  if (failures.length) {
    console.error(`[pack-smoke] Keeping failed sandboxes at ${tmpRoot}`);
    throw new Error(`Pack smoke failed: ${failures.join(", ")}`);
  }

  if (process.env.KEEP_PACK_SMOKE_TMP !== "1") {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } else {
    console.log(`[pack-smoke] KEEP_PACK_SMOKE_TMP=1, leaving ${tmpRoot}`);
  }
}

main();
