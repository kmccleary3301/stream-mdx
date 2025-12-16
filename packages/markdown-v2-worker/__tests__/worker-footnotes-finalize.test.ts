import assert from "node:assert";

import type { Patch, WorkerOut } from "@stream-mdx/core";
import type { Block, InlineNode } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

function findInlineFootnoteNumber(nodes: InlineNode[], label: string): number | undefined {
  for (const node of nodes) {
    if (node.kind === "footnote-ref" && node.label === label) {
      return node.number;
    }
    if ("children" in node && Array.isArray(node.children)) {
      const nested = findInlineFootnoteNumber(node.children, label);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

async function runFootnotesFinalizeTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true },
  });
  const init = initMessages.find((m) => m.type === "INITIALIZED") as Extract<WorkerOut, { type: "INITIALIZED" }> | undefined;
  assert.ok(init, "worker did not emit INITIALIZED message");
  store.reset(init.blocks);

  const content = [
    "> This is a blockquote with a footnote.[^1]\\",
    "> Second line",
    "",
    "",
    "[^1]: This is the definition for the footnote.",
    "",
  ].join("\n");

  const appendMessages = await harness.send({ type: "APPEND", text: content });
  const appendPatches = appendMessages.filter((m): m is Extract<WorkerOut, { type: "PATCH" }> => m.type === "PATCH");
  assert.ok(appendPatches.length > 0, "missing patch message after append");
  for (const patchMsg of appendPatches) {
    store.applyPatches(patchMsg.patches as Patch[], { captureMetrics: false });
  }

  const blocksBeforeFinalize = store.getBlocks();
  assert.ok(blocksBeforeFinalize.some((block) => !block.isFinalized), "expected dirty blocks prior to FINALIZE");
  assert.ok(!blocksBeforeFinalize.some((block) => block.type === "footnotes"), "synthetic footnotes block should not appear while tail is dirty");

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  const finalizePatchMessages = finalizeMessages.filter((m): m is Extract<WorkerOut, { type: "PATCH" }> => m.type === "PATCH");
  assert.ok(finalizePatchMessages.length > 0, "FINALIZE should emit PATCH message when blocks are dirty");
  for (const patchMsg of finalizePatchMessages) {
    store.applyPatches(patchMsg.patches as Patch[], { captureMetrics: false });
  }

  const blocksAfterFinalize = store.getBlocks();
  const footnotesBlock = blocksAfterFinalize.find((block) => block.type === "footnotes") as Block | undefined;
  assert.ok(footnotesBlock, "expected synthetic footnotes block after FINALIZE");
  const meta = (footnotesBlock.payload.meta ?? {}) as { items?: Array<{ number: number; label: string; inlines: InlineNode[] }> };
  assert.ok(Array.isArray(meta.items) && meta.items.length === 1, "expected exactly one footnote item");
  assert.strictEqual(meta.items[0]?.number, 1, "footnote item should be numbered");
  assert.strictEqual(meta.items[0]?.label, "1", "footnote label should be preserved");

  const quoteBlock = blocksAfterFinalize.find((block) => block.type === "blockquote");
  assert.ok(quoteBlock, "expected blockquote to be present after finalize");
  const quoteMeta = (quoteBlock.payload.meta ?? {}) as { mixedSegments?: Array<{ inline?: InlineNode[] }> };
  const segments = Array.isArray(quoteMeta.mixedSegments) ? quoteMeta.mixedSegments : [];
  assert.ok(segments.length > 0, "expected blockquote mixedSegments to be present");
  const segmentInline = segments.flatMap((segment) => (Array.isArray(segment.inline) ? segment.inline : []));
  const numberFromSegments = findInlineFootnoteNumber(segmentInline, "1");
  assert.strictEqual(numberFromSegments, 1, "footnote number should be assigned inside mixedSegments inline nodes");
}

await runFootnotesFinalizeTest();
console.log("worker-footnotes-finalize test passed");

