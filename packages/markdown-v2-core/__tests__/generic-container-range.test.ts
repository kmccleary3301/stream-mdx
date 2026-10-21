import assert from "node:assert/strict";
import { GFM, parser } from "@lezer/markdown";
import {
  applyPatchBatch,
  createBlockCompatibilityExtension,
  createBlockSnapshot,
  createInitialSnapshot,
  InlineParser,
  prepareNestedBlockSnapshotFromNative,
} from "../src/index";
import { AppendSourceDocument } from "../src/source-document";
import type {
  Block,
  InlineNode,
  MixedContentSegment,
  NodeSnapshot,
  ParagraphBlockSnapshot,
  ParagraphSpanChildSnapshot,
  ParagraphSpanRecord,
  PreparedNestedSnapshot,
  SourceSnapshot,
} from "../src/index";
import { PATCH_ROOT_ID } from "../src/types";

const NATIVE_LIST_ID = "native-list";
const INPUT_GENERATION = 31;
const nativeParser = parser.configure([GFM, createBlockCompatibilityExtension()]);
function inlineText(text: string): InlineNode[] {
  return [{ kind: "text", text }];
}

function managedPrimaryParagraph(id: string, range: { from: number; to: number }, raw: string, text: string): NodeSnapshot {
  const span: ParagraphSpanRecord = {
    id: `${id}:span:0`,
    index: 0,
    sourceRange: { ...range },
    sourceRevision: 0,
    isProvisional: true,
    nodes: inlineText(text),
    attemptedReferences: [],
  };
  const paragraph: ParagraphBlockSnapshot = {
    paragraphOwnerId: id,
    generation: 7,
    revision: 0,
    state: "open",
    processedTo: range.to,
    completeSpanCount: 0,
    spanCount: 1,
    sourceRange: { ...range },
    spans: [span],
    raw,
  };
  return {
    id,
    type: "paragraph",
    range: { ...range },
    props: {
      listItemPrimary: true,
      block: {
        id,
        type: "paragraph",
        isFinalized: false,
        payload: { raw: "", range: { ...range }, inline: [], meta: {} },
      },
    },
    paragraph,
    children: [],
  };
}

function managedMixedPrimaryParagraph(
  id: string,
  range: { from: number; to: number },
  raw: string,
  revision = 0,
): NodeSnapshot {
  const htmlRaw = '<span onclick="bad()">HTML</span>';
  const sanitizedHtml = "<span>HTML</span>";
  const mdxRaw = '<InlineChip tone="warm" />';
  const textBeforeHtml = "Before ";
  const separator = " ";
  const tailText = raw.slice(textBeforeHtml.length + htmlRaw.length + separator.length + mdxRaw.length);
  let cursor = range.from;
  const childRange = (text: string): { from: number; to: number } => {
    const result = { from: cursor, to: cursor + text.length };
    cursor = result.to;
    return result;
  };
  const children: ParagraphSpanChildSnapshot[] = [
    {
      id: `${id}:text:0`,
      type: "paragraph-text",
      range: childRange(textBeforeHtml),
      props: { inline: inlineText(textBeforeHtml) },
    },
    {
      id: `${id}:html:0`,
      type: "paragraph-html",
      range: childRange(htmlRaw),
      props: { raw: htmlRaw, html: sanitizedHtml },
      meta: { sanitized: true },
    },
    {
      id: `${id}:text:1`,
      type: "paragraph-text",
      range: childRange(separator),
      props: { inline: inlineText(separator) },
    },
    {
      id: `${id}:mdx:0`,
      type: "paragraph-mdx",
      range: childRange(mdxRaw),
      props: { raw: mdxRaw },
    },
    {
      id: `${id}:text:2`,
      type: "paragraph-text",
      range: childRange(tailText),
      props: { inline: inlineText(tailText) },
    },
  ];
  const span: ParagraphSpanRecord = {
    id: `${id}:span:0`,
    index: 0,
    sourceRange: { ...range },
    sourceRevision: revision,
    isProvisional: true,
    nodes: [],
    attemptedReferences: [],
    children,
  };
  const paragraph: ParagraphBlockSnapshot = {
    paragraphOwnerId: id,
    generation: 7,
    revision,
    state: "open",
    processedTo: range.to,
    completeSpanCount: 0,
    spanCount: 1,
    sourceRange: { ...range },
    spans: [span],
    raw,
  };
  return {
    id,
    type: "paragraph",
    range: { ...range },
    props: {
      listItemPrimary: true,
      block: {
        id,
        type: "paragraph",
        isFinalized: false,
        payload: { raw: "", range: { ...range }, inline: [], meta: {} },
      },
    },
    paragraph,
    children: [],
  };
}

function legacyParagraph(id: string, text: string, range: { from: number; to: number }): NodeSnapshot {
  const inline = inlineText(text);
  return {
    id,
    type: "paragraph",
    range,
    props: {
      block: {
        id,
        type: "paragraph",
        isFinalized: true,
        payload: { raw: text, range, inline, meta: {} },
      },
      inline,
      text,
    },
    children: [],
  };
}

function nativeListSnapshot(source: SourceSnapshot): NodeSnapshot {
  const tree = nativeParser.parse(source);
  let listNode = tree.topNode.firstChild;
  while (listNode && listNode.type.name !== "BulletList") listNode = listNode.nextSibling;
  assert.ok(listNode, "the canonical source must parse as a native list");

  const block: Block = {
    id: NATIVE_LIST_ID,
    type: "list",
    isFinalized: false,
    payload: {
      raw: "",
      range: { from: listNode.from, to: listNode.to },
      meta: { sourceContainer: "list" },
    },
  };
  const preparedNested = prepareNestedBlockSnapshotFromNative(
    block,
    listNode,
    { input: source, source, mapOffset: (offset) => offset },
    new InlineParser(),
    nativeParser,
  );
  block.payload.meta = { ...block.payload.meta, preparedNested };
  return createBlockSnapshot(block);
}

function preparedChildren(block: Block): NodeSnapshot[] {
  const prepared = block.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
  assert.ok(prepared, "cold blocks expose their current prepared nested tree");
  return prepared.children;
}

function itemBlock(node: NodeSnapshot | undefined): Block {
  assert.ok(node, "native list item exists");
  const block = node.props?.block as Block | undefined;
  assert.ok(block, "native list item keeps its block projection");
  return block;
}

const initialRaw = "- alpha\n- omega";
const append = "\n  continuation";
const completeRaw = `${initialRaw}${append}`;
const LAST_TEXT_SEGMENT_ID = `${NATIVE_LIST_ID}::item:1::list-item:segment:0`;
const LAST_TEXT_SEGMENT_FROM = initialRaw.lastIndexOf("omega");
const source = new AppendSourceDocument();
source.append(initialRaw);
const initialNode = nativeListSnapshot(source.snapshot());
const initialLastItem = initialNode.children?.find((item) => item.id === `${NATIVE_LIST_ID}::item:1`);
assert.ok(initialLastItem);
initialLastItem.children = [{
  id: LAST_TEXT_SEGMENT_ID,
  type: "list-item-text",
  range: { from: LAST_TEXT_SEGMENT_FROM, to: initialRaw.length },
  props: { inline: inlineText("omega"), text: "omega" },
  children: [],
}];
const snapshot = createInitialSnapshot({
  id: PATCH_ROOT_ID,
  type: "__root__",
  range: { from: 0, to: initialRaw.length },
  inputSource: { generation: INPUT_GENERATION, raw: initialRaw },
  children: [initialNode],
});

const originalBlocks = snapshot.getBlocks();
const originalList = originalBlocks[0];
assert.ok(originalList);
assert.equal(originalList.payload.raw, initialRaw, "cold generic container raw comes from the canonical authored source");
assert.deepEqual(originalList.payload.range, initialNode.range, "cold range preserves the native authored offsets");
const originalItems = preparedChildren(originalList);
const originalFirstItem = originalItems.find((item) => item.id === `${NATIVE_LIST_ID}::item:0`);
const originalLastItem = originalItems.find((item) => item.id === `${NATIVE_LIST_ID}::item:1`);
assert.equal(itemBlock(originalLastItem).payload.raw, "- omega", "cold item raw is authored, not a display projection");
assert.deepEqual(itemBlock(originalLastItem).payload.range, originalLastItem?.range, "cold nested range preserves the authored item offsets");
const firstItemNode = snapshot.nodes.get(`${NATIVE_LIST_ID}::item:0`);
const lastItemNode = snapshot.nodes.get(`${NATIVE_LIST_ID}::item:1`);
assert.ok(firstItemNode && lastItemNode);
const originalLastText = lastItemNode.props.text;

source.append(append);
const extendedNode = nativeListSnapshot(source.snapshot());
const extendedLastItem = extendedNode.children?.find((item) => item.id === `${NATIVE_LIST_ID}::item:1`);
assert.ok(extendedNode.range && extendedLastItem?.range);
applyPatchBatch(snapshot, [
  {
    op: "appendInputSource",
    at: { blockId: PATCH_ROOT_ID },
    generation: INPUT_GENERATION,
    from: initialRaw.length,
    text: append,
  },
  {
    op: "setProps",
    at: { blockId: NATIVE_LIST_ID, nodeId: NATIVE_LIST_ID },
    props: { range: extendedNode.range },
  },
  {
    op: "setProps",
    at: { blockId: NATIVE_LIST_ID, nodeId: `${NATIVE_LIST_ID}::item:1` },
    props: { range: extendedLastItem.range },
  },
  {
    op: "setProps",
    at: { blockId: NATIVE_LIST_ID, nodeId: LAST_TEXT_SEGMENT_ID },
    props: {
      range: { from: LAST_TEXT_SEGMENT_FROM, to: completeRaw.length },
      inline: inlineText("omega continuation"),
      text: "omega continuation",
    },
  },
]);

const updatedList = snapshot.getBlocks()[0];
assert.ok(updatedList);
assert.equal(updatedList.payload.raw, completeRaw, "container raw is derived from the admitted physical source range");
assert.deepEqual(updatedList.payload.range, extendedNode.range);
const updatedItems = preparedChildren(updatedList);
const updatedFirstItem = updatedItems.find((item) => item.id === `${NATIVE_LIST_ID}::item:0`);
const updatedLastItem = updatedItems.find((item) => item.id === `${NATIVE_LIST_ID}::item:1`);
assert.ok(updatedFirstItem?.range && updatedLastItem?.range);
assert.deepEqual(updatedFirstItem.range, originalFirstItem?.range, "completed sibling range stays unchanged");
assert.equal(itemBlock(updatedFirstItem).payload.raw, "- alpha", "completed sibling source stays unchanged");
assert.deepEqual(updatedLastItem.range, extendedLastItem.range);
assert.deepEqual(itemBlock(updatedLastItem).payload.range, extendedLastItem.range);
assert.equal(itemBlock(updatedLastItem).payload.raw, "- omega\n  continuation");
assert.equal(updatedLastItem.props?.raw, "- omega\n  continuation");
assert.equal(snapshot.nodes.get(`${NATIVE_LIST_ID}::item:0`), firstItemNode, "range growth does not rebuild completed sibling nodes");
assert.equal(snapshot.nodes.get(`${NATIVE_LIST_ID}::item:1`), lastItemNode, "range growth updates the existing nested target");
assert.equal(lastItemNode.range?.to, extendedLastItem.range.to);
const updatedLastTextSegment = updatedLastItem?.children?.find((child) => child.id === LAST_TEXT_SEGMENT_ID);
assert.ok(updatedLastTextSegment);
assert.deepEqual(updatedLastTextSegment.range, { from: LAST_TEXT_SEGMENT_FROM, to: completeRaw.length });
assert.equal(updatedLastTextSegment.props.text, "omega continuation", "mixed segment meaning follows the physical range update");
const publishedRangeList = updatedList;
applyPatchBatch(snapshot, [{
  op: "setProps",
  at: { blockId: NATIVE_LIST_ID, nodeId: LAST_TEXT_SEGMENT_ID },
  props: { inline: inlineText("current meaning"), text: "current meaning" },
}]);
const currentList = snapshot.getBlocks()[0];
assert.ok(currentList);
const currentLastItem = preparedChildren(currentList).find((item) => item.id === `${NATIVE_LIST_ID}::item:1`);
const currentLastTextSegment = currentLastItem?.children?.find((child) => child.id === LAST_TEXT_SEGMENT_ID);
assert.equal(currentLastTextSegment?.props.text, "current meaning", "a source-neutral semantic update reaches cold generic children");
const publishedRangeTextSegment = preparedChildren(publishedRangeList)
  .find((item) => item.id === `${NATIVE_LIST_ID}::item:1`)
  ?.children?.find((child) => child.id === LAST_TEXT_SEGMENT_ID);
assert.equal(publishedRangeTextSegment?.props.text, "omega continuation", "published cold meaning remains historical");

applyPatchBatch(snapshot, [{
  op: "setProps",
  at: { blockId: NATIVE_LIST_ID, nodeId: `${NATIVE_LIST_ID}::item:1` },
  props: {
    range: { from: extendedLastItem.range.from, to: completeRaw.length + 1 },
    text: "must not partially apply",
  },
}]);
const afterRejectedRange = snapshot.getBlocks()[0];
assert.ok(afterRejectedRange);
assert.equal(afterRejectedRange.payload.raw, completeRaw, "an out-of-source range cannot corrupt the admitted container source");
assert.equal(itemBlock(preparedChildren(afterRejectedRange).find((item) => item.id === `${NATIVE_LIST_ID}::item:1`)).payload.raw, "- omega\n  continuation");
assert.deepEqual(lastItemNode.range, extendedLastItem.range, "rejected range data leaves the admitted range unchanged");
assert.equal(lastItemNode.props.text, originalLastText, "rejected range patches do not partially apply sibling props");
applyPatchBatch(snapshot, [{
  op: "setProps",
  at: { blockId: NATIVE_LIST_ID, nodeId: LAST_TEXT_SEGMENT_ID },
  props: {
    range: { from: LAST_TEXT_SEGMENT_FROM, to: completeRaw.length + 1 },
    inline: inlineText("must not partially apply"),
    text: "must not partially apply",
  },
}]);
const afterRejectedSegmentRange = snapshot.getBlocks()[0];
assert.ok(afterRejectedSegmentRange);
const rejectedLastTextSegment = preparedChildren(afterRejectedSegmentRange)
  .find((item) => item.id === `${NATIVE_LIST_ID}::item:1`)
  ?.children?.find((child) => child.id === LAST_TEXT_SEGMENT_ID);
assert.equal(rejectedLastTextSegment?.props.text, "current meaning", "an invalid source range cannot partially replace segment meaning");
assert.deepEqual(rejectedLastTextSegment?.range, { from: LAST_TEXT_SEGMENT_FROM, to: completeRaw.length });
assert.equal(originalList.payload.raw, initialRaw, "previously published cold blocks remain historical values");
assert.equal(itemBlock(originalLastItem).payload.raw, "- omega", "previous nested exports remain unchanged after range growth");

const unmanagedParagraphRaw = "before";
const unmanagedParagraphAppend = " after";
const unmanagedParagraphRange = { from: 0, to: unmanagedParagraphRaw.length };
const unmanagedParagraphId = "unmanaged-quote::paragraph";
const unmanagedParagraph: NodeSnapshot = {
  id: unmanagedParagraphId,
  type: "paragraph",
  range: unmanagedParagraphRange,
  props: {
    block: {
      id: unmanagedParagraphId,
      type: "paragraph",
      isFinalized: false,
      payload: { raw: unmanagedParagraphRaw, range: unmanagedParagraphRange, inline: inlineText("before"), meta: {} },
    },
    inline: inlineText("before"),
    text: "before",
  },
  children: [],
};
const unmanagedQuoteRange = { from: 0, to: unmanagedParagraphRaw.length };
const unmanagedQuote: NodeSnapshot = {
  id: "unmanaged-quote",
  type: "blockquote",
  range: unmanagedQuoteRange,
  props: {
    block: {
      id: "unmanaged-quote",
      type: "blockquote",
      isFinalized: false,
      payload: {
        raw: unmanagedParagraphRaw,
        range: unmanagedQuoteRange,
        meta: { preparedNested: { props: {}, children: [unmanagedParagraph] } satisfies PreparedNestedSnapshot },
      },
    },
  },
  children: [unmanagedParagraph],
};
const unmanagedParagraphSnapshot = createInitialSnapshot({
  id: PATCH_ROOT_ID,
  type: "__root__",
  range: unmanagedQuoteRange,
  inputSource: { generation: INPUT_GENERATION + 2, raw: unmanagedParagraphRaw },
  children: [unmanagedQuote],
});
const extendedUnmanagedParagraphLength = unmanagedParagraphRaw.length + unmanagedParagraphAppend.length;
applyPatchBatch(unmanagedParagraphSnapshot, [
  {
    op: "appendInputSource",
    at: { blockId: PATCH_ROOT_ID },
    generation: INPUT_GENERATION + 2,
    from: unmanagedParagraphRaw.length,
    text: unmanagedParagraphAppend,
  },
  {
    op: "setProps",
    at: { blockId: "unmanaged-quote", nodeId: "unmanaged-quote" },
    props: { range: { from: 0, to: extendedUnmanagedParagraphLength } },
  },
  {
    op: "setProps",
    at: { blockId: "unmanaged-quote", nodeId: unmanagedParagraphId },
    props: {
      range: { from: 0, to: extendedUnmanagedParagraphLength },
      inline: inlineText("before after"),
      text: "before after",
    },
  },
]);
const publishedUnmanagedQuote = unmanagedParagraphSnapshot.getBlocks()[0];
assert.ok(publishedUnmanagedQuote);
assert.equal(publishedUnmanagedQuote.payload.raw, "before after");
const unmanagedPrepared = publishedUnmanagedQuote.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
assert.equal(unmanagedPrepared?.children[0]?.props.text, "before after", "an unmanaged nested paragraph accepts its physical source range");
applyPatchBatch(unmanagedParagraphSnapshot, [{
  op: "setProps",
  at: { blockId: "unmanaged-quote", nodeId: unmanagedParagraphId },
  props: { inline: inlineText("current paragraph meaning"), text: "current paragraph meaning" },
}]);
const currentUnmanagedQuote = unmanagedParagraphSnapshot.getBlocks()[0];
assert.ok(currentUnmanagedQuote);
const currentUnmanagedPrepared = currentUnmanagedQuote.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
assert.equal(currentUnmanagedPrepared?.children[0]?.props.text, "current paragraph meaning");
assert.equal(unmanagedPrepared?.children[0]?.props.text, "before after", "published paragraph snapshots keep historical meaning");

const innerParagraphId = "outer-quote::quote::paragraph";
const innerParagraph: NodeSnapshot = {
  id: innerParagraphId,
  type: "paragraph",
  props: {
    block: {
      id: innerParagraphId,
      type: "paragraph",
      isFinalized: false,
      payload: { raw: "inner", inline: inlineText("inner"), meta: {} },
    },
    inline: inlineText("inner"),
    text: "inner",
  },
  children: [],
};
const innerQuote = createBlockSnapshot({
  id: "outer-quote::quote",
  type: "blockquote",
  isFinalized: false,
  payload: { raw: "> inner", meta: { preparedNested: { props: {}, children: [innerParagraph] } } },
});
const nestedQuoteDocument = createInitialSnapshot([{
  id: "outer-quote",
  type: "blockquote",
  isFinalized: false,
  payload: { raw: "> > inner", meta: { preparedNested: { props: {}, children: [innerQuote] } } },
}]);
const publishedNestedQuote = nestedQuoteDocument.getBlocks()[0];
assert.ok(publishedNestedQuote);
applyPatchBatch(nestedQuoteDocument, [{
  op: "setProps",
  at: { blockId: "outer-quote", nodeId: innerParagraphId },
  props: { inline: inlineText("current inner"), text: "current inner" },
}]);
const currentNestedQuote = nestedQuoteDocument.getBlocks()[0];
assert.ok(currentNestedQuote);
// Remount the cold export the way a consumer does, then read the nested quote's exported hierarchy.
const remountedNestedQuote = createInitialSnapshot([currentNestedQuote]).getBlocks()[0];
assert.ok(remountedNestedQuote);
for (const exported of [currentNestedQuote, remountedNestedQuote]) {
  const exportedInnerQuote = preparedChildren(exported).find((child) => child.id === "outer-quote::quote");
  assert.ok(exportedInnerQuote);
  assert.equal(exportedInnerQuote.children?.[0]?.props?.text, "current inner");
  assert.equal(
    preparedChildren(itemBlock(exportedInnerQuote))[0]?.props?.text,
    "current inner",
    "the nested quote block exports its current hierarchy",
  );
  const innerMetaPrepared = exportedInnerQuote.meta?.preparedNested as PreparedNestedSnapshot | undefined;
  assert.equal(
    innerMetaPrepared?.children[0]?.props?.text,
    "current inner",
    "nested snapshot metadata cannot reintroduce the initial prepared tree",
  );
}
const publishedInnerQuote = preparedChildren(publishedNestedQuote).find((child) => child.id === "outer-quote::quote");
assert.equal(publishedInnerQuote?.children?.[0]?.props?.text, "inner", "the earlier nested export keeps its historical meaning");

const rootParagraphId = "root-unmanaged-paragraph";
const rootParagraphRange = { from: 0, to: "before".length };
const rootParagraphDocument = createInitialSnapshot({
  id: PATCH_ROOT_ID,
  type: "__root__",
  range: rootParagraphRange,
  inputSource: { generation: INPUT_GENERATION + 3, raw: "before" },
  children: [{
    id: rootParagraphId,
    type: "paragraph",
    range: rootParagraphRange,
    props: {
      block: {
        id: rootParagraphId,
        type: "paragraph",
        isFinalized: false,
        payload: { raw: "before", range: rootParagraphRange, inline: inlineText("before"), meta: {} },
      },
      inline: inlineText("before"),
      text: "before",
    },
    children: [],
  }],
});
const publishedRootParagraph = rootParagraphDocument.getBlocks()[0];
applyPatchBatch(rootParagraphDocument, [
  {
    op: "appendInputSource",
    at: { blockId: PATCH_ROOT_ID },
    generation: INPUT_GENERATION + 3,
    from: "before".length,
    text: " after",
  },
  {
    op: "setProps",
    at: { blockId: rootParagraphId },
    props: { range: { from: 0, to: "before after".length } },
  },
]);
const currentRootParagraph = rootParagraphDocument.getBlocks()[0];
assert.equal(currentRootParagraph?.payload.raw, "before after", "a root unmanaged paragraph exports its admitted source window");
assert.deepEqual(currentRootParagraph?.payload.range, { from: 0, to: "before after".length });
assert.equal(publishedRootParagraph?.payload.raw, "before", "the earlier root paragraph export keeps its capped window");
assert.deepEqual(publishedRootParagraph?.payload.range, rootParagraphRange);

const nestedCodeRaw = "- ```js\n  const value = 42;\n  ```";
const nestedCodeSource = new AppendSourceDocument();
nestedCodeSource.append(nestedCodeRaw);
const nestedCodeDocument = createInitialSnapshot({
  id: PATCH_ROOT_ID,
  type: "__root__",
  range: { from: 0, to: nestedCodeRaw.length },
  inputSource: { generation: INPUT_GENERATION + 1, raw: nestedCodeRaw },
  children: [nativeListSnapshot(nestedCodeSource.snapshot())],
});
const nestedCodeList = nestedCodeDocument.getBlocks()[0];
assert.ok(nestedCodeList);
const nestedCode = preparedChildren(nestedCodeList)
  .flatMap((item) => item.children ?? [])
  .find((child) => child.type === "code");
assert.ok(nestedCode);
assert.ok(nestedCode.code);
assert.ok(Array.isArray(nestedCode.code.lines), "cold nested code exports line records");
assert.deepEqual(nestedCode.code.lines.map((line) => line.text), ["const value = 42;"]);


const primaryGrowthRaw = "- alpha";
const primaryGrowthAppend = " growth";
const primaryGrowthUpdatedRaw = `${primaryGrowthRaw}${primaryGrowthAppend}`;
const primaryGrowthListId = "primary-growth-list";
const primaryGrowthItemId = `${primaryGrowthListId}::item:0`;
const primaryGrowthParagraphId = `${primaryGrowthItemId}::paragraph`;
const primaryGrowthItemRange = { from: 0, to: primaryGrowthRaw.length };
const primaryGrowthParagraphRange = { from: 2, to: primaryGrowthRaw.length };
const primaryGrowthParagraph = managedPrimaryParagraph(
  primaryGrowthParagraphId,
  primaryGrowthParagraphRange,
  "alpha",
  "alpha",
);
const primaryGrowthItemBlock: Block = {
  id: primaryGrowthItemId,
  type: "list-item",
  isFinalized: false,
  payload: {
    raw: "",
    range: primaryGrowthItemRange,
    meta: {
      sourceContainer: "list",
      preparedNested: { props: {}, children: [primaryGrowthParagraph] },
    },
  },
};
const primaryGrowthItem: NodeSnapshot = {
  id: primaryGrowthItemId,
  type: "list-item",
  range: primaryGrowthItemRange,
  props: {
    block: primaryGrowthItemBlock,
    index: 0,
    ordered: false,
    loose: false,
    start: 1,
    raw: "",
  },
  children: [primaryGrowthParagraph],
};
const primaryGrowthListRange = { from: 0, to: primaryGrowthRaw.length };
const primaryGrowthList: NodeSnapshot = {
  id: primaryGrowthListId,
  type: "list",
  range: primaryGrowthListRange,
  props: {
    block: {
      id: primaryGrowthListId,
      type: "list",
      isFinalized: false,
      payload: {
        raw: "",
        range: primaryGrowthListRange,
        meta: {
          sourceContainer: "list",
          ordered: true,
          loose: false,
          start: 3,
          items: [inlineText("stale")],
          preparedNested: { props: {}, children: [primaryGrowthItem] },
        },
      },
    },
    ordered: true,
    loose: false,
    start: 3,
    items: [inlineText("stale")],
  },
  children: [primaryGrowthItem],
};
const primaryGrowthDocument = createInitialSnapshot({
  id: PATCH_ROOT_ID,
  type: "__root__",
  inputSource: { generation: INPUT_GENERATION + 3, raw: primaryGrowthRaw },
  children: [primaryGrowthList],
});
const publishedPrimaryGrowthList = primaryGrowthDocument.getBlocks()[0];
assert.ok(publishedPrimaryGrowthList);
const publishedPrimaryGrowthItem = preparedChildren(publishedPrimaryGrowthList)
  .find((node) => node.id === primaryGrowthItemId);
assert.ok(publishedPrimaryGrowthItem);
assert.deepEqual(publishedPrimaryGrowthItem.props.inline, inlineText("alpha"));
assert.deepEqual(itemBlock(publishedPrimaryGrowthItem).payload.inline, inlineText("alpha"));
assert.equal(publishedPrimaryGrowthItem.props.ordered, true);
assert.equal(publishedPrimaryGrowthItem.props.start, 3);
assert.equal(publishedPrimaryGrowthItem.children?.some((node) => node.id === primaryGrowthParagraphId), false);
assert.ok(primaryGrowthDocument.nodes.get(primaryGrowthItemId)?.children.includes(primaryGrowthParagraphId));

const primaryGrowthParagraphNextRange = { from: 2, to: primaryGrowthUpdatedRaw.length };
const primaryGrowthNextSpan: ParagraphSpanRecord = {
  id: `${primaryGrowthParagraphId}:span:0`,
  index: 0,
  sourceRange: primaryGrowthParagraphNextRange,
  sourceRevision: 1,
  isProvisional: true,
  nodes: inlineText("alpha growth"),
  attemptedReferences: [],
};
applyPatchBatch(primaryGrowthDocument, [
  {
    op: "appendInputSource",
    at: { blockId: PATCH_ROOT_ID },
    generation: INPUT_GENERATION + 3,
    from: primaryGrowthRaw.length,
    text: primaryGrowthAppend,
  },
  {
    op: "appendParagraph",
    at: { blockId: primaryGrowthListId, nodeId: primaryGrowthParagraphId },
    paragraphOwnerId: primaryGrowthParagraphId,
    generation: 7,
    expectedRevision: 0,
    revision: 1,
    sourceAppend: primaryGrowthAppend,
    fromSpan: 0,
    spans: [primaryGrowthNextSpan],
    paragraph: {
      paragraphOwnerId: primaryGrowthParagraphId,
      generation: 7,
      revision: 1,
      state: "open",
      processedTo: primaryGrowthUpdatedRaw.length,
      completeSpanCount: 0,
      spanCount: 1,
      sourceRange: primaryGrowthParagraphNextRange,
    },
  },
  {
    op: "setProps",
    at: { blockId: primaryGrowthListId, nodeId: primaryGrowthListId },
    props: {
      range: { from: 0, to: primaryGrowthUpdatedRaw.length },
      ordered: true,
      loose: true,
      start: 7,
    },
  },
  {
    op: "setProps",
    at: { blockId: primaryGrowthListId, nodeId: primaryGrowthItemId },
    props: { range: { from: 0, to: primaryGrowthUpdatedRaw.length }, ordered: false, loose: false, start: 1 },
  },
  {
    op: "setProps",
    at: { blockId: primaryGrowthListId, nodeId: primaryGrowthParagraphId },
    props: { range: primaryGrowthParagraphNextRange },
  },
]);
const currentPrimaryGrowthList = primaryGrowthDocument.getBlocks()[0];
assert.ok(currentPrimaryGrowthList);
assert.equal(currentPrimaryGrowthList.payload.raw, primaryGrowthUpdatedRaw);
assert.deepEqual(currentPrimaryGrowthList.payload.meta?.items, [inlineText("alpha growth")]);
const currentPrimaryGrowthItem = preparedChildren(currentPrimaryGrowthList)
  .find((node) => node.id === primaryGrowthItemId);
assert.ok(currentPrimaryGrowthItem);
assert.deepEqual(currentPrimaryGrowthItem.props.inline, inlineText("alpha growth"));
assert.deepEqual(itemBlock(currentPrimaryGrowthItem).payload.inline, inlineText("alpha growth"));
assert.equal(currentPrimaryGrowthItem.props.text, "alpha growth");
assert.equal(currentPrimaryGrowthItem.props.ordered, true);
assert.equal(currentPrimaryGrowthItem.props.loose, true);
assert.equal(currentPrimaryGrowthItem.props.start, 7);
assert.equal(primaryGrowthDocument.nodes.get(primaryGrowthItemId)?.children.includes(primaryGrowthParagraphId), true);
assert.equal(publishedPrimaryGrowthItem.props.text, "alpha", "published cold list items keep historical primary meaning");
assert.equal(itemBlock(publishedPrimaryGrowthItem).payload.raw, primaryGrowthRaw);
const remountedPrimaryGrowthList = createInitialSnapshot([currentPrimaryGrowthList]).getBlocks()[0];
assert.ok(remountedPrimaryGrowthList);
const remountedPrimaryGrowthItem = preparedChildren(remountedPrimaryGrowthList)
  .find((node) => node.id === primaryGrowthItemId);
assert.deepEqual(remountedPrimaryGrowthItem?.props.inline, inlineText("alpha growth"));
assert.deepEqual(itemBlock(remountedPrimaryGrowthItem).payload.inline, inlineText("alpha growth"));
assert.equal(remountedPrimaryGrowthItem?.children?.some((node) => node.id === primaryGrowthParagraphId), false);
const mixedPrimaryListId = "mixed-primary-list";
const mixedPrimaryItemId = `${mixedPrimaryListId}::item:0`;
const mixedPrimaryParagraphId = `${mixedPrimaryItemId}::paragraph`;
const mixedPrimaryParagraphRaw = 'Before <span onclick="bad()">HTML</span> <InlineChip tone="warm" /> tail';
const mixedPrimaryRaw = `- ${mixedPrimaryParagraphRaw}`;
const mixedPrimaryAppend = " continued";
const currentMixedPrimaryParagraphRaw = `${mixedPrimaryParagraphRaw}${mixedPrimaryAppend}`;
const currentMixedPrimaryRaw = `${mixedPrimaryRaw}${mixedPrimaryAppend}`;
const mixedPrimaryParagraphRange = { from: 2, to: mixedPrimaryRaw.length };
const mixedPrimaryItemRange = { from: 0, to: mixedPrimaryRaw.length };
const mixedPrimaryParagraph = managedMixedPrimaryParagraph(
  mixedPrimaryParagraphId,
  mixedPrimaryParagraphRange,
  mixedPrimaryParagraphRaw,
);
const mixedPrimaryItemBlock: Block = {
  id: mixedPrimaryItemId,
  type: "list-item",
  isFinalized: false,
  payload: {
    raw: "",
    range: mixedPrimaryItemRange,
    meta: { sourceContainer: "list", preparedNested: { props: {}, children: [mixedPrimaryParagraph] } },
  },
};
const mixedPrimaryItem: NodeSnapshot = {
  id: mixedPrimaryItemId,
  type: "list-item",
  range: mixedPrimaryItemRange,
  props: {
    block: mixedPrimaryItemBlock,
    index: 0,
    ordered: false,
    loose: false,
    start: 1,
    raw: "",
  },
  children: [mixedPrimaryParagraph],
};
const mixedPrimaryListRange = { from: 0, to: mixedPrimaryRaw.length };
const mixedPrimaryList: NodeSnapshot = {
  id: mixedPrimaryListId,
  type: "list",
  range: mixedPrimaryListRange,
  props: {
    block: {
      id: mixedPrimaryListId,
      type: "list",
      isFinalized: false,
      payload: {
        raw: "",
        range: mixedPrimaryListRange,
        meta: {
          sourceContainer: "list",
          ordered: false,
          loose: false,
          start: 1,
          items: [inlineText("stale")],
          preparedNested: { props: {}, children: [mixedPrimaryItem] },
        },
      },
    },
    ordered: false,
    loose: false,
    start: 1,
    items: [inlineText("stale")],
  },
  children: [mixedPrimaryItem],
};
const mixedPrimaryDocument = createInitialSnapshot({
  id: PATCH_ROOT_ID,
  type: "__root__",
  inputSource: { generation: INPUT_GENERATION + 4, raw: mixedPrimaryRaw },
  children: [mixedPrimaryList],
});
const historicalMixedPrimaryList = mixedPrimaryDocument.getBlocks()[0];
assert.ok(historicalMixedPrimaryList);
assert.equal(historicalMixedPrimaryList.payload.raw, mixedPrimaryRaw);
const historicalMixedPrimaryItem = preparedChildren(historicalMixedPrimaryList)
  .find((node) => node.id === mixedPrimaryItemId);
assert.ok(historicalMixedPrimaryItem);
const initialMixedPrimaryInline: InlineNode[] = [
  { kind: "text", text: "Before " },
  { kind: "html", raw: '<span onclick="bad()">HTML</span>', sanitized: "<span>HTML</span>" },
  { kind: "text", text: " " },
  { kind: "text", text: " tail" },
];
assert.deepEqual(historicalMixedPrimaryItem.props.inline, initialMixedPrimaryInline);
const historicalMixedPrimaryBlock = itemBlock(historicalMixedPrimaryItem);
assert.equal(historicalMixedPrimaryBlock.payload.raw, mixedPrimaryRaw);
assert.deepEqual(historicalMixedPrimaryBlock.payload.inline, initialMixedPrimaryInline);
const historicalMixedSegments = historicalMixedPrimaryBlock.payload.meta?.mixedSegments as MixedContentSegment[] | undefined;
assert.ok(historicalMixedSegments);
const historicalMdxSegment = historicalMixedSegments.find((segment) => segment.kind === "mdx");
assert.ok(historicalMdxSegment);
assert.equal(historicalMdxSegment.value, '<InlineChip tone="warm" />');
const historicalMdxChild = historicalMixedPrimaryItem.children?.find((child) => child.type === "list-item-mdx");
assert.ok(historicalMdxChild);
assert.equal(historicalMdxChild.props.raw, historicalMdxSegment.value);
assert.equal(
  mixedPrimaryRaw.slice(historicalMdxChild.range?.from ?? 0, historicalMdxChild.range?.to ?? 0),
  historicalMdxSegment.value,
);
assert.ok(historicalMixedPrimaryItem.children?.some((child) => child.type === "list-item-text"));
assert.ok(historicalMixedPrimaryItem.children?.some((child) => child.type === "list-item-html"));
assert.ok(!historicalMixedPrimaryItem.children?.some((child) => child.type === "paragraph-mdx"));

const currentMixedPrimaryParagraphRange = { from: 2, to: currentMixedPrimaryRaw.length };
const currentMixedPrimaryParagraph = managedMixedPrimaryParagraph(
  mixedPrimaryParagraphId,
  currentMixedPrimaryParagraphRange,
  currentMixedPrimaryParagraphRaw,
  1,
);
const currentMixedPrimarySpan = currentMixedPrimaryParagraph.paragraph?.spans[0];
assert.ok(currentMixedPrimarySpan);
applyPatchBatch(mixedPrimaryDocument, [
  {
    op: "appendInputSource",
    at: { blockId: PATCH_ROOT_ID },
    generation: INPUT_GENERATION + 4,
    from: mixedPrimaryRaw.length,
    text: mixedPrimaryAppend,
  },
  {
    op: "appendParagraph",
    at: { blockId: mixedPrimaryListId, nodeId: mixedPrimaryParagraphId },
    paragraphOwnerId: mixedPrimaryParagraphId,
    generation: 7,
    expectedRevision: 0,
    revision: 1,
    sourceAppend: mixedPrimaryAppend,
    fromSpan: 0,
    spans: [currentMixedPrimarySpan],
    paragraph: {
      paragraphOwnerId: mixedPrimaryParagraphId,
      generation: 7,
      revision: 1,
      state: "open",
      processedTo: currentMixedPrimaryRaw.length,
      completeSpanCount: 0,
      spanCount: 1,
      sourceRange: currentMixedPrimaryParagraphRange,
    },
  },
  {
    op: "setProps",
    at: { blockId: mixedPrimaryListId, nodeId: mixedPrimaryListId },
    props: { range: { from: 0, to: currentMixedPrimaryRaw.length } },
  },
  {
    op: "setProps",
    at: { blockId: mixedPrimaryListId, nodeId: mixedPrimaryItemId },
    props: { range: { from: 0, to: currentMixedPrimaryRaw.length } },
  },
  {
    op: "setProps",
    at: { blockId: mixedPrimaryListId, nodeId: mixedPrimaryParagraphId },
    props: { range: currentMixedPrimaryParagraphRange },
  },
]);
const currentMixedPrimaryList = mixedPrimaryDocument.getBlocks()[0];
assert.ok(currentMixedPrimaryList);
assert.equal(currentMixedPrimaryList.payload.raw, currentMixedPrimaryRaw);
assert.deepEqual(currentMixedPrimaryList.payload.meta?.items, [[
  { kind: "text", text: "Before " },
  { kind: "html", raw: '<span onclick="bad()">HTML</span>', sanitized: "<span>HTML</span>" },
  { kind: "text", text: " " },
  { kind: "text", text: " tail continued" },
]]);
const currentMixedPrimaryItem = preparedChildren(currentMixedPrimaryList)
  .find((node) => node.id === mixedPrimaryItemId);
assert.ok(currentMixedPrimaryItem);
const currentMixedPrimaryInline: InlineNode[] = [
  { kind: "text", text: "Before " },
  { kind: "html", raw: '<span onclick="bad()">HTML</span>', sanitized: "<span>HTML</span>" },
  { kind: "text", text: " " },
  { kind: "text", text: " tail continued" },
];
assert.deepEqual(currentMixedPrimaryItem.props.inline, currentMixedPrimaryInline);
const currentMixedPrimaryBlock = itemBlock(currentMixedPrimaryItem);
assert.equal(currentMixedPrimaryBlock.payload.raw, currentMixedPrimaryRaw);
assert.deepEqual(currentMixedPrimaryBlock.payload.inline, currentMixedPrimaryInline);
const currentMixedSegments = currentMixedPrimaryBlock.payload.meta?.mixedSegments as MixedContentSegment[] | undefined;
assert.ok(currentMixedSegments);
const currentMdxSegment = currentMixedSegments.find((segment) => segment.kind === "mdx");
assert.ok(currentMdxSegment);
assert.equal(currentMdxSegment.value, '<InlineChip tone="warm" />');
assert.equal(historicalMixedPrimaryList.payload.raw, mixedPrimaryRaw);
assert.deepEqual(itemBlock(historicalMixedPrimaryItem).payload.inline, initialMixedPrimaryInline);
const remountedMixedPrimaryList = createInitialSnapshot([currentMixedPrimaryList]).getBlocks()[0];
assert.ok(remountedMixedPrimaryList);
const remountedMixedPrimaryItem = preparedChildren(remountedMixedPrimaryList)
  .find((node) => node.id === mixedPrimaryItemId);
assert.ok(remountedMixedPrimaryItem);
assert.deepEqual(remountedMixedPrimaryItem.props.inline, currentMixedPrimaryInline);
assert.deepEqual(itemBlock(remountedMixedPrimaryItem).payload.inline, currentMixedPrimaryInline);
const remountedMdxChild = remountedMixedPrimaryItem.children?.find((child) => child.type === "list-item-mdx");
assert.equal(remountedMdxChild?.props.raw, currentMdxSegment.value);

const layoutRaw = "- outer\n  outer secondary\n  - inner\n    nested secondary";
const layoutRange = { from: 0, to: layoutRaw.length };
const outerParagraphText = "outer secondary";
const nestedParagraphText = "nested secondary";
const outerParagraphFrom = layoutRaw.indexOf(outerParagraphText);
const nestedListFrom = layoutRaw.indexOf("- inner");
const nestedParagraphFrom = layoutRaw.indexOf(nestedParagraphText);
const outerParagraphId = "layout-list::item:0::secondary:0";
const nestedParagraphId = "layout-list::nested::item:0::secondary:0";
const makeSecondaryParagraph = (id: string, text: string, from: number): NodeSnapshot =>
  legacyParagraph(id, text, { from, to: from + text.length });
const outerSecondaryParagraph = makeSecondaryParagraph(outerParagraphId, outerParagraphText, outerParagraphFrom);
const nestedSecondaryParagraph = makeSecondaryParagraph(nestedParagraphId, nestedParagraphText, nestedParagraphFrom);
const nestedListId = "layout-list::nested";
const nestedItemId = `${nestedListId}::item:0`;
const nestedListRange = { from: nestedListFrom, to: layoutRaw.length };
const nestedItem: NodeSnapshot = {
  id: nestedItemId,
  type: "list-item",
  range: nestedListRange,
  props: {
    block: {
      id: nestedItemId,
      type: "list-item",
      isFinalized: true,
      payload: { raw: "", range: nestedListRange, meta: { sourceContainer: "list", preparedNested: { props: {}, children: [] } } },
    },
    index: 0,
    ordered: false,
    loose: false,
    start: 1,
  },
  children: [nestedSecondaryParagraph],
};
const nestedList: NodeSnapshot = {
  id: nestedListId,
  type: "list",
  range: nestedListRange,
  props: {
    block: {
      id: nestedListId,
      type: "list",
      isFinalized: true,
      payload: {
        raw: "",
        range: nestedListRange,
        meta: { sourceContainer: "list", ordered: false, loose: false, preparedNested: { props: {}, children: [nestedItem] } },
      },
    },
    ordered: false,
    loose: false,
  },
  children: [nestedItem],
};
const outerItemId = "layout-list::item:0";
const outerItem: NodeSnapshot = {
  id: outerItemId,
  type: "list-item",
  range: layoutRange,
  props: {
    block: {
      id: outerItemId,
      type: "list-item",
      isFinalized: true,
      payload: { raw: "", range: layoutRange, meta: { sourceContainer: "list", preparedNested: { props: {}, children: [] } } },
    },
    index: 0,
    ordered: false,
    loose: false,
    start: 1,
  },
  children: [outerSecondaryParagraph, nestedList],
};
const layoutListId = "layout-list";
const layoutList: NodeSnapshot = {
  id: layoutListId,
  type: "list",
  range: layoutRange,
  props: {
    block: {
      id: layoutListId,
      type: "list",
      isFinalized: true,
      payload: {
        raw: "",
        range: layoutRange,
        meta: { sourceContainer: "list", ordered: false, loose: false, preparedNested: { props: {}, children: [outerItem] } },
      },
    },
    ordered: false,
    loose: false,
  },
  children: [outerItem],
};
const layoutDocument = createInitialSnapshot({
  id: PATCH_ROOT_ID,
  type: "__root__",
  inputSource: { generation: INPUT_GENERATION + 5, raw: layoutRaw },
  children: [layoutList],
});
const tightLayoutList = layoutDocument.getBlocks()[0];
assert.ok(tightLayoutList);
const tightOuterItem = preparedChildren(tightLayoutList).find((node) => node.id === outerItemId);
assert.ok(tightOuterItem);
assert.equal(tightOuterItem.children?.find((node) => node.id === outerParagraphId)?.props.tight, true);
const tightNestedList = tightOuterItem.children?.find((node) => node.id === nestedListId);
assert.ok(tightNestedList);
const tightNestedItem = tightNestedList.children?.find((node) => node.id === nestedItemId);
assert.ok(tightNestedItem);
assert.equal(tightNestedItem.children?.find((node) => node.id === nestedParagraphId)?.props.tight, true);
applyPatchBatch(layoutDocument, [{
  op: "setProps",
  at: { blockId: layoutListId, nodeId: layoutListId },
  props: { loose: true },
}]);
const looseOuterList = layoutDocument.getBlocks()[0];
assert.ok(looseOuterList);
const looseOuterItem = preparedChildren(looseOuterList).find((node) => node.id === outerItemId);
assert.ok(looseOuterItem);
assert.equal(looseOuterItem.children?.find((node) => node.id === outerParagraphId)?.props.tight, false);
const inheritedNestedList = looseOuterItem.children?.find((node) => node.id === nestedListId);
assert.ok(inheritedNestedList);
const inheritedNestedItem = inheritedNestedList.children?.find((node) => node.id === nestedItemId);
assert.ok(inheritedNestedItem);
assert.equal(
  inheritedNestedItem.children?.find((node) => node.id === nestedParagraphId)?.props.tight,
  true,
  "nested secondary paragraphs keep their nearest list's tightness",
);
applyPatchBatch(layoutDocument, [{
  op: "setProps",
  at: { blockId: layoutListId, nodeId: nestedListId },
  props: { loose: true },
}]);
const looseNestedOuterList = layoutDocument.getBlocks()[0];
assert.ok(looseNestedOuterList);
const looseNestedOuterItem = preparedChildren(looseNestedOuterList).find((node) => node.id === outerItemId);
const looseNestedList = looseNestedOuterItem?.children?.find((node) => node.id === nestedListId);
const looseNestedItem = looseNestedList?.children?.find((node) => node.id === nestedItemId);
assert.equal(
  looseNestedItem?.children?.find((node) => node.id === nestedParagraphId)?.props.tight,
  false,
  "a nested list's loose update reaches its own secondary paragraphs",
);

console.log("generic container range test passed");
