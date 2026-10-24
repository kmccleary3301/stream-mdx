import assert from "node:assert/strict";
import { STREAM_MDX_SCHEMA_VERSION, type Block, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { MarkdownBlocksRenderer } from "../src/renderer/blocks-renderer";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore, type RendererStore } from "../src/renderer/store";

const rootPlugins = {
  footnotes: false,
  html: false,
  mdx: false,
  tables: true,
  callouts: false,
  math: true,
} as const;

const DOM_GLOBALS = ["window", "document", "HTMLElement", "Node", "DOMParser", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobalName = (typeof DOM_GLOBALS)[number];
type DomGlobalSnapshot = Array<{ name: DomGlobalName; descriptor: PropertyDescriptor | undefined }>;

type MountedList = {
  readonly engine: MarkdownEngine;
  readonly emitted: WorkerOut[];
  readonly store: RendererStore;
  readonly container: HTMLDivElement;
};

function restoreDomGlobals(snapshot: DomGlobalSnapshot): void {
  const target = globalThis as unknown as Record<string, unknown>;
  for (const { name, descriptor } of snapshot) {
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else delete target[name];
  }
}

function applyMessages(store: RendererStore, messages: readonly WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") {
      store.resetSnapshot(message.snapshot);
    } else if (message.type === "PATCH") {
      store.applyPatches(message.patches, { captureMetrics: false });
    } else if (message.type === "ERROR") {
      assert.fail(`worker ${message.phase} failed: ${message.error.message}`);
    }
  }
}

async function handleAndApply(
  dom: JSDOM,
  engine: MarkdownEngine,
  store: RendererStore,
  emitted: WorkerOut[],
  input: WorkerIn,
): Promise<void> {
  await act(async () => {
    await engine.handle(input);
    applyMessages(store, emitted.splice(0));
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  });
}

async function mountNativeList(dom: JSDOM, roots: Root[], source: string, componentRegistry = new ComponentRegistry()): Promise<MountedList> {
  const emitted: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => emitted.push(message) });
  const store = createRendererStore();
  const init: Extract<WorkerIn, { type: "INIT" }> = {
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: source,
    prewarmLangs: [],
    docPlugins: rootPlugins,
  };
  await handleAndApply(dom, engine, store, emitted, init);

  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(MarkdownBlocksRenderer, {
      blocks: [],
      store,
      componentRegistry,
      animated: { sep: "word", stagger: 0 },
    }));
  });
  return { engine, emitted, store, container };
}

function rootListId(store: RendererStore): string {
  const list = store.getBlocks().find((block) => block.type === "list");
  assert.ok(list, "the native snapshot must expose its root list");
  return list.id;
}

function listItemIds(store: RendererStore, listId: string): string[] {
  return store.getChildren(listId).filter((childId) => store.getNode(childId)?.type === "list-item");
}

function primaryParagraphId(store: RendererStore, itemId: string): string {
  const paragraphId = store.getChildren(itemId).find((childId) => {
    const child = store.getNode(childId);
    return child?.type === "paragraph" && child.props?.listItemPrimary === true;
  });
  assert.ok(paragraphId, "a native list item must retain its managed primary paragraph child");
  return paragraphId;
}

function secondaryParagraphId(store: RendererStore, itemId: string): string {
  const paragraphId = store.getChildren(itemId).find((childId) => {
    const child = store.getNode(childId);
    return child?.type === "paragraph" && child.props?.listItemPrimary !== true;
  });
  assert.ok(paragraphId, "the list item must retain a separate secondary paragraph");
  return paragraphId;
}

function directParagraph(item: Element): HTMLParagraphElement | undefined {
  return Array.from(item.children).find((child) => child.tagName === "P") as HTMLParagraphElement | undefined;
}

async function runMountedListPrimaryParagraphRegression(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const globalsBefore = DOM_GLOBALS.map((name) => ({ name, descriptor: Object.getOwnPropertyDescriptor(globalThis, name) }));
  const globalTarget = globalThis as unknown as Record<string, unknown>;
  Object.assign(globalTarget, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    DOMParser: dom.window.DOMParser,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const roots: Root[] = [];
  try {
    const liveRegistry = new ComponentRegistry();
    liveRegistry.setNodePresentations({
      "inline:strong": { wrapper: ({ children }) => createElement("strong", { "data-managed-inline": "strong" }, children) },
    });
    const live = await mountNativeList(dom, roots, "- **live**", liveRegistry);
    const listId = rootListId(live.store);
    const [itemId] = listItemIds(live.store, listId);
    assert.ok(itemId);
    const primaryId = primaryParagraphId(live.store, itemId);
    const itemChildren = live.store.getChildren(itemId);
    await handleAndApply(dom, live.engine, live.store, live.emitted, { type: "APPEND", text: " tail" });
    assert.deepEqual(live.store.getChildren(itemId), itemChildren, "a primary leaf append must preserve list-item child IDs");
    assert.equal(primaryParagraphId(live.store, itemId), primaryId, "a primary leaf append must retain its managed paragraph ID");
    assert.equal(live.container.querySelector("li")?.textContent?.trim(), "live tail", "the mounted primary content must render its live suffix exactly once");
    assert.equal(live.container.querySelector('li strong[data-managed-inline="strong"]')?.textContent, "live", "the managed primary keeps registered inline components");

    const loosening = await mountNativeList(dom, roots, "- before");
    const looseningListId = rootListId(loosening.store);
    const [firstItemId] = listItemIds(loosening.store, looseningListId);
    assert.ok(firstItemId);
    const firstItemChildren = loosening.store.getChildren(firstItemId);
    const firstPrimaryId = primaryParagraphId(loosening.store, firstItemId);
    assert.equal(loosening.store.getNode(looseningListId)?.props?.loose, false, "the initial list is tight");
    const firstItemElement = loosening.container.querySelector("li");
    assert.ok(firstItemElement);
    assert.equal(directParagraph(firstItemElement), undefined, "a tight primary paragraph must be unwrapped");
    await handleAndApply(dom, loosening.engine, loosening.store, loosening.emitted, { type: "APPEND", text: "\n\n- after" });
    assert.equal(loosening.store.getNode(looseningListId)?.props?.loose, true, "the nearest list node owns the loose transition");
    assert.deepEqual(loosening.store.getChildren(firstItemId), firstItemChildren, "loosening preserves the completed item's child IDs");
    assert.equal(primaryParagraphId(loosening.store, firstItemId), firstPrimaryId);
    assert.equal(directParagraph(firstItemElement)?.textContent?.trim(), "before", "a loose primary keeps its authored content inside a paragraph");
    const ordered = await mountNativeList(dom, roots, "7. Item 1\n8. Item 2");
    await handleAndApply(dom, ordered.engine, ordered.store, ordered.emitted, { type: "APPEND", text: "\n\n9. Item 3 separat" });
    await handleAndApply(dom, ordered.engine, ordered.store, ordered.emitted, { type: "APPEND", text: "ed by blank line turning the list loose" });
    const orderedList = ordered.container.querySelector("ol");
    assert.ok(orderedList);
    assert.equal(orderedList.getAttribute("start"), "7", "the ordered list retains its authored start");
    const orderedItems = orderedList.querySelectorAll(":scope > li");
    assert.deepEqual(
      Array.from(orderedItems, (item) => item.getAttribute("data-counter-text")),
      ["7.", "8.", "9."],
      "ordered markers must advance across blank-line-loosened items after an append",
    );
    assert.equal(
      orderedItems[2]?.textContent?.trim(),
      "Item 3 separated by blank line turning the list loose",
      "the appended partial third item must retain its full authored content",
    );


    const nested = await mountNativeList(dom, roots, "- outer\n  - nested one\n\n  - nested two");
    const outerListId = rootListId(nested.store);
    const [outerItemId] = listItemIds(nested.store, outerListId);
    assert.ok(outerItemId);
    const nestedListId = nested.store.getChildren(outerItemId).find((childId) => nested.store.getNode(childId)?.type === "list");
    assert.ok(nestedListId, "the outer item must retain a nested list");
    assert.equal(nested.store.getNode(outerListId)?.props?.loose, false, "the outer list remains tight");
    assert.equal(nested.store.getNode(nestedListId)?.props?.loose, true, "the nested list owns its separate loose layout");
    const outerList = nested.container.querySelector("ul");
    assert.ok(outerList);
    const outerItem = Array.from(outerList.children).find((child) => child.tagName === "LI");
    assert.ok(outerItem);
    const nestedList = outerItem.querySelector("ul");
    assert.ok(nestedList, "the nested list must mount under its owning item");
    const nestedItem = Array.from(nestedList.children).find((child) => child.tagName === "LI");
    assert.ok(nestedItem);
    assert.equal(directParagraph(outerItem), undefined, "the tight outer primary stays unwrapped");
    assert.equal(directParagraph(nestedItem)?.textContent?.trim(), "nested one", "the loose nested primary gets its own paragraph");

    // A nested list grows while its top-level container stays open; nested nodes carry no finalization of their own.
    for (const [source, append, selector] of [
      ["> - first\n", "> - second", "blockquote li"],
      ["- outer\n  - first\n", "  - second", "li li"],
    ] as const) {
      const growing = await mountNativeList(dom, roots, source);
      await handleAndApply(dom, growing.engine, growing.store, growing.emitted, { type: "APPEND", text: append });
      assert.deepEqual(
        Array.from(growing.container.querySelectorAll(selector), (item) => item.textContent?.trim()),
        ["first", "second"],
        `a mounted nested list must render an item appended inside its open container: ${JSON.stringify(source)}`,
      );
    }

    // A registered blockquote wraps a quote nested in a list item; the nested node has no content of its own,
    // so the wrapper must receive the quote's rendered children.
    const customQuoteRegistry = new ComponentRegistry();
    customQuoteRegistry.setNodePresentations({
      blockquote: {
        wrapper: ({ children }) => createElement("blockquote", { className: "custom-quote" }, children),
      },
    });
    const quoted = await mountNativeList(dom, roots, "- item\n  > first", customQuoteRegistry);
    await handleAndApply(dom, quoted.engine, quoted.store, quoted.emitted, { type: "APPEND", text: " quoted line" });
    assert.equal(
      quoted.container.querySelector("li blockquote.custom-quote")?.textContent?.trim(),
      "first quoted line",
      "a custom blockquote nested in a list item must render its quoted content",
    );

    const tasks = await mountNativeList(dom, roots, "- [x] done\n- [ ] ");
    const taskItems = tasks.container.querySelectorAll("li");
    assert.equal(taskItems.length, 2);
    assert.equal(taskItems[0]?.querySelectorAll('input[type="checkbox"]').length, 1, "a checked task gets one checkbox");
    assert.equal((taskItems[0]?.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked, true);
    assert.equal(taskItems[0]?.textContent?.trim(), "done", "the authored task marker must not be duplicated as text");
    assert.equal(taskItems[1]?.querySelectorAll('input[type="checkbox"]').length, 1, "an empty task still gets one checkbox");
    assert.equal(taskItems[1]?.textContent?.trim(), "", "an empty task has no authored marker text");
    const emptyTaskItemId = listItemIds(tasks.store, rootListId(tasks.store))[1];
    assert.ok(emptyTaskItemId);
    const emptyTaskPrimaryId = primaryParagraphId(tasks.store, emptyTaskItemId);
    await handleAndApply(dom, tasks.engine, tasks.store, tasks.emitted, { type: "APPEND", text: "pending" });
    assert.equal(tasks.container.querySelectorAll("li")[1]?.textContent?.trim(), "pending", "an empty Task must accept body text without restoring its marker");
    assert.equal(tasks.container.querySelectorAll("li")[1]?.querySelectorAll('input[type="checkbox"]').length, 1);
    await handleAndApply(dom, tasks.engine, tasks.store, tasks.emitted, { type: "FINALIZE" });
    assert.equal(tasks.store.getParagraphBlock(emptyTaskPrimaryId)?.source.state, "finalized", "FINALIZE must settle the Task's managed source");
    assert.equal(tasks.container.querySelectorAll("li")[1]?.textContent?.trim(), "pending", "Task completion must retain its rendered body");

    const splitTask = await mountNativeList(dom, roots, "- [x");
    assert.equal(splitTask.container.querySelectorAll('input[type="checkbox"]').length, 0);
    assert.equal(splitTask.container.querySelector("li")?.textContent?.trim(), "[x");
    await handleAndApply(dom, splitTask.engine, splitTask.store, splitTask.emitted, { type: "APPEND", text: "] done" });
    assert.equal(splitTask.container.querySelectorAll('input[type="checkbox"]').length, 1, "a completed task marker replaces the literal prefix once");
    assert.equal((splitTask.container.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked, true);
    assert.equal(splitTask.container.querySelector("li")?.textContent?.trim(), "done", "task reclassification retires the old paragraph text");
    await handleAndApply(dom, splitTask.engine, splitTask.store, splitTask.emitted, { type: "APPEND", text: " tail" });
    assert.equal(splitTask.container.querySelector("li")?.textContent?.trim(), "done tail", "the replacement paragraph keeps accepting source");

    const secondary = await mountNativeList(dom, roots, "- primary\n\n  secondary");
    const secondaryListId = rootListId(secondary.store);
    const [secondaryItemId] = listItemIds(secondary.store, secondaryListId);
    assert.ok(secondaryItemId);
    const secondaryId = secondaryParagraphId(secondary.store, secondaryItemId);
    assert.ok(secondary.store.getParagraphBlock(secondaryId), "the secondary paragraph is managed independently");
    const secondaryChildren = secondary.store.getChildren(secondaryItemId);
    await handleAndApply(dom, secondary.engine, secondary.store, secondary.emitted, { type: "APPEND", text: " tail" });
    assert.deepEqual(secondary.store.getChildren(secondaryItemId), secondaryChildren, "a secondary paragraph append must preserve its parent child IDs");
    assert.equal(secondaryParagraphId(secondary.store, secondaryItemId), secondaryId);
    assert.ok(
      Array.from(secondary.container.querySelectorAll("li p")).some((paragraph) => paragraph.textContent?.trim() === "secondary tail"),
      "the mounted secondary paragraph must render its live suffix",
    );

    const legacyBlock: Block = {
      id: "legacy-list-remount",
      type: "list",
      isFinalized: false,
      payload: { raw: "- legacy item", meta: { ordered: false } },
    };
    const legacyStore = createRendererStore([legacyBlock]);
    const legacyContainer = dom.window.document.createElement("div");
    dom.window.document.body.append(legacyContainer);
    const legacyRoot = createRoot(legacyContainer);
    roots.push(legacyRoot);
    await act(async () => {
      legacyRoot.render(createElement(BlockNodeRenderer, {
        store: legacyStore,
        blockId: legacyBlock.id,
        registry: new ComponentRegistry(),
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    });
    assert.ok(legacyContainer.querySelector("li"), "a historical static list must still render through its cold Block path");
    assert.ok(legacyContainer.textContent?.includes("legacy item"), "legacy list text must remain visible after remount");
  } finally {
    for (const root of roots) await act(async () => root.unmount());
    restoreDomGlobals(globalsBefore);
  }
}

await runMountedListPrimaryParagraphRegression();
console.log("mounted list primary paragraph regression passed");
