#!/usr/bin/env tsx

import { readFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "@playwright/test";

import { compileMarkdownSnapshot } from "../../packages/markdown-v2-worker/src/node/index";
import type { Block, TocHeading, WorkerIn, WorkerOut } from "../../packages/markdown-v2-core/src/types";

type InitConfig = Extract<WorkerIn, { type: "INIT" }>["docPlugins"];

const DEFAULT_INIT: InitConfig = {
  footnotes: true,
  html: true,
  mdx: false, // keep the matrix harness focused and fast; add mdx later with a compile endpoint
  tables: true,
  callouts: true,
  math: true,
  codeHighlighting: "final",
  outputMode: "html",
  emitHighlightTokens: true,
  emitDiffBlocks: false,
  liveTokenization: true,
};

function normalizeBlocks(blocks: ReadonlyArray<Block>): unknown {
  // Strip obviously transient fields and keep a stable subset for parity.
  return blocks.map((b) => ({
    id: b.id,
    type: b.type,
    isFinalized: b.isFinalized,
    payload: {
      raw: typeof b.payload.raw === "string" ? b.payload.raw : "",
      meta: b.payload.meta ?? null,
      // highlightedHtml is stable but large; keep it for code blocks only.
      highlightedHtml: b.type === "code" ? (b.payload.highlightedHtml ?? null) : null,
    },
  }));
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeToc(headings: ReadonlyArray<TocHeading>): unknown {
  return headings.map((h) => ({
    id: h.id,
    text: h.text,
    level: h.level,
    blockId: h.blockId,
  }));
}

function extractMermaidSource(blocks: ReadonlyArray<Block>): string | null {
  for (const block of blocks) {
    if (block.type !== "code") continue;
    const meta = (block.payload.meta ?? {}) as Record<string, unknown>;
    const language = typeof meta.language === "string" ? meta.language : typeof meta.lang === "string" ? meta.lang : "";
    if (language.toLowerCase() !== "mermaid") continue;
    if (typeof meta.code === "string" && meta.code.length > 0) return meta.code;
    if (typeof block.payload.raw === "string" && block.payload.raw.length > 0) return block.payload.raw;
    return "";
  }
  return null;
}

function extractHeadingAnchors(blocks: ReadonlyArray<Block>): Array<{ id: string; text: string; level: number }> {
  const anchors: Array<{ id: string; text: string; level: number }> = [];
  for (const block of blocks) {
    if (block.type !== "heading") continue;
    const meta = (block.payload.meta ?? {}) as Record<string, unknown>;
    const id = typeof meta.headingId === "string" ? meta.headingId : "";
    const text = typeof meta.headingText === "string" ? meta.headingText : "";
    const level = typeof meta.headingLevel === "number" ? meta.headingLevel : 1;
    anchors.push({ id, text, level });
  }
  return anchors;
}

async function runBrowserWorkerOnPage(
  page: import("@playwright/test").Page,
  bundleText: string,
  markdown: string,
  docPlugins: InitConfig,
): Promise<{ blocks: Block[]; tocHeadings: TocHeading[] }> {
  const result = await page.evaluate(
      async ({ bundleText, markdown, docPlugins }) => {
        const blob = new Blob([bundleText], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);

        const worker = new Worker(url);

        const waitFor = <T extends WorkerOut["type"]>(type: T) =>
          new Promise<Extract<WorkerOut, { type: T }>>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 30_000);
            const handler = (e: MessageEvent) => {
              const msg = e.data as WorkerOut;
              if (!msg || typeof msg.type !== "string") return;
              if (msg.type === "ERROR") {
                clearTimeout(timeout);
                worker.removeEventListener("message", handler);
                reject(new Error(`worker error phase=${msg.phase} message=${msg.error?.message || ""}`));
                return;
              }
              if (msg.type === type) {
                clearTimeout(timeout);
                worker.removeEventListener("message", handler);
                resolve(msg as any);
              }
            };
            worker.addEventListener("message", handler);
          });

        worker.postMessage({
          type: "INIT",
          initialContent: markdown,
          prewarmLangs: [],
          docPlugins,
        } satisfies WorkerIn);

        // Wait for initialization and allow the worker to emit the document patch + TOC props.
        await waitFor("INITIALIZED");
        worker.postMessage({ type: "FINALIZE" } satisfies WorkerIn);
        await waitFor("FINALIZED");
        await new Promise((r) => setTimeout(r, 25));

        worker.postMessage({ type: "DUMP_BLOCKS" } satisfies WorkerIn);
        const dump = await waitFor("DUMP_BLOCKS");

        worker.terminate();
        URL.revokeObjectURL(url);

        return { blocks: dump.blocks, tocHeadings: dump.tocHeadings ?? [] };
      },
      { bundleText, markdown, docPlugins },
    );

  return result;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const bundlePath = path.join(repoRoot, "packages/markdown-v2-worker/dist/hosted/markdown-worker.js");

  const fixtureArg = process.argv.find((a) => a.startsWith("--fixture="));
  const fixtures = fixtureArg
    ? [fixtureArg.split("=", 2)[1]]
    : [
        "tests/regression/fixtures/kitchen-sink.md",
        "tests/determinism/fixtures/toc-collisions.md",
      "tests/determinism/fixtures/inline-code-headings.md",
      "tests/determinism/fixtures/heading-slug-policy.md",
      "tests/determinism/fixtures/mixed-html-tables.md",
      "tests/determinism/fixtures/mermaid-fence.md",
    ];

  const bundleText = await readFile(bundlePath, "utf8");

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(`<html><body><div id="ready"></div></body></html>`);
    // Ensure `__name` exists in the evaluation world used by Playwright.
    await page.evaluate("globalThis.__name = (target, name) => target;");

    for (const fixture of fixtures) {
      const fixturePath = path.isAbsolute(fixture) ? fixture : path.join(repoRoot, fixture);
      const markdown = await readFile(fixturePath, "utf8");

      const nodeResult = await compileMarkdownSnapshot({
        text: markdown,
        init: {
          docPlugins: DEFAULT_INIT,
          prewarmLangs: [],
        },
        // Keep determinism stable across runs.
        hashSalt: "determinism-matrix-v2",
        cache: { dir: path.join(repoRoot, ".cache/determinism-matrix"), key: `matrix-v2:${fixture}` },
      });

      const browserResult = await runBrowserWorkerOnPage(page, bundleText, markdown, DEFAULT_INIT);

      const a = normalizeBlocks(nodeResult.blocks);
      const b = normalizeBlocks(browserResult.blocks);
      if (!deepEqualJson(a, b)) {
        throw new Error(
          [
            "Determinism matrix mismatch (blocks):",
            `- fixture: ${fixturePath}`,
            `- node blocks: ${nodeResult.blocks.length}`,
            `- browser blocks: ${browserResult.blocks.length}`,
            "",
            "Tip: re-run with --fixture=... and inspect the first differing block in the JSON.",
          ].join("\n"),
        );
      }

      const nodeToc = nodeResult.artifact.tocHeadings ?? [];
      const browserToc = browserResult.tocHeadings ?? [];
      const tocA = normalizeToc(nodeToc);
      const tocB = normalizeToc(browserToc);
      if (!deepEqualJson(tocA, tocB)) {
        throw new Error(
          [
            "Determinism matrix mismatch (tocHeadings):",
            `- fixture: ${fixturePath}`,
            `- node toc: ${nodeToc.length}`,
            `- browser toc: ${browserToc.length}`,
          ].join("\n"),
        );
      }

      const headingA = extractHeadingAnchors(nodeResult.blocks);
      const headingB = extractHeadingAnchors(browserResult.blocks);
      if (!deepEqualJson(headingA, headingB)) {
        throw new Error(
          [
            "Determinism matrix mismatch (heading anchors):",
            `- fixture: ${fixturePath}`,
            `- node headings: ${headingA.length}`,
            `- browser headings: ${headingB.length}`,
          ].join("\n"),
        );
      }

      // Dedicated sanity check for mermaid fenced blocks: keep source payload parity.
      if (fixturePath.endsWith("mermaid-fence.md")) {
        const nodeMermaid = extractMermaidSource(nodeResult.blocks);
        const browserMermaid = extractMermaidSource(browserResult.blocks);
        if (nodeMermaid === null || browserMermaid === null) {
          throw new Error(`Determinism matrix mismatch (mermaid missing): fixture=${fixturePath}`);
        }
        if (nodeMermaid !== browserMermaid) {
          throw new Error(`Determinism matrix mismatch (mermaid source): fixture=${fixturePath}`);
        }
      }

      process.stdout.write(
        ["[determinism] OK", `fixture=${path.relative(repoRoot, fixturePath)}`, `blocks=${nodeResult.blocks.length}`, `toc=${browserToc.length}`].join(" "),
      );
      process.stdout.write("\n");
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exitCode = 1;
});
