import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { JSDOM } from "jsdom";
import { createWorkerHarness, type WorkerHarness } from "./worker-test-harness";

interface GlobalDomScope {
  window?: unknown;
  document?: unknown;
  HTMLElement?: unknown;
  Node?: unknown;
}

function ensureDom(): void {
  const globalScope = globalThis as unknown as GlobalDomScope;
  if (typeof globalScope.window !== "undefined") {
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalScope.window = dom.window;
  globalScope.document = dom.window.document;
  globalScope.HTMLElement = dom.window.HTMLElement;
  globalScope.Node = dom.window.Node;
}

ensureDom();

function normalizeBlockForParity(block: Block) {
  return {
    id: block.id,
    type: block.type,
    isFinalized: block.isFinalized,
    payload: {
      raw: block.payload.raw,
      range: block.payload.range ? { from: block.payload.range.from, to: block.payload.range.to } : null,
      inline: block.payload.inline,
      meta: block.payload.meta,
    },
  };
}

// Deterministic pseudo-random number generator
function createRng(seed = 123456789) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

async function runSession(harness: WorkerHarness, chunks: string[]): Promise<Block[]> {
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true },
  });
  const init = initMessages.find((m) => m.type === "INITIALIZED") as Extract<WorkerOut, { type: "INITIALIZED" }>;
  store.reset(init.blocks);

  for (const chunk of chunks) {
    const appendMessages = await harness.send({ type: "APPEND", text: chunk });
    for (const msg of appendMessages) {
      if (msg.type === "PATCH") {
        store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
      }
    }
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  for (const msg of finalizeMessages) {
    if (msg.type === "PATCH") {
      store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
    }
  }

  return store.getBlocks();
}

async function runParityTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const fixturesDir = join(import.meta.dirname, "../../../apps/docs/public/perf/fixtures");
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".md")).sort();
  assert.ok(files.length > 0, "expected fixtures to be found");

  const rng = createRng(42);

  for (const file of files) {
    const content = readFileSync(join(fixturesDir, file), "utf8");
    if (!content.trim()) continue;

    // 1. Single-shot parse
    const singleShotBlocks = await runSession(harness, [content]);

    // 2. Random chunking parse
    const chunks: string[] = [];
    let pos = 0;
    while (pos < content.length) {
      const chunkSize = Math.max(16, Math.floor(rng() * 112) + 16);
      chunks.push(content.slice(pos, pos + chunkSize));
      pos += chunkSize;
    }

    const streamedBlocks = await runSession(harness, chunks);

    const normSingle = singleShotBlocks.map(normalizeBlockForParity);
    const normStreamed = streamedBlocks.map(normalizeBlockForParity);

    assert.strictEqual(
      normStreamed.length,
      normSingle.length,
      `block count mismatch for fixture ${file}: streamed=${normStreamed.length} single=${normSingle.length}`,
    );

    assert.deepStrictEqual(
      normStreamed,
      normSingle,
      `blocks differ between random chunking and single-shot parse for fixture ${file}`,
    );
  }

  console.log("incremental-chunking-parity test passed");
}

await runParityTest();
