import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WorkerOut } from "@stream-mdx/core";
import { createRendererStore, type RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness, type WorkerHarness } from "./worker-test-harness";


// Deterministic pseudo-random number generator
function createRng(seed = 123456789) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

async function runSession(harness: WorkerHarness, chunks: string[]): Promise<RendererStore> {
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: ["typescript"],
    docPlugins: { footnotes: true, html: true, mdx: true, math: true, tables: true, callouts: true },
    mdx: { compileMode: "worker" },
  });
  assertNoErrors(initMessages);
  const init = initMessages.find((m): m is Extract<WorkerOut, { type: "INITIALIZED" }> => m.type === "INITIALIZED");
  assert.ok(init, "worker must initialize before applying patches");
  store.reset(init.blocks);
  for (const msg of initMessages) {
    if (msg.type === "PATCH") store.applyPatches(msg.patches, { captureMetrics: false });
  }

  for (const chunk of chunks) {
    const appendMessages = await harness.send({ type: "APPEND", text: chunk });
    assertNoErrors(appendMessages);
    for (const msg of appendMessages) {
      if (msg.type === "PATCH") {
        store.applyPatches(msg.patches, { captureMetrics: false });
      }
    }
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  assertNoErrors(finalizeMessages);
  for (const msg of finalizeMessages) {
    if (msg.type === "PATCH") {
      store.applyPatches(msg.patches, { captureMetrics: false });
    }
  }

  assert.strictEqual(finalizeMessages.at(-1)?.type, "FINALIZED", "final store requires terminal FINALIZED after all patches");
  assert.ok(store.getBlocks().every((block) => block.isFinalized), "terminal blocks must all be finalized");
  return store;
}


function assertNoErrors(messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "ERROR") {
      assert.fail(`Worker error during ${message.phase}: ${message.error.message}`);
    }
  }
}


async function runParityTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const fixturesDir = join(import.meta.dirname, "../../../apps/docs/public/perf/fixtures");
  // stress-xl (1 MB) is a throughput fixture: same generator and feature mix as the 250 KB stress-mega
  // documents covered here, so random 16-128 char chunking of it (~14k appends) adds cost, not coverage.
  const MAX_PARITY_FIXTURE_BYTES = 300_000;
  const files = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".md") && statSync(join(fixturesDir, f)).size <= MAX_PARITY_FIXTURE_BYTES)
    .sort();
  assert.ok(files.length > 0, "expected fixtures to be found");

  const rng = createRng(42);

  for (const file of files) {
    const content = readFileSync(join(fixturesDir, file), "utf8");
    if (!content.trim()) continue;

    // 1. Single-shot parse
    const singleShotStore = await runSession(harness, [content]);

    // 2. Random chunking parse
    const chunks: string[] = [];
    let pos = 0;
    while (pos < content.length) {
      const chunkSize = Math.max(16, Math.floor(rng() * 112) + 16);
      chunks.push(content.slice(pos, pos + chunkSize));
      pos += chunkSize;
    }

    const streamedStore = await runSession(harness, chunks);
    const singleShotBlocks = singleShotStore.getBlocks();
    const streamedBlocks = streamedStore.getBlocks();

    assert.strictEqual(
      streamedBlocks.length,
      singleShotBlocks.length,
      `block count mismatch for fixture ${file}: streamed=${streamedBlocks.length} single=${singleShotBlocks.length}`,
    );

    assert.deepStrictEqual(
      streamedBlocks,
      singleShotBlocks,
      `blocks differ between random chunking and single-shot parse for fixture ${file}`,
    );
  }

  console.log("incremental-chunking-parity test passed");
}

await runParityTest();
