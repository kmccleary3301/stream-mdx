import assert from "node:assert";
import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { blocksStructurallyEqual } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { JSDOM } from "jsdom";

import { createWorkerHarness } from "./worker-test-harness";

function ensureDom(): void {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;
}

function applyPatchMessages(store: ReturnType<typeof createRendererStore>, messages: WorkerOut[]): void {
  for (const msg of messages) {
    if (msg.type !== "PATCH") continue;
    store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }
}

async function createInitializedHarnessStore() {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: {
      footnotes: false,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
      formatAnticipation: true,
      liveCodeHighlighting: false,
    },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to emit INITIALIZED");
  store.reset(init.blocks);
  return { harness, store };
}

function assertMixedSegmentsCanonical(blocks: ReadonlyArray<Block>, label: string): void {
  for (const block of blocks) {
    const meta = block.payload.meta as { mixedSegments?: unknown } | undefined;
    const segments = Array.isArray(meta?.mixedSegments) ? (meta?.mixedSegments as Array<Record<string, unknown>>) : [];
    for (let idx = 0; idx < segments.length; idx++) {
      const segment = segments[idx];
      for (const key of Object.keys(segment)) {
        assert.notStrictEqual(
          segment[key],
          undefined,
          `${label}: block=${block.id} segment=${idx} contains undefined key '${key}'`,
        );
      }
    }
  }
}

async function computeBaseline(doc: string): Promise<Block[]> {
  const { harness, store } = await createInitializedHarnessStore();
  applyPatchMessages(store, await harness.send({ type: "APPEND", text: doc }));
  applyPatchMessages(store, await harness.send({ type: "FINALIZE" }));
  applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: 1 }));
  return store.getBlocks().map((block) => ({
    ...block,
    payload: {
      ...block.payload,
      meta: block.payload.meta ? JSON.parse(JSON.stringify(block.payload.meta)) : undefined,
      range: block.payload.range ? { ...block.payload.range } : undefined,
    },
  }));
}

async function runMixedSegmentCanonicalizationTest(): Promise<void> {
  ensureDom();

  const doc = [
    "# Canonicalization",
    "",
    "Paragraph with <em>inline html</em> and {renderInlineExpression()} then **formatting**.",
    "",
    "> Blockquote with <code>inline tag</code> and {quoteExpr}.",
    "",
    "Another paragraph with <span data-x=\"1\">attributes</span> and {trailingExpression}.",
    "",
  ].join("\n");

  const baseline = await computeBaseline(doc);

  const { harness, store } = await createInitializedHarnessStore();
  for (let i = 0; i < doc.length; i += 17) {
    applyPatchMessages(store, await harness.send({ type: "APPEND", text: doc.slice(i, i + 17) }));
    assertMixedSegmentsCanonical(store.getBlocks(), `stream-chunk-${Math.floor(i / 17)}`);
  }

  applyPatchMessages(store, await harness.send({ type: "FINALIZE" }));
  applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: 1 }));

  const finalBlocks = store.getBlocks();
  assertMixedSegmentsCanonical(finalBlocks, "stream-final");

  assert.strictEqual(finalBlocks.length, baseline.length, "block count mismatch for canonicalization parity");
  for (let i = 0; i < baseline.length; i++) {
    const current = finalBlocks[i];
    const expected = baseline[i];
    assert.ok(current, `missing final block at index ${i}`);
    assert.strictEqual(current.id, expected.id, `final id mismatch at index ${i}`);
    assert.ok(blocksStructurallyEqual(current, expected), `final block diverged at index ${i} (${current.id})`);
  }
}

await runMixedSegmentCanonicalizationTest();
console.log("mixed segment canonicalization regression test passed");
