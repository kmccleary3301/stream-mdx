import assert from "node:assert/strict";
import { applyPatchBatch, createInitialSnapshot } from "../src/block-snapshot";
import { PATCH_ROOT_ID, type NodeSnapshot } from "../src/types";
import type { ParagraphBlockSnapshot, ParagraphSpanRecord } from "../src/paragraph-records";

function span(
  ownerId: string,
  index: number,
  from: number,
  to: number,
  text: string,
): ParagraphSpanRecord {
  return {
    id: `${ownerId}:span:${index}`,
    index,
    sourceRange: { from, to },
    sourceRevision: 0,
    isProvisional: false,
    nodes: [{ kind: "text", text }],
    attemptedReferences: [],
  };
}

function paragraphSnapshot(
  ownerId: string,
  raw: string,
  from: number,
  generation: number,
  text = raw,
): ParagraphBlockSnapshot {
  return {
    paragraphOwnerId: ownerId,
    generation,
    revision: 0,
    state: "closed",
    processedTo: from + raw.length,
    completeSpanCount: 1,
    spanCount: 1,
    sourceRange: { from, to: from + raw.length },
    spans: [span(ownerId, 0, from, from + raw.length, text)],
    raw,
  };
}

const appendText = "\n[reference]: /target";
const baseline: NodeSnapshot = {
  id: PATCH_ROOT_ID,
  type: "__root__",
  range: { from: 0, to: 2 },
  inputSource: { generation: 18, raw: "ab" },
  children: [
    {
      id: "paragraph-1",
      type: "paragraph",
      range: { from: 0, to: 2 },
      paragraph: paragraphSnapshot("paragraph-1", "ab", 0, 4),
    },
  ],
};
const snapshot = createInitialSnapshot(baseline);
const initialBlocks = snapshot.getBlocks();
const originalNode = snapshot.nodes.get("paragraph-1");
assert.ok(originalNode?.paragraphState);
const originalWindow = originalNode.paragraphState.sourceSnapshot;

applyPatchBatch(snapshot, [
  {
    op: "appendInputSource",
    at: { blockId: PATCH_ROOT_ID },
    generation: 18,
    from: 1,
    text: "stale point",
  },
  {
    op: "appendInputSource",
    at: { blockId: PATCH_ROOT_ID },
    generation: 17,
    from: 2,
    text: "wrong generation",
  },
]);
assert.strictEqual(snapshot.nodes.get("paragraph-1"), originalNode, "rejected input operations do not mutate semantic nodes");
assert.strictEqual(snapshot.getBlocks(), initialBlocks, "rejected input operations do not rebuild root children");

applyPatchBatch(snapshot, [{
  op: "appendInputSource",
  at: { blockId: PATCH_ROOT_ID },
  generation: 18,
  from: 2,
  text: appendText,
}]);
assert.strictEqual(snapshot.nodes.get("paragraph-1"), originalNode, "input-only appends retain semantic node identity");
assert.strictEqual(snapshot.getBlocks(), initialBlocks, "input-only appends do not complete semantic work");
assert.equal(originalWindow.materialize(), "ab", "captured source windows stay immutable after input growth");

applyPatchBatch(snapshot, [{
  op: "updateParagraphSpans",
  at: { blockId: "paragraph-1" },
  paragraphOwnerId: "paragraph-1",
  generation: 4,
  expectedRevision: 0,
  revision: 1,
  updates: [{
    index: 0,
    expectedSourceRevision: 0,
    span: span("paragraph-1", 0, 0, 2, "meaning-only update"),
  }],
  paragraph: {
    ...paragraphSnapshot("paragraph-1", "ab", 0, 4),
    revision: 1,
  },
}]);
const updatedNode = snapshot.nodes.get("paragraph-1");
assert.ok(updatedNode?.paragraphState);
assert.strictEqual(updatedNode.paragraphState.sourceSnapshot, originalWindow, "same-bounds meaning updates retain the source window");
assert.equal(snapshot.getBlocks()[0]?.payload.raw, "ab", "meaning updates do not absorb later reference definitions");

applyPatchBatch(snapshot, [{
  op: "insertChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 1,
  node: {
    id: "paragraph-2",
    type: "paragraph",
    range: { from: 2, to: 2 + appendText.length },
    paragraph: paragraphSnapshot("paragraph-2", appendText, 2, 1),
  },
}]);
assert.equal(snapshot.getBlocks()[1]?.payload.raw, appendText, "the next valid source window reads bytes admitted after the baseline");
console.log("canonical input source test passed");
