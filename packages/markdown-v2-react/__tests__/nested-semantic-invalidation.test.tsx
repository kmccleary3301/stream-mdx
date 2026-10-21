import assert from "node:assert/strict";
import {
  createBlockSnapshot,
  STREAM_MDX_SCHEMA_VERSION,
  type Block,
  type InlineNode,
  type NodeSnapshot,
  type ParagraphBlockSnapshot,
  type ParagraphSpanRecord,
  type Patch,
  type TableRowRecord,
  type WorkerIn,
  type WorkerOut,
} from "@stream-mdx/core";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { MarkdownBlocksRenderer } from "../src/renderer/blocks-renderer";
import { PARAGRAPH_SPAN_RANGE_SIZE } from "../src/renderer/paragraph-span-range";
import { createRendererStore, type RendererStore } from "../src/renderer/store";

const DOM_GLOBALS = ["window", "document", "HTMLElement", "Node", "DOMParser", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobalName = (typeof DOM_GLOBALS)[number];
type DomGlobalSnapshot = Array<{ name: DomGlobalName; descriptor: PropertyDescriptor | undefined }>;
type LinkNode = Extract<InlineNode, { kind: "link" }>;
type FootnoteReference = Extract<InlineNode, { kind: "footnote-ref" }>;

type MountedEngine = {
  readonly engine: MarkdownEngine;
  readonly emitted: WorkerOut[];
  readonly initializationMessages: WorkerOut[];
  readonly store: RendererStore;
  readonly container: HTMLDivElement;
  readonly root: Root;
};

function restoreDomGlobals(snapshot: DomGlobalSnapshot): void {
  const target = globalThis as unknown as Record<string, unknown>;
  for (const { name, descriptor } of snapshot) {
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else delete target[name];
  }
}

function patchesOf(messages: readonly WorkerOut[]): Patch[] {
  return messages.flatMap((message) => message.type === "PATCH" ? message.patches : []);
}

function applyMessages(store: RendererStore, messages: readonly WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
    else if (message.type === "ERROR") assert.fail(`worker ${message.phase} failed: ${message.error.message}`);
  }
}

async function handleAndApply(
  dom: JSDOM,
  engine: MarkdownEngine,
  store: RendererStore,
  emitted: WorkerOut[],
  input: WorkerIn,
): Promise<WorkerOut[]> {
  let messages: WorkerOut[] = [];
  await act(async () => {
    await engine.handle(input);
    messages = emitted.splice(0);
    applyMessages(store, messages);
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  });
  return messages;
}

async function mountEngine(dom: JSDOM, roots: Root[], source: string): Promise<MountedEngine> {
  const emitted: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => emitted.push(message) });
  const store = createRendererStore();
  const init: Extract<WorkerIn, { type: "INIT" }> = {
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: source,
    prewarmLangs: [],
    // Keep the actual default table and footnote plugins enabled.
    docPlugins: { formatAnticipation: true },
  };
  const initializationMessages = await handleAndApply(dom, engine, store, emitted, init);

  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(MarkdownBlocksRenderer, {
      blocks: [],
      store,
      componentRegistry: new ComponentRegistry(),
      animated: { sep: "word", stagger: 0 },
    }));
  });
  return { engine, emitted, initializationMessages, store, container, root };
}


function paragraphState(store: RendererStore, id: string) {
  const state = store.getParagraphBlock(id);
  assert.ok(state, `expected a managed paragraph owner for ${id}`);
  return state;
}

function paragraphSpans(store: RendererStore, id: string) {
  const state = paragraphState(store, id);
  const spans: ParagraphSpanRecord[] = [];
  for (let from = 0; from < state.source.spanCount; from += PARAGRAPH_SPAN_RANGE_SIZE) {
    spans.push(...store.getParagraphSpans(id, state.source.generation, from, from + PARAGRAPH_SPAN_RANGE_SIZE));
  }
  return spans;
}

function spanMeaning(spans: readonly ParagraphSpanRecord[]) {
  return spans.map((span) => ({
    index: span.index,
    sourceRange: { ...span.sourceRange },
    sourceRevision: span.sourceRevision,
    isProvisional: span.isProvisional,
    nodes: span.nodes,
    children: span.children,
  }));
}

function findNodeChild(store: RendererStore, parentId: string, type: string): string {
  const id = store.getChildren(parentId).find((childId) => store.getNode(childId)?.type === type);
  assert.ok(id, `expected ${type} under the actual parent ${parentId}`);
  return id;
}

function listPrimaryParagraphId(store: RendererStore, itemId: string): string {
  const id = store.getChildren(itemId).find((childId) => {
    const child = store.getNode(childId);
    return child?.type === "paragraph" && child.props.listItemPrimary === true;
  });
  assert.ok(id, "the native list item must expose its managed primary paragraph child");
  return id;
}

function collectLinks(nodes: readonly InlineNode[]): LinkNode[] {
  const links: LinkNode[] = [];
  for (const node of nodes) {
    if (node.kind === "link") links.push(node);
    if ("children" in node && Array.isArray(node.children)) links.push(...collectLinks(node.children));
  }
  return links;
}

function collectFootnotes(nodes: readonly InlineNode[]): FootnoteReference[] {
  const refs: FootnoteReference[] = [];
  for (const node of nodes) {
    if (node.kind === "footnote-ref") refs.push(node);
    if ("children" in node && Array.isArray(node.children)) refs.push(...collectFootnotes(node.children));
  }
  return refs;
}

function coldParagraphSnapshot(store: RendererStore, id: string): ParagraphBlockSnapshot {
  const coldBlock = store.getParagraphColdBlock(id);
  assert.ok(coldBlock, `expected cold paragraph export for ${id}`);
  const snapshot = createBlockSnapshot(coldBlock) as NodeSnapshot & { paragraph?: ParagraphBlockSnapshot };
  assert.ok(snapshot.paragraph, "cold materialization must retain its paragraph snapshot");
  return snapshot.paragraph;
}

function tableRows(store: RendererStore, id: string) {
  const state = store.getTableBlock(id);
  assert.ok(state, `expected a managed native table owner for ${id}`);
  return store.getTableRows(id, 0, state.source.rowCount);
}

function rowMeaning(row: TableRowRecord) {
  return {
    index: row.index,
    sourceRange: { ...row.sourceRange },
    sourceRevision: row.sourceRevision,
    isProvisional: row.isProvisional,
    cells: row.cells.map((cell) => ({
      index: cell.index,
      sourceRange: { ...cell.sourceRange },
      raw: cell.raw,
      inline: cell.inline,
    })),
  };
}

function nestedParagraphUpdates(patches: readonly Patch[], paragraphId: string) {
  return patches.filter((patch): patch is Extract<Patch, { op: "updateParagraphSpans" }> =>
    patch.op === "updateParagraphSpans" && patch.paragraphOwnerId === paragraphId,
  );
}

function nestedTableUpdates(patches: readonly Patch[], tableId: string, containerId: string) {
  return patches.filter((patch): patch is Extract<Patch, { op: "updateTableRows" }> =>
    patch.op === "updateTableRows" && patch.tableOwnerId === tableId
      && patch.at.blockId === containerId && patch.at.nodeId === tableId,
  );
}

function patchTargetsNode(patch: Patch, id: string): boolean {
  if ("at" in patch && (patch.at.blockId === id || patch.at.nodeId === id)) return true;
  if ("childId" in patch && patch.childId === id) return true;
  if ("node" in patch && patch.node.id === id) return true;
  if ("paragraphOwnerId" in patch && patch.paragraphOwnerId === id) return true;
  if ("tableOwnerId" in patch && patch.tableOwnerId === id) return true;
  return false;
}

async function runNestedReferenceInvalidation(): Promise<void> {
  const initialSource = [
    "- Keep **stable** and [doc][ref]",
    "- Unchanged list sibling",
    "",
    "> Footnote order [^second] then [^first].",
    ">",
    "> ## Heading [doc][ref]",
    ">",
    "> | Destination | Stable |",
    "> | --- | --- |",
    "> | [doc][ref] [^first] | stable cell |",
    "> | Unrelated | untouched row |",
    "",
    "Unchanged owner.",
    "",
    "---",
    "",
  ].join("\n");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const roots: Root[] = [];
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

  let mounted: MountedEngine | undefined;
  try {
    mounted = await mountEngine(dom, roots, initialSource);
    const { engine, emitted, store, container } = mounted;
    const initialized = mounted.initializationMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
    assert.ok(initialized, "the real engine must publish the native source baseline");
    const initialSnapshotWire = JSON.stringify(initialized.snapshot);
    assert.equal(initialized.snapshot.inputSource?.raw, initialSource);

    const listId = store.getBlocks().find((block) => block.type === "list")?.id;
    assert.ok(listId, "the source must produce a native list");
    const firstItemId = findNodeChild(store, listId, "list-item");
    const primaryId = listPrimaryParagraphId(store, firstItemId);
    assert.equal(store.getNode(primaryId)?.parentId, firstItemId, "the primary paragraph must be the real list-item child");

    const quoteId = store.getBlocks().find((block) => block.type === "blockquote")?.id;
    assert.ok(quoteId, "the source must produce a native quote containing the nested owners");
    const quoteParagraphId = findNodeChild(store, quoteId, "paragraph");
    const quoteHeadingId = findNodeChild(store, quoteId, "heading");
    const tableId = findNodeChild(store, quoteId, "table");
    assert.equal(store.getNode(quoteParagraphId)?.parentId, quoteId);
    assert.equal(store.getNode(quoteHeadingId)?.parentId, quoteId);
    assert.equal(store.getNode(tableId)?.parentId, quoteId);
    const headingBefore = store.getNode(quoteHeadingId);
    assert.ok(headingBefore?.range, "the generic heading must expose its admitted source range");
    const quoteBlockBefore = store.getBlocks().find((block) => block.id === quoteId);
    assert.ok(quoteBlockBefore, "the current native quote must expose its prepared children");
    const quoteSnapshotBefore = createBlockSnapshot(quoteBlockBefore);
    const headingSnapshotBefore = quoteSnapshotBefore.children?.find((child) => child.id === quoteHeadingId);
    assert.ok(headingSnapshotBefore, "the native quote snapshot must retain the actual generic heading");
    const headingBeforeBlock = headingSnapshotBefore.props?.block as Block | undefined;
    assert.ok(headingBeforeBlock, "the native quote snapshot must expose the heading's current cold block");
    const headingRange = { ...headingBefore.range };
    assert.deepEqual(headingSnapshotBefore.range, headingRange);
    const headingSource = headingBeforeBlock.payload.raw;
    assert.equal(initialSource.slice(headingRange.from, headingRange.to), headingSource, "the heading snapshot must retain its admitted authored source window");
    const historicalHeadingSnapshot = createBlockSnapshot(headingBeforeBlock);
    const historicalHeadingSnapshotWire = JSON.stringify(historicalHeadingSnapshot);
    assert.equal(
      collectLinks(headingBeforeBlock.payload.inline ?? []).length,
      0,
      "the generic heading reference must begin with unresolved inline meaning",
    );

    const unresolvedHeading = container.querySelector("blockquote h2");
    assert.ok(unresolvedHeading, "the nested generic heading must render before reference resolution");
    assert.equal(unresolvedHeading.querySelector("a"), null, "the unresolved heading reference must not render a link");
    const unrelatedId = store.getBlocks().find((block) => block.type === "paragraph" && block.payload.raw === "Unchanged owner.")?.id;
    assert.ok(unrelatedId, "an unrelated completed root paragraph must be available as a negative control");
    const unrelatedBefore = paragraphState(store, unrelatedId);
    const unrelatedRange = { ...unrelatedBefore.source.sourceRange };
    const unrelatedSpans = spanMeaning(paragraphSpans(store, unrelatedId));

    const primaryBefore = paragraphState(store, primaryId);
    const primarySource = primaryBefore.sourceSnapshot.materialize();
    const primaryRange = { ...primaryBefore.source.sourceRange };
    const primarySpansBefore = paragraphSpans(store, primaryId);
    assert.equal(initialSource.slice(primaryRange.from, primaryRange.to), primarySource, "the primary owner must expose its physical authored source window");
    const primaryReferenceSource = "[doc][ref]";
    const primaryReferenceOffset = primarySource.indexOf(primaryReferenceSource);
    assert.ok(primaryReferenceOffset >= 0, "the native primary source must contain the authored reference");
    const primaryReferenceRange = {
      from: primaryRange.from + primaryReferenceOffset,
      to: primaryRange.from + primaryReferenceOffset + primaryReferenceSource.length,
    };
    const unresolvedPrimarySpans = primarySpansBefore.filter((span) =>
      span.sourceRange.from < primaryReferenceRange.to && span.sourceRange.to > primaryReferenceRange.from
    );
    assert.equal(
      collectLinks(unresolvedPrimarySpans.flatMap((span) => span.nodes)).length,
      0,
      "the managed primary reference must begin with unresolved inline meaning",
    );
    const historicalPrimary = coldParagraphSnapshot(store, primaryId);
    const historicalPrimaryWire = JSON.stringify(historicalPrimary);

    const quoteParagraphBefore = paragraphState(store, quoteParagraphId);
    const quoteParagraphSource = quoteParagraphBefore.sourceSnapshot.materialize();
    const quoteParagraphRange = { ...quoteParagraphBefore.source.sourceRange };
    assert.equal(initialSource.slice(quoteParagraphRange.from, quoteParagraphRange.to), quoteParagraphSource);
    const quoteParagraphSpansBefore = paragraphSpans(store, quoteParagraphId);
    const quoteParagraphMeaningBefore = spanMeaning(quoteParagraphSpansBefore);
    const footnoteSpanIndexes = quoteParagraphSpansBefore
      .filter((span) => collectFootnotes(span.nodes).length > 0)
      .map((span) => span.index);
    const historicalQuoteParagraph = coldParagraphSnapshot(store, quoteParagraphId);
    const historicalQuoteWire = JSON.stringify(historicalQuoteParagraph);

    const tableBefore = store.getTableBlock(tableId);
    assert.ok(tableBefore);
    const tableRange = { ...tableBefore.source.sourceRange };
    const tableSource = tableBefore.sourceSnapshot.materialize();
    assert.equal(initialSource.slice(tableRange.from, tableRange.to), tableSource, "the nested table owner must expose its physical authored source window");
    const rowsBefore = tableRows(store, tableId);
    const linkRowBefore = rowsBefore.find((row) => row.cells.some((cell) => cell.raw.includes("[doc][ref]")));
    const unrelatedRowBefore = rowsBefore.find((row) => row.cells.some((cell) => cell.raw.includes("untouched row")));
    assert.ok(linkRowBefore && unrelatedRowBefore, "the real nested table must contain both reference-bearing and unaffected rows");
    const stableCellBefore = linkRowBefore.cells.find((cell) => cell.raw.includes("stable cell"));
    assert.ok(stableCellBefore, "the reference-bearing row must retain an unaffected sibling cell");
    const targetCellBefore = linkRowBefore.cells.find((cell) => cell.raw.includes("[doc][ref]"));
    assert.ok(targetCellBefore);
    assert.equal(collectLinks(targetCellBefore.inline).length, 0, "the unresolved table reference must not fabricate a link");

    assert.equal(container.querySelector("ul li a"), null, "an unresolved list-primary reference must remain non-link content");
    assert.equal(container.querySelector("blockquote table tbody tr td a"), null, "an unresolved table reference must remain non-link content");
    assert.equal(container.querySelectorAll(".footnote-ref a[data-label]").length, 0, "undefined nested footnotes must not publish anchors");

    const linkDefinition = "\n\n[ref]: https://example.com \"Docs\"\n";
    const linkMessages = await handleAndApply(dom, engine, store, emitted, { type: "APPEND", text: linkDefinition });
    const linkPatches = patchesOf(linkMessages);
    const linkInput = linkPatches.find((patch): patch is Extract<Patch, { op: "appendInputSource" }> => patch.op === "appendInputSource");
    assert.ok(linkInput, "the real late reference definition must append to canonical input source");
    assert.equal(linkInput.from, initialSource.length);
    assert.equal(linkInput.text, linkDefinition);

    const primaryLinkUpdates = nestedParagraphUpdates(linkPatches, primaryId);
    for (const update of primaryLinkUpdates) {
      assert.deepEqual(update.at, { blockId: listId, nodeId: primaryId }, "nested paragraph updates must target the existing list family node by actual IDs");
    }
    assert.deepEqual(
      new Set(primaryLinkUpdates.flatMap((update) => update.updates.map((span) => span.index))),
      new Set(unresolvedPrimarySpans.map((span) => span.index)),
      "the late definition must update only primary spans covering the authored reference",
    );
    assert.deepEqual(
      spanMeaning(paragraphSpans(store, quoteParagraphId)),
      quoteParagraphMeaningBefore,
      "the unrelated nested footnote paragraph must remain unchanged by link resolution",
    );
    const tableLinkUpdates = nestedTableUpdates(linkPatches, tableId, quoteId);
    assert.deepEqual(
      new Set(tableLinkUpdates.flatMap((update) => update.updates.map((row) => row.index))),
      new Set([linkRowBefore.index]),
      "the late definition must update only the actual reference-bearing table row",
    );

    const primaryAfterLink = paragraphState(store, primaryId);
    assert.equal(primaryAfterLink.sourceSnapshot.materialize(), primarySource, "link meaning must not widen list-primary physical source");
    assert.deepEqual(primaryAfterLink.source.sourceRange, primaryRange);
    const primarySpansAfterLink = paragraphSpans(store, primaryId);
    const primaryReferenceSpanIndexes = new Set(unresolvedPrimarySpans.map((span) => span.index));
    const primaryLinkSpans = primarySpansAfterLink.filter((span) => primaryReferenceSpanIndexes.has(span.index));
    const primaryLink = collectLinks(primaryLinkSpans.flatMap((span) => span.nodes))
      .find((link) => link.children.some((node) => node.kind === "text" && node.text === "doc"));
    assert.ok(primaryLink, "the current managed paragraph meaning must contain the resolved link node");
    assert.equal(primaryLink.href, "https://example.com");
    assert.equal(primaryLink.title, "Docs");
    for (const previousSpan of primarySpansBefore) {
      if (primaryReferenceSpanIndexes.has(previousSpan.index)) continue;
      assert.deepEqual(
        spanMeaning([primarySpansAfterLink.find((span) => span.index === previousSpan.index)!]),
        spanMeaning([previousSpan]),
        "unrelated primary spans must retain their prior meaning and source ranges",
      );
    }

    const tableAfterLink = store.getTableBlock(tableId);
    assert.ok(tableAfterLink);
    assert.deepEqual(tableAfterLink.source.sourceRange, tableRange);
    assert.equal(tableAfterLink.sourceSnapshot.materialize(), tableSource, "link meaning must not widen nested table physical source");
    const rowsAfterLink = tableRows(store, tableId);
    assert.deepEqual(rowsAfterLink.map((row) => row.sourceRange), rowsBefore.map((row) => row.sourceRange), "table row source ranges remain physical and unchanged");
    assert.deepEqual(rowMeaning(rowsAfterLink.find((row) => row.index === unrelatedRowBefore.index)!), rowMeaning(unrelatedRowBefore), "the unrelated table row must remain unchanged");
    const linkRowAfterLink = rowsAfterLink.find((row) => row.index === linkRowBefore.index);
    assert.ok(linkRowAfterLink);
    const tableLinkCell = linkRowAfterLink.cells.find((cell) => cell.raw.includes("[doc][ref]"));
    assert.ok(tableLinkCell);
    const tableLink = collectLinks(tableLinkCell.inline).find((link) => link.children.some((node) => node.kind === "text" && node.text === "doc"));
    assert.ok(tableLink, "the current table cell meaning must contain the resolved link node");
    assert.equal(tableLink.href, "https://example.com");
    assert.equal(tableLink.title, "Docs");
    assert.deepEqual(tableLinkCell.sourceRange, targetCellBefore.sourceRange);
    assert.equal(tableLinkCell.raw, targetCellBefore.raw, "link resolution must not change authored cell text");
    const stableCellAfterLink = linkRowAfterLink.cells.find((cell) => cell.index === stableCellBefore.index);
    assert.ok(stableCellAfterLink);
    assert.deepEqual(stableCellAfterLink.inline, stableCellBefore.inline, "an unaffected sibling cell must retain its prepared meaning");
    const headingAfter = store.getNode(quoteHeadingId);
    assert.ok(headingAfter, "the existing generic heading must remain in the current store");
    assert.equal(headingAfter.id, quoteHeadingId, "the late definition must update the existing heading node");
    assert.equal(headingAfter.type, "heading");
    assert.equal(headingAfter.parentId, quoteId);
    assert.deepEqual(headingAfter.range, headingRange, "link meaning must not change the heading's authored range");
    const quoteBlockAfter = store.getBlocks().find((block) => block.id === quoteId);
    assert.ok(quoteBlockAfter, "the current native quote must retain its prepared children after link resolution");
    const quoteSnapshotAfter = createBlockSnapshot(quoteBlockAfter);
    const headingSnapshotAfter = quoteSnapshotAfter.children?.find((child) => child.id === quoteHeadingId);
    assert.ok(headingSnapshotAfter, "the current native quote snapshot must retain the same generic heading");
    assert.deepEqual(headingSnapshotAfter.range, headingRange, "the nested heading snapshot must keep its authored range");
    const headingAfterBlock = headingSnapshotAfter.props?.block as Block | undefined;
    assert.ok(headingAfterBlock, "the current native quote snapshot must expose the updated heading block");
    assert.equal(headingAfterBlock.payload.raw, headingSource, "link meaning must not change the heading's authored source");
    const headingLink = collectLinks(headingAfterBlock.payload.inline ?? [])
      .find((link) => link.children.some((node) => node.kind === "text" && node.text === "doc"));
    assert.ok(headingLink, "the current generic heading meaning must contain the resolved link node");
    assert.equal(headingLink.href, "https://example.com");
    assert.equal(headingLink.title, "Docs");
    assert.equal(JSON.stringify(historicalHeadingSnapshot), historicalHeadingSnapshotWire,
      "the prior cold heading snapshot must retain its unresolved meaning");
    const headingElement = container.querySelector("blockquote h2");
    assert.ok(headingElement, "the same nested heading must remain mounted after reference resolution");
    const headingAnchor = headingElement.querySelector("a");
    assert.ok(headingAnchor, "the mounted generic heading must render the resolved link");
    assert.equal(headingAnchor.getAttribute("href"), "https://example.com");
    assert.equal(headingAnchor.getAttribute("title"), "Docs");
    assert.equal(headingAnchor.textContent, "doc");
    assert.equal(headingElement.textContent, "Heading doc");


    assert.equal(container.querySelector("ul li a")?.getAttribute("href"), "https://example.com", "the mounted primary paragraph must render the resolved target");
    assert.equal(container.querySelector("ul li a")?.getAttribute("title"), "Docs", "the mounted primary paragraph must render the definition title");
    assert.equal(container.querySelector("blockquote table tbody tr td a")?.getAttribute("href"), "https://example.com", "the mounted nested table must render the resolved target");
    assert.equal(container.querySelector("blockquote table tbody tr td a")?.getAttribute("title"), "Docs", "the mounted nested table must render the definition title");
    assert.equal(JSON.stringify(historicalPrimary), historicalPrimaryWire, "the historical cold primary snapshot must not acquire later link meaning");
    assert.equal(collectLinks(historicalPrimary.spans.flatMap((span) => span.nodes)).length, 0);
    assert.deepEqual(spanMeaning(paragraphSpans(store, unrelatedId)), unrelatedSpans, "late link resolution must leave an unrelated owner's spans unchanged");
    assert.deepEqual(paragraphState(store, unrelatedId).source.sourceRange, unrelatedRange);
    assert.equal(paragraphState(store, unrelatedId).source.revision, unrelatedBefore.source.revision);

    const footnoteDefinitions = "\n\n[^first]: First definition\n\n[^second]: Second definition";
    const definitionMessages = await handleAndApply(dom, engine, store, emitted, { type: "APPEND", text: footnoteDefinitions });
    const definitionInput = patchesOf(definitionMessages).find((patch): patch is Extract<Patch, { op: "appendInputSource" }> => patch.op === "appendInputSource");
    assert.ok(definitionInput);
    assert.equal(definitionInput.from, initialSource.length + linkDefinition.length);
    assert.equal(definitionInput.text, footnoteDefinitions, "footnote definitions must arrive as actual source outside the nested owners");
    const publicationMessages = await handleAndApply(dom, engine, store, emitted, { type: "APPEND", text: "\n\n---\n\n" });
    const publicationPatches = patchesOf(publicationMessages);
    const quoteFootnoteUpdates = nestedParagraphUpdates(publicationPatches, quoteParagraphId);
    for (const update of quoteFootnoteUpdates) {
      assert.deepEqual(update.at, { blockId: quoteId, nodeId: quoteParagraphId }, "nested footnote updates must address the actual existing quote paragraph");
    }
    assert.deepEqual(
      new Set(quoteFootnoteUpdates.flatMap((update) => update.updates.map((span) => span.index))),
      new Set(footnoteSpanIndexes),
      "footnote numbering must update only the nested paragraph spans that attempted references",
    );
    const tableFootnoteUpdates = nestedTableUpdates(publicationPatches, tableId, quoteId);
    assert.deepEqual(
      new Set(tableFootnoteUpdates.flatMap((update) => update.updates.map((row) => row.index))),
      new Set([linkRowBefore.index]),
      "footnote publication must touch only the table row that owns the nested reference",
    );

    const quoteParagraphAfterFootnotes = paragraphState(store, quoteParagraphId);
    assert.equal(quoteParagraphAfterFootnotes.sourceSnapshot.materialize(), quoteParagraphSource);
    assert.deepEqual(quoteParagraphAfterFootnotes.source.sourceRange, quoteParagraphRange);
    const quoteSnapshot = coldParagraphSnapshot(store, quoteParagraphId);
    const quoteRefs = collectFootnotes(quoteSnapshot.spans.flatMap((span) => span.nodes));
    assert.deepEqual(
      quoteRefs.map((ref) => [ref.label, ref.number, ref.occurrence, ref.defined]),
      [["second", 1, 1, true], ["first", 2, 1, true]],
      "footnote numbers follow first reference order, not the reverse order of their later definitions",
    );
    assert.equal(JSON.stringify(historicalQuoteParagraph), historicalQuoteWire, "the historical cold quote snapshot must retain its unresolved meaning");

    const tableAfterFootnotes = store.getTableBlock(tableId);
    assert.ok(tableAfterFootnotes);
    assert.deepEqual(tableAfterFootnotes.source.sourceRange, tableRange);
    assert.equal(tableAfterFootnotes.sourceSnapshot.materialize(), tableSource);
    const rowsAfterFootnotes = tableRows(store, tableId);
    assert.deepEqual(rowsAfterFootnotes.map((row) => row.sourceRange), rowsBefore.map((row) => row.sourceRange));
    assert.deepEqual(rowMeaning(rowsAfterFootnotes.find((row) => row.index === unrelatedRowBefore.index)!), rowMeaning(unrelatedRowBefore));
    const finalLinkRow = rowsAfterFootnotes.find((row) => row.index === linkRowBefore.index);
    assert.ok(finalLinkRow);
    const finalFootnoteCell = finalLinkRow.cells.find((cell) => cell.raw.includes("[doc][ref]"));
    assert.ok(finalFootnoteCell);
    assert.deepEqual(
      collectFootnotes(finalFootnoteCell.inline).map((ref) => [ref.label, ref.number, ref.occurrence, ref.defined]),
      [["first", 2, 2, true]],
      "the nested table footnote must use the same document-wide numbering and occurrence order",
    );
    const finalTableLink = collectLinks(finalFootnoteCell.inline).find((link) => link.children.some((node) => node.kind === "text" && node.text === "doc"));
    assert.ok(finalTableLink);
    assert.equal(finalTableLink.href, "https://example.com", "footnote re-preparation must retain the late table link meaning");
    assert.equal(finalTableLink.title, "Docs");

    const footnotesBlock = store.getBlocks().find((block) => block.type === "footnotes");
    assert.ok(footnotesBlock, "the existing footnote publication path must publish the canonical definitions block");
    const publishedItems = footnotesBlock.payload.meta?.items as Array<{ label: string; number: number; refCount?: number }> | undefined;
    assert.deepEqual(
      publishedItems?.map((item) => [item.label, item.number, item.refCount]),
      [["second", 1, 1], ["first", 2, 2]],
      "published footnote definitions must retain reference-order numbering and total occurrences",
    );
    const mountedFootnoteAnchors = Array.from(container.querySelectorAll("blockquote .footnote-ref a[data-label]"));
    assert.deepEqual(
      mountedFootnoteAnchors.map((anchor) => [anchor.getAttribute("data-label"), anchor.textContent?.trim()]),
      [["second", "1"], ["first", "2"], ["first", "2"]],
      "the mounted paragraph and table anchors must expose their defined numbers in source order",
    );
    const anchorIds = mountedFootnoteAnchors.map((anchor) => anchor.id);
    assert.ok(anchorIds.every(Boolean));
    assert.equal(new Set(anchorIds).size, anchorIds.length, "each real footnote occurrence must retain its own anchor");
    for (const anchor of mountedFootnoteAnchors) {
      const href = anchor.getAttribute("href");
      assert.ok(href?.startsWith("#"), "each reference anchor must link to a real published definition");
      const definitionTarget = dom.window.document.getElementById(href.slice(1));
      assert.ok(definitionTarget, "the rendered reference target must exist without pinning its generated ID format");
      const label = anchor.getAttribute("data-label");
      assert.ok(label === "first" || label === "second");
      assert.ok(definitionTarget.textContent?.includes(label === "first" ? "First definition" : "Second definition"));
    }
    assert.equal(JSON.stringify(initialized.snapshot), initialSnapshotWire, "late source publication must not mutate the historical INITIALIZED snapshot");
    assert.equal(JSON.stringify(historicalPrimary), historicalPrimaryWire, "later footnotes must not mutate the earlier primary cold snapshot");
    assert.equal(primaryAfterLink.sourceSnapshot.materialize(), primarySource);
    assert.deepEqual(primaryAfterLink.source.sourceRange, primaryRange);
    assert.equal(JSON.stringify(historicalQuoteParagraph), historicalQuoteWire);
    assert.equal(container.querySelector("ul li a")?.getAttribute("title"), "Docs");
    assert.equal(container.querySelector("blockquote table tbody tr td a")?.getAttribute("title"), "Docs");
  } finally {
    if (mounted) mounted.engine.dispose();
    for (const root of roots) await act(async () => root.unmount());
    restoreDomGlobals(globalsBefore);
    dom.window.close();
  }
}

async function runListLoosenessInvalidation(): Promise<void> {
  const initialSource = "- alpha\n- beta";
  const appendText = "\n\n- gamma";
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const roots: Root[] = [];
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

  let mounted: MountedEngine | undefined;
  try {
    mounted = await mountEngine(dom, roots, initialSource);
    const { engine, emitted, store, container } = mounted;
    const listId = store.getBlocks().find((block) => block.type === "list")?.id;
    assert.ok(listId);
    const firstItemId = findNodeChild(store, listId, "list-item");
    const firstPrimaryId = listPrimaryParagraphId(store, firstItemId);
    const firstItemChildren = [...store.getChildren(firstItemId)];
    const firstItemBefore = store.getNode(firstItemId);
    assert.ok(firstItemBefore?.range, "the completed first item must retain its physical source range");
    const firstItemRange = { ...firstItemBefore.range };
    const firstItemSource = initialSource.slice(firstItemRange.from, firstItemRange.to);
    assert.ok(firstItemSource.includes("alpha"), "the first item's source range must retain its authored text");
    const firstPrimaryBefore = paragraphState(store, firstPrimaryId);
    assert.equal(firstPrimaryBefore.sourceSnapshot.materialize(), "alpha");
    const firstPrimaryRange = { ...firstPrimaryBefore.source.sourceRange };
    const firstPrimaryRevision = firstPrimaryBefore.source.revision;
    const firstPrimaryMeaning = spanMeaning(paragraphSpans(store, firstPrimaryId));
    const firstListItem = container.querySelector("ul li");
    assert.ok(firstListItem);
    assert.equal(firstListItem.querySelector(":scope > p"), null, "a tight completed primary is initially unwrapped");

    const looseMessages = await handleAndApply(dom, engine, store, emitted, { type: "APPEND", text: appendText });
    const loosePatches = patchesOf(looseMessages);
    const appendedInput = loosePatches.find((patch): patch is Extract<Patch, { op: "appendInputSource" }> => patch.op === "appendInputSource");
    assert.ok(appendedInput);
    assert.equal(appendedInput.from, initialSource.length);
    assert.equal(appendedInput.text, appendText, "looseness is triggered by appending a later sibling, not by replacing earlier source");
    assert.equal(store.getNode(listId)?.props.loose, true, "the native list owns the list-level loose transition");
    assert.deepEqual(store.getChildren(firstItemId), firstItemChildren, "the already completed first item retains its existing child structure");
    assert.equal(listPrimaryParagraphId(store, firstItemId), firstPrimaryId);
    assert.deepEqual(spanMeaning(paragraphSpans(store, firstPrimaryId)), firstPrimaryMeaning, "the first primary meaning records must not be re-prepared");
    const firstPrimaryAfter = paragraphState(store, firstPrimaryId);
    assert.equal(firstPrimaryAfter.source.revision, firstPrimaryRevision, "list-level looseness must retain the earlier paragraph owner revision");
    assert.deepEqual(firstPrimaryAfter.source.sourceRange, firstPrimaryRange);
    assert.equal(firstPrimaryAfter.sourceSnapshot.materialize(), "alpha", "list-level looseness must retain earlier primary source");
    assert.deepEqual(store.getNode(firstItemId)?.range, firstItemRange, "the first item keeps its physical source range");
    assert.deepEqual(
      loosePatches.filter((patch) => patchTargetsNode(patch, firstItemId) || patchTargetsNode(patch, firstPrimaryId)),
      [],
      "the later sibling must not replace, reprepare, or update the completed first item or its primary paragraph",
    );
    const firstListItemAfter = container.querySelector("ul li");
    assert.ok(firstListItemAfter);
    assert.equal(firstListItemAfter.querySelector(":scope > p")?.textContent?.trim(), "alpha", "the mounted first item becomes paragraph-wrapped when its list turns loose");
    assert.ok(container.textContent?.includes("beta"));
    assert.ok(container.textContent?.includes("gamma"));
  } finally {
    if (mounted) mounted.engine.dispose();
    for (const root of roots) await act(async () => root.unmount());
    restoreDomGlobals(globalsBefore);
    dom.window.close();
  }
}

await runNestedReferenceInvalidation();
await runListLoosenessInvalidation();
console.log("nested semantic invalidation fixtures passed");
