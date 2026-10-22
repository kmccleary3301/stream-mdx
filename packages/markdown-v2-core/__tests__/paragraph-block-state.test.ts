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
