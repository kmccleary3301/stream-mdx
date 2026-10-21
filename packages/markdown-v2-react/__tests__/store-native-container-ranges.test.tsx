import assert from "node:assert/strict";

import {
  PATCH_ROOT_ID,
  type Block,
  type InlineNode,
  type MixedContentSegment,
  type NodeSnapshot,
  type ParagraphBlockSnapshot,
  type ParagraphSpanChildSnapshot,
  type ParagraphSpanRecord,
  type Patch,
  type PreparedNestedSnapshot,
} from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const SOURCE_GENERATION = 41;
const INITIAL_RAW = "- Done\n- Parent\n  - old";
const SOURCE_APPEND = "\n    continued\n  - new";
const UPDATED_RAW = INITIAL_RAW + SOURCE_APPEND;
const LIST_ID = "native-list";
const COMPLETED_ITEM_ID = "native-list::item:0";
const PARENT_ITEM_ID = "native-list::item:1";
const NESTED_LIST_ID = `${PARENT_ITEM_ID}::list:0`;
const OLD_NESTED_ITEM_ID = `${NESTED_LIST_ID}::item:0`;
const OLD_TEXT_SEGMENT_ID = `${OLD_NESTED_ITEM_ID}::list-item:segment:0`;
const NEW_NESTED_ITEM_ID = `${NESTED_LIST_ID}::item:1`;
const COMPLETED_END = "- Done".length;
const PARENT_START = "- Done\n".length;
const NESTED_START = "- Done\n- Parent\n".length;
const OLD_TEXT_SEGMENT_FROM = NESTED_START + "  - ".length;
const EXTENDED_TEXT_SEGMENT_TO = NESTED_START + "  - old\n    continued".length;

function inlineText(text: string): InlineNode[] {
  return [{ kind: "text", text }];
}

function nativeBlock(
  id: string,
  type: string,
  range: { from: number; to: number },
  meta: Record<string, unknown> = {},
): Block {
  return {
    id,
    type,
    isFinalized: false,
    payload: { raw: "", range, meta },
  };
}

function listItemSnapshot(
  id: string,
  index: number,
  text: string,
  range: { from: number; to: number },
): NodeSnapshot {
  const inline = inlineText(text);
  return {
    id,
    type: "list-item",
    range,
    props: {
      block: nativeBlock(id, "list-item", range, { sourceContainer: "list" }),
      index,
      ordered: false,
      loose: false,
      inline,
      text,
      raw: "",
    },
    children: [],
  };
}

function listItemTextSnapshot(
  id: string,
  text: string,
  range: { from: number; to: number },
): NodeSnapshot {
  return {
    id,
    type: "list-item-text",
    range,
    props: { inline: inlineText(text), text },
    children: [],
  };
}

function managedPrimaryParagraph(
  id: string,
  range: { from: number; to: number },
  raw: string,
  text: string,
): NodeSnapshot {
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
    generation: 9,
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
      block: nativeBlock(id, "paragraph", range),
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
      props: { raw: mdxRaw, status: "error", error: "InlineChip compilation failed" },
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
    generation: 9,
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
      block: nativeBlock(id, "paragraph", range),
    },
    paragraph,
    children: [],
  };
}

function secondaryParagraphSnapshot(id: string, text: string, range: { from: number; to: number }): NodeSnapshot {
  const inline = inlineText(text);
  return {
    id,
    type: "paragraph",
    range,
    props: { block: nativeBlock(id, "paragraph", range), inline, text },
    children: [],
  };
}

function initialSnapshot(): NodeSnapshot {
  const listRange = { from: 0, to: INITIAL_RAW.length };
  const parentItem = listItemSnapshot(PARENT_ITEM_ID, 1, "Parent", {
    from: PARENT_START,
    to: INITIAL_RAW.length,
  });
  const oldNestedItem = listItemSnapshot(OLD_NESTED_ITEM_ID, 0, "old", {
    from: NESTED_START,
    to: INITIAL_RAW.length,
  });
  oldNestedItem.children = [listItemTextSnapshot(OLD_TEXT_SEGMENT_ID, "old", {
    from: OLD_TEXT_SEGMENT_FROM,
    to: INITIAL_RAW.length,
  })];
  const nestedList = {
    id: NESTED_LIST_ID,
    type: "list",
    range: { from: NESTED_START, to: INITIAL_RAW.length },
    props: {
      block: nativeBlock(NESTED_LIST_ID, "list", { from: NESTED_START, to: INITIAL_RAW.length }, {
        sourceContainer: "list",
        ordered: false,
        loose: false,
      }),
      ordered: false,
      loose: false,
    },
    children: [oldNestedItem],
  } satisfies NodeSnapshot;
  parentItem.children = [nestedList];
  return {
    id: PATCH_ROOT_ID,
    type: "__root__",
    inputSource: { generation: SOURCE_GENERATION, raw: INITIAL_RAW },
    children: [{
      id: LIST_ID,
      type: "list",
      range: listRange,
      props: {
        block: nativeBlock(LIST_ID, "list", listRange, {
          sourceContainer: "list",
          ordered: false,
          loose: false,
          items: [inlineText("initial list item")],
        }),
        ordered: false,
        loose: false,
      },
      meta: { items: [inlineText("stale snapshot item")] },
      children: [
        listItemSnapshot(COMPLETED_ITEM_ID, 0, "Done", { from: 0, to: COMPLETED_END }),
        parentItem,
      ],
    }],
  };
}

const DOM_GLOBALS = [
  "window",
  "document",
  "HTMLElement",
  "Node",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

async function runNativeContainerRangeTest(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const ambient = globalThis as unknown as Record<string, unknown>;
  const descriptors = new Map(DOM_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let root: Root | undefined;
  try {
    ambient.window = dom.window;
    ambient.document = dom.window.document;
    ambient.HTMLElement = dom.window.HTMLElement;
    ambient.Node = dom.window.Node;
    ambient.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
    ambient.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
    ambient.IS_REACT_ACT_ENVIRONMENT = true;

    const store = createRendererStore();
    store.resetSnapshot(initialSnapshot());
    const beforeBlocks = store.getBlocks();
    const beforeListBlock = beforeBlocks[0];
    assert.ok(beforeListBlock);
    assert.equal(beforeListBlock.payload.raw, INITIAL_RAW, "cold export reads the physical source range from the canonical input");
    assert.deepEqual(beforeListBlock.payload.range, { from: 0, to: INITIAL_RAW.length });
    const completedView = store.getNode(COMPLETED_ITEM_ID);
    const parentView = store.getNode(PARENT_ITEM_ID);
    const oldNestedListView = store.getNode(NESTED_LIST_ID);
    assert.ok(completedView?.block && parentView?.block && oldNestedListView?.block);
    const completedRaw = completedView.block.payload.raw;
    const oldParentRaw = parentView.block.payload.raw;
    const oldNestedListRaw = oldNestedListView.block.payload.raw;
    const rootChildArray = store.getChildren(LIST_ID);
    const currentEnd = UPDATED_RAW.length;
    const appendedItem = listItemSnapshot(NEW_NESTED_ITEM_ID, 1, "new", {
      from: NESTED_START + "  - old\n    continued\n".length,
      to: currentEnd,
    });
    const container = dom.window.document.getElementById("root");
    assert.ok(container);
    const registry = new ComponentRegistry();
    const notificationFrame = (): Promise<void> => new Promise((resolve) => {
      dom.window.requestAnimationFrame(() => resolve());
    });
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store, blockId: LIST_ID, registry }));
    });
    assert.deepEqual(
      Array.from(container.querySelectorAll("li"), (item) => item.textContent),
      ["Done", "Parentold", "old"],
      "the mounted list consumes prepared inline children instead of authored indentation",
    );

    const patches: Patch[] = [
      {
        op: "appendInputSource",
        at: { blockId: PATCH_ROOT_ID },
        generation: SOURCE_GENERATION,
        from: INITIAL_RAW.length,
        text: SOURCE_APPEND,
      },
      {
        op: "insertChild",
        at: { blockId: LIST_ID, nodeId: NESTED_LIST_ID },
        index: 1,
        node: appendedItem,
      },
      {
        op: "setProps",
        at: { blockId: LIST_ID, nodeId: LIST_ID },
        props: { range: { from: 0, to: currentEnd } },
      },
      {
        op: "setProps",
        at: { blockId: LIST_ID, nodeId: PARENT_ITEM_ID },
        props: { range: { from: PARENT_START, to: currentEnd } },
      },
      {
        op: "setProps",
        at: { blockId: LIST_ID, nodeId: NESTED_LIST_ID },
        props: { range: { from: NESTED_START, to: currentEnd } },
      },
      {
        op: "setProps",
        at: { blockId: LIST_ID, nodeId: OLD_NESTED_ITEM_ID },
        props: { range: { from: NESTED_START, to: appendedItem.range!.from } },
      },
      {
        op: "setProps",
        at: { blockId: LIST_ID, nodeId: OLD_TEXT_SEGMENT_ID },
        props: {
          range: { from: OLD_TEXT_SEGMENT_FROM, to: EXTENDED_TEXT_SEGMENT_TO },
          inline: inlineText("old continued"),
          text: "old continued",
        },
      },
      {
        op: "setProps",
        at: { blockId: LIST_ID, nodeId: LIST_ID },
        props: {
          block: nativeBlock(LIST_ID, "list", { from: 0, to: currentEnd }, {
            sourceContainer: "list",
            ordered: false,
            loose: false,
            items: [inlineText("latest list item")],
          }),
        },
      },
    ];
    await act(async () => {
      store.applyPatches(patches);
      await notificationFrame();
    });

    assert.deepEqual(
      Array.from(container.querySelectorAll("li"), (item) => item.textContent),
      ["Done", "Parentold continuednew", "old continued", "new"],
      "mounted nested views use admitted children and keep source indentation out of display text",
    );
    const nestedList = store.getNode(NESTED_LIST_ID);
    const parentItem = store.getNode(PARENT_ITEM_ID);
    const rootList = store.getNode(LIST_ID);
    assert.ok(nestedList?.block && parentItem?.block && rootList?.block);
    assert.deepEqual(nestedList.range, { from: NESTED_START, to: currentEnd });
    assert.deepEqual(parentItem.range, { from: PARENT_START, to: currentEnd });
    assert.deepEqual(rootList.range, { from: 0, to: currentEnd });
    assert.equal(nestedList.block.payload.raw, UPDATED_RAW.slice(NESTED_START, currentEnd));
    assert.equal(parentItem.block.payload.raw, UPDATED_RAW.slice(PARENT_START, currentEnd));
    assert.equal(store.getNode(NEW_NESTED_ITEM_ID)?.block?.payload.raw, UPDATED_RAW.slice(appendedItem.range!.from, currentEnd));
    const segmentRangeAfterAppend = store.getNode(OLD_TEXT_SEGMENT_ID)?.range;
    assert.deepEqual(segmentRangeAfterAppend, {
      from: OLD_TEXT_SEGMENT_FROM,
      to: EXTENDED_TEXT_SEGMENT_TO,
    }, "mixed text segment range advances with its authored source");
    const publishedRangeBlocks = store.getBlocks();
    await act(async () => {
      store.applyPatches([{
        op: "setProps",
        at: { blockId: LIST_ID, nodeId: OLD_TEXT_SEGMENT_ID },
        props: { inline: inlineText("meaning changed"), text: "meaning changed" },
      }]);
      await notificationFrame();
    });
    assert.deepEqual(
      Array.from(container.querySelectorAll("li"), (item) => item.textContent),
      ["Done", "Parentmeaning changednew", "meaning changed", "new"],
      "source-neutral segment meaning changes reach the mounted generic child",
    );
    assert.equal(store.getChildren(LIST_ID), rootChildArray, "range growth does not rebuild the completed root child array");
    assert.equal(store.getNode(COMPLETED_ITEM_ID)?.block?.payload.raw, completedRaw);
    assert.deepEqual(oldNestedListView.range, { from: NESTED_START, to: INITIAL_RAW.length });
    assert.equal(oldNestedListView.block.payload.raw, oldNestedListRaw, "captured native views retain their authored source window");
    assert.equal(parentView.block.payload.raw, oldParentRaw, "captured parent history is immutable after source growth");
    assert.equal(completedView.block.payload.raw, completedRaw, "completed sibling history is immutable after source growth");
    assert.equal(beforeBlocks[0]?.payload.raw, INITIAL_RAW, "published cold blocks remain unchanged after range growth");

    const currentBlocks = store.getBlocks();
    const currentBlock = currentBlocks[0];
    assert.ok(currentBlock);
    assert.equal(currentBlock.payload.raw, UPDATED_RAW);
    assert.deepEqual(currentBlock.payload.range, { from: 0, to: currentEnd });
    const customListRegistry = new ComponentRegistry();
    customListRegistry.setBlockComponents({
      list: ({ items }) => createElement(
        "ul",
        null,
        items.map((item, index) => createElement(
          "li",
          { key: index },
          item.map((inline) => inline.kind === "text" ? inline.text : "").join(""),
        )),
      ),
    });
    const customListMarkup = renderToStaticMarkup(customListRegistry.renderBlock(currentBlock));
    assert.equal(
      new JSDOM(customListMarkup).window.document.querySelector("li")?.textContent,
      "latest list item",
      "custom list renderers consume the current block metadata",
    );
    const prepared = currentBlock.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
    assert.ok(prepared);
    const currentParent = prepared.children.find((node) => node.id === PARENT_ITEM_ID);
    const currentNestedList = currentParent?.children?.find((node) => node.id === NESTED_LIST_ID);
    assert.deepEqual(currentParent?.range, { from: PARENT_START, to: currentEnd });
    assert.deepEqual(currentNestedList?.range, { from: NESTED_START, to: currentEnd });
    const segmentVersion = store.getVersion();
    await act(async () => {
      store.applyPatches([{
        op: "setProps",
        at: { blockId: LIST_ID, nodeId: OLD_TEXT_SEGMENT_ID },
        props: {
          range: { from: OLD_TEXT_SEGMENT_FROM, to: currentEnd + 1 },
          inline: inlineText("rejected segment meaning"),
          text: "rejected segment meaning",
        },
      }]);
      await notificationFrame();
    });
    assert.equal(store.getVersion(), segmentVersion, "invalid segment range rejects the whole mixed-content update");
    assert.deepEqual(
      Array.from(container.querySelectorAll("li"), (item) => item.textContent),
      ["Done", "Parentmeaning changednew", "meaning changed", "new"],
      "invalid source ranges cannot partially replace rendered segment meaning",
    );
    const coldStore = createRendererStore(currentBlocks);
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store: coldStore, blockId: LIST_ID, registry }));
    });
    assert.deepEqual(
      Array.from(container.querySelectorAll("li"), (item) => item.textContent),
      ["Done", "Parentmeaning changednew", "meaning changed", "new"],
      "cold blocks round-trip the current generic hierarchy without stale nested metadata",
    );
    const historicalStore = createRendererStore(publishedRangeBlocks);
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store: historicalStore, blockId: LIST_ID, registry }));
    });
    assert.deepEqual(
      Array.from(container.querySelectorAll("li"), (item) => item.textContent),
      ["Done", "Parentold continuednew", "old continued", "new"],
      "previously published cold blocks remain historical after later segment updates",
    );

    const acceptedVersion = store.getVersion();
    store.applyPatches([{
      op: "setProps",
      at: { blockId: LIST_ID, nodeId: NESTED_LIST_ID },
      props: { range: { from: NESTED_START, to: currentEnd + 1 }, loose: true },
    }]);
    assert.equal(store.getVersion(), acceptedVersion, "out-of-source range updates are rejected atomically");
    assert.equal(store.getNode(NESTED_LIST_ID)?.props.loose, false);
    assert.deepEqual(store.getNode(NESTED_LIST_ID)?.range, { from: NESTED_START, to: currentEnd });

    store.applyPatches([{
      op: "setProps",
      at: { blockId: LIST_ID, nodeId: NESTED_LIST_ID },
      props: { range: { from: NESTED_START + 0.5, to: currentEnd }, ordered: true },
    }]);
    assert.equal(store.getVersion(), acceptedVersion, "malformed range updates are rejected atomically");
    assert.equal(store.getNode(NESTED_LIST_ID)?.props.ordered, false);

    const currentEpoch = store.getNode(NESTED_LIST_ID)?.blockEpoch;
    assert.ok(typeof currentEpoch === "number" && currentEpoch > 0);
    store.applyPatches([{
      op: "setProps",
      at: { blockId: LIST_ID, nodeId: NESTED_LIST_ID },
      meta: { kind: "semantic", blockEpoch: currentEpoch - 1 },
      props: { range: { from: NESTED_START, to: currentEnd - 1 }, loose: true },
    }]);
    assert.deepEqual(store.getNode(NESTED_LIST_ID)?.range, { from: NESTED_START, to: currentEnd });
    assert.equal(store.getNode(NESTED_LIST_ID)?.props.loose, false, "stale epoch range updates leave admitted state untouched");

    const blocksBeforeReorder = store.getBlocks();
    store.applyPatches([{ op: "reorder", at: { blockId: LIST_ID, nodeId: LIST_ID }, from: 1, to: 0, count: 1 }]);
    const reorderedStore = createRendererStore(store.getBlocks());
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store: reorderedStore, blockId: LIST_ID, registry }));
    });
    assert.deepEqual(
      Array.from(container.querySelectorAll("li"), (item) => item.textContent),
      ["Parentmeaning changednew", "meaning changed", "new", "Done"],
      "a cold export read after a native child reorder remounts the current item order",
    );
    const beforeReorderStore = createRendererStore(blocksBeforeReorder);
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store: beforeReorderStore, blockId: LIST_ID, registry }));
    });
    assert.deepEqual(
      Array.from(container.querySelectorAll("li"), (item) => item.textContent),
      ["Done", "Parentmeaning changednew", "meaning changed", "new"],
      "the cold export published before the reorder keeps its historical item order",
    );

    const unmanagedParagraphRaw = "before";
    const unmanagedParagraphAppend = " after";
    const unmanagedParagraphId = "generic-quote::paragraph";
    const unmanagedParagraphRange = { from: 0, to: unmanagedParagraphRaw.length };
    const unmanagedParagraph: NodeSnapshot = {
      id: unmanagedParagraphId,
      type: "paragraph",
      range: unmanagedParagraphRange,
      props: {
        block: nativeBlock(unmanagedParagraphId, "paragraph", unmanagedParagraphRange),
        inline: inlineText("before"),
        text: "before",
      },
      children: [],
    };
    const quoteRange = { from: 0, to: unmanagedParagraphRaw.length };
    const genericQuote: NodeSnapshot = {
      id: "generic-quote",
      type: "blockquote",
      range: quoteRange,
      props: {
        block: nativeBlock("generic-quote", "blockquote", quoteRange, {
          preparedNested: { props: {}, children: [unmanagedParagraph] } satisfies PreparedNestedSnapshot,
        }),
      },
      children: [unmanagedParagraph],
    };
    const unmanagedParagraphStore = createRendererStore();
    unmanagedParagraphStore.resetSnapshot({
      id: PATCH_ROOT_ID,
      type: "__root__",
      inputSource: { generation: SOURCE_GENERATION + 1, raw: unmanagedParagraphRaw },
      children: [genericQuote],
    });
    const unmanagedParagraphEnd = unmanagedParagraphRaw.length + unmanagedParagraphAppend.length;
    await act(async () => {
      unmanagedParagraphStore.applyPatches([
        {
          op: "appendInputSource",
          at: { blockId: PATCH_ROOT_ID },
          generation: SOURCE_GENERATION + 1,
          from: unmanagedParagraphRaw.length,
          text: unmanagedParagraphAppend,
        },
        {
          op: "setProps",
          at: { blockId: "generic-quote", nodeId: "generic-quote" },
          props: { range: { from: 0, to: unmanagedParagraphEnd } },
        },
        {
          op: "setProps",
          at: { blockId: "generic-quote", nodeId: unmanagedParagraphId },
          props: {
            range: { from: 0, to: unmanagedParagraphEnd },
            inline: inlineText("before after"),
            text: "before after",
          },
        },
      ]);
      await notificationFrame();
    });
    assert.deepEqual(unmanagedParagraphStore.getNode(unmanagedParagraphId)?.range, {
      from: 0,
      to: unmanagedParagraphEnd,
    });
    assert.equal(
      unmanagedParagraphStore.getNode(unmanagedParagraphId)?.props.text,
      "before after",
      "an unmanaged nested paragraph keeps the semantic props beside its physical source range",
    );
    await act(async () => {
      unmanagedParagraphStore.applyPatches([{
        op: "setProps",
        at: { blockId: "generic-quote", nodeId: unmanagedParagraphId },
        props: { inline: inlineText("current paragraph meaning"), text: "current paragraph meaning" },
      }]);
      await notificationFrame();
    });
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store: unmanagedParagraphStore, blockId: "generic-quote", registry }));
    });
    assert.equal(
      container.querySelector("blockquote")?.textContent,
      "before after",
      "the mounted quote renders its admitted generic child over the grown source window",
    );
    const liveQuotePrepared = unmanagedParagraphStore.getNode("generic-quote")?.block?.payload.meta?.preparedNested as
      | PreparedNestedSnapshot
      | undefined;
    assert.equal(
      liveQuotePrepared?.children[0]?.props?.text,
      "current paragraph meaning",
      "a live quote read reflects the current nested meaning instead of its initial prepared tree",
    );
    const coldQuoteStore = createRendererStore(unmanagedParagraphStore.getBlocks());
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store: coldQuoteStore, blockId: "generic-quote", registry }));
    });
    assert.equal(container.querySelector("blockquote")?.textContent, "before after");
    assert.equal(
      coldQuoteStore.getNode(unmanagedParagraphId)?.props.text,
      "current paragraph meaning",
      "a remounted cold quote carries the current nested meaning",
    );

    const rootParagraphId = "root-unmanaged-paragraph";
    const rootParagraphRaw = "before";
    const rootParagraphAppend = " after";
    const rootParagraphRange = { from: 0, to: rootParagraphRaw.length };
    const rootParagraphEnd = rootParagraphRaw.length + rootParagraphAppend.length;
    const rootParagraphStore = createRendererStore();
    rootParagraphStore.resetSnapshot({
      id: PATCH_ROOT_ID,
      type: "__root__",
      inputSource: { generation: SOURCE_GENERATION + 2, raw: rootParagraphRaw },
      children: [{
        id: rootParagraphId,
        type: "paragraph",
        range: rootParagraphRange,
        props: {
          block: {
            id: rootParagraphId,
            type: "paragraph",
            isFinalized: false,
            payload: { raw: rootParagraphRaw, range: rootParagraphRange, inline: inlineText("before"), meta: {} },
          } satisfies Block,
          inline: inlineText("before"),
          text: "before",
        },
        children: [],
      }],
    });
    const publishedRootParagraph = rootParagraphStore.getBlocks()[0];
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store: rootParagraphStore, blockId: rootParagraphId, registry }));
    });
    assert.equal(container.querySelector("p")?.textContent, "before");
    await act(async () => {
      rootParagraphStore.applyPatches([
        {
          op: "appendInputSource",
          at: { blockId: PATCH_ROOT_ID },
          generation: SOURCE_GENERATION + 2,
          from: rootParagraphRaw.length,
          text: rootParagraphAppend,
        },
        {
          op: "setProps",
          at: { blockId: rootParagraphId },
          props: { range: { from: 0, to: rootParagraphEnd } },
        },
      ]);
      await notificationFrame();
    });
    assert.equal(
      container.querySelector("p")?.textContent,
      "before after",
      "a mounted root unmanaged paragraph reads its admitted source window",
    );
    const currentRootParagraph = rootParagraphStore.getBlocks()[0];
    assert.equal(currentRootParagraph?.payload.raw, "before after", "the root paragraph cold export follows its admitted range");
    assert.deepEqual(currentRootParagraph?.payload.range, { from: 0, to: rootParagraphEnd });
    const coldRootParagraphStore = createRendererStore(rootParagraphStore.getBlocks());
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store: coldRootParagraphStore, blockId: rootParagraphId, registry }));
    });
    assert.equal(container.querySelector("p")?.textContent, "before after", "the remounted root paragraph renders the current window");
    assert.equal(publishedRootParagraph?.payload.raw, "before", "the earlier root paragraph export keeps its capped window");
    assert.deepEqual(publishedRootParagraph?.payload.range, rootParagraphRange);

    // A producer may carry the prepared layout only on the snapshot meta. A registered quote wrapper must still
    // receive the generic children rendered through the native quote view.
    const metaQuoteRaw = "quoted";
    const metaQuoteRange = { from: 0, to: metaQuoteRaw.length };
    const metaQuoteParagraphId = "meta-quote::paragraph";
    const metaQuoteParagraph: NodeSnapshot = {
      id: metaQuoteParagraphId,
      type: "paragraph",
      range: metaQuoteRange,
      props: {
        block: nativeBlock(metaQuoteParagraphId, "paragraph", metaQuoteRange),
        inline: inlineText(metaQuoteRaw),
        text: metaQuoteRaw,
      },
      children: [],
    };
    const metaQuoteStore = createRendererStore();
    metaQuoteStore.resetSnapshot({
      id: PATCH_ROOT_ID,
      type: "__root__",
      inputSource: { generation: SOURCE_GENERATION + 3, raw: metaQuoteRaw },
      children: [{
        id: "meta-quote",
        type: "blockquote",
        range: metaQuoteRange,
        props: { block: nativeBlock("meta-quote", "blockquote", metaQuoteRange) },
        meta: { preparedNested: { props: {}, children: [metaQuoteParagraph] } satisfies PreparedNestedSnapshot },
        children: [metaQuoteParagraph],
      }],
    });
    const registeredQuoteRegistry = new ComponentRegistry();
    registeredQuoteRegistry.setBlockComponents({
      blockquote: ({ renderedContent }) => createElement("blockquote", { className: "registered-quote" }, renderedContent),
    });
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store: metaQuoteStore, blockId: "meta-quote", registry: registeredQuoteRegistry }));
    });
    assert.equal(
      container.querySelector("blockquote.registered-quote p")?.textContent,
      metaQuoteRaw,
      "a registered quote wrapper renders meta-prepared generic children through the native quote view",
    );

    // A reset to a new source baseline reuses the unchanged paragraph record; its live view must read the new source.
    const baselineParagraphId = "baseline-paragraph";
    const baselineRange = { from: 0, to: "before".length };
    const baselineSnapshot = (generation: number, raw: string): NodeSnapshot => ({
      id: PATCH_ROOT_ID,
      type: "__root__",
      inputSource: { generation, raw },
      children: [{
        id: baselineParagraphId,
        type: "paragraph",
        range: baselineRange,
        props: { block: nativeBlock(baselineParagraphId, "paragraph", baselineRange) },
        children: [],
      }],
    });
    const baselineStore = createRendererStore();
    baselineStore.resetSnapshot(baselineSnapshot(SOURCE_GENERATION + 4, "before"));
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store: baselineStore, blockId: baselineParagraphId, registry }));
    });
    assert.equal(container.querySelector("p")?.textContent, "before");
    const beforeResetBlocks = baselineStore.getBlocks();
    assert.equal(beforeResetBlocks[0]?.payload.raw, "before", "the initial cold export reads the canonical source window");
    assert.deepEqual(beforeResetBlocks[0]?.payload.range, baselineRange);
    await act(async () => {
      baselineStore.resetSnapshot(baselineSnapshot(SOURCE_GENERATION + 5, "after!"));
      await notificationFrame();
    });
    assert.equal(
      container.querySelector("p")?.textContent,
      "after!",
      "a paragraph reused across a source baseline reset renders the new canonical source",
    );
    const afterResetBlocks = baselineStore.getBlocks();
    assert.equal(afterResetBlocks[0]?.payload.raw, "after!", "the reset cold export reads the new canonical source window");
    assert.deepEqual(afterResetBlocks[0]?.payload.range, baselineRange);
    const afterResetColdStore = createRendererStore(afterResetBlocks);
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store: afterResetColdStore, blockId: baselineParagraphId, registry }));
    });
    assert.equal(container.querySelector("p")?.textContent, "after!", "the remounted reset export renders the new source window");
    const beforeResetColdStore = createRendererStore(beforeResetBlocks);
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store: beforeResetColdStore, blockId: baselineParagraphId, registry }));
    });
    assert.equal(container.querySelector("p")?.textContent, "before", "the export published before the reset keeps its window");
    assert.equal(beforeResetBlocks[0]?.payload.raw, "before");

    const primaryListId = "managed-primary-list";
    const primaryItemId = `${primaryListId}::item:0`;
    const primaryParagraphId = `${primaryItemId}::paragraph`;
    const primaryRaw = "- [x] alpha";
    const primaryAppend = " growth";
    const currentPrimaryRaw = primaryRaw + primaryAppend;
    const primaryItemRange = { from: 0, to: primaryRaw.length };
    const primaryParagraphRange = { from: 6, to: primaryRaw.length };
    const primaryParagraph = managedPrimaryParagraph(primaryParagraphId, primaryParagraphRange, "alpha", "alpha");
    const primaryItem: NodeSnapshot = {
      id: primaryItemId,
      type: "list-item",
      range: primaryItemRange,
      props: {
        block: nativeBlock(primaryItemId, "list-item", primaryItemRange, { sourceContainer: "list" }),
        index: 0,
        ordered: false,
        loose: false,
        start: 1,
        task: true,
        checked: true,
        raw: "",
      },
      children: [primaryParagraph],
    };
    const primaryListRange = { from: 0, to: primaryRaw.length };
    const primaryList: NodeSnapshot = {
      id: primaryListId,
      type: "list",
      range: primaryListRange,
      props: {
        block: nativeBlock(primaryListId, "list", primaryListRange, {
          sourceContainer: "list",
          ordered: false,
          loose: false,
          start: 1,
          items: [inlineText("stale")],
        }),
        ordered: false,
        loose: false,
        start: 1,
        items: [inlineText("stale")],
      },
      children: [primaryItem],
    };
    const managedPrimaryStore = createRendererStore();
    managedPrimaryStore.resetSnapshot({
      id: PATCH_ROOT_ID,
      type: "__root__",
      inputSource: { generation: SOURCE_GENERATION + 6, raw: primaryRaw },
      children: [primaryList],
    });
    const livePrimaryItem = managedPrimaryStore.getNode(primaryItemId);
    assert.ok(livePrimaryItem);
    assert.deepEqual(managedPrimaryStore.getChildren(primaryItemId), [primaryParagraphId]);
    assert.equal(livePrimaryItem.block?.payload.inline, undefined, "native item reads retain the unmaterialized block");
    const historicalPrimaryBlocks = managedPrimaryStore.getBlocks();
    const historicalPrimaryList = historicalPrimaryBlocks[0];
    assert.ok(historicalPrimaryList);
    assert.equal(historicalPrimaryList.payload.raw, primaryRaw);
    assert.deepEqual(historicalPrimaryList.payload.meta?.items, [inlineText("alpha")]);
    const historicalPrepared = historicalPrimaryList.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
    assert.ok(historicalPrepared);
    const historicalPrimaryItem = historicalPrepared.children.find((node) => node.id === primaryItemId);
    assert.ok(historicalPrimaryItem);
    assert.deepEqual(historicalPrimaryItem.props.inline, inlineText("alpha"));
    assert.equal(historicalPrimaryItem.props.task, true);
    assert.equal(historicalPrimaryItem.props.checked, true);
    assert.equal(historicalPrimaryItem.props.raw, "- [x] alpha");
    assert.equal(historicalPrimaryItem.children?.some((node) => node.id === primaryParagraphId), false);
    const currentPrimaryParagraphRange = { from: 6, to: currentPrimaryRaw.length };
    const currentPrimarySpan: ParagraphSpanRecord = {
      id: `${primaryParagraphId}:span:0`,
      index: 0,
      sourceRange: currentPrimaryParagraphRange,
      sourceRevision: 1,
      isProvisional: true,
      nodes: inlineText("alpha growth"),
      attemptedReferences: [],
    };
    managedPrimaryStore.applyPatches([
      {
        op: "appendInputSource",
        at: { blockId: PATCH_ROOT_ID },
        generation: SOURCE_GENERATION + 6,
        from: primaryRaw.length,
        text: primaryAppend,
      },
      {
        op: "appendParagraph",
        at: { blockId: primaryListId, nodeId: primaryParagraphId },
        paragraphOwnerId: primaryParagraphId,
        generation: 9,
        expectedRevision: 0,
        revision: 1,
        sourceAppend: primaryAppend,
        fromSpan: 0,
        spans: [currentPrimarySpan],
        paragraph: {
          paragraphOwnerId: primaryParagraphId,
          generation: 9,
          revision: 1,
          state: "open",
          processedTo: currentPrimaryRaw.length,
          completeSpanCount: 0,
          spanCount: 1,
          sourceRange: currentPrimaryParagraphRange,
        },
      },
      {
        op: "setProps",
        at: { blockId: primaryListId, nodeId: primaryListId },
        props: {
          range: { from: 0, to: currentPrimaryRaw.length },
          ordered: true,
          loose: true,
          start: 9,
        },
      },
      {
        op: "setProps",
        at: { blockId: primaryListId, nodeId: primaryItemId },
        props: { range: { from: 0, to: currentPrimaryRaw.length }, ordered: false, loose: false, start: 1 },
      },
      {
        op: "setProps",
        at: { blockId: primaryListId, nodeId: primaryParagraphId },
        props: { range: currentPrimaryParagraphRange },
      },
    ]);
    assert.deepEqual(managedPrimaryStore.getChildren(primaryItemId), [primaryParagraphId]);
    const currentPrimaryBlocks = managedPrimaryStore.getBlocks();
    const currentPrimaryList = currentPrimaryBlocks[0];
    assert.ok(currentPrimaryList);
    assert.equal(currentPrimaryList.payload.raw, currentPrimaryRaw);
    assert.deepEqual(currentPrimaryList.payload.meta?.items, [inlineText("alpha growth")]);
    const currentPrimaryPrepared = currentPrimaryList.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
    assert.ok(currentPrimaryPrepared);
    assert.deepEqual(currentPrimaryPrepared.props.items, [inlineText("alpha growth")]);
    const currentPrimaryItem = currentPrimaryPrepared.children.find((node) => node.id === primaryItemId);
    assert.ok(currentPrimaryItem);
    assert.deepEqual(currentPrimaryItem.props.inline, inlineText("alpha growth"));
    assert.equal(currentPrimaryItem.props.text, "alpha growth");
    assert.equal(currentPrimaryItem.props.ordered, true);
    assert.equal(currentPrimaryItem.props.loose, true);
    assert.equal(currentPrimaryItem.props.start, 9);
    assert.equal(currentPrimaryItem.props.task, true);
    assert.equal(currentPrimaryItem.props.checked, true);
    assert.equal(currentPrimaryItem.props.raw, "- [x] alpha growth");
    assert.equal(currentPrimaryItem.children?.some((node) => node.id === primaryParagraphId), false);
    assert.equal(historicalPrimaryItem.props.text, "alpha", "published legacy item snapshots keep historical meaning");
    assert.equal(historicalPrimaryList.payload.raw, primaryRaw);
    const remountedPrimaryStore = createRendererStore(currentPrimaryBlocks);
    const remountedPrimaryList = remountedPrimaryStore.getBlocks()[0];
    assert.ok(remountedPrimaryList);
    assert.deepEqual(remountedPrimaryList.payload.meta?.items, [inlineText("alpha growth")]);
    const remountedPrimaryPrepared = remountedPrimaryList.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
    assert.ok(remountedPrimaryPrepared);
    assert.deepEqual(remountedPrimaryPrepared.props.items, [inlineText("alpha growth")]);
    const remountedPrimaryItem = remountedPrimaryPrepared.children.find((node) => node.id === primaryItemId);
    assert.deepEqual(remountedPrimaryItem?.props.inline, inlineText("alpha growth"));
    assert.equal(remountedPrimaryItem?.props.raw, "- [x] alpha growth");
    assert.equal(remountedPrimaryItem?.children?.some((node) => node.id === primaryParagraphId), false);
    const mixedPrimaryListId = "managed-mixed-primary-list";
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
    const mixedPrimaryItem: NodeSnapshot = {
      id: mixedPrimaryItemId,
      type: "list-item",
      range: mixedPrimaryItemRange,
      props: {
        block: nativeBlock(mixedPrimaryItemId, "list-item", mixedPrimaryItemRange, {
          sourceContainer: "list",
          preparedNested: { props: {}, children: [mixedPrimaryParagraph] },
        }),
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
        block: nativeBlock(mixedPrimaryListId, "list", mixedPrimaryListRange, {
          sourceContainer: "list",
          ordered: false,
          loose: false,
          start: 1,
          items: [inlineText("stale")],
          preparedNested: { props: {}, children: [mixedPrimaryItem] },
        }),
        ordered: false,
        loose: false,
        start: 1,
        items: [inlineText("stale")],
      },
      children: [mixedPrimaryItem],
    };
    const managedMixedPrimaryStore = createRendererStore();
    managedMixedPrimaryStore.resetSnapshot({
      id: PATCH_ROOT_ID,
      type: "__root__",
      inputSource: { generation: SOURCE_GENERATION + 7, raw: mixedPrimaryRaw },
      children: [mixedPrimaryList],
    });
    assert.deepEqual(managedMixedPrimaryStore.getChildren(mixedPrimaryItemId), [mixedPrimaryParagraphId]);
    assert.equal(
      managedMixedPrimaryStore.getNode(mixedPrimaryItemId)?.block?.payload.inline,
      undefined,
      "native item reads keep the primary paragraph as a child instead of cold inline materialization",
    );
    const historicalMixedPrimaryBlocks = managedMixedPrimaryStore.getBlocks();
    const historicalMixedPrimaryList = historicalMixedPrimaryBlocks[0];
    assert.ok(historicalMixedPrimaryList);
    assert.equal(historicalMixedPrimaryList.payload.raw, mixedPrimaryRaw);
    assert.deepEqual(historicalMixedPrimaryList.payload.meta?.items, [[
      { kind: "text", text: "Before " },
      { kind: "html", raw: '<span onclick="bad()">HTML</span>', sanitized: "<span>HTML</span>" },
      { kind: "text", text: " " },
      { kind: "text", text: " tail" },
    ]]);
    const historicalMixedPrepared = historicalMixedPrimaryList.payload.meta?.preparedNested as
      | PreparedNestedSnapshot
      | undefined;
    assert.ok(historicalMixedPrepared);
    const historicalMixedPrimaryItem = historicalMixedPrepared.children.find((node) => node.id === mixedPrimaryItemId);
    assert.ok(historicalMixedPrimaryItem);
    const historicalMixedPrimaryInline: InlineNode[] = [
      { kind: "text", text: "Before " },
      { kind: "html", raw: '<span onclick="bad()">HTML</span>', sanitized: "<span>HTML</span>" },
      { kind: "text", text: " " },
      { kind: "text", text: " tail" },
    ];
    assert.deepEqual(historicalMixedPrimaryItem.props.inline, historicalMixedPrimaryInline);
    const historicalMixedItemBlock = historicalMixedPrimaryItem.props.block as Block | undefined;
    assert.ok(historicalMixedItemBlock);
    assert.equal(historicalMixedItemBlock.payload.raw, mixedPrimaryRaw);
    assert.deepEqual(historicalMixedItemBlock.payload.inline, historicalMixedPrimaryInline);
    const historicalMixedSegments = historicalMixedItemBlock.payload.meta?.mixedSegments as MixedContentSegment[] | undefined;
    assert.ok(historicalMixedSegments);
    const historicalMdxSegment = historicalMixedSegments.find((segment) => segment.kind === "mdx");
    assert.ok(historicalMdxSegment);
    assert.equal(historicalMdxSegment.value, '<InlineChip tone="warm" />');
    assert.equal(historicalMdxSegment.status, "error");
    assert.equal(historicalMdxSegment.error, "InlineChip compilation failed");
    const historicalMdxChild = historicalMixedPrimaryItem.children?.find((node) => node.type === "list-item-mdx");
    assert.ok(historicalMdxChild);
    assert.equal(historicalMdxChild.props.raw, historicalMdxSegment.value);
    assert.equal(historicalMdxChild.props.status, historicalMdxSegment.status);
    assert.equal(historicalMdxChild.props.error, historicalMdxSegment.error);
    assert.equal(
      mixedPrimaryRaw.slice(historicalMdxChild.range?.from ?? 0, historicalMdxChild.range?.to ?? 0),
      historicalMdxSegment.value,
    );
    assert.ok(historicalMixedPrimaryItem.children?.some((node) => node.type === "list-item-text"));
    assert.ok(historicalMixedPrimaryItem.children?.some((node) => node.type === "list-item-html"));
    assert.ok(!historicalMixedPrimaryItem.children?.some((node) => node.type === "paragraph-mdx"));
    assert.equal(
      managedMixedPrimaryStore.getNode(mixedPrimaryItemId)?.block?.payload.inline,
      undefined,
      "requesting a cold export does not rewrite native item inline state",
    );

    const currentMixedPrimaryParagraphRange = { from: 2, to: currentMixedPrimaryRaw.length };
    const currentMixedPrimaryParagraph = managedMixedPrimaryParagraph(
      mixedPrimaryParagraphId,
      currentMixedPrimaryParagraphRange,
      currentMixedPrimaryParagraphRaw,
      1,
    );
    const currentMixedPrimarySpan = currentMixedPrimaryParagraph.paragraph?.spans[0];
    assert.ok(currentMixedPrimarySpan);
    managedMixedPrimaryStore.applyPatches([
      {
        op: "appendInputSource",
        at: { blockId: PATCH_ROOT_ID },
        generation: SOURCE_GENERATION + 7,
        from: mixedPrimaryRaw.length,
        text: mixedPrimaryAppend,
      },
      {
        op: "appendParagraph",
        at: { blockId: mixedPrimaryListId, nodeId: mixedPrimaryParagraphId },
        paragraphOwnerId: mixedPrimaryParagraphId,
        generation: 9,
        expectedRevision: 0,
        revision: 1,
        sourceAppend: mixedPrimaryAppend,
        fromSpan: 0,
        spans: [currentMixedPrimarySpan],
        paragraph: {
          paragraphOwnerId: mixedPrimaryParagraphId,
          generation: 9,
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
    assert.deepEqual(managedMixedPrimaryStore.getChildren(mixedPrimaryItemId), [mixedPrimaryParagraphId]);
    const currentMixedPrimaryBlocks = managedMixedPrimaryStore.getBlocks();
    const currentMixedPrimaryList = currentMixedPrimaryBlocks[0];
    assert.ok(currentMixedPrimaryList);
    assert.equal(currentMixedPrimaryList.payload.raw, currentMixedPrimaryRaw);
    const currentMixedPrimaryInline: InlineNode[] = [
      { kind: "text", text: "Before " },
      { kind: "html", raw: '<span onclick="bad()">HTML</span>', sanitized: "<span>HTML</span>" },
      { kind: "text", text: " " },
      { kind: "text", text: " tail continued" },
    ];
    assert.deepEqual(currentMixedPrimaryList.payload.meta?.items, [currentMixedPrimaryInline]);
    const currentMixedPrepared = currentMixedPrimaryList.payload.meta?.preparedNested as
      | PreparedNestedSnapshot
      | undefined;
    assert.ok(currentMixedPrepared);
    const currentMixedPrimaryItem = currentMixedPrepared.children.find((node) => node.id === mixedPrimaryItemId);
    assert.ok(currentMixedPrimaryItem);
    assert.deepEqual(currentMixedPrimaryItem.props.inline, currentMixedPrimaryInline);
    const currentMixedItemBlock = currentMixedPrimaryItem.props.block as Block | undefined;
    assert.ok(currentMixedItemBlock);
    assert.equal(currentMixedItemBlock.payload.raw, currentMixedPrimaryRaw);
    assert.deepEqual(currentMixedItemBlock.payload.inline, currentMixedPrimaryInline);
    const currentMixedSegments = currentMixedItemBlock.payload.meta?.mixedSegments as MixedContentSegment[] | undefined;
    assert.ok(currentMixedSegments);
    const currentMdxSegment = currentMixedSegments.find((segment) => segment.kind === "mdx");
    assert.ok(currentMdxSegment);
    assert.equal(currentMdxSegment.value, '<InlineChip tone="warm" />');
    assert.equal(currentMdxSegment.status, "error");
    assert.equal(currentMdxSegment.error, "InlineChip compilation failed");
    const currentMdxChild = currentMixedPrimaryItem.children?.find((node) => node.type === "list-item-mdx");
    assert.ok(currentMdxChild);
    assert.equal(currentMdxChild.props.raw, currentMdxSegment.value);
    assert.equal(currentMdxChild.props.status, currentMdxSegment.status);
    assert.equal(currentMdxChild.props.error, currentMdxSegment.error);
    assert.equal(
      currentMixedPrimaryRaw.slice(currentMdxChild.range?.from ?? 0, currentMdxChild.range?.to ?? 0),
      currentMdxSegment.value,
    );
    assert.equal(historicalMixedPrimaryList.payload.raw, mixedPrimaryRaw);
    assert.deepEqual(historicalMixedPrimaryItem.props.inline, historicalMixedPrimaryInline);
    assert.equal(historicalMdxChild.props.status, "error");
    const remountedMixedPrimaryStore = createRendererStore(currentMixedPrimaryBlocks);
    const remountedMixedPrimaryList = remountedMixedPrimaryStore.getBlocks()[0];
    assert.ok(remountedMixedPrimaryList);
    const remountedMixedPrepared = remountedMixedPrimaryList.payload.meta?.preparedNested as
      | PreparedNestedSnapshot
      | undefined;
    assert.ok(remountedMixedPrepared);
    const remountedMixedPrimaryItem = remountedMixedPrepared.children.find((node) => node.id === mixedPrimaryItemId);
    assert.ok(remountedMixedPrimaryItem);
    assert.deepEqual(remountedMixedPrimaryItem.props.inline, currentMixedPrimaryInline);
    const remountedMdxChild = remountedMixedPrimaryItem.children?.find((node) => node.type === "list-item-mdx");
    assert.equal(remountedMdxChild?.props.raw, currentMdxSegment.value);
    assert.equal(remountedMdxChild?.props.status, currentMdxSegment.status);
    assert.equal(remountedMdxChild?.props.error, currentMdxSegment.error);

    const layoutListId = "layout-list";
    const layoutItemId = `${layoutListId}::item:0`;
    const layoutNestedListId = `${layoutItemId}::nested`;
    const layoutNestedItemId = `${layoutNestedListId}::item:0`;
    const layoutRaw = "- outer\n  outer secondary\n  - inner\n    nested secondary";
    const layoutRange = { from: 0, to: layoutRaw.length };
    const outerParagraphText = "outer secondary";
    const nestedParagraphText = "nested secondary";
    const outerParagraphFrom = layoutRaw.indexOf(outerParagraphText);
    const nestedListFrom = layoutRaw.indexOf("- inner");
    const nestedParagraphFrom = layoutRaw.indexOf(nestedParagraphText);
    const outerParagraphId = `${layoutItemId}::secondary:0`;
    const nestedParagraphId = `${layoutNestedItemId}::secondary:0`;
    const outerSecondaryParagraph = secondaryParagraphSnapshot(
      outerParagraphId,
      outerParagraphText,
      { from: outerParagraphFrom, to: outerParagraphFrom + outerParagraphText.length },
    );
    const nestedSecondaryParagraph = secondaryParagraphSnapshot(
      nestedParagraphId,
      nestedParagraphText,
      { from: nestedParagraphFrom, to: nestedParagraphFrom + nestedParagraphText.length },
    );
    const nestedListRange = { from: nestedListFrom, to: layoutRaw.length };
    const nestedItem: NodeSnapshot = {
      id: layoutNestedItemId,
      type: "list-item",
      range: nestedListRange,
      props: {
        block: nativeBlock(layoutNestedItemId, "list-item", nestedListRange, {
          sourceContainer: "list",
          preparedNested: { props: {}, children: [] },
        }),
        index: 0,
        ordered: false,
        loose: false,
        start: 1,
      },
      children: [nestedSecondaryParagraph],
    };
    const nestedLayoutList: NodeSnapshot = {
      id: layoutNestedListId,
      type: "list",
      range: nestedListRange,
      props: {
        block: nativeBlock(layoutNestedListId, "list", nestedListRange, {
          sourceContainer: "list",
          ordered: false,
          loose: false,
          preparedNested: { props: {}, children: [nestedItem] },
        }),
        ordered: false,
        loose: false,
      },
      children: [nestedItem],
    };
    const outerItem: NodeSnapshot = {
      id: layoutItemId,
      type: "list-item",
      range: layoutRange,
      props: {
        block: nativeBlock(layoutItemId, "list-item", layoutRange, {
          sourceContainer: "list",
          preparedNested: { props: {}, children: [] },
        }),
        index: 0,
        ordered: false,
        loose: false,
        start: 1,
      },
      children: [outerSecondaryParagraph, nestedLayoutList],
    };
    const layoutList: NodeSnapshot = {
      id: layoutListId,
      type: "list",
      range: layoutRange,
      props: {
        block: nativeBlock(layoutListId, "list", layoutRange, {
          sourceContainer: "list",
          ordered: false,
          loose: false,
          preparedNested: { props: {}, children: [outerItem] },
        }),
        ordered: false,
        loose: false,
      },
      children: [outerItem],
    };
    const layoutStore = createRendererStore();
    layoutStore.resetSnapshot({
      id: PATCH_ROOT_ID,
      type: "__root__",
      inputSource: { generation: SOURCE_GENERATION + 8, raw: layoutRaw },
      children: [layoutList],
    });
    const tightLayoutBlock = layoutStore.getBlocks()[0];
    assert.ok(tightLayoutBlock);
    const tightOuterItem = (tightLayoutBlock.payload.meta?.preparedNested as PreparedNestedSnapshot).children
      .find((node) => node.id === layoutItemId);
    assert.ok(tightOuterItem);
    assert.equal(tightOuterItem.children?.find((node) => node.id === outerParagraphId)?.props.tight, true);
    const tightNestedList = tightOuterItem.children?.find((node) => node.id === layoutNestedListId);
    assert.ok(tightNestedList);
    const tightNestedItem = tightNestedList.children?.find((node) => node.id === layoutNestedItemId);
    assert.ok(tightNestedItem);
    assert.equal(tightNestedItem.children?.find((node) => node.id === nestedParagraphId)?.props.tight, true);
    layoutStore.applyPatches([{
      op: "setProps",
      at: { blockId: layoutListId, nodeId: layoutListId },
      props: { loose: true },
    }]);
    const looseLayoutBlock = layoutStore.getBlocks()[0];
    assert.ok(looseLayoutBlock);
    const looseOuterItem = (looseLayoutBlock.payload.meta?.preparedNested as PreparedNestedSnapshot).children
      .find((node) => node.id === layoutItemId);
    assert.ok(looseOuterItem);
    assert.equal(looseOuterItem.children?.find((node) => node.id === outerParagraphId)?.props.tight, false);
    const inheritedNestedList = looseOuterItem.children?.find((node) => node.id === layoutNestedListId);
    assert.ok(inheritedNestedList);
    const inheritedNestedItem = inheritedNestedList.children?.find((node) => node.id === layoutNestedItemId);
    assert.ok(inheritedNestedItem);
    assert.equal(
      inheritedNestedItem.children?.find((node) => node.id === nestedParagraphId)?.props.tight,
      true,
      "nested secondary paragraphs retain their nearest list's tightness",
    );
    layoutStore.applyPatches([{
      op: "setProps",
      at: { blockId: layoutListId, nodeId: layoutNestedListId },
      props: { loose: true },
    }]);
    const nestedLooseLayoutBlock = layoutStore.getBlocks()[0];
    assert.ok(nestedLooseLayoutBlock);
    const nestedLooseOuterItem = (nestedLooseLayoutBlock.payload.meta?.preparedNested as PreparedNestedSnapshot).children
      .find((node) => node.id === layoutItemId);
    const nestedLooseList = nestedLooseOuterItem?.children?.find((node) => node.id === layoutNestedListId);
    const nestedLooseItem = nestedLooseList?.children?.find((node) => node.id === layoutNestedItemId);
    assert.equal(
      nestedLooseItem?.children?.find((node) => node.id === nestedParagraphId)?.props.tight,
      false,
      "a nested list's loose update reaches its own secondary paragraphs",
    );
  } finally {
    try {
      if (root) await act(async () => root?.unmount());
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete ambient[name];
      }
      dom.window.close();
    }
  }
}

await runNativeContainerRangeTest();
console.log("store-native-container-ranges test passed");
