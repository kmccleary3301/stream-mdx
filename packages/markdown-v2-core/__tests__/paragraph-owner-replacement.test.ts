import assert from "node:assert/strict";
import { applyPatchBatch, createBlockSnapshot, createInitialSnapshot } from "../src/block-snapshot";
import type { ParagraphBlockSnapshot, ParagraphSpanRecord } from "../src/paragraph-records";
import { PATCH_ROOT_ID, type Block, type NodeSnapshot, type Patch } from "../src/types";

function span(
  index: number,
  from: number,
  to: number,
  text: string,
  sourceRevision = 0,
): ParagraphSpanRecord {
  return {
    id: `paragraph-1:span:${index}`,
    index,
    sourceRange: { from, to },
    sourceRevision,
    isProvisional: false,
    nodes: [{ kind: "text", text }],
    attemptedReferences: [],
  };
}

function blockFor(paragraph: ParagraphBlockSnapshot): Block {
  return {
    id: paragraph.paragraphOwnerId,
    type: "paragraph",
    isFinalized: paragraph.state !== "open",
    payload: {
      raw: paragraph.raw,
      inline: paragraph.spans.flatMap((record) => [...record.nodes]),
      range: { ...paragraph.sourceRange },
      meta: { paragraph },
    },
  };
}

function nodeFor(paragraph: ParagraphBlockSnapshot): NodeSnapshot {
  return createBlockSnapshot(blockFor(paragraph));
}

const initial: ParagraphBlockSnapshot = {
  paragraphOwnerId: "paragraph-1",
  generation: 7,
  revision: 4,
  state: "finalized",
  processedTo: 2,
  completeSpanCount: 1,
  spanCount: 1,
  sourceRange: { from: 0, to: 2 },
  spans: [span(0, 0, 2, "ab")],
  raw: "ab",
};
const originalNode = nodeFor(initial);
const snapshot = createInitialSnapshot({
  id: PATCH_ROOT_ID,
  type: "__root__",
  children: [originalNode],
});
const originalBlock = snapshot.getBlocks()[0];
const originalInline = originalBlock?.payload.inline?.[0];
assert.equal(originalInline?.kind === "text" ? originalInline.text : undefined, "ab");

const updatedMeaning: ParagraphBlockSnapshot = {
  ...initial,
  revision: 5,
  spans: [span(0, 0, 2, "updated finalized meaning")],
};
applyPatchBatch(snapshot, [{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: nodeFor(updatedMeaning),
}]);
const updatedInline = snapshot.getBlocks()[0]?.payload.inline?.[0];
assert.equal(updatedInline?.kind === "text" ? updatedInline.text : undefined, "updated finalized meaning");
const historicalInline = originalBlock?.payload.inline?.[0];
assert.equal(historicalInline?.kind === "text" ? historicalInline.text : undefined, "ab", "previously materialized blocks remain historical values");

const extendedMeaning: ParagraphBlockSnapshot = {
  ...updatedMeaning,
  generation: initial.generation + 1,
  revision: 0,
  processedTo: 3,
  completeSpanCount: 2,
  spanCount: 2,
  sourceRange: { from: 0, to: 3 },
  spans: [updatedMeaning.spans[0]!, span(1, 2, 3, "c")],
  raw: "abc",
};
applyPatchBatch(snapshot, [{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: nodeFor({ ...extendedMeaning, generation: initial.generation, revision: updatedMeaning.revision + 1 }),
}]);
assert.equal(snapshot.getBlocks()[0]?.payload.raw, "ab", "a finalized generation cannot admit more authored source");
assert.deepEqual(snapshot.getBlocks()[0]?.payload.inline?.map((node) => node.kind === "text" ? node.text : node.kind), ["updated finalized meaning"]);

applyPatchBatch(snapshot, [{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: nodeFor(extendedMeaning),
}]);
assert.equal(snapshot.getBlocks()[0]?.payload.raw, "abc", "a fresh generation can advance a finalized owner's source frontier");
assert.deepEqual(snapshot.getBlocks()[0]?.payload.inline?.map((node) => node.kind === "text" ? node.text : node.kind), ["updated finalized meaning", "c"]);

applyPatchBatch(snapshot, [{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: originalNode,
}]);
assert.equal(snapshot.getBlocks()[0]?.payload.raw, "abc", "a delayed snapshot cannot roll source back");
assert.deepEqual(snapshot.getBlocks()[0]?.payload.inline?.map((node) => node.kind === "text" ? node.text : node.kind), ["updated finalized meaning", "c"]);

const changedCompletedBytes: ParagraphBlockSnapshot = {
  ...extendedMeaning,
  revision: 7,
  raw: "xbc",
};
applyPatchBatch(snapshot, [{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: nodeFor(changedCompletedBytes),
}]);
assert.equal(snapshot.getBlocks()[0]?.payload.raw, "abc", "same completed span identities cannot rewrite retained source bytes");
assert.deepEqual(snapshot.getBlocks()[0]?.payload.inline?.map((node) => node.kind === "text" ? node.text : node.kind), ["updated finalized meaning", "c"]);

const changedCompletedSource: ParagraphBlockSnapshot = {
  ...extendedMeaning,
  revision: 8,
  spans: [span(0, 0, 2, "source identity changed", 1), extendedMeaning.spans[1]!],
};
applyPatchBatch(snapshot, [{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: nodeFor(changedCompletedSource),
}]);
assert.equal(snapshot.getBlocks()[0]?.payload.raw, "abc", "active replacements cannot rewrite completed source identities");
assert.deepEqual(snapshot.getBlocks()[0]?.payload.inline?.map((node) => node.kind === "text" ? node.text : node.kind), ["updated finalized meaning", "c"]);

applyPatchBatch(snapshot, [{ op: "deleteChild", at: { blockId: PATCH_ROOT_ID }, index: 0 }]);
assert.deepEqual(snapshot.getBlocks(), []);
applyPatchBatch(snapshot, [{
  op: "insertChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: nodeFor(extendedMeaning),
}]);
assert.deepEqual(snapshot.getBlocks(), [], "a removed owner generation cannot be reinserted");

const reopenedGeneration: ParagraphBlockSnapshot = {
  ...extendedMeaning,
  generation: extendedMeaning.generation + 1,
  revision: 0,
};
applyPatchBatch(snapshot, [{
  op: "insertChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: nodeFor(reopenedGeneration),
}]);
assert.equal(snapshot.getBlocks()[0]?.payload.raw, "abc", "a fresh generation may reuse the stable paragraph ID");
assert.deepEqual(snapshot.getBlocks()[0]?.payload.inline?.map((node) => node.kind === "text" ? node.text : node.kind), ["updated finalized meaning", "c"]);

const openSnapshot: ParagraphBlockSnapshot = {
  ...initial,
  generation: 2,
  revision: 0,
  state: "open",
  processedTo: 2,
  completeSpanCount: 1,
  spanCount: 2,
  spans: [span(0, 0, 1, "a"), { ...span(1, 1, 2, "b"), isProvisional: true }],
};
const rootParagraph: NodeSnapshot = {
  id: "paragraph-1",
  type: "paragraph",
  paragraph: openSnapshot,
  props: {},
  children: [],
};
const managedSnapshot = createInitialSnapshot({ id: PATCH_ROOT_ID, type: "__root__", children: [rootParagraph] });
const appended: Extract<Patch, { op: "appendParagraph" }> = {
  op: "appendParagraph",
  at: { blockId: "paragraph-1" },
  paragraphOwnerId: "paragraph-1",
  generation: 2,
  expectedRevision: 0,
  revision: 1,
  sourceAppend: "c",
  fromSpan: 1,
  spans: [{ ...span(1, 1, 3, "bc", 1), isProvisional: true }],
  paragraph: {
    ...openSnapshot,
    revision: 1,
    processedTo: 3,
    sourceRange: { from: 0, to: 3 },
  },
};
const beforeAppend = managedSnapshot.getBlocks()[0];
applyPatchBatch(managedSnapshot, [appended]);
assert.equal(managedSnapshot.getBlocks()[0]?.payload.raw, "abc");
assert.equal(beforeAppend?.payload.raw, "ab", "materialized results do not change after later patches");
const appendedBlock = managedSnapshot.getBlocks()[0];
const semanticUpdate: Extract<Patch, { op: "updateParagraphSpans" }> = {
  op: "updateParagraphSpans",
  at: { blockId: "paragraph-1" },
  paragraphOwnerId: "paragraph-1",
  generation: 2,
  expectedRevision: 1,
  revision: 2,
  updates: [{
    index: 0,
    expectedSourceRevision: 0,
    span: span(0, 0, 1, "resolved reference"),
  }],
  paragraph: { ...appended.paragraph, revision: 2 },
};
applyPatchBatch(managedSnapshot, [semanticUpdate]);
const updatedManagedBlock = managedSnapshot.getBlocks()[0];
const updatedManagedInline = updatedManagedBlock?.payload.inline?.[0];
const historicalAppendedInline = appendedBlock?.payload.inline?.[0];
assert.equal(updatedManagedInline?.kind === "text" ? updatedManagedInline.text : undefined, "resolved reference");
assert.equal(historicalAppendedInline?.kind === "text" ? historicalAppendedInline.text : undefined, "a");
assert.equal(updatedManagedBlock?.payload.raw, "abc");


console.log("paragraph owner replacement test passed");
