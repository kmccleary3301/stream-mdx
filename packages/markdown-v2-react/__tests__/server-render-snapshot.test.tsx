import assert from "node:assert";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownBlocksRenderer, ComponentRegistry } from "../src/server";

async function runServerRenderSnapshotTest(): Promise<void> {
  const compiler = await loadCompiler();
  const { blocks } = await compiler.compileMarkdownSnapshot({
    text: ["# Hello", "", "A paragraph.", "", "```ts", "const x = 1;", "```"].join("\n"),
    init: {
      docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true },
      mdx: { compileMode: "server" },
      prewarmLangs: ["typescript"],
    },
  });

  const registry = new ComponentRegistry();
  const html = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      componentRegistry: registry,
    }),
  );

  assert.ok(html.includes("markdown-heading"), "expected heading markup in SSR render");
  assert.ok(html.includes('id="hello"'), "expected heading id in SSR render");
  assert.ok(html.includes("markdown-code-block"), "expected code block markup in SSR render");
}

await runServerRenderSnapshotTest();
console.log("server render snapshot test passed");

async function loadCompiler(): Promise<{ compileMarkdownSnapshot: typeof import("../../markdown-v2-worker/dist/node/index.mjs").compileMarkdownSnapshot }> {
  const testFile = fileURLToPath(import.meta.url);
  const reactRoot = path.resolve(path.dirname(testFile), "..");
  const workerRoot = path.resolve(reactRoot, "..", "markdown-v2-worker");
  const distPath = path.join(workerRoot, "dist/node/index.mjs");
  const hostedPath = path.join(workerRoot, "dist/hosted/markdown-worker.js");
  let needsBuild = false;
  try {
    await fs.access(distPath);
  } catch {
    needsBuild = true;
  }
  if (needsBuild) {
    execSync("npm run build", { cwd: workerRoot, stdio: "inherit" });
  }
  try {
    await fs.access(hostedPath);
  } catch {
    execSync("npm run build:hosted", { cwd: workerRoot, stdio: "inherit" });
  }
  let module = await import(distPath);
  if (typeof (module as any).compileMarkdownSnapshot !== "function") {
    execSync("npm run build", { cwd: workerRoot, stdio: "inherit" });
    execSync("npm run build:hosted", { cwd: workerRoot, stdio: "inherit" });
    module = await import(`${distPath}?v=${Date.now()}`);
  }
  return module as { compileMarkdownSnapshot: typeof import("../../markdown-v2-worker/dist/node/index.mjs").compileMarkdownSnapshot };
}
