import assert from "node:assert/strict";
import {
  appendManagedParagraphSpans,
  createManagedParagraphState,
  materializeManagedParagraphSnapshot,
  updateManagedParagraphSpans,
} from "../src/paragraph-block-state";
import type { ParagraphBlockSnapshot, ParagraphBlockSourceMetadata, ParagraphSpanRecord } from "../src/paragraph-records";
import type { Patch } from "../src/types";

function metadata(overrides: Partial<ParagraphBlockSourceMetadata> = {}): ParagraphBlockSourceMetadata {
  return {
    paragraphOwnerId: "paragraph-1",
    generation: 3,
    revision: 0,
    state: "open",
    processedTo: 2,
    completeSpanCount: 1,
    spanCount: 2,
    sourceRange: { from: 0, to: 2 },
    ...overrides,
  };
}

function span(
  index: number,
  from: number,
  to: number,
  sourceRevision: number,
  isProvisional: boolean,
  text: string,
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

function initialSnapshot(): ParagraphBlockSnapshot {
  return {
    ...metadata(),
    spans: [span(0, 0, 1, 0, false, "a"), span(1, 1, 2, 0, true, "b")],
    raw: "ab",
  };
}

function appendPatch(
  expectedRevision: number,
  revision: number,
  sourceAppend: string,
  fromSpan: number,
  spans: readonly ParagraphSpanRecord[],
  paragraph: ParagraphBlockSourceMetadata,
): Extract<Patch, { op: "appendParagraph" }> {
  return {
    op: "appendParagraph",
    at: { blockId: "paragraph-1" },
    paragraphOwnerId: "paragraph-1",
    generation: 3,
    expectedRevision,
    revision,
    sourceAppend,
    fromSpan,
    spans,
    paragraph,
  };
}

const state0 = createManagedParagraphState(initialSnapshot(), "paragraph-1");
const historical0 = materializeManagedParagraphSnapshot(state0);
const nextOpen = metadata({ revision: 1, processedTo: 3, spanCount: 2, sourceRange: { from: 0, to: 3 } });
const appendResult = appendManagedParagraphSpans(
  state0,
  "paragraph-1",
  appendPatch(0, 1, "c", 1, [span(1, 1, 3, 1, true, "bc")], nextOpen),
);
assert.ok("state" in appendResult);
const state1 = appendResult.state;
assert.strictEqual(state1.spans.get(0), state0.spans.get(0), "ordinary append preserves completed span identity");
assert.equal(materializeManagedParagraphSnapshot(state1).raw, "abc");
assert.equal(historical0.raw, "ab", "later source appends do not alter historical snapshots");
assert.equal(state0.sourceSnapshot.materialize(), "ab", "historical source readers stay bounded to their own frontier");

const offsetState = createManagedParagraphState({
  ...initialSnapshot(),
  sourceRange: { from: 10, to: 12 },
  processedTo: 12,
  spans: [span(0, 10, 11, 0, false, "a"), span(1, 11, 12, 0, true, "b")],
}, "paragraph-1");
const offsetAppend = appendManagedParagraphSpans(
  offsetState,
  "paragraph-1",
  appendPatch(0, 1, "c", 1, [span(1, 11, 13, 1, true, "bc")], metadata({
    revision: 1,
    processedTo: 13,
    sourceRange: { from: 10, to: 13 },
  })),
);
assert.ok("state" in offsetAppend, "paragraphs at nonzero document offsets accept contiguous source growth");
const offsetSnapshot = materializeManagedParagraphSnapshot(offsetAppend.state);
assert.equal(offsetSnapshot.raw, "abc");
assert.deepEqual(offsetSnapshot.sourceRange, { from: 10, to: 13 });
assert.equal(materializeManagedParagraphSnapshot(offsetState).raw, "ab");

const retractableState = createManagedParagraphState(initialSnapshot(), "paragraph-1");
const retracted = appendManagedParagraphSpans(
  retractableState,
  "paragraph-1",
  appendPatch(0, 1, "", 1, [], metadata({
    revision: 1,
    state: "closed",
    spanCount: 1,
    sourceRange: { from: 0, to: 1 },
  })),
);
assert.ok("state" in retracted, "closing a paragraph may return its provisional source tail to the document parser");
const retractedSnapshot = materializeManagedParagraphSnapshot(retracted.state);
assert.equal(retractedSnapshot.raw, "a");
assert.equal(retractedSnapshot.state, "closed");
assert.deepEqual(retractedSnapshot.spans.map((record) => record.nodes), [[{ kind: "text", text: "a" }]]);
assert.equal(materializeManagedParagraphSnapshot(retractableState).raw, "ab");

const progressState = createManagedParagraphState(initialSnapshot(), "paragraph-1");
const progressed = appendManagedParagraphSpans(
  progressState,
  "paragraph-1",
  appendPatch(0, 1, "", 2, [], metadata({ revision: 1, processedTo: 3 })),
);
assert.ok("state" in progressed, "open paragraphs may advance their inspected document frontier without replacing provisional source");
const progressedSnapshot = materializeManagedParagraphSnapshot(progressed.state);
assert.equal(progressedSnapshot.raw, "ab");
assert.equal(progressedSnapshot.processedTo, 3);
assert.deepEqual(progressedSnapshot.spans.map((record) => record.nodes), [
  [{ kind: "text", text: "a" }],
  [{ kind: "text", text: "b" }],
]);
assert.equal(progressed.state.sourceSnapshot.materialize(), "ab");
assert.equal(progressState.source.processedTo, 2);

const revisionGap = appendManagedParagraphSpans(
  createManagedParagraphState(initialSnapshot(), "paragraph-1"),
  "paragraph-1",
  appendPatch(0, 2, "c", 1, [span(1, 1, 3, 1, true, "bc")], metadata({
    revision: 2,
    processedTo: 3,
    sourceRange: { from: 0, to: 3 },
  })),
);
assert.ok("reason" in revisionGap, "an append may not skip an owner revision even when its expected revision is current");

const provisionalState = createManagedParagraphState({
  ...initialSnapshot(),
  completeSpanCount: 0,
  spanCount: 1,
  spans: [span(0, 0, 2, 0, true, "ab")],
}, "paragraph-1");
const provisionalAppend = appendManagedParagraphSpans(
  provisionalState,
  "paragraph-1",
  appendPatch(0, 1, "c", 0, [span(0, 0, 3, 1, true, "abc")], metadata({
    revision: 1,
    processedTo: 3,
    completeSpanCount: 0,
    spanCount: 1,
    sourceRange: { from: 0, to: 3 },
  })),
);
assert.ok("state" in provisionalAppend, "paragraphs with no completed spans may grow their first provisional span");
const provisionalSnapshot = materializeManagedParagraphSnapshot(provisionalAppend.state);
assert.equal(provisionalSnapshot.raw, "abc");
assert.deepEqual(provisionalSnapshot.spans.map((record) => record.nodes), [[{ kind: "text", text: "abc" }]]);
assert.equal(materializeManagedParagraphSnapshot(provisionalState).raw, "ab");

const foreignOwnerProgress = appendManagedParagraphSpans(
  createManagedParagraphState(initialSnapshot(), "paragraph-1"),
  "paragraph-1",
  appendPatch(0, 1, "", 2, [], metadata({ paragraphOwnerId: "paragraph-other", revision: 1 })),
);
assert.ok("reason" in foreignOwnerProgress, "metadata-only progress cannot transfer a paragraph to a different source owner");

const regressingFrontier = appendManagedParagraphSpans(
  state0,
  "paragraph-1",
  appendPatch(0, 1, "c", 1, [span(1, 1, 3, 1, true, "bc")], { ...nextOpen, processedTo: 1 }),
);
assert.ok("reason" in regressingFrontier, "processed frontiers cannot regress");

const mismatchedSourceLength = appendManagedParagraphSpans(
  state0,
  "paragraph-1",
  appendPatch(0, 1, "c", 1, [span(1, 1, 3, 1, true, "bc")], {
    ...nextOpen,
    sourceRange: { from: 0, to: 4 },
  }),
);
assert.ok("reason" in mismatchedSourceLength, "source range advancement must match appended source");

const overlappingTail = appendManagedParagraphSpans(
  state0,
  "paragraph-1",
  appendPatch(0, 1, "c", 1, [span(1, 0, 3, 1, true, "abc")], nextOpen),
);
assert.ok("reason" in overlappingTail, "replacement spans must remain contiguous after the completed prefix");

const staleAppend = appendManagedParagraphSpans(
  state1,
  "paragraph-1",
  appendPatch(0, 2, "d", 1, [span(1, 1, 4, 2, true, "bcd")], {
    ...nextOpen,
    revision: 2,
    processedTo: 4,
    sourceRange: { from: 0, to: 4 },
  }),
);
assert.ok("reason" in staleAppend, "stale owner revisions are rejected");
assert.equal(materializeManagedParagraphSnapshot(state1).raw, "abc");

const foreignGenerationAppend = appendManagedParagraphSpans(
  state1,
  "paragraph-1",
  {
    ...appendPatch(1, 2, "d", 1, [span(1, 1, 4, 2, true, "bcd")], {
      ...nextOpen,
      revision: 2,
      processedTo: 4,
      sourceRange: { from: 0, to: 4 },
    }),
    generation: 4,
  },
);
assert.ok("reason" in foreignGenerationAppend, "an otherwise current append from a different generation must be refused");

const wronglyAddressedState = createManagedParagraphState(initialSnapshot(), "paragraph-1");
const wronglyAddressedAppend = appendManagedParagraphSpans(
  wronglyAddressedState,
  "another-paragraph",
  appendPatch(0, 1, "c", 1, [span(1, 1, 3, 1, true, "bc")], nextOpen),
);
assert.ok("reason" in wronglyAddressedAppend, "an append addressed to another owner must not change this paragraph");

const relabeledState = createManagedParagraphState(initialSnapshot(), "paragraph-1");
const relabeledGeneration = appendManagedParagraphSpans(
  relabeledState,
  "paragraph-1",
  appendPatch(0, 1, "c", 1, [span(1, 1, 3, 1, true, "bc")], { ...nextOpen, generation: 4 }),
);
assert.ok("reason" in relabeledGeneration, "current-envelope metadata cannot relabel the paragraph into a different generation");

const revisionState = createManagedParagraphState(initialSnapshot(), "paragraph-1");
const conflictingRevision = appendManagedParagraphSpans(
  revisionState,
  "paragraph-1",
  appendPatch(0, 1, "c", 1, [span(1, 1, 3, 1, true, "bc")], { ...nextOpen, revision: 2 }),
);
assert.ok("reason" in conflictingRevision, "source metadata and append envelope must agree on the committed revision");

const closed = metadata({ revision: 2, state: "closed", processedTo: 3, completeSpanCount: 2, spanCount: 2, sourceRange: { from: 0, to: 3 } });
const closeResult = appendManagedParagraphSpans(
  state1,
  "paragraph-1",
  appendPatch(1, 2, "", 1, [span(1, 1, 3, 2, false, "bc")], closed),
);
assert.ok("state" in closeResult);
const state2 = closeResult.state;
assert.equal(state2.source.state, "closed");

const closedMeaning = span(0, 0, 1, 0, false, "resolved while closed");
const closedUpdate = updateManagedParagraphSpans(state2, "paragraph-1", {
  op: "updateParagraphSpans",
  at: { blockId: "paragraph-1" },
  paragraphOwnerId: "paragraph-1",
  generation: 3,
  expectedRevision: 2,
  revision: 3,
  updates: [{ index: 0, expectedSourceRevision: 0, span: closedMeaning }],
  paragraph: { ...closed, revision: 3 },
});
assert.ok("state" in closedUpdate, "closed paragraphs may receive source-preserving semantic updates");
const state3 = closedUpdate.state;
const closedHistoryText = state2.spans.get(0)?.nodes[0];
const closedUpdatedText = materializeManagedParagraphSnapshot(state3).spans[0]?.nodes[0];
assert.equal(closedHistoryText?.kind === "text" ? closedHistoryText.text : undefined, "a");
assert.equal(closedUpdatedText?.kind === "text" ? closedUpdatedText.text : undefined, "resolved while closed");

const finalized = { ...closed, revision: 4, state: "finalized" as const };
const finalizeResult = appendManagedParagraphSpans(
  state3,
  "paragraph-1",
  appendPatch(3, 4, "", 2, [], finalized),
);
assert.ok("state" in finalizeResult);
const state4 = finalizeResult.state;
assert.equal(state4.source.state, "finalized");

const growthAfterFinalization = appendManagedParagraphSpans(
  state4,
  "paragraph-1",
  appendPatch(4, 5, "d", 2, [span(2, 3, 4, 5, false, "d")], {
    ...finalized,
    revision: 5,
    processedTo: 4,
    completeSpanCount: 3,
    spanCount: 3,
    sourceRange: { from: 0, to: 4 },
  }),
);
assert.ok("reason" in growthAfterFinalization, "a finalized paragraph cannot acquire more source in the same generation");

const finalizedMeaning = span(0, 0, 1, 0, false, "resolved after finalization");
const finalizedUpdate = updateManagedParagraphSpans(state4, "paragraph-1", {
  op: "updateParagraphSpans",
  at: { blockId: "paragraph-1" },
  paragraphOwnerId: "paragraph-1",
  generation: 3,
  expectedRevision: 4,
  revision: 5,
  updates: [{ index: 0, expectedSourceRevision: 0, span: finalizedMeaning }],
  paragraph: { ...finalized, revision: 5 },
});
assert.ok("state" in finalizedUpdate, "finalized paragraphs may receive meaning updates without reopening source ownership");
const state5 = finalizedUpdate.state;
const finalizedHistoryText = materializeManagedParagraphSnapshot(state4).spans[0]?.nodes[0];
const finalizedUpdatedText = materializeManagedParagraphSnapshot(state5).spans[0]?.nodes[0];
assert.equal(finalizedHistoryText?.kind === "text" ? finalizedHistoryText.text : undefined, "resolved while closed");
assert.equal(finalizedUpdatedText?.kind === "text" ? finalizedUpdatedText.text : undefined, "resolved after finalization");
assert.equal(state0.source.revision, 0);
assert.equal(state1.source.revision, 1);
assert.equal(state2.source.state, "closed");

console.log("paragraph block state test passed");
