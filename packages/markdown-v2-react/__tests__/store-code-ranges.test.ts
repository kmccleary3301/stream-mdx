import assert from "node:assert";

import type { Block, CodeLineRecord, NodeSnapshot, Patch } from "@stream-mdx/core";
import { createRendererStore } from "../src/renderer/store";

const OWNER_ID = "streamed-code";
const SOURCE_FROM = 100;
const INITIAL_RAW = "```ts\r\n  alpha\r\n  bet";
const SOURCE_TO = SOURCE_FROM + INITIAL_RAW.length;
const BODY_FROM = SOURCE_FROM + "```ts\r\n".length;

function codeLine(
  index: number,
  text: string,
  from: number,
  to: number,
  ending: CodeLineRecord["ending"],
  sourceRevision: number,
  isProvisional: boolean,
): CodeLineRecord {
  return {
    id: `${OWNER_ID}::line:${index}`,
    index,
    text,
    ending,
    sourceRange: { from, to },
    sourceRevision,
    isProvisional,
  };
}

function rootSnapshot(generation: number): NodeSnapshot {
  return {
    id: "__root__",
    type: "__root__",
    children: [
      {
        id: OWNER_ID,
        type: "code",
        props: { info: "ts", lang: "ts" },
        range: { from: SOURCE_FROM, to: SOURCE_TO },
        children: [],
        code: {
          codeOwnerId: OWNER_ID,
          generation,
          revision: 0,
          state: "open",
          processedTo: SOURCE_TO,
          completeLineCount: 1,
          lineCount: 2,
          sourceRange: { from: SOURCE_FROM, to: SOURCE_TO },
          configurationRevision: 3,
          info: "ts",
          language: "ts",
          lines: [
            codeLine(0, "  alpha", BODY_FROM, BODY_FROM + 7, "\r\n", 0, false),
            codeLine(1, "  bet", BODY_FROM + 9, BODY_FROM + 14, "", 0, true),
          ],
          raw: INITIAL_RAW,
        },
      },
    ],
  };
}

const store = createRendererStore();
store.resetSnapshot(rootSnapshot(7));
assert.strictEqual(store.hasProvisionalBlocks(), true);

const initialView = store.getCodeBlock(OWNER_ID);
assert.ok(initialView, "managed code snapshot should be indexed");
assert.strictEqual(initialView.source.sourceRange.from, SOURCE_FROM);
assert.strictEqual(initialView.source.sourceRange.to, SOURCE_TO);
assert.strictEqual(store.getChildren(OWNER_ID).length, 0, "managed source rows must not inflate the node map");
assert.strictEqual(store.getNode(`${OWNER_ID}::line:0`), undefined, "managed source rows stay out of NodeRecords");

const stablePrefix = store.getCodeLines(OWNER_ID, 0, 1);
const stableRow = stablePrefix[0];
assert.ok(stableRow);
assert.strictEqual(stableRow.text, "  alpha");
const oldBlocks = store.getBlocks();
assert.strictEqual(oldBlocks[0]?.payload.raw, INITIAL_RAW, "cold export preserves authored CRLF and indentation");

const sourceAppend = "a\r\n```";
const nextRaw = `${INITIAL_RAW}${sourceAppend}`;
const appendedLine = codeLine(1, "  beta", BODY_FROM + 9, BODY_FROM + 15, "\r\n", 1, false);
const appendPatch: Patch = {
  op: "appendCode",
  at: { blockId: OWNER_ID },
  code: {
    codeOwnerId: OWNER_ID,
    generation: 7,
    revision: 1,
    state: "closed",
    processedTo: SOURCE_TO + sourceAppend.length,
    completeLineCount: 2,
    lineCount: 2,
    sourceRange: { from: SOURCE_FROM, to: SOURCE_TO + sourceAppend.length },
  },
  expectedRevision: 0,
  fromLine: 1,
  lines: [appendedLine],
  sourceAppend,
  meta: { kind: "semantic" },
};
store.applyPatches([appendPatch]);

assert.strictEqual(store.getCodeBlock(OWNER_ID)?.source.revision, 1);
assert.strictEqual(store.getCodeLines(OWNER_ID, 0, 1), stablePrefix, "unchanged range reads retain their snapshot");
assert.strictEqual(store.getCodeLines(OWNER_ID, 0, 1)[0], stableRow, "unchanged prefix rows retain identity");
assert.strictEqual(store.getCodeLines(OWNER_ID, 1, 2)[0]?.isProvisional, false, "append replaces the provisional tail");
assert.strictEqual(oldBlocks[0]?.payload.raw, INITIAL_RAW, "older cold exports remain unchanged after append");
assert.strictEqual(store.getBlocks()[0]?.payload.raw, nextRaw, "cold export reads the exact appended authored source");

const validOldRowTokens = { spans: [{ t: "  alpha", s: { fg: "#aa0000" } }] };
const decoratePatch: Extract<Patch, { op: "decorateCode" }> = {
  op: "decorateCode",
  at: { blockId: OWNER_ID },
  codeOwnerId: OWNER_ID,
  generation: 7,
  configurationRevision: 3,
  decorations: [
    {
      index: 0,
      lineId: `${OWNER_ID}::line:0`,
      sourceRevision: 0,
      configurationRevision: 3,
      exactness: "exact",
      tokens: validOldRowTokens,
    },
    {
      index: 1,
      lineId: `${OWNER_ID}::line:1`,
      sourceRevision: 0,
      configurationRevision: 3,
      exactness: "exact",
      tokens: { spans: [{ t: "stale" }] },
    },
  ],
  meta: { kind: "enrichment", blockEpoch: 0 },
};
store.applyPatches([decoratePatch]);
assert.deepStrictEqual(store.getCodeLines(OWNER_ID, 0, 1)[0]?.decoration?.tokens, validOldRowTokens);
assert.strictEqual(store.getCodeLines(OWNER_ID, 1, 2)[0]?.decoration, undefined, "stale row revisions are dropped independently");
const clearDecoratePatch: Extract<Patch, { op: "decorateCode" }> = {
  ...decoratePatch,
  decorations: [
    {
      index: 0,
      lineId: `${OWNER_ID}::line:0`,
      sourceRevision: 0,
      configurationRevision: 3,
      tokens: null,
    },
  ],
};
store.applyPatches([clearDecoratePatch]);
assert.strictEqual(store.getCodeLines(OWNER_ID, 0, 1)[0]?.decoration, undefined);
assert.strictEqual(store.getCodeBlock(OWNER_ID)?.source.revision, 1, "managed decoration clearing does not change owner revision");
assert.strictEqual(store.getBlocks()[0]?.payload.raw, nextRaw);


const revisionBeforeStaleOwner = store.getCodeBlock(OWNER_ID)?.source.revision;
store.applyPatches([
  {
    ...decoratePatch,
    generation: 6,
    decorations: [decoratePatch.decorations[0]],
  },
]);
assert.strictEqual(store.getCodeBlock(OWNER_ID)?.source.revision, revisionBeforeStaleOwner);
assert.throws(() => store.resetSnapshot(rootSnapshot(6)));
assert.strictEqual(store.getCodeBlock(OWNER_ID)?.source.generation, 7, "stale reset cannot revive an older owner");
store.applyPatches([{ op: "finalize", at: { blockId: OWNER_ID } }]);
assert.strictEqual(store.getCodeBlock(OWNER_ID)?.source.state, "finalized");
store.resetSnapshot(rootSnapshot(8));
assert.strictEqual(store.getCodeBlock(OWNER_ID)?.source.generation, 8, "new reset generation replaces the prior owner");
assert.strictEqual(store.getBlocks()[0]?.payload.raw, INITIAL_RAW);
assert.strictEqual(store.hasProvisionalBlocks(), true);
store.applyPatches([{ op: "deleteChild", at: { blockId: "__root__" }, index: 0 }]);
assert.strictEqual(store.hasProvisionalBlocks(), false, "removing the root block updates the cached status");
const closedBlock: Block = {
  id: "native-closed-code",
  type: "code",
  isFinalized: false,
  payload: { raw: "```ts\nclosed\n```", meta: { lang: "ts" } },
};
const closedStore = createRendererStore([closedBlock]);
assert.strictEqual(closedStore.getCodeBlock(closedBlock.id)?.source.state, "closed");
assert.strictEqual(closedStore.getBlocks()[0]?.isFinalized, true, "a closed fence projects as finalized block source");
const nativeOwnerId = "native-cold-code";
const nativeRaw = ["```diff", "-old", "+new", " context", "```"].join("\r\n");
const nativeBlock: Block = {
  id: nativeOwnerId,
  type: "code",
  isFinalized: true,
  payload: {
    raw: nativeRaw,
    range: { from: 300, to: 300 + nativeRaw.length },
    meta: {
      lang: "diff",
      diffKind: ["del", "add", "context"],
      oldNo: [1, null, 2],
      newNo: [null, 1, 2],
    },
  },
};
const nativeStore = createRendererStore([nativeBlock]);
const nativeBefore = nativeStore.getCodeBlock(nativeOwnerId);
assert.ok(nativeBefore);
const nativePrefix = nativeStore.getCodeLines(nativeOwnerId, 0, 1);
const nativePrefixRow = nativePrefix[0];
const nativeSuffix = nativeStore.getCodeLines(nativeOwnerId, 2, 3);
const nativeSuffixRow = nativeSuffix[0];
const nativeMiddleBefore = nativeStore.getCodeLines(nativeOwnerId, 1, 2)[0];
assert.ok(nativePrefixRow && nativeSuffixRow && nativeMiddleBefore);
assert.strictEqual(nativeMiddleBefore.text, "+new");
assert.strictEqual(nativeMiddleBefore.diffKind, "add");
assert.strictEqual(nativeMiddleBefore.oldNo, null);
assert.strictEqual(nativeMiddleBefore.newNo, 1);
const nativeTokens = { spans: [{ t: "+new", s: { fg: "#00aa00" } }] };
nativeStore.applyPatches([
  {
    op: "setProps",
    at: { blockId: nativeOwnerId, nodeId: `${nativeOwnerId}::line:1` },
    props: { text: "+new", html: null, tokens: nativeTokens },
  },
]);
const nativeDecorated = nativeStore.getCodeLines(nativeOwnerId, 1, 2)[0];
assert.ok(nativeDecorated?.decoration, "same-source setProps installs the derived line decoration");
assert.deepStrictEqual(nativeDecorated.decoration.tokens, nativeTokens);
assert.strictEqual(nativeStore.getCodeBlock(nativeOwnerId)?.source.revision, nativeBefore.source.revision);
assert.strictEqual(nativeDecorated.sourceRevision, nativeMiddleBefore.sourceRevision);
assert.strictEqual(nativeStore.getCodeLines(nativeOwnerId, 0, 1), nativePrefix);
assert.strictEqual(nativeStore.getCodeLines(nativeOwnerId, 0, 1)[0], nativePrefixRow);
assert.strictEqual(nativeStore.getCodeLines(nativeOwnerId, 2, 3), nativeSuffix);
assert.strictEqual(nativeStore.getCodeLines(nativeOwnerId, 2, 3)[0], nativeSuffixRow);
assert.strictEqual(nativeStore.getBlocks()[0]?.payload.raw, nativeRaw, "native decoration leaves exact authored source unchanged");

nativeStore.applyPatches([
  {
    op: "setProps",
    at: { blockId: nativeOwnerId, nodeId: `${nativeOwnerId}::line:1` },
    props: { text: "+new", html: null, tokens: null },
  },
]);
const nativeCleared = nativeStore.getCodeLines(nativeOwnerId, 1, 2)[0];
assert.ok(nativeCleared);
assert.strictEqual(nativeCleared.decoration, undefined, "explicit null highlight props clear the derived decoration");
assert.strictEqual(Object.prototype.hasOwnProperty.call(nativeCleared, "decoration"), false);
assert.strictEqual(nativeCleared.sourceRevision, nativeMiddleBefore.sourceRevision);
assert.strictEqual(nativeStore.getCodeBlock(nativeOwnerId)?.source.revision, nativeBefore.source.revision);
assert.strictEqual(nativeCleared.diffKind, "add", "setProps omission preserves snapshot-owned diff metadata");
assert.strictEqual(nativeCleared.oldNo, null);
assert.strictEqual(nativeCleared.newNo, 1);
assert.strictEqual(nativeStore.getBlocks()[0]?.payload.raw, nativeRaw);
assert.strictEqual(nativeStore.getCodeLines(nativeOwnerId, 0, 1), nativePrefix);
assert.strictEqual(nativeStore.getCodeLines(nativeOwnerId, 2, 3), nativeSuffix);

const pendingOwnerId = "native-pending-code";
const pendingRaw = "```ts\r\nfirst\r\nbet";
const pendingBlock: Block = {
  id: pendingOwnerId,
  type: "code",
  isFinalized: false,
  payload: {
    raw: pendingRaw,
    range: { from: 500, to: 500 + pendingRaw.length },
    meta: { lang: "ts" },
  },
};
const pendingStore = createRendererStore([pendingBlock]);
const pendingBefore = pendingStore.getCodeBlock(pendingOwnerId);
assert.ok(pendingBefore);
const pendingPrefix = pendingStore.getCodeLines(pendingOwnerId, 0, 1);
const pendingPrefixRow = pendingPrefix[0];
const pendingTailBefore = pendingStore.getCodeLines(pendingOwnerId, 1, 2)[0];
assert.ok(pendingPrefixRow && pendingTailBefore?.isProvisional);
const oldPendingBlocks = pendingStore.getBlocks();
pendingStore.applyPatches([
  {
    op: "setProps",
    at: { blockId: pendingOwnerId, nodeId: `${pendingOwnerId}::line:1` },
    props: { text: "better" },
  },
]);
const pendingAfter = pendingStore.getCodeBlock(pendingOwnerId);
const pendingTailAfter = pendingStore.getCodeLines(pendingOwnerId, 1, 2)[0];
const expectedPendingRaw = `${pendingRaw.slice(0, pendingRaw.length - "bet".length)}better`;
assert.ok(pendingAfter && pendingTailAfter);
assert.strictEqual(pendingAfter.source.state, "open");
assert.strictEqual(pendingAfter.source.revision, pendingBefore.source.revision + 1);
assert.strictEqual(pendingAfter.source.completeLineCount, 1);
assert.strictEqual(pendingAfter.source.lineCount, 2);
assert.strictEqual(pendingAfter.source.sourceRange.to, 500 + expectedPendingRaw.length);
assert.strictEqual(pendingAfter.source.processedTo, pendingAfter.source.sourceRange.to);
assert.strictEqual(pendingTailAfter.text, "better");
assert.strictEqual(pendingTailAfter.isProvisional, true);
assert.strictEqual(pendingTailAfter.sourceRevision, pendingTailBefore.sourceRevision + 1);
assert.strictEqual(pendingTailAfter.sourceRange.from, pendingTailBefore.sourceRange.from);
assert.strictEqual(pendingTailAfter.sourceRange.to, pendingAfter.source.sourceRange.to);
assert.notStrictEqual(pendingTailAfter, pendingTailBefore);
assert.strictEqual(pendingStore.getCodeLines(pendingOwnerId, 0, 1), pendingPrefix);
assert.strictEqual(pendingStore.getCodeLines(pendingOwnerId, 0, 1)[0], pendingPrefixRow);
const nextPendingBlock = pendingStore.getBlocks()[0];
assert.strictEqual(nextPendingBlock?.payload.raw, expectedPendingRaw, "cold tail edits replace source exactly");
assert.strictEqual(nextPendingBlock?.payload.range?.to, pendingAfter.source.sourceRange.to);
assert.strictEqual(oldPendingBlocks[0]?.payload.raw, pendingRaw, "older cold exports remain unchanged");


// A full 64-row range must stay cached when the provisional row in the next range closes.
const rangeOwnerId = "native-range-boundary";
const rangeBodyRows = Array.from({ length: 65 }, (_, index) => `row-${index}`);
const rangeTailText = rangeBodyRows[64] ?? "";
const rangePrefixRaw = rangeBodyRows.slice(0, 64).join("\r\n");
const rangeSourceFrom = 700;
const rangeBodyFrom = rangeSourceFrom + "```ts\r\n".length;
const rangeTailFrom = rangeBodyFrom + rangePrefixRaw.length + "\r\n".length;
const rangeRaw = `\`\`\`ts\r\n${rangePrefixRaw}\r\n${rangeTailText}`;
let rangeRowFrom = rangeBodyFrom;
const initialRangeRows: CodeLineRecord[] = rangeBodyRows.map((text, index) => {
  const sourceRange = { from: rangeRowFrom, to: rangeRowFrom + text.length };
  const ending = index < 64 ? "\r\n" : "";
  rangeRowFrom = sourceRange.to + ending.length;
  return {
    id: `${rangeOwnerId}::line:${index}`,
    index,
    text,
    ending,
    sourceRange,
    sourceRevision: 0,
    isProvisional: index === 64,
  };
});
const rangeStore = createRendererStore();
rangeStore.resetSnapshot({
  id: "__root__",
  type: "__root__",
  children: [{
    id: rangeOwnerId,
    type: "code",
    props: { info: "ts", lang: "ts" },
    children: [],
    code: {
      codeOwnerId: rangeOwnerId,
      generation: 1,
      revision: 0,
      state: "open",
      processedTo: rangeSourceFrom + rangeRaw.length,
      completeLineCount: 64,
      lineCount: 65,
      sourceRange: { from: rangeSourceFrom, to: rangeSourceFrom + rangeRaw.length },
      configurationRevision: 0,
      info: "ts",
      language: "ts",
      raw: rangeRaw,
      lines: initialRangeRows,
    },
  }],
});
const rangeBefore = rangeStore.getCodeBlock(rangeOwnerId);
assert.ok(rangeBefore);
const completedRange = rangeStore.getCodeLines(rangeOwnerId, 0, 64);
const provisionalRange = rangeStore.getCodeLines(rangeOwnerId, 64, 128);
const provisionalBoundaryRow = provisionalRange[0];
assert.strictEqual(completedRange.length, 64);
assert.strictEqual(provisionalRange.length, 1);
assert.strictEqual(completedRange[63]?.ending, "\r\n", "the row before a range boundary keeps its authored CRLF");
assert.ok(provisionalBoundaryRow?.isProvisional);
const rangeSourceAppend = "\r\n```";
const completedBoundaryRow: CodeLineRecord = {
  id: `${rangeOwnerId}::line:64`,
  index: 64,
  text: rangeTailText,
  ending: "\r\n",
  sourceRange: { from: rangeTailFrom, to: rangeTailFrom + rangeTailText.length },
  sourceRevision: provisionalBoundaryRow.sourceRevision + 1,
  isProvisional: false,
};
rangeStore.applyPatches([
  {
    op: "appendCode",
    at: { blockId: rangeOwnerId },
    code: {
      codeOwnerId: rangeOwnerId,
      generation: rangeBefore.source.generation,
      revision: rangeBefore.source.revision + 1,
      state: "closed",
      processedTo: rangeBefore.source.sourceRange.to + rangeSourceAppend.length,
      completeLineCount: 65,
      lineCount: 65,
      sourceRange: { from: rangeSourceFrom, to: rangeBefore.source.sourceRange.to + rangeSourceAppend.length },
    },
    expectedRevision: rangeBefore.source.revision,
    fromLine: 64,
    lines: [completedBoundaryRow],
    sourceAppend: rangeSourceAppend,
    meta: { kind: "semantic" },
  },
]);
assert.strictEqual(rangeStore.getCodeLines(rangeOwnerId, 0, 64), completedRange, "the completed first 64-row snapshot survives a tail append");
const completedTailRange = rangeStore.getCodeLines(rangeOwnerId, 64, 128);
assert.notStrictEqual(completedTailRange, provisionalRange, "the tail range refreshes when its provisional row closes");
assert.strictEqual(completedTailRange[0]?.isProvisional, false);
assert.strictEqual(completedTailRange[0]?.ending, "\r\n");
console.log("renderer store code range test passed");
