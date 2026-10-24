import assert from "node:assert";
import { applyPatchBatch, createInitialSnapshot } from "../src/block-snapshot";
import { createCodeLineIndex } from "../src/code-records";
import type { CodeLineDecoration, CodeLineDecorationUpdate, CodeLineRecord, CodeTokenLine } from "../src/code-records";
import { PATCH_ROOT_ID } from "../src/types";
import type { Block, CodeBlockSnapshot, NodeSnapshot, Patch } from "../src/types";

function makeLine(
  index: number,
  text: string,
  ending: CodeLineRecord["ending"],
  isProvisional = false,
  sourceRevision = 1,
): CodeLineRecord {
  return {
    id: `line-${index}`,
    index,
    text,
    ending,
    sourceRange: { from: index * 16, to: index * 16 + text.length },
    sourceRevision,
    isProvisional,
  };
}

const initialRows = Array.from({ length: 64 * 32 }, (_, index) =>
  makeLine(index, `row-${index}`, "\n", false, 17),
);
const original = createCodeLineIndex({ lines: initialRows });
const originalBody = original.materialize();
const retainedRow = initialRows[0];
const retainedSourceRange = retainedRow.sourceRange;
const grown = original.replaceTail(64 * 32, [
  makeLine(64 * 32, "directory-growth", "\r\n", false, 19),
  makeLine(64 * 32 + 1, "page-tail", "", true, 19),
]);

assert.strictEqual(grown.length, 64 * 32 + 2);
assert.strictEqual(grown.completeLineCount, 64 * 32 + 1);
assert.strictEqual(grown.revision, original.revision + 1);
assert.strictEqual(grown.get(0), retainedRow);
assert.strictEqual(grown.get(0)?.sourceRange, retainedSourceRange);
assert.strictEqual(grown.get(64 * 31), initialRows[64 * 31]);
assert.strictEqual(grown.get(0)?.sourceRevision, 17);
const grownRange = grown.readRange(64 * 32 - 1, 64 * 32 + 2);
assert.strictEqual(grownRange[0], initialRows[64 * 32 - 1]);
assert.strictEqual(grownRange[1], grown.get(64 * 32));
assert.strictEqual(grownRange[2], grown.get(64 * 32 + 1));
assert.strictEqual(grown.get(64 * 32)?.sourceRevision, 19);
assert.strictEqual(original.length, 64 * 32);
assert.strictEqual(original.get(64 * 32), undefined);
assert.strictEqual(original.materialize(), originalBody);
assert.strictEqual(original.replaceTail(original.length, []), original, "empty append preserves the subscription value");

const provisional = createCodeLineIndex({
  lines: [
    makeLine(0, "complete", "\n"),
    makeLine(1, "draft", "", true, 3),
  ],
});
const replacedProvisional = provisional.replaceTail(1, [
  makeLine(1, "finished", "\r", false, 4),
  makeLine(2, "next draft", "", true, 4),
]);
assert.strictEqual(provisional.completeLineCount, 1);
assert.strictEqual(provisional.get(1)?.text, "draft");
assert.strictEqual(replacedProvisional.length, 3);
assert.strictEqual(replacedProvisional.completeLineCount, 2);
assert.strictEqual(replacedProvisional.get(1)?.isProvisional, false);
assert.strictEqual(replacedProvisional.get(2)?.isProvisional, true);
const finalized = replacedProvisional.replaceTail(2, [makeLine(2, "finished tail", "\n", false, 5)]);
assert.strictEqual(finalized.completeLineCount, 3);
assert.strictEqual(replacedProvisional.get(2)?.isProvisional, true);

const decorationRows = [
  makeLine(0, "left", "\n", false, 8),
  makeLine(1, "stale-source", "\n", false, 8),
  makeLine(2, "stale-id", "\n", false, 8),
  makeLine(3, "right", "", false, 8),
];
const undecorated = createCodeLineIndex({ lines: decorationRows });
const tokenLine: CodeTokenLine = {
  spans: [{ t: "const", v: { dark: { fg: "#fff" }, light: { fg: "#111" } } }],
};
const decorations: readonly CodeLineDecoration[] = [
  {
    index: 0,
    lineId: "line-0",
    sourceRevision: 8,
    configurationRevision: 2,
    exactness: "exact",
    tokens: tokenLine,
  },
  {
    index: 1,
    lineId: "line-1",
    sourceRevision: 7,
    configurationRevision: 2,
    exactness: "isolated",
    tokens: tokenLine,
  },
  {
    index: 2,
    lineId: "different-line",
    sourceRevision: 8,
    configurationRevision: 2,
    exactness: "isolated",
    tokens: tokenLine,
  },
  {
    index: 3,
    lineId: "line-3",
    sourceRevision: 8,
    configurationRevision: 2,
    exactness: "exact",
    tokens: tokenLine,
  },
];
const decorated = undecorated.decorate(decorations);
assert.notStrictEqual(decorated, undecorated);
assert.notStrictEqual(decorated.get(0), decorationRows[0]);
assert.strictEqual(decorated.get(0)?.decoration?.tokens, tokenLine);
assert.strictEqual(decorated.get(1), decorationRows[1]);
assert.strictEqual(decorated.get(2), decorationRows[2]);
assert.notStrictEqual(decorated.get(3), decorationRows[3]);
assert.strictEqual(decorated.get(3)?.sourceRange, decorationRows[3].sourceRange);
assert.strictEqual(decorated.decorate(decorations), decorated, "replayed and stale decoration leaves subscription identity unchanged");
assert.strictEqual(undecorated.decorate(decorations.slice(1, 3)), undecorated, "entirely stale decoration cannot publish a new value");
const clearDecoration: CodeLineDecorationUpdate = {
  index: 0,
  lineId: "line-0",
  sourceRevision: 8,
  configurationRevision: 2,
  tokens: null,
};
const clearPatchDecorations: Extract<Patch, { op: "decorateCode" }>["decorations"] = [
  clearDecoration,
];
const cleared = decorated.decorate(clearPatchDecorations);
assert.notStrictEqual(cleared, decorated);
assert.strictEqual(cleared.get(0)?.decoration, undefined);
assert.strictEqual(Object.prototype.hasOwnProperty.call(cleared.get(0), "decoration"), false);
assert.strictEqual(cleared.get(0)?.sourceRevision, 8, "decoration clearing does not change the source revision");
assert.strictEqual(cleared.get(1), decorated.get(1));
assert.strictEqual(cleared.get(2), decorated.get(2));
assert.strictEqual(cleared.get(3), decorated.get(3));
assert.strictEqual(decorated.get(0)?.decoration?.tokens, tokenLine, "clearing keeps the old index immutable");
assert.strictEqual(cleared.decorate([clearDecoration]), cleared, "replayed clear preserves index identity");
assert.strictEqual(
  decorated.decorate([{ ...clearDecoration, sourceRevision: 7 }]),
  decorated,
  "stale source revision cannot clear a current decoration",
);
assert.strictEqual(
  decorated.decorate([{ ...clearDecoration, configurationRevision: 3 }]),
  decorated,
  "stale configuration revision cannot clear a current decoration",
);

const rawLines = createCodeLineIndex({
  lines: [
    makeLine(0, "alpha", "\r\n"),
    makeLine(1, "beta", "\r"),
    makeLine(2, "gamma", "\n"),
    makeLine(3, "omega", ""),
  ],
});
assert.strictEqual(rawLines.materialize(), "alpha\r\nbeta\rgamma\nomega");
assert.strictEqual(rawLines.readRange(9, 12), rawLines.readRange(12, 20));

// A partially filled page can become prefix while an older reader stays intact.
const activeRows = Array.from({ length: 66 }, (_, index) => makeLine(index, `original-${index}`, "\n", false, 7));
const active = createCodeLineIndex({ lines: activeRows });
const activeBody = active.materialize();
const rolledRows = Array.from({ length: 64 }, (_, offset) => makeLine(66 + offset, `rolled-${offset}`, "\n", false, 9));
const rolled = active.replaceTail(66, rolledRows);
const tailRow = makeLine(130, "active-tail", "", true, 11);
const withTail = rolled.replaceTail(130, [tailRow]);
assert.strictEqual(rolled.length, 130);
assert.strictEqual(rolled.get(64), activeRows[64]);
assert.strictEqual(rolled.get(65), activeRows[65]);
assert.strictEqual(rolled.get(65)?.sourceRange, activeRows[65].sourceRange);
assert.deepStrictEqual(withTail.readRange(127, 133), [rolledRows[61], rolledRows[62], rolledRows[63], tailRow]);
assert.strictEqual(withTail.materialize(), [...activeRows, ...rolledRows, tailRow].map((line) => line.text + line.ending).join(""));
assert.strictEqual(active.length, 66);
assert.strictEqual(active.materialize(), activeBody);

const boundaryDecorations: readonly CodeLineDecoration[] = [63, 64, 130].map((index) => {
  const row = withTail.get(index)!;
  return {
    index,
    lineId: row.id,
    sourceRevision: row.sourceRevision,
    configurationRevision: 4,
    exactness: "exact",
    tokens: tokenLine,
  };
});
const decoratedBoundary = withTail.decorate(boundaryDecorations);
for (const decoration of boundaryDecorations) {
  assert.strictEqual(decoratedBoundary.get(decoration.index)?.decoration, decoration);
  assert.strictEqual(withTail.get(decoration.index)?.decoration, undefined);
}
assert.strictEqual(decoratedBoundary.get(65), activeRows[65]);
assert.strictEqual(decoratedBoundary.decorate(boundaryDecorations), decoratedBoundary);
const sealed = decoratedBoundary.replaceTail(130, [makeLine(130, "sealed", "\r\n", false, 12)]);
assert.strictEqual(sealed.get(64), decoratedBoundary.get(64));
assert.strictEqual(sealed.completeLineCount, 131);
assert.strictEqual(decoratedBoundary.get(130)?.isProvisional, true);
assert.strictEqual(withTail.get(130), tailRow);

const multiPageRows = Array.from({ length: 3 * 64 }, (_, index) =>
  makeLine(index, `batch-${index}`, "\n", false, 23),
);
const multiPageIndex = createCodeLineIndex({ lines: multiPageRows });
const multiPageDecorations: readonly CodeLineDecoration[] = [
  {
    index: 65,
    lineId: "line-65",
    sourceRevision: 23,
    configurationRevision: 5,
    exactness: "exact",
    tokens: { spans: [{ t: "batch-65" }] },
  },
  {
    index: 130,
    lineId: "line-130",
    sourceRevision: 23,
    configurationRevision: 5,
    exactness: "exact",
    tokens: { spans: [{ t: "batch-130" }] },
  },
  {
    index: 1,
    lineId: "line-1",
    sourceRevision: 23,
    configurationRevision: 5,
    exactness: "exact",
    tokens: { spans: [{ t: "batch-1" }] },
  },
];
const multiPageDecorated = multiPageIndex.decorate(multiPageDecorations);
assert.strictEqual(multiPageDecorated.get(1)?.decoration?.tokens.spans[0]?.t, "batch-1");
assert.strictEqual(multiPageDecorated.get(65)?.decoration?.tokens.spans[0]?.t, "batch-65");
assert.strictEqual(multiPageDecorated.get(130)?.decoration?.tokens.spans[0]?.t, "batch-130");
assert.strictEqual(multiPageDecorated.get(2), multiPageRows[2], "an untouched line retains its identity");
assert.strictEqual(multiPageIndex.get(1), multiPageRows[1], "the original index keeps all source rows after decoration");
assert.strictEqual(multiPageIndex.get(65), multiPageRows[65]);
assert.strictEqual(multiPageIndex.get(130), multiPageRows[130]);
const prefixOnlyRows = Array.from({ length: 64 }, (_, index) =>
  makeLine(index, index === 0 ? "const" : `page-${index}`, "\n", false, 23),
);
const activeTailRow = makeLine(64, "active-tail", "", true, 29);
const prefixAndTail = createCodeLineIndex({ lines: [...prefixOnlyRows, activeTailRow] });
const prefixAndTailBody = prefixAndTail.materialize();
const prefixDecorated = prefixAndTail.decorate([{
  index: 0,
  lineId: "line-0",
  sourceRevision: 23,
  configurationRevision: 6,
  exactness: "exact",
  tokens: tokenLine,
}]);
assert.strictEqual(prefixDecorated.get(0)?.text, "const");
assert.strictEqual(prefixDecorated.get(0)?.decoration?.tokens.spans[0]?.t, "const");
assert.strictEqual(prefixDecorated.get(64)?.id, "line-64");
assert.strictEqual(prefixDecorated.get(64)?.text, "active-tail");
assert.strictEqual(prefixDecorated.get(64)?.sourceRevision, 29);
assert.strictEqual(prefixDecorated.materialize(), prefixAndTailBody);
assert.strictEqual(prefixAndTail.get(0)?.text, "const");
assert.strictEqual(prefixAndTail.get(0)?.decoration, undefined);
assert.strictEqual(prefixAndTail.get(64), activeTailRow);
assert.strictEqual(prefixAndTail.materialize(), prefixAndTailBody);

const tailDecorated = prefixAndTail.decorate([{
  index: 64,
  lineId: "line-64",
  sourceRevision: 29,
  configurationRevision: 6,
  exactness: "exact",
  tokens: { spans: [{ t: "active-tail" }] },
}]);
assert.strictEqual(tailDecorated.get(64)?.decoration?.tokens.spans[0]?.t, "active-tail");
assert.strictEqual(tailDecorated.get(0), prefixOnlyRows[0]);
assert.strictEqual(tailDecorated.get(63)?.text, "page-63");
assert.strictEqual(tailDecorated.materialize(), prefixAndTailBody);
assert.strictEqual(prefixAndTail.get(64)?.decoration, undefined);

function managedCodeNode(
  id: string,
  generation: number,
  revision: number,
  raw: string,
  line: CodeLineRecord,
  state: CodeBlockSnapshot["state"] = "open",
): NodeSnapshot {
  const block: Block = {
    id,
    type: "code",
    isFinalized: state !== "open",
    payload: { raw, meta: { info: "ts", lang: "ts" } },
  };
  return {
    id,
    type: "code",
    props: { block },
    code: {
      codeOwnerId: id,
      generation,
      revision,
      state,
      processedTo: raw.length,
      completeLineCount: line.ending ? 1 : 0,
      lineCount: 1,
      sourceRange: { from: 0, to: raw.length },
      configurationRevision: 4,
      info: "ts",
      language: "ts",
      lines: [line],
      raw,
    },
  };
}

function snapshotWithCode(code: NodeSnapshot) {
  return createInitialSnapshot({ id: PATCH_ROOT_ID, type: "__root__", children: [code] });
}

const activeSnapshot = snapshotWithCode(managedCodeNode("active-code", 7, 1, "old", makeLine(0, "old", "", true, 1)));
const detachedGetBlocks = activeSnapshot.getBlocks;
assert.strictEqual(detachedGetBlocks()[0]?.payload.raw, "old", "detached getBlocks callback reads its snapshot");

const replacement = managedCodeNode("active-code", 7, 2, "new", makeLine(0, "new", "", true, 2));
applyPatchBatch(activeSnapshot, [{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: replacement,
}]);
assert.strictEqual(detachedGetBlocks()[0]?.payload.raw, "new", "same-generation replacement updates the current snapshot");

const repeatedReplacement = managedCodeNode("active-code", 7, 3, "latest", makeLine(0, "latest", "", true, 3));
applyPatchBatch(activeSnapshot, [{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: repeatedReplacement,
}]);
assert.strictEqual(detachedGetBlocks()[0]?.payload.raw, "latest", "atomic replacement does not retire its active generation");

const appendSnapshot = snapshotWithCode(
  managedCodeNode("delayed-code", 9, 1, "old", makeLine(0, "old", "", true, 1)),
);
const firstAppendLines: CodeLineRecord[] = [
  { ...makeLine(0, "old", "\n", false, 2), sourceRange: { from: 0, to: 3 } },
  { ...makeLine(1, "new", "", true, 2), sourceRange: { from: 4, to: 7 } },
];
applyPatchBatch(appendSnapshot, [{
  op: "appendCode",
  at: { blockId: "delayed-code" },
  code: {
    codeOwnerId: "delayed-code",
    generation: 9,
    revision: 2,
    state: "open",
    processedTo: 7,
    completeLineCount: 1,
    lineCount: 2,
    sourceRange: { from: 0, to: 7 },
  },
  expectedRevision: 1,
  fromLine: 0,
  lines: firstAppendLines,
  sourceAppend: "\nnew",
  meta: { kind: "semantic" },
}]);
applyPatchBatch(appendSnapshot, [{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: managedCodeNode("delayed-code", 9, 1, "old", makeLine(0, "old", "", true, 1)),
}]);
assert.strictEqual(appendSnapshot.getBlocks()[0]?.payload.raw, "old\nnew",
  "delayed same-generation replacement cannot roll source back behind an append");
applyPatchBatch(appendSnapshot, [{
  op: "appendCode",
  at: { blockId: "delayed-code" },
  code: {
    codeOwnerId: "delayed-code",
    generation: 9,
    revision: 3,
    state: "open",
    processedTo: 9,
    completeLineCount: 1,
    lineCount: 2,
    sourceRange: { from: 0, to: 9 },
  },
  expectedRevision: 2,
  fromLine: 1,
  lines: [{ ...makeLine(1, "newer", "", true, 3), sourceRange: { from: 4, to: 9 } }],
  sourceAppend: "er",
  meta: { kind: "semantic" },
}]);
assert.strictEqual(appendSnapshot.getBlocks()[0]?.payload.raw, "old\nnewer",
  "subsequent source append remains accepted after a delayed replacement");
assert.strictEqual(appendSnapshot.getBlocks()[0]?.payload.meta?.code, "old\nnewer",
  "consumer code reflects the append after rejecting the delayed replacement");

applyPatchBatch(activeSnapshot, [{ op: "deleteChild", at: { blockId: PATCH_ROOT_ID }, index: 0 }]);
applyPatchBatch(activeSnapshot, [{
  op: "insertChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: repeatedReplacement,
}]);
assert.deepStrictEqual(detachedGetBlocks(), [], "a truly retired generation cannot be reinserted");

const decoratedProvisionalLine: CodeLineRecord = {
  ...makeLine(0, "pri", "", true, 3),
  decoration: {
    index: 0,
    lineId: "line-0",
    sourceRevision: 3,
    configurationRevision: 4,
    exactness: "exact",
    tokens: tokenLine,
  },
};
const provisionalCodeNode = managedCodeNode("provisional-code", 5, 1, "pri", decoratedProvisionalLine);
const initialCodeSnapshot = provisionalCodeNode.code;
assert.ok(initialCodeSnapshot);
assert.strictEqual(initialCodeSnapshot.raw, "pri");
assert.strictEqual(initialCodeSnapshot.lines[0], decoratedProvisionalLine);
const initialCodeIndex = createCodeLineIndex({ lines: initialCodeSnapshot.lines });
const provisionalSnapshot = snapshotWithCode(provisionalCodeNode);
const initialProvisionalState = provisionalSnapshot.nodes.get("provisional-code")?.codeState;
assert.ok(initialProvisionalState, "managed code retains its native owner state");
assert.strictEqual(initialProvisionalState.managed, true);
assert.strictEqual(initialProvisionalState.source.codeOwnerId, "provisional-code");
assert.strictEqual(initialProvisionalState.source.state, "open");
assert.strictEqual(initialProvisionalState.source.sourceRange.to, 3);
const initialProvisionalLine = initialProvisionalState.lines.get(0);
assert.ok(initialProvisionalLine);
assert.strictEqual(initialProvisionalLine.text, "pri");
assert.strictEqual(initialProvisionalLine.isProvisional, true);
assert.strictEqual(initialProvisionalLine.decoration?.tokens, tokenLine);
assert.strictEqual(initialProvisionalState.lines.materialize(), "pri");
assert.strictEqual(provisionalSnapshot.getBlocks()[0]?.payload.raw, "pri");
assert.strictEqual(initialProvisionalState.lines.get(0), initialCodeIndex.get(0),
  "the native owner index retains the canonical `.code.lines` record");
applyPatchBatch(provisionalSnapshot, [{
  op: "appendCode",
  at: { blockId: "provisional-code" },
  code: {
    codeOwnerId: "provisional-code",
    generation: 5,
    revision: 2,
    state: "open",
    processedTo: 5,
    completeLineCount: 0,
    lineCount: 1,
    sourceRange: { from: 0, to: 5 },
  },
  expectedRevision: 1,
  fromLine: 0,
  lines: [makeLine(0, "print", "", true, 4)],
  sourceAppend: "nt",
  meta: { kind: "semantic" },
}]);
const changedProvisionalState = provisionalSnapshot.nodes.get("provisional-code")?.codeState;
assert.ok(changedProvisionalState);
assert.strictEqual(changedProvisionalState.managed, true);
assert.strictEqual(changedProvisionalState.source.codeOwnerId, "provisional-code");
assert.strictEqual(changedProvisionalState.source.revision, 2);
assert.strictEqual(changedProvisionalState.source.sourceRange.to, 5);
const changedProvisionalLine = changedProvisionalState.lines.get(0);
assert.ok(changedProvisionalLine);
assert.strictEqual(changedProvisionalLine.text, "print", "provisional replacement keeps the exact changed text");
assert.strictEqual(changedProvisionalLine.isProvisional, true);
assert.strictEqual(changedProvisionalLine.sourceRevision, 4);
assert.strictEqual(changedProvisionalLine.decoration, undefined,
  "provisional replacement clears tokens belonging to the previous text");
assert.strictEqual(changedProvisionalState.lines.materialize(), "print");
assert.strictEqual(provisionalSnapshot.getBlocks()[0]?.payload.raw, "print");
applyPatchBatch(provisionalSnapshot, [{
  op: "finalize",
  at: { blockId: "provisional-code" },
}]);
const finalizedProvisionalState = provisionalSnapshot.nodes.get("provisional-code")?.codeState;
assert.ok(finalizedProvisionalState);
assert.strictEqual(finalizedProvisionalState.managed, true);
assert.strictEqual(finalizedProvisionalState.source.state, "finalized");
assert.strictEqual(finalizedProvisionalState.source.revision, 2);
assert.strictEqual(finalizedProvisionalState.lines.materialize(), "print");
assert.strictEqual(provisionalSnapshot.getBlocks()[0]?.isFinalized, true);
assert.strictEqual(provisionalSnapshot.getBlocks()[0]?.payload.raw, "print");
