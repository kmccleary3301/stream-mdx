import assert from "node:assert/strict";
import { inlineNodesToPlainText } from "../src/block-snapshot";
import { createParagraphSpanIndex } from "../src/paragraph-span-index";
import { freezeParagraphSpanRecord, type ParagraphSpanRecord } from "../src/paragraph-records";
import type { InlineNode } from "../src/types";

function span(index: number, provisional = false): ParagraphSpanRecord {
  return {
    id: `paragraph:span:${index}`,
    index,
    sourceRange: { from: index, to: index + 1 },
    sourceRevision: 0,
    isProvisional: provisional,
    nodes: [{ kind: "text", text: String(index) }],
    attemptedReferences: [],
  };
}
const sourceText = { kind: "text", text: "before" } satisfies InlineNode;
const sourcePlugin = {
  kind: "plugin",
  name: "chip",
  attrs: { label: "before" },
  raw: "<Chip/>",
  children: [sourceText],
} satisfies InlineNode;
const sourceHtml = {
  kind: "html",
  raw: "<span>",
  attributes: { class: "before" },
  children: [sourcePlugin],
} satisfies InlineNode;
const authoredNodes: InlineNode[] = [sourceHtml];
const frozen = freezeParagraphSpanRecord({
  ...span(0),
  nodes: authoredNodes,
  attemptedReferences: ["target"],
});
sourceText.text = "after";
sourcePlugin.attrs.label = "after";
sourceHtml.attributes.class = "after";
authoredNodes.length = 0;
assert.equal(frozen.nodes.length, 1, "records own their source node arrays");
const frozenHtml = frozen.nodes[0];
if (!frozenHtml || frozenHtml.kind !== "html") throw new Error("Expected a frozen HTML node");
const frozenPlugin = frozenHtml.children?.[0];
if (!frozenPlugin || frozenPlugin.kind !== "plugin") throw new Error("Expected a frozen plugin node");
const frozenText = frozenPlugin.children?.[0];
if (!frozenText || frozenText.kind !== "text") throw new Error("Expected a frozen text node");
assert.equal(frozenText.text, "before");
assert.equal(frozenPlugin.attrs.label, "before");
assert.equal(frozenHtml.attributes?.class, "before");
assert.ok(Object.isFrozen(frozen));
assert.ok(Object.isFrozen(frozen.nodes));
assert.ok(Object.isFrozen(frozenHtml));
assert.ok(Object.isFrozen(frozenHtml.attributes));
assert.ok(Object.isFrozen(frozenPlugin.attrs));
assert.ok(Object.isFrozen(frozenText));



const initial = Array.from({ length: 2049 }, (_value, index) => span(index, index === 2048));
const index = createParagraphSpanIndex({ spans: initial });
assert.equal(index.length, 2049);
assert.equal(index.completeSpanCount, 2048);
assert.equal(index.get(2048)?.isProvisional, true, "only the final record may remain mutable");
assert.equal(index.readRange(63, 66).map((record) => record.index).join(","), "63,64,65");
assert.equal(index.get(2047)?.sourceRange.to, index.get(2048)?.sourceRange.from);
assert.throws(() => index.replaceTail(2048, [{
  ...span(2048),
  sourceRange: { from: 2048, to: 2050 },
  sourceRevision: 0,
}]), /source revision/);


const next = index.replaceTail(2048, [{
  ...span(2048),
  sourceRange: { from: 2048, to: 2050 },
  sourceRevision: 1,
  nodes: [{ kind: "text", text: "extended" }],
}]);

assert.equal(next.length, 2049);
assert.equal(next.completeSpanCount, 2049);
assert.strictEqual(next.get(0), index.get(0), "tail replacement must retain earlier records by identity");
assert.strictEqual(next.get(2047), index.get(2047), "the 64-record leaf prefix must remain shared");
assert.equal(next.get(2048)?.sourceRange.to, 2050);
assert.equal(index.get(2048)?.sourceRange.to, 2049, "the previous index is immutable");

const current = next.get(100)!;
const semantic = next.updateSpans([{
  index: 100,
  expectedSourceRevision: current.sourceRevision,
  span: {
    ...current,
    nodes: [{ kind: "text", text: "reference now resolved" }],
  },
}]);
assert.strictEqual(semantic.get(0), next.get(0));
assert.notStrictEqual(semantic.get(100), current);
assert.equal(inlineNodesToPlainText(semantic.get(100)?.nodes ?? []), "reference now resolved");
assert.deepEqual(semantic.get(100)?.sourceRange, current.sourceRange);
assert.equal(semantic.get(100)?.sourceRevision, current.sourceRevision);
assert.equal(inlineNodesToPlainText(next.get(100)?.nodes ?? []), "100", "semantic updates must preserve historical meaning");

const invalidSourceUpdates = [
  { label: "stable IDs", span: { ...current, id: `${current.id}:replacement` } },
  { label: "source revisions", span: { ...current, sourceRevision: current.sourceRevision + 1 } },
  { label: "provisional state", span: { ...current, isProvisional: true } },
];
for (const { label, span: replacement } of invalidSourceUpdates) {
  assert.throws(
    () => next.updateSpans([{ index: 100, expectedSourceRevision: current.sourceRevision, span: replacement }]),
    /source identity/,
    `semantic updates preserve paragraph span ${label}`,
  );
}

assert.throws(
  () => createParagraphSpanIndex({ spans: [span(0, true), span(1, false)] }),
  /Only the final paragraph span may be provisional/,
  "only the final paragraph span may be provisional",
);
assert.throws(() => next.replaceTail(2047, []), /completeSpanCount/);
assert.throws(() => next.updateSpans([{
  index: 100,
  expectedSourceRevision: current.sourceRevision + 1,
  span: { ...current, nodes: [{ kind: "text", text: "stale" }] },
}]), /stale/);
