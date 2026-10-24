import assert from "node:assert/strict";
import {
  PATCH_ROOT_ID,
  type NodeSnapshot,
  type ParagraphBlockSnapshot,
  type ParagraphSpanRecord,
} from "@stream-mdx/core";
import { createRendererStore } from "../src/renderer/store";

function span(
  index: number,
  from: number,
  to: number,
  text: string,
  sourceRevision = 0,
  isProvisional = false,
): ParagraphSpanRecord {
  return {
    id: `paragraph-1:span:${index}`,
    index,
    sourceRange: { from, to },
    sourceRevision,
    isProvisional,
    nodes: [{ kind: "text", text }],
    attemptedReferences: [],
  };
}

function paragraphNode(paragraph: ParagraphBlockSnapshot): NodeSnapshot {
  return { id: "paragraph-1", type: "paragraph", paragraph, props: {}, children: [] };
}

function rootSnapshot(paragraph: ParagraphBlockSnapshot): NodeSnapshot {
  return { id: PATCH_ROOT_ID, type: "__root__", props: {}, children: [paragraphNode(paragraph)] };
}

const completedParagraph: ParagraphBlockSnapshot = {
  paragraphOwnerId: "paragraph-1",
  generation: 4,
  revision: 0,
  state: "finalized",
  processedTo: 2,
  completeSpanCount: 1,
  spanCount: 1,
  sourceRange: { from: 0, to: 2 },
  spans: [span(0, 0, 2, "ab")],
  raw: "ab",
};
const regressedParagraph: ParagraphBlockSnapshot = {
  ...completedParagraph,
  revision: 1,
  processedTo: 1,
  sourceRange: { from: 0, to: 1 },
  spans: [span(0, 0, 1, "x")],
  raw: "x",
};

for (const op of ["insertChild", "replaceChild"] as const) {
  const store = createRendererStore();
  store.resetSnapshot(rootSnapshot(completedParagraph));
  store.applyPatches([op === "insertChild"
    ? { op, at: { blockId: PATCH_ROOT_ID }, index: 0, node: paragraphNode(regressedParagraph) }
    : { op, at: { blockId: PATCH_ROOT_ID }, index: 0, node: paragraphNode(regressedParagraph) }]);

  const block = store.getBlocks()[0];
  assert.equal(block?.payload.raw, "ab", `${op} must preserve the accepted paragraph source`);
  assert.deepEqual(block?.payload.inline?.map((node) => node.kind === "text" ? node.text : node.kind), ["ab"]);
  assert.equal(store.getParagraphBlock("paragraph-1")?.source.processedTo, 2, `${op} must preserve the accepted source frontier`);

  const grownParagraph: ParagraphBlockSnapshot = {
    ...completedParagraph,
    revision: 1,
    processedTo: 3,
    completeSpanCount: 2,
    spanCount: 2,
    sourceRange: { from: 0, to: 3 },
    spans: [...completedParagraph.spans, span(1, 2, 3, "c")],
    raw: "abc",
  };
  store.applyPatches([{ op, at: { blockId: PATCH_ROOT_ID }, index: 0, node: paragraphNode(grownParagraph) }]);
  assert.deepEqual(store.getBlocks().map((candidate) => candidate.payload.raw), ["ab"], `${op} cannot grow finalized source in the same generation`);
  store.applyPatches([{
    op,
    at: { blockId: PATCH_ROOT_ID },
    index: 0,
    node: paragraphNode({ ...grownParagraph, generation: completedParagraph.generation + 1, state: "open" }),
  }]);
  assert.deepEqual(store.getBlocks().map((candidate) => candidate.payload.raw), ["abc"], `${op} may reopen source in a fresh generation`);
  assert.equal(store.getBlocks()[0]?.isFinalized, false);
}

const semanticStore = createRendererStore();
semanticStore.resetSnapshot(rootSnapshot(completedParagraph));
semanticStore.applyPatches([{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: paragraphNode({
    ...completedParagraph,
    revision: 1,
    spans: [{
      ...span(0, 0, 2, "resolved reference"),
      nodes: [{ kind: "footnote-ref", label: "note", number: 2 }],
    }],
  }),
}]);
assert.equal(semanticStore.getBlocks()[0]?.payload.raw, "ab", "semantic replacement must retain authored source");
const footnoteMeaning = semanticStore.getBlocks()[0]?.payload.inline?.[0];
assert.equal(
  footnoteMeaning?.kind === "footnote-ref" ? footnoteMeaning.number : undefined,
  2,
  "same-source semantic revision must publish its new reference number",
);
assert.deepEqual(
  semanticStore.getBlocks()[0]?.payload.inline?.map((node) => node.kind === "text" ? node.text : node.kind),
  ["footnote-ref"],
  "same-source semantic replacement must publish its updated meaning",
);

const openParagraph: ParagraphBlockSnapshot = {
  ...completedParagraph,
  generation: 9,
  revision: 0,
  state: "open",
  completeSpanCount: 0,
  spans: [span(0, 0, 2, "ab", 0, true)],
};
const finalizeStore = createRendererStore();
finalizeStore.resetSnapshot(rootSnapshot(openParagraph));
finalizeStore.applyPatches([{ op: "finalize", at: { blockId: "paragraph-1" } }]);

const finalizedState = finalizeStore.getParagraphBlock("paragraph-1");
assert.ok(finalizedState, "direct finalize must preserve the managed paragraph owner");
assert.equal(finalizedState.source.paragraphOwnerId, "paragraph-1");
assert.equal(finalizedState.source.generation, 9);
assert.equal(finalizedState.source.state, "finalized");
assert.equal(finalizeStore.hasProvisionalBlocks(), false);
const finalizedBlock = finalizeStore.getBlocks()[0];
assert.equal(finalizedBlock?.payload.raw, "ab", "direct finalize must preserve the actual authored body");
assert.deepEqual(finalizedBlock?.payload.inline?.map((node) => node.kind === "text" ? node.text : node.kind), ["ab"]);
assert.equal(finalizeStore.getNode("paragraph-1")?.block?.payload.raw, "ab", "native node access must expose managed source on demand");

finalizeStore.applyPatches([{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: paragraphNode({
    ...openParagraph,
    revision: 2,
    state: "finalized",
    completeSpanCount: 1,
    spans: [span(0, 0, 2, "finalized semantic update", 1)],
  }),
}]);
assert.equal(finalizeStore.getBlocks()[0]?.payload.raw, "ab", "finalized semantic updates must retain source bytes");
assert.deepEqual(
  finalizeStore.getBlocks()[0]?.payload.inline?.map((node) => node.kind === "text" ? node.text : node.kind),
  ["finalized semantic update"],
  "a finalized owner must still accept valid same-source semantic replacement",
);

console.log("paragraph store owner replacement test passed");
