import assert from "node:assert/strict";
import { createBlockSnapshot, STREAM_MDX_SCHEMA_VERSION, type Block, type Patch, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MarkdownBlocksRenderer } from "../src/renderer/blocks-renderer";
import { createRendererStore, type RendererStore } from "../src/renderer/store";

type InitMessage = Extract<WorkerIn, { type: "INIT" }>;
type InitializedMessage = Extract<WorkerOut, { type: "INITIALIZED" }>;
type AppendInputSourcePatch = Extract<Patch, { op: "appendInputSource" }>;

type MountedFixture = {
  readonly dom: JSDOM;
  readonly engine: MarkdownEngine;
  readonly emitted: WorkerOut[];
  readonly initialized: InitializedMessage;
  readonly store: RendererStore;
  readonly container: HTMLDivElement;
};

const DOM_GLOBALS = ["window", "document", "HTMLElement", "Node", "DOMParser", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobalName = (typeof DOM_GLOBALS)[number];
type DomGlobalSnapshot = Array<{ name: DomGlobalName; descriptor: PropertyDescriptor | undefined }>;

const rootPlugins = {
  footnotes: false,
  html: true,
  mdx: false,
  tables: true,
  callouts: false,
  math: false,
  formatAnticipation: { inline: true, html: true },
} as const;

function restoreDomGlobals(snapshot: DomGlobalSnapshot): void {
  const target = globalThis as unknown as Record<string, unknown>;
  for (const { name, descriptor } of snapshot) {
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else delete target[name];
  }
}

function applyMessages(store: RendererStore, messages: readonly WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
    else if (message.type === "ERROR") assert.fail(`worker ${message.phase} failed: ${message.error.message}`);
  }
}

async function mountEngine(
  dom: JSDOM,
  roots: Root[],
  engines: MarkdownEngine[],
  source: string,
  docPlugins: NonNullable<InitMessage["docPlugins"]> = rootPlugins,
): Promise<MountedFixture> {
  const emitted: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => emitted.push(message) });
  engines.push(engine);
  const store = createRendererStore();
  const init: InitMessage = {
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: source,
    prewarmLangs: [],
    docPlugins,
    html: { allowedTags: { em: ["title"] } },
  };
  let initMessages: WorkerOut[] = [];
  await act(async () => {
    await engine.handle(init);
    initMessages = emitted.splice(0);
    applyMessages(store, initMessages);
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  });
  const initialized = initMessages.find((message): message is InitializedMessage => message.type === "INITIALIZED");
  assert.ok(initialized, "INIT must publish the real engine snapshot");

  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(MarkdownBlocksRenderer, { blocks: [], store }));
  });
  return { dom, engine, emitted, initialized, store, container };
}

async function handleAndApply(fixture: MountedFixture, input: WorkerIn): Promise<WorkerOut[]> {
  let messages: WorkerOut[] = [];
  await act(async () => {
    await fixture.engine.handle(input);
    messages = fixture.emitted.splice(0);
    applyMessages(fixture.store, messages);
    await new Promise<void>((resolve) => fixture.dom.window.requestAnimationFrame(() => resolve()));
  });
  return messages;
}


function appendInputSource(messages: readonly WorkerOut[]): AppendInputSourcePatch {
  const patch = messages.flatMap((message) => message.type === "PATCH" ? message.patches : [])
    .find((candidate) => candidate.op === "appendInputSource");
  assert.ok(patch && patch.op === "appendInputSource", "APPEND must retain the exact canonical input suffix");
  return patch;
}

function paragraphId(store: RendererStore): string {
  const paragraph = store.getBlocks().find((block) => block.type === "paragraph");
  assert.ok(paragraph, "the root snapshot must expose its native paragraph");
  return paragraph.id;
}

function paragraphState(store: RendererStore, id: string) {
  const state = store.getParagraphBlock(id);
  assert.ok(state, "the renderer store must retain managed paragraph state");
  return state;
}

function paragraphSource(store: RendererStore, id: string): string {
  return paragraphState(store, id).sourceSnapshot.materialize();
}

function paragraphHtmlChild(store: RendererStore, id: string) {
  const state = paragraphState(store, id);
  return store.getParagraphSpans(id, state.source.generation, 0, 64)
    .flatMap((span) => span.children ?? [])
    .find((child) => child.type === "paragraph-html");
}

function emMeanings(root: ParentNode): Array<{ title: string | null; text: string }> {
  return Array.from(root.querySelectorAll("em"), (em) => ({
    title: em.getAttribute("title"),
    text: em.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
}

async function renderColdBlock(fixture: MountedFixture, roots: Root[], block: Block): Promise<HTMLDivElement> {
  const container = fixture.dom.window.document.createElement("div");
  fixture.dom.window.document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(MarkdownBlocksRenderer, { blocks: [block] }));
  });
  return container;
}

function nestedPrimaryParagraphId(store: RendererStore): string {
  const outerList = store.getBlocks().find((block) => block.type === "list");
  assert.ok(outerList, "the native snapshot must expose its outer list");
  const outerItem = store.getChildren(outerList.id).find((id) => store.getNode(id)?.type === "list-item");
  assert.ok(outerItem, "the outer list must retain its native list item");
  const nestedList = store.getChildren(outerItem).find((id) => store.getNode(id)?.type === "list");
  assert.ok(nestedList, "the outer item must retain a nested native list");
  const nestedItem = store.getChildren(nestedList).find((id) => store.getNode(id)?.type === "list-item");
  assert.ok(nestedItem, "the nested list must retain its native list item");
  const paragraph = store.getChildren(nestedItem).find((id) => {
    const node = store.getNode(id);
    return node?.type === "paragraph" && node.props?.listItemPrimary === true;
  });
  assert.ok(paragraph, "the nested item must retain its managed primary paragraph");
  return paragraph;
}

async function runManagedHtmlLifecycleRegressions(): Promise<void> {
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
  const engines: MarkdownEngine[] = [];
  try {
    const splitHeader = 'before <em title="warm';
    const splitFixture = await mountEngine(dom, roots, engines, splitHeader);
    const splitId = paragraphId(splitFixture.store);
    assert.equal(splitFixture.initialized.snapshot.inputSource?.raw, splitHeader, "INIT must preserve the incomplete authored header verbatim");
    assert.equal(splitFixture.container.querySelector("p")?.textContent, splitHeader, "a split quoted attribute stays literal before its header is complete");
    assert.equal(splitFixture.container.querySelector("em"), null, "an incomplete quoted header must not create an HTML preview");
    const historicalCold = splitFixture.store.getParagraphColdBlock(splitId);
    assert.ok(historicalCold, "the initial paragraph must have a cold value");
    assert.equal(historicalCold.payload.raw, splitHeader);
    const historicalColdSnapshot = JSON.stringify(createBlockSnapshot(historicalCold));
    const historicalSourceSnapshot = paragraphState(splitFixture.store, splitId).sourceSnapshot;

    const splitAppend = ' value">\r\nbody';
    const splitSource = splitHeader + splitAppend;
    const splitMessages = await handleAndApply(splitFixture, { type: "APPEND", text: splitAppend });
    const splitInput = appendInputSource(splitMessages);
    assert.equal(splitInput.from, splitHeader.length, "canonical input append offsets use the physical authored length");
    assert.equal(splitInput.text, splitAppend, "canonical input must retain the CRLF and body bytes exactly");
    assert.equal(splitFixture.initialized.snapshot.inputSource?.raw, splitHeader, "the historical INITIALIZED value must remain unchanged");
    assert.equal(paragraphSource(splitFixture.store, splitId), splitSource, "the live paragraph source must contain only authored input");
    assert.equal(historicalSourceSnapshot.materialize(), splitHeader, "the retained historical source view must not follow HTML closure");
    assert.equal(historicalCold.payload.raw, splitHeader, "the historical cold Block must not acquire a synthetic close or later body");
    assert.equal(JSON.stringify(createBlockSnapshot(historicalCold)), historicalColdSnapshot, "the historical cold snapshot must remain unchanged after closure");
    const currentCold = splitFixture.store.getParagraphColdBlock(splitId);
    assert.ok(currentCold);
    assert.equal(currentCold.payload.raw, splitSource, "the current cold raw source must remain canonical");
    const splitHtml = paragraphHtmlChild(splitFixture.store, splitId);
    assert.ok(splitHtml, "a complete quoted header within the newline budget must publish an HTML child");
    assert.deepEqual(splitHtml.range, { from: splitSource.indexOf("<em"), to: splitSource.length }, "the appended CRLF body must retain its physical UTF-16 range");
    assert.deepEqual(emMeanings(splitFixture.container), [{ title: "warm value", text: "body" }], "the mounted native renderer must show the ephemeral HTML meaning");

    const mdxSource = "<Badge>preview";
    const mdxFixture = await mountEngine(dom, roots, engines, mdxSource, {
      formatAnticipation: { inline: true, mdx: true },
      mdxComponentNames: ["Badge"],
    });
    const mdxId = paragraphId(mdxFixture.store);
    const mdxState = paragraphState(mdxFixture.store, mdxId);
    const historicalMdxSource = mdxState.sourceSnapshot;
    const historicalMdxCold = mdxFixture.store.getParagraphColdBlock(mdxId);
    assert.ok(historicalMdxCold, "the initial MDX paragraph must have a cold value");
    const historicalMdxSnapshot = JSON.stringify(createBlockSnapshot(historicalMdxCold));
    const initializedMdxSnapshot = JSON.stringify(mdxFixture.initialized.snapshot);
    assert.equal(mdxFixture.initialized.snapshot.inputSource?.raw, mdxSource, "INIT must preserve the exact authored MDX input");
    assert.equal(paragraphSource(mdxFixture.store, mdxId), mdxSource, "the managed paragraph source must remain authored input");
    assert.equal(historicalMdxCold.payload.raw, mdxSource, "cold paragraph export must not contain the prepared lookahead value");

    const mdxSpans = mdxFixture.store.getParagraphSpans(mdxId, mdxState.source.generation, 0, 64);
    const mdxChildren = mdxSpans.flatMap((span) => span.children ?? []);
    const pendingMdxChild = mdxChildren.find((child) => child.type === "paragraph-mdx");
    const previewTextChild = mdxChildren.find((child) => child.type === "paragraph-text");
    assert.ok(pendingMdxChild && previewTextChild, "the engine must publish native MDX and text siblings");
    assert.equal(pendingMdxChild.props?.status, "pending", "the opening-only registered component must remain a native pending descriptor");
    const historicalMdxChildRanges = mdxChildren.map((child) => ({ type: child.type, range: { ...child.range } }));
    assert.deepEqual(historicalMdxChildRanges, [
      { type: "paragraph-mdx", range: { from: 0, to: 7 } },
      { type: "paragraph-text", range: { from: 7, to: 14 } },
    ], "native MDX and FIFO text sibling ranges must use canonical absolute source offsets");

    const mountedMdxParagraph = mdxFixture.container.querySelector("p");
    const pendingMdxRegion = mdxFixture.container.querySelector<HTMLSpanElement>('.markdown-mdx-inline[data-mdx-status="pending"]');
    assert.ok(mountedMdxParagraph && pendingMdxRegion, "the mounted renderer must expose the native pending MDX region");
    assert.strictEqual(pendingMdxRegion.parentElement, mountedMdxParagraph, "the pending MDX region must belong to the native paragraph");
    assert.equal(pendingMdxRegion.nextSibling?.textContent, "preview", "the visible text child must remain the FIFO sibling after the MDX region");
    const repairedDescriptor = pendingMdxRegion.textContent ?? "";
    const parsedDescriptor = new dom.window.DOMParser().parseFromString(repairedDescriptor, "application/xml");
    assert.equal(parsedDescriptor.getElementsByTagName("parsererror").length, 0, "the visible MDX lookahead descriptor must be structurally valid XML");
    assert.equal(parsedDescriptor.documentElement.tagName, "Badge", "the repaired descriptor must retain the allowlisted Badge opening");
    assert.equal(parsedDescriptor.documentElement.childNodes.length, 0, "the MDX descriptor must be an empty opening, with preview outside it");

    await handleAndApply(mdxFixture, { type: "FINALIZE" });
    const finalizedMdxState = paragraphState(mdxFixture.store, mdxId);
    assert.equal(finalizedMdxState.source.state, "finalized", "FINALIZE must expose native finalized paragraph state");
    assert.equal(paragraphSource(mdxFixture.store, mdxId), mdxSource, "FINALIZE must not alter authored paragraph source");
    assert.equal(mdxFixture.container.querySelector('.markdown-mdx-inline[data-mdx-status="pending"]'), null, "FINALIZE must remove the ephemeral MDX preview");
    assert.equal(mdxFixture.container.querySelector("p")?.textContent, mdxSource, "the finalized unclosed MDX source must render literally");
    const finalizedMdxCold = mdxFixture.store.getParagraphColdBlock(mdxId);
    assert.ok(finalizedMdxCold, "the finalized paragraph must remain available as a cold native block");
    assert.equal(finalizedMdxCold.payload.raw, mdxSource, "the finalized cold paragraph must preserve exact authored source");
    assert.equal(mdxFixture.initialized.snapshot.inputSource?.raw, mdxSource, "FINALIZE must not rewrite the historical INIT input");
    assert.equal(JSON.stringify(mdxFixture.initialized.snapshot), initializedMdxSnapshot, "the retained INIT snapshot must remain unchanged after finalization");
    assert.equal(historicalMdxSource.materialize(), mdxSource, "the retained source snapshot must remain unchanged after finalization");
    assert.equal(historicalMdxCold.payload.raw, mdxSource, "the historical cold block must remain canonical after finalization");
    assert.equal(JSON.stringify(createBlockSnapshot(historicalMdxCold)), historicalMdxSnapshot, "the historical cold snapshot must remain unchanged after finalization");
    assert.deepEqual(
      mdxChildren.map((child) => ({ type: child.type, range: { ...child.range } })),
      historicalMdxChildRanges,
      "retained native child ranges must remain unchanged through FINALIZE",
    );


    const boundedSource = "before <em>one\nnext\nlast\nbeyond";
    const boundedFixture = await mountEngine(dom, roots, engines, boundedSource);
    const boundedId = paragraphId(boundedFixture.store);
    assert.equal(emMeanings(boundedFixture.container).length, 0, "more than two newlines disable only the ephemeral HTML preview");
    const boundedText = boundedFixture.container.querySelector("p")?.textContent ?? "";
    assert.ok(boundedText.includes("<em>"), "budget fallback must keep the authored opener visible");
    for (const word of ["one", "next", "last", "beyond"]) assert.ok(boundedText.includes(word), `budget fallback must retain ${word}`);
    const authoredClose = "</em> tail";
    const closedSource = boundedSource + authoredClose;
    const closeMessages = await handleAndApply(boundedFixture, { type: "APPEND", text: authoredClose });
    assert.equal(appendInputSource(closeMessages).text, authoredClose, "the later authored close remains canonical input");
    assert.equal(paragraphSource(boundedFixture.store, boundedId), closedSource, "the unsettled scope must retain the full authored source");
    const closedCold = boundedFixture.store.getParagraphColdBlock(boundedId);
    assert.ok(closedCold);
    assert.equal(closedCold.payload.raw, closedSource, "cold export must preserve the exact authored close and text");
    const closedColdContainer = await renderColdBlock(boundedFixture, roots, closedCold);
    assert.deepEqual(emMeanings(boundedFixture.container), [{ title: null, text: "one next last beyond" }], "the authored close must restore the whole inline HTML scope");
    assert.deepEqual(emMeanings(boundedFixture.container), emMeanings(closedColdContainer), "managed rendering must match the actual Core cold final HTML meaning");
    assert.ok((boundedFixture.container.querySelector("p")?.textContent ?? "").includes("tail"), "authored text after the close must remain visible");

    const wrappedFallbackSource = "before **bold <em>one**\nnext\nlast\nbeyond";
    const wrappedFallback = await mountEngine(dom, roots, engines, wrappedFallbackSource);
    assert.equal(wrappedFallback.container.querySelector("em"), null, "budget fallback must also literalize HTML nested in inline formatting");
    assert.equal(wrappedFallback.container.querySelector("strong")?.textContent, "bold <em>one", "literal HTML fallback must preserve surrounding strong meaning");

    const siblingFixture = await mountEngine(dom, roots, engines, "prior paragraph");
    const toList = "\n\n- current <em>unfinished";
    await handleAndApply(siblingFixture, { type: "APPEND", text: toList });
    assert.ok(siblingFixture.container.querySelector("li em"), "the open list-primary HTML tail must preview while provisional");
    const toFollowingParagraph = "\n\nfollowing <em>unfinished";
    await handleAndApply(siblingFixture, { type: "APPEND", text: toFollowingParagraph });
    const rootList = siblingFixture.container.querySelector("ul");
    const priorItem = rootList?.querySelector("li");
    const followingParagraph = Array.from(siblingFixture.container.querySelectorAll("p")).find((paragraph) => paragraph.querySelector("em"));
    assert.ok(rootList && priorItem && followingParagraph, "a following native paragraph must remain a separate root block");
    assert.equal(priorItem.querySelector("em"), null, "a non-tail unclosed HTML opener must return to literal authored text");
    assert.ok(priorItem.textContent?.includes("<em>unfinished"), "the prior list item must retain its authored unclosed tag text");
    assert.ok(followingParagraph.querySelector("em"), "the current paragraph may preview only its own unclosed HTML tail");
    assert.strictEqual(rootList.parentElement, followingParagraph.parentElement, "ordinary unclosed inline HTML must not own the later native paragraph");
    await handleAndApply(siblingFixture, { type: "FINALIZE" });
    const finalizedParagraph = Array.from(siblingFixture.store.getBlocks()).find((block) => block.type === "paragraph" && block.payload.raw.includes("following"));
    assert.ok(finalizedParagraph);
    assert.equal(paragraphState(siblingFixture.store, finalizedParagraph.id).source.state, "finalized", "FINALIZE must settle the genuinely unclosed current paragraph");
    assert.equal(siblingFixture.container.querySelectorAll("em").length, 0, "FINALIZE must remove provisional HTML closure from the current authored source");
    const finalizedList = siblingFixture.container.querySelector("ul");
    const finalizedFollowingParagraph = Array.from(siblingFixture.container.querySelectorAll("p"))
      .find((paragraph) => paragraph.textContent?.includes("following"));
    assert.ok(finalizedList && finalizedFollowingParagraph);
    assert.ok(finalizedFollowingParagraph.textContent?.includes("following <em>unfinished"), "finalized authored HTML must render literally without losing source text");
    assert.strictEqual(finalizedList.parentElement, finalizedFollowingParagraph.parentElement, "the finalized paragraph remains a sibling of the earlier native list");

    const nestedFixture = await mountEngine(dom, roots, engines, "- outer\n  - <em>nested");
    const nestedParagraphId = nestedPrimaryParagraphId(nestedFixture.store);
    const outerItem = nestedFixture.container.querySelector("ul > li");
    const nestedItem = outerItem?.querySelector("ul li");
    assert.ok(outerItem && nestedItem, "the source must render as a nested native list item");
    assert.equal(nestedItem.querySelector("em")?.textContent, "nested", "the nested managed primary must render its open HTML preview");
    await handleAndApply(nestedFixture, { type: "APPEND", text: " tail" });
    const updatedNestedItem = nestedFixture.container.querySelector("ul > li ul > li");
    assert.ok(updatedNestedItem, "the nested native item must remain mounted after APPEND");
    assert.equal(updatedNestedItem.querySelector("em")?.textContent, "nested tail", "the subscribed managed primary must receive newly appended HTML-owned text");
    assert.equal(updatedNestedItem.textContent?.trim(), "nested tail", "list markers and indentation must not leak into nested authored content");
    assert.ok(paragraphSource(nestedFixture.store, nestedParagraphId).includes("nested tail"), "the nested primary source must retain the appended authored text");
  } finally {
    for (const root of roots) await act(async () => root.unmount());
    for (const engine of engines) engine.dispose();
    restoreDomGlobals(globalsBefore);
    dom.window.close();
  }
}

await runManagedHtmlLifecycleRegressions();
console.log("managed HTML paragraph lifecycle regressions passed");
