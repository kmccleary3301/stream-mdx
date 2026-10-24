import assert from "node:assert";

import { STREAM_MDX_SCHEMA_VERSION, type FootnoteItem, type InlineNode, type Patch, type WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

function findFootnoteNumber(nodes: InlineNode[], label: string): number | undefined {
  for (const node of nodes) {
    if (node.kind === "footnote-ref" && node.label === label) return node.number;
    if ("children" in node && Array.isArray(node.children)) {
      const nested = findFootnoteNumber(node.children, label);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

const harness = await createWorkerHarness();
const store = createRendererStore();
const apply = (messages: WorkerOut[]): void => {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
    else if (message.type === "ERROR") throw new Error(message.error.message);
  }
};

apply(await harness.send({
  type: "INIT",
  schemaVersion: STREAM_MDX_SCHEMA_VERSION,
  initialContent: "",
  prewarmLangs: [],
  docPlugins: { footnotes: true, html: false, mdx: false, tables: false, callouts: false },
}));
apply(await harness.send({ type: "APPEND", text: "A reference[^later]." }));
apply(await harness.send({ type: "FINALIZE" }));
const finalizedParagraph = store.getBlocks().find(
  (block) => block.type === "paragraph" && block.payload.raw === "A reference[^later].",
);
assert.ok(finalizedParagraph?.isFinalized, "the referenced paragraph must finalize before its definition arrives");

apply(await harness.send({ type: "APPEND", text: "\n\n[^later]: Authored after the paragraph finalized." }));
apply(await harness.send({ type: "FINALIZE" }));

const blocks = store.getBlocks();
const paragraph = blocks.find(
  (block) => block.type === "paragraph" && block.payload.raw === "A reference[^later].",
);
assert.ok(paragraph, "the earlier paragraph must remain in the consumer store");
const footnotes = blocks.find((block) => block.type === "footnotes");
assert.ok(footnotes, "a definition appended after paragraph finalization must publish a footer");
assert.strictEqual(findFootnoteNumber(paragraph.payload.inline ?? [], "later"), 1);
const items = footnotes.payload.meta?.items as FootnoteItem[];
assert.deepStrictEqual(items.map(({ label, number }) => [label, number]), [["later", 1]]);
assert.ok(
  items[0]?.inlines.some((node) => node.kind === "text" && node.text.includes("Authored after the paragraph finalized.")),
  "the footer must contain the later definition body",
);
console.log("worker-root-footnote-late-definition test passed");
