import assert from "node:assert";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileMarkdownSnapshotDirect } from "../src/direct-compile";
import { compileMarkdownSnapshot } from "../src/node/index";

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

async function runDirectCompileParityTest(): Promise<void> {
  const text = [
    "# Edge-safe compile",
    "",
    "Paragraph with `inline` code and a table.",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| alpha | 1 |",
    "",
    "```ts",
    "export const answer = 42;",
    "```",
    "",
    "## Repeated heading",
    "### Repeated heading",
  ].join("\n");

  const init = {
    docPlugins: {
      footnotes: true,
      html: true,
      mdx: true,
      tables: true,
      callouts: false,
      math: true,
      codeHighlighting: "final" as const,
      outputMode: "html" as const,
    },
    mdx: { compileMode: "server" as const },
    prewarmLangs: ["typescript"],
  };

  const [nodeResult, directResult] = await Promise.all([
    compileMarkdownSnapshot({
      text,
      init,
      hashSalt: "direct-parity",
      workerOptions: {
        workerBundle: resolveTestWorkerBundle(),
      },
    }),
    compileMarkdownSnapshotDirect({ text, init, hashSalt: "direct-parity" }),
  ]);

  assert.deepStrictEqual(summarizeBlocks(directResult.blocks), summarizeBlocks(nodeResult.blocks), "Direct compile output should match worker_threads compile output");
  assert.deepStrictEqual(directResult.artifact.tocHeadings ?? [], nodeResult.artifact.tocHeadings ?? [], "Direct compile TOC headings should match worker_threads compile");
  assert.strictEqual(directResult.artifact.hash, nodeResult.artifact.hash, "Direct compile hash should match worker_threads compile hash");
  assert.strictEqual(directResult.artifact.configHash, nodeResult.artifact.configHash, "Direct compile config hash should match worker_threads compile config hash");
  assert.strictEqual(directResult.artifact.contentHash, nodeResult.artifact.contentHash, "Direct compile content hash should match worker_threads compile content hash");
}

function resolveTestWorkerBundle(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.resolve(here, "..");
  const hostedPath = path.join(pkgRoot, "dist/hosted/markdown-worker.js");
  if (!existsSync(hostedPath)) {
    execSync("npm run build:hosted", { cwd: pkgRoot, stdio: "inherit" });
  }
  return hostedPath;
}

await runDirectCompileParityTest();
console.log("direct compile parity test passed");
