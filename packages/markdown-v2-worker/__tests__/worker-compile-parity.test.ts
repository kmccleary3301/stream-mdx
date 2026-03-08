import assert from "node:assert";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyPatchBatch, createInitialSnapshot, type Patch, type WorkerOut } from "@stream-mdx/core";

import { createWorkerHarness } from "./worker-test-harness";

function summarizeBlocks(blocks: ReadonlyArray<any>) {
  return blocks.map((block) => {
    const meta = (block.payload?.meta ?? {}) as Record<string, unknown>;
    return {
      id: block.id ?? null,
      type: block.type ?? null,
      raw: block.payload?.raw ?? null,
      isFinalized: Boolean(block.isFinalized),
      meta: {
        headingId: typeof meta.headingId === "string" ? meta.headingId : null,
        headingText: typeof meta.headingText === "string" ? meta.headingText : null,
        headingLevel: typeof meta.headingLevel === "number" ? meta.headingLevel : null,
        lang: typeof meta.lang === "string" ? meta.lang : null,
      },
    };
  });
}

async function runWorkerCompileParityTest(): Promise<void> {
  const text = [
    "# Hello World",
    "",
    "A paragraph with `inline` code.",
    "",
    "Footnote here.[^1]",
    "",
    "```ts",
    "const value = 42;",
    "```",
    "",
    "- item one",
    "- item two",
    "",
    "[^1]: Note body.",
  ].join("\n");

  const docPlugins = {
    footnotes: true,
    html: false,
    mdx: false,
    tables: true,
    callouts: false,
    math: false,
    codeHighlighting: "final" as const,
    outputMode: "html" as const,
  };

  const harness = await createWorkerHarness();
  const initMessages = await harness.send({
    type: "INIT",
    initialContent: text,
    prewarmLangs: ["typescript"],
    docPlugins,
  });
  const init = initMessages.find((msg) => msg.type === "INITIALIZED") as Extract<WorkerOut, { type: "INITIALIZED" }> | undefined;
  assert.ok(init, "worker did not emit INITIALIZED message");

  const snapshot = createInitialSnapshot(init.blocks ?? []);
  const initPatches = initMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  for (const message of initPatches) {
    applyPatchBatch(snapshot, message.patches as Patch[]);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  const finalizePatches = finalizeMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  for (const message of finalizePatches) {
    applyPatchBatch(snapshot, message.patches as Patch[]);
  }

  const browserSummary = summarizeBlocks(snapshot.blocks);

  const nodeResult = await loadCompiler().then((compiler) =>
    compiler.compileMarkdownSnapshot({
      text,
      init: {
        docPlugins,
        prewarmLangs: ["typescript"],
        mdx: { compileMode: "server" },
      },
    }),
  );

  const nodeSummary = summarizeBlocks(nodeResult.blocks);
  assert.deepStrictEqual(nodeSummary, browserSummary, "Node worker_thread compile should match browser worker output");
}

async function loadCompiler(): Promise<{ compileMarkdownSnapshot: typeof import("../dist/node/index.mjs").compileMarkdownSnapshot }> {
  const testFile = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(testFile), "..");
  const distPath = path.join(pkgRoot, "dist/node/index.mjs");
  const hostedPath = path.join(pkgRoot, "dist/hosted/markdown-worker.js");
  let needsBuild = false;
  try {
    await fs.access(distPath);
  } catch {
    needsBuild = true;
  }
  if (needsBuild) {
    execSync("npm run build", { cwd: pkgRoot, stdio: "inherit" });
  }
  try {
    await fs.access(hostedPath);
  } catch {
    execSync("npm run build:hosted", { cwd: pkgRoot, stdio: "inherit" });
  }
  let module = await import(distPath);
  if (typeof (module as any).compileMarkdownSnapshot !== "function") {
    execSync("npm run build", { cwd: pkgRoot, stdio: "inherit" });
    execSync("npm run build:hosted", { cwd: pkgRoot, stdio: "inherit" });
    module = await import(`${distPath}?v=${Date.now()}`);
  }
  return module as { compileMarkdownSnapshot: typeof import("../dist/node/index.mjs").compileMarkdownSnapshot };
}

await runWorkerCompileParityTest();
console.log("worker compile parity test passed");
