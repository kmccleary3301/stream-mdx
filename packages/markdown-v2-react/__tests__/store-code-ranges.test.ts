import assert from "node:assert";

import type { Block, CodeLineRecord, NodeSnapshot, Patch } from "@stream-mdx/core";
import { createRendererStore } from "../src/renderer/store";

const OWNER_ID = "streamed-code";
const SOURCE_FROM = 100;
const INITIAL_RAW = "```ts\r\n  alpha\r\n  bet";
const SOURCE_TO = SOURCE_FROM + INITIAL_RAW.length;
const BODY_FROM = SOURCE_FROM + "```ts\r\n".length;
const INPUT_GENERATION = 11;
const INPUT_PREFIX = "x".repeat(SOURCE_FROM);
const INITIAL_DOCUMENT = `${INPUT_PREFIX}${INITIAL_RAW}`;

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
    range: { from: 0, to: INITIAL_DOCUMENT.length },
    inputSource: { generation: INPUT_GENERATION, raw: INITIAL_DOCUMENT },
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
function emptyCodeRootSnapshot(raw: string, from: number): NodeSnapshot {
  const ownerId = "empty-code";
  return {
    id: "__root__",
    type: "__root__",
    inputSource: { generation: INPUT_GENERATION, raw },
    children: [{
      id: ownerId,
      type: "code",
      props: {},
      range: { from, to: from },
      children: [],
      code: {
        codeOwnerId: ownerId,
        generation: 1,
        revision: 0,
        state: "finalized",
        processedTo: from,
        completeLineCount: 0,
        lineCount: 0,
        sourceRange: { from, to: from },
        configurationRevision: 0,
        info: "",
        raw: "",
        lines: [],
      },
    }],
  };
}

const store = createRendererStore();
store.resetSnapshot(rootSnapshot(7));
assert.strictEqual(store.hasProvisionalBlocks(), true);

const initialView = store.getCodeBlock(OWNER_ID);
assert.ok(initialView, "managed code snapshot should be indexed");
assert.strictEqual(initialView.source.sourceRange.from, SOURCE_FROM);
assert.strictEqual(initialView.source.sourceRange.to, SOURCE_TO);

const stablePrefix = store.getCodeLines(OWNER_ID, 0, 1);
const stableRow = stablePrefix[0];
assert.ok(stableRow);
assert.strictEqual(stableRow.text, "  alpha");
const oldBlocks = store.getBlocks();
const versionBeforeInput = store.getVersion();
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
store.applyPatches([
  {
    op: "appendInputSource",
    at: { blockId: "__root__" },
    generation: INPUT_GENERATION,
    from: INITIAL_DOCUMENT.length - 1,
    text: "stale",
  },
  {
    op: "appendInputSource",
    at: { blockId: "__root__" },
    generation: INPUT_GENERATION - 1,
    from: INITIAL_DOCUMENT.length,
    text: "wrong generation",
  },
  {
    op: "appendInputSource",
    at: { blockId: "__root__", nodeId: "__root__" },
    generation: INPUT_GENERATION,
    from: INITIAL_DOCUMENT.length,
    text: "wrong root target",
  },
]);
assert.strictEqual(store.getVersion(), versionBeforeInput, "rejected input appends do not complete semantic work");
assert.strictEqual(store.getBlocks(), oldBlocks, "input-only changes do not rebuild root children");
store.applyPatches([{
  op: "appendInputSource",
  at: { blockId: "__root__" },
  generation: INPUT_GENERATION,
  from: INITIAL_DOCUMENT.length,
  text: sourceAppend,
}]);
assert.strictEqual(store.getVersion(), versionBeforeInput, "input retention does not advance the semantic version");
assert.strictEqual(store.getBlocks(), oldBlocks, "input-only append preserves the root block snapshot");
assert.strictEqual(oldBlocks[0]?.payload.raw, INITIAL_RAW, "captured source windows remain immutable");
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
const definitionAppend = "\n\n[reference]: /target";
const versionBeforeDefinition = store.getVersion();
store.applyPatches([{
  op: "appendInputSource",
  at: { blockId: "__root__" },
  generation: INPUT_GENERATION,
  from: INITIAL_DOCUMENT.length + sourceAppend.length,
  text: definitionAppend,
}]);
assert.strictEqual(store.getVersion(), versionBeforeDefinition, "dependency text retention is not semantic completion");
store.applyPatches([{
  op: "setProps",
  at: { blockId: OWNER_ID, nodeId: OWNER_ID },
  props: { info: "meaning-only update" },
}]);
assert.strictEqual(store.getBlocks()[0]?.payload.raw, nextRaw, "same-bounds meaning updates do not absorb later definitions");
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
const legacyBoundaryId = "legacy-code-range-boundary";
const legacyBoundaryBlock: Block = {
  id: legacyBoundaryId,
  type: "code",
  isFinalized: false,
  payload: {
    raw: Array.from({ length: 64 }, (_, index) => `line-${index}`).join("\n"),
    meta: { lang: "ts" },
  },
};
const legacyBoundaryStore = createRendererStore([legacyBoundaryBlock]);
const provisionalBoundaryRange = legacyBoundaryStore.getCodeLines(legacyBoundaryId, 0, 64);
assert.strictEqual(provisionalBoundaryRange.length, 64);
assert.ok(provisionalBoundaryRange[63]?.isProvisional);
legacyBoundaryStore.applyPatches([{
  op: "appendLines",
  at: { blockId: legacyBoundaryId, nodeId: legacyBoundaryId },
  startIndex: 64,
  lines: ["line-64"],
} satisfies Patch]);
const finalizedBoundaryRange = legacyBoundaryStore.getCodeLines(legacyBoundaryId, 0, 64);
assert.notStrictEqual(finalizedBoundaryRange, provisionalBoundaryRange, "legacy tail completion refreshes the prior boundary range");
assert.strictEqual(finalizedBoundaryRange[63]?.isProvisional, false);
assert.strictEqual(legacyBoundaryStore.getCodeLines(legacyBoundaryId, 64, 128)[0]?.text, "line-64");
const atomicStore = createRendererStore();
atomicStore.resetSnapshot(rootSnapshot(9));
const preservedBlocks = atomicStore.getBlocks();
const preservedVersion = atomicStore.getVersion();
const invalidBaseline = rootSnapshot(10);
invalidBaseline.inputSource = { generation: INPUT_GENERATION, raw: "invalid" };
assert.throws(() => atomicStore.resetSnapshot(invalidBaseline));
assert.strictEqual(atomicStore.getVersion(), preservedVersion, "invalid baselines do not partially reset the store");
assert.strictEqual(atomicStore.getBlocks(), preservedBlocks, "invalid baselines retain the previous semantic snapshot");
const emptyCodeStore = createRendererStore();
emptyCodeStore.resetSnapshot(emptyCodeRootSnapshot("x", 1));
assert.equal(emptyCodeStore.getCodeBlock("empty-code")?.source.sourceRange.to, 1, "empty code at canonical EOF remains valid");
const emptyCodeBlocks = emptyCodeStore.getBlocks();
const emptyCodeVersion = emptyCodeStore.getVersion();
assert.throws(
  () => emptyCodeStore.resetSnapshot(emptyCodeRootSnapshot("", 1)),
  "an empty code range past canonical EOF is invalid",
);
assert.strictEqual(emptyCodeStore.getBlocks(), emptyCodeBlocks, "invalid empty code ranges preserve the prior snapshot");
assert.equal(emptyCodeStore.getVersion(), emptyCodeVersion, "invalid empty code ranges do not partially reset store state");
const overlapStore = createRendererStore();
overlapStore.resetSnapshot(rootSnapshot(17));
const overlapInputFrom = INITIAL_DOCUMENT.length;
overlapStore.applyPatches([{
  op: "appendInputSource",
  at: { blockId: "__root__" },
  generation: INPUT_GENERATION,
  from: overlapInputFrom,
  text: "\n",
}]);
overlapStore.applyPatches([{
  op: "appendInputSource",
  at: { blockId: "__root__" },
  generation: INPUT_GENERATION,
  from: overlapInputFrom + 1,
  text: "```",
}]);
overlapStore.applyPatches([{
  op: "appendCode",
  at: { blockId: OWNER_ID },
  code: {
    codeOwnerId: OWNER_ID,
    generation: 17,
    revision: 1,
    state: "closed",
    processedTo: SOURCE_TO + 4,
    completeLineCount: 2,
    lineCount: 2,
    sourceRange: { from: SOURCE_FROM, to: SOURCE_TO + 4 },
  },
  expectedRevision: 0,
  fromLine: 1,
  lines: [codeLine(1, "  bet", BODY_FROM + 9, BODY_FROM + 14, "\n", 1, false)],
  sourceAppend: "\n```",
  meta: { kind: "semantic" },
}]);
assert.strictEqual(
  overlapStore.getBlocks()[0]?.payload.raw,
  `${INITIAL_RAW}\n\`\`\``,
  "a newly owned code suffix may include an LF retained by an earlier root append",
);
const emptyBaselineStore = createRendererStore();
emptyBaselineStore.resetSnapshot({
  id: "__root__",
  type: "__root__",
  range: { from: 0, to: 0 },
  inputSource: { generation: 0, raw: "" },
  children: [],
});
assert.deepStrictEqual(emptyBaselineStore.getBlocks(), [], "an empty canonical input baseline is valid");
const previousRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
const scheduledFrames: Array<(timestamp: number) => void> = [];
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: (timestamp: number) => void) => {
    scheduledFrames.push(callback);
    return scheduledFrames.length;
  },
});
try {
  const notificationStore = createRendererStore();
  notificationStore.resetSnapshot(rootSnapshot(23));
  let rootNotifications = 0;
  const unsubscribe = notificationStore.subscribe(() => {
    rootNotifications += 1;
  });
  const initialNotification = scheduledFrames.shift();
  assert.ok(initialNotification, "snapshot reset schedules its root notification");
  initialNotification(0);
  rootNotifications = 0;
  const notificationVersion = notificationStore.getVersion();
  notificationStore.applyPatches([{
    op: "appendInputSource",
    at: { blockId: "__root__" },
    generation: INPUT_GENERATION,
    from: INITIAL_DOCUMENT.length,
    text: " retained input",
  }]);
  assert.equal(scheduledFrames.length, 0, "input-only appends schedule no notification");
  assert.equal(rootNotifications, 0, "input-only appends do not notify semantic root children");
  assert.equal(notificationStore.getVersion(), notificationVersion, "input-only appends do not signal semantic completion");
  unsubscribe();
  const codeRangeStore = createRendererStore();
  codeRangeStore.resetSnapshot(rootSnapshot(7));
  let prefixRangeNotifications = 0;
  let tailRangeNotifications = 0;
  const unsubscribePrefixRange = codeRangeStore.subscribeCodeLines(OWNER_ID, 0, 64, () => {
    prefixRangeNotifications += 1;
  });
  const unsubscribeTailRange = codeRangeStore.subscribeCodeLines(OWNER_ID, 64, 128, () => {
    tailRangeNotifications += 1;
  });
  const initialCodeNotification = scheduledFrames.shift();
  assert.ok(initialCodeNotification, "code snapshot reset schedules range notifications");
  initialCodeNotification(0);
  prefixRangeNotifications = 0;
  tailRangeNotifications = 0;
  codeRangeStore.applyPatches([{
    op: "appendInputSource",
    at: { blockId: "__root__" },
    generation: INPUT_GENERATION,
    from: INITIAL_DOCUMENT.length,
    text: sourceAppend,
  }]);
  codeRangeStore.applyPatches([appendPatch]);
  const appendCodeNotification = scheduledFrames.shift();
  assert.ok(appendCodeNotification, "code append schedules its changed range");
  appendCodeNotification(0);
  assert.strictEqual(prefixRangeNotifications, 1, "append notifies only the bucket containing changed code lines");
  assert.strictEqual(tailRangeNotifications, 0, "append does not inspect or notify unrelated code ranges");
  const lateDecorationWithStaleTail: Extract<Patch, { op: "decorateCode" }> = {
    ...decoratePatch,
    decorations: [
      decoratePatch.decorations[0]!,
      { ...decoratePatch.decorations[1]!, index: 64, lineId: `${OWNER_ID}::line:64` },
    ],
  };
  codeRangeStore.applyPatches([lateDecorationWithStaleTail]);
  const decorateCodeNotification = scheduledFrames.shift();
  assert.ok(decorateCodeNotification, "late decoration schedules its changed code range");
  decorateCodeNotification(0);
  assert.strictEqual(prefixRangeNotifications, 2, "late decoration notifies the bucket for its accepted line");
  assert.strictEqual(tailRangeNotifications, 0, "stale decorations do not notify unrelated buckets");
  codeRangeStore.applyPatches([{ op: "finalize", at: { blockId: OWNER_ID } }]);
  const finalizeCodeNotification = scheduledFrames.shift();
  assert.ok(finalizeCodeNotification, "code finalization schedules owner range updates");
  finalizeCodeNotification(0);
  assert.strictEqual(prefixRangeNotifications, 3);
  assert.strictEqual(tailRangeNotifications, 1, "owner finality invalidates active ranges");
  unsubscribePrefixRange();
  unsubscribeTailRange();
} finally {
  if (previousRaf) Object.defineProperty(globalThis, "requestAnimationFrame", previousRaf);
  else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
}
console.log("renderer store code range test passed");
