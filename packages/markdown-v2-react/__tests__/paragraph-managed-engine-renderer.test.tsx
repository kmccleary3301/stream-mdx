import assert from "node:assert/strict";
import { createBlockSnapshot, STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
import type { HtmlTreeNode, InlineNode, Patch, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { MarkdownBlocksRenderer } from "../src/renderer/blocks-renderer";
import { StreamingMarkdown } from "../src/streaming-markdown";
import type { StreamingMarkdownHandle } from "../src/streaming-markdown";
import { createRendererStore, type RendererStore } from "../src/renderer/store";

const rootParagraphPlugins = {
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
    if (message.type === "INITIALIZED") {
      assert.ok(message.snapshot.inputSource, "live INITIALIZED snapshots must carry canonical input");
      assert.equal(message.snapshot.inputSource.generation, message.generation, "root input and worker generations must match");
      store.resetSnapshot(message.snapshot);
    } else if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
    else if (message.type === "ERROR") assert.fail(`worker ${message.phase} failed: ${message.error.message}`);
  }
}

async function handleAndApply(
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
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  return messages;
}

function paragraphId(store: RendererStore): string {
  const paragraph = store.getBlocks().find((block) => block.type === "paragraph");
  assert.ok(paragraph, "the engine snapshot must expose its managed root paragraph");
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

function hasInlineKind(nodes: readonly InlineNode[], kind: string): boolean {
  for (const node of nodes) {
    if (node.kind === kind) return true;
    if ("children" in node && node.children && hasInlineKind(node.children, kind)) return true;
  }
  return false;
}

type FootnoteReference = Extract<InlineNode, { kind: "footnote-ref" }>;

function collectFootnoteReferences(nodes: readonly InlineNode[]): FootnoteReference[] {
  const references: FootnoteReference[] = [];
  for (const node of nodes) {
    if (node.kind === "footnote-ref") references.push(node);
    if ("children" in node && Array.isArray(node.children)) references.push(...collectFootnoteReferences(node.children));
  }
  return references;
}

function collectHtmlFootnoteReferences(tree: readonly HtmlTreeNode[]): FootnoteReference[] {
  const references: FootnoteReference[] = [];
  for (const node of tree) {
    if (node.kind === "text" && node.inline) {
      references.push(...collectFootnoteReferences(node.inline));
    } else if (node.kind === "element") {
      if (node.inlineNode?.kind === "footnote-ref") references.push(node.inlineNode);
      references.push(...collectHtmlFootnoteReferences(node.children));
    } else if (node.kind === "block" && node.block.payload.inline) {
      references.push(...collectFootnoteReferences(node.block.payload.inline));
    }
  }
  return references;
}

function paragraphInit(initialContent: string, plainRootPlugins = true): WorkerIn {
  const input: Extract<WorkerIn, { type: "INIT" }> = {
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent,
    prewarmLangs: [],
  };
  if (plainRootPlugins) input.docPlugins = rootParagraphPlugins;
  return input;
}

async function runManagedParagraphEngineRendererRegression(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
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

  const emitted: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => emitted.push(message) });
  const store = createRendererStore();
  let root: Root | undefined;
  let coldParagraphBlockReads = 0;
  const getColdParagraphBlock = store.getParagraphColdBlock.bind(store);
  store.getParagraphColdBlock = (id) => {
    coldParagraphBlockReads += 1;
    return getColdParagraphBlock(id);
  };
  const componentRegistry = new ComponentRegistry();
  componentRegistry.setInlineComponents({
    strong: ({ children }) => createElement("strong", { "data-managed-inline": "strong" }, children),
  });

  try {
    // This first case pins the plain-root route before the default mixed-content case below.
    const originalParagraph = "**pinned**. See [guide][destination]";
    const initialized = await handleAndApply(engine, store, emitted, paragraphInit(originalParagraph));
    assert.ok(initialized.some((message) => message.type === "INITIALIZED"), "INIT must publish the engine's native root snapshot");
    const initializedMessage = initialized.find((message) => message.type === "INITIALIZED");
    assert.ok(initializedMessage && initializedMessage.type === "INITIALIZED");
    assert.equal(initializedMessage.snapshot.inputSource?.raw, originalParagraph, "INIT publishes the complete baseline, not append ops");

    const container = dom.window.document.getElementById("root");
    assert.ok(container, "missing JSDOM render root");
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(MarkdownBlocksRenderer, {
        blocks: [],
        store,
        componentRegistry,
        animated: { sep: "word", stagger: 0 },
      }));
    });

    const id = paragraphId(store);
    const generation = paragraphState(store, id).source.generation;
    assert.equal(paragraphSource(store, id), originalParagraph, "managed source snapshots must preserve exact authored bytes");
    assert.equal(coldParagraphBlockReads, 0, "the default managed renderer must not materialize a cold paragraph Block");
    assert.equal(container.querySelector("p strong[data-managed-inline=\"strong\"]")?.textContent, "pinned", "native rendering must use the configured inline component registry");
    assert.equal(container.querySelector("p a"), null, "an unresolved reference must remain non-link content");

    const firstAppend = " remains";
    const afterFirstSource = originalParagraph + firstAppend;
    const firstAppendMessages = await handleAndApply(engine, store, emitted, { type: "APPEND", text: firstAppend });
    const firstAppendPatch = patchesOf(firstAppendMessages).find((patch) => patch.op === "appendParagraph");
    const inputAppend = patchesOf(firstAppendMessages).find((patch) => patch.op === "appendInputSource");
    assert.ok(inputAppend && inputAppend.op === "appendInputSource");
    assert.equal(inputAppend.from, originalParagraph.length, "the first input append starts at the baseline UTF-16 length");
    assert.equal(inputAppend.text, firstAppend, "the root operation carries only the newly admitted bytes");
    assert.ok(
      patchesOf(firstAppendMessages).indexOf(inputAppend) < patchesOf(firstAppendMessages).findIndex((patch) => patch.op === "appendParagraph"),
      "root input retention precedes semantic paragraph ownership",
    );
    assert.ok(firstAppendPatch && firstAppendPatch.op === "appendParagraph", "APPEND must publish a managed paragraph tail patch");
    assert.equal(firstAppendPatch.sourceAppend, firstAppend, "the semantic patch must carry only newly authored paragraph source");
    assert.equal(paragraphSource(store, id), afterFirstSource, "append source export must include the exact new authored suffix");

    const retainedState = paragraphState(store, id);
    const retainedSourceSnapshot = retainedState.sourceSnapshot;
    const retainedMetadata = retainedState.source;
    const retainedRevision = retainedMetadata.revision;
    const retainedRange = store.getParagraphSpans(id, generation, 0, 64);
    assert.ok(Object.isFrozen(retainedRange), "a retained span-range read must be an immutable snapshot");
    assert.ok(Object.isFrozen(retainedMetadata), "a retained metadata read must not be a live-current view");
    const completedSpan = retainedRange.find((span) => !span.isProvisional && hasInlineKind(span.nodes, "strong"));
    assert.ok(completedSpan, "the closed emphasis before the unresolved reference must settle into a completed span");
    const provisionalSpan = retainedRange.find((span) => span.isProvisional);
    const retainedCompletedSpans = retainedRange.filter((span) => !span.isProvisional);
    assert.ok(provisionalSpan, "the unresolved reference tail must remain provisional while the paragraph is open");
    assert.strictEqual(retainedRange.at(-1), provisionalSpan, "only the final source span may remain provisional");
    assert.ok(Object.isFrozen(provisionalSpan), "a retained span record must be immutable");
    assert.equal(retainedSourceSnapshot.materialize(), afterFirstSource, "the retained read snapshot must describe its own source revision");
    const pinnedStrong = container.querySelector("p strong");
    assert.ok(pinnedStrong, "the completed inline span must have a mounted DOM node");

    const secondAppend = " and **live**";
    const afterSecondSource = afterFirstSource + secondAppend;
    const secondAppendMessages = await handleAndApply(engine, store, emitted, { type: "APPEND", text: secondAppend });
    assert.ok(patchesOf(secondAppendMessages).some((patch) => patch.op === "appendParagraph"), "a second APPEND must update the managed tail");
    const secondInputAppend = patchesOf(secondAppendMessages).find((patch) => patch.op === "appendInputSource");
    assert.ok(secondInputAppend && secondInputAppend.op === "appendInputSource");
    assert.equal(secondInputAppend.from, afterFirstSource.length);
    assert.equal(secondInputAppend.text, secondAppend);
    assert.equal(paragraphSource(store, id), afterSecondSource, "second append source export must remain exact");

    const currentState = paragraphState(store, id);
    const currentRange = store.getParagraphSpans(id, generation, 0, 64);
    assert.notStrictEqual(currentState, retainedState, "an append must publish a new immutable view state");
    assert.ok(currentState.source.revision > retainedRevision, "the new view must advance its paragraph revision");
    assert.equal(retainedMetadata.revision, retainedRevision, "a retained metadata read must not acquire live-current fields");
    assert.equal(retainedSourceSnapshot.materialize(), afterFirstSource, "a retained source snapshot must not follow later appends");
    assert.strictEqual(currentRange[completedSpan.index], completedSpan, "append must preserve the completed span record identity");
    for (const span of retainedCompletedSpans) {
      assert.strictEqual(currentRange[span.index], span, "append must preserve every completed span record");
    }
    assert.ok(!currentRange.includes(provisionalSpan), "append must replace the previous provisional record, not mutate it");
    assert.notStrictEqual(currentRange.at(-1), provisionalSpan, "append must replace only the prior tail record");
    assert.equal(container.querySelector("p strong") === pinnedStrong, true, "the completed inline DOM must retain identity across tail append");
    assert.ok(Array.from(container.querySelectorAll("p strong")).some((node) => node.textContent === "live"), "the newly prepared tail meaning must appear in mounted DOM");
    assert.equal(container.querySelector("p a"), null, "an unresolved reference must remain unresolved until its real definition arrives");
    assert.ok(container.querySelector(".stream-mdx-anim"), "provisional prepared text must retain the configured anticipation context");

    const unresolvedSpan = currentRange.find((span) => span.attemptedReferences.includes("destination"));
    assert.ok(unresolvedSpan, "the engine-prepared tail must retain its unresolved reference dependency");
    const definition = "\n\n[destination]: /guide\n";
    const sourceBeforeDefinition = afterSecondSource;
    const retainedReferenceSource = paragraphState(store, id).sourceSnapshot;
    const referenceMessages = await handleAndApply(engine, store, emitted, { type: "APPEND", text: definition });
    const referenceUpdatePatch = patchesOf(referenceMessages).find((patch) => patch.op === "updateParagraphSpans");
    assert.ok(referenceUpdatePatch && referenceUpdatePatch.op === "updateParagraphSpans", "a real later definition must publish targeted prepared-meaning updates");
    const definitionInputAppend = patchesOf(referenceMessages).find((patch) => patch.op === "appendInputSource");
    assert.ok(definitionInputAppend && definitionInputAppend.op === "appendInputSource");
    assert.equal(definitionInputAppend.from, sourceBeforeDefinition.length);
    assert.equal(definitionInputAppend.text, definition, "the reference definition is root input, not paragraph source");
    assert.deepEqual(
      referenceUpdatePatch.updates.map((update) => update.index),
      [unresolvedSpan.index],
      "the later definition must target only its dependent prepared span",
    );
    const resolvedSpan = store.getParagraphSpans(id, generation, 0, 64).find((span) => span.id === unresolvedSpan.id);
    assert.ok(resolvedSpan, "the targeted update must retain the original source span");
    assert.deepEqual(resolvedSpan.sourceRange, unresolvedSpan.sourceRange, "reference resolution must not change authored span range");
    assert.equal(resolvedSpan.sourceRevision, unresolvedSpan.sourceRevision, "reference resolution must not revise authored span source");
    assert.deepEqual(resolvedSpan.nodes.filter((node) => node.kind === "link").map((node) => node.kind === "link" ? node.href : undefined), ["/guide"], "the engine's reference update must carry the resolved link meaning");
    assert.strictEqual(paragraphState(store, id).sourceSnapshot, retainedReferenceSource, "same-bounds reference updates retain the paragraph source window");
    const mountedLink = container.querySelector("p a[href=\"/guide\"]");
    assert.equal(mountedLink?.textContent, "guide", "the mounted native renderer must expose the actual late reference meaning");
    assert.equal(container.querySelector("p strong") === pinnedStrong, true, "targeted reference meaning must leave completed inline DOM unchanged");
    assert.strictEqual(
      store.getParagraphSpans(id, generation, 0, 64)[completedSpan.index],
      completedSpan,
      "targeted reference meaning must preserve the completed prefix span identity",
    );
    assert.equal(paragraphSource(store, id), sourceBeforeDefinition, "a reference definition must not widen the paragraph's authored source export");

    const continuationText = "  \"Guide title\"";
    const continuationMessages = await handleAndApply(engine, store, emitted, { type: "APPEND", text: continuationText });
    assert.ok(
      patchesOf(continuationMessages).some((patch) => patch.op === "updateParagraphSpans"),
      "a native title continuation must update existing reference meaning",
    );
    const titledSpan = store.getParagraphSpans(id, generation, 0, 64).find((span) => span.id === unresolvedSpan.id);
    const titledLink = titledSpan?.nodes.find(
      (node): node is Extract<InlineNode, { kind: "link" }> => node.kind === "link",
    );
    assert.equal(titledLink?.title, "Guide title", "a continued native definition title must reach the existing link span");
    assert.equal(
      container.querySelector("p a[href=\"/guide\"]")?.getAttribute("title"),
      "Guide title",
      "the mounted renderer must preserve the continued native definition title",
    );
    assert.equal(paragraphSource(store, id), sourceBeforeDefinition, "reference title continuation must not widen paragraph source");

    const finalizedMessages = await handleAndApply(engine, store, emitted, { type: "FINALIZE" });
    assert.equal(finalizedMessages.at(-1)?.type, "FINALIZED", "EOF must finish only after its managed paragraph publication");
    assert.equal(paragraphState(store, id).source.state, "finalized", "EOF must finalize the managed paragraph lifecycle");
    assert.equal(paragraphSource(store, id), sourceBeforeDefinition, "EOF source export must remain exact and exclude the separate definition");
    assert.equal(container.querySelector("p a[href=\"/guide\"]")?.textContent, "guide", "EOF must retain the resolved semantic DOM");
    assert.equal(container.querySelector("p strong") === pinnedStrong, true, "EOF must retain the completed inline DOM node");
    const finalizedParagraphState = paragraphState(store, id);
    const finalizedGeneration = finalizedParagraphState.source.generation;
    const finalizedSourceRange = finalizedParagraphState.source.sourceRange;
    const finalizedSourceSnapshot = finalizedParagraphState.sourceSnapshot;
    const finalizedParagraphDom = container.querySelector("p");
    assert.ok(finalizedParagraphDom, "the finalized authored paragraph must remain mounted");
    const reopenAppend = " reopened **tail**";
    await handleAndApply(engine, store, emitted, { type: "APPEND", text: reopenAppend });
    assert.equal(paragraphState(store, id).source.generation, finalizedGeneration, "content after the separate definition must not reopen the prior paragraph generation");
    assert.deepEqual(paragraphState(store, id).source.sourceRange, finalizedSourceRange, "new body content must not widen the prior paragraph source window");
    assert.equal(paragraphSource(store, id), sourceBeforeDefinition, "new body content must leave the prior paragraph's authored source unchanged");
    assert.equal(finalizedSourceSnapshot.materialize(), sourceBeforeDefinition, "the retained finalized source window must stay immutable");
    const reopenedTailStrong = Array.from(container.querySelectorAll("p strong")).find((node) => node.textContent === "tail");
    assert.ok(reopenedTailStrong, "the newly authored tail must mount its native inline meaning");
    const reopenedTailParagraph = reopenedTailStrong.closest("p");
    assert.ok(reopenedTailParagraph, "the new tail must remain in native paragraph DOM");
    assert.notStrictEqual(reopenedTailParagraph, finalizedParagraphDom, "new body content after the definition must render separately from the finalized paragraph");
    assert.ok(reopenedTailParagraph.textContent?.includes("reopened"), "the separately rendered tail must retain its authored text");
    assert.equal(finalizedParagraphDom.querySelector("a[href=\"/guide\"]")?.textContent, "guide", "the earlier paragraph must retain its native resolved reference");
    assert.equal(finalizedParagraphDom.querySelector("a[href=\"/guide\"]")?.getAttribute("title"), null, "the invalid continued definition must not retain a stale native reference title");

    const metadataInit = await handleAndApply(engine, store, emitted, paragraphInit("Alpha\n\n# Hea"));
    assert.ok(metadataInit.some((message) => message.type === "INITIALIZED"), "reinitialization must publish a fresh engine snapshot");
    const metadataId = paragraphId(store);
    assert.equal(metadataId, id, "same-source-start replacement must exercise generation rejection rather than a missing-ID path");
    const metadataBefore = paragraphState(store, metadataId);
    const metadataGeneration = metadataBefore.source.generation;
    assert.equal(paragraphSource(store, metadataId), "Alpha", "heading content must remain outside the earlier paragraph's authored source");
    assert.equal(container.querySelector("p")?.textContent, "Alpha", "the earlier paragraph must remain visible before heading completion");
    assert.equal(container.querySelector("h1")?.textContent, "Hea", "INIT must render the native heading content");

    await handleAndApply(engine, store, emitted, { type: "APPEND", text: "ding" });
    assert.equal(metadataBefore.sourceSnapshot.materialize(), "Alpha", "the retained source snapshot must stay fixed after heading completion");
    assert.equal(paragraphSource(store, metadataId), "Alpha", "heading completion must retain the earlier paragraph source");
    assert.equal(container.querySelector("p")?.textContent, "Alpha", "heading completion must preserve the earlier paragraph DOM");
    assert.equal(container.querySelector("h1")?.textContent, "Heading", "APPEND must update the mounted native heading content");
    const replacementSource = "Replacement generation";
    const replacementMessages = await handleAndApply(engine, store, emitted, paragraphInit(replacementSource));
    assert.ok(replacementMessages.some((message) => message.type === "INITIALIZED"), "generation reset must publish the replacement snapshot");
    const replacementId = paragraphId(store);
    assert.equal(replacementId, metadataId, "replacement must reuse the source-start paragraph ID");
    const replacementState = paragraphState(store, replacementId);
    assert.ok(replacementState.source.generation > metadataGeneration, "replacement must advance the owner generation");
    assert.equal(paragraphSource(store, replacementId), replacementSource, "replacement must install only its own authored source");
    assert.equal(container.querySelector("p")?.textContent, replacementSource, "the mounted native renderer must show the new generation");
    assert.equal(coldParagraphBlockReads, 0, "default source, metadata, replacement, and EOF transitions must stay on managed paragraph queries");

    // These are saved WorkerOut patches from actual earlier engine actions, not prepared fixtures.
    const staleActions = [firstAppendPatch, referenceUpdatePatch];
    await act(async () => {
      store.applyPatches(staleActions, { captureMetrics: false });
    });
    assert.equal(paragraphState(store, replacementId).source.generation, replacementState.source.generation, "saved old-generation actions must not advance replacement state");
    assert.equal(paragraphSource(store, replacementId), replacementSource, "saved old-generation actions must not change replacement source");
    assert.equal(container.querySelector("p")?.textContent, replacementSource, "saved old-generation actions must not change mounted DOM");
    // Omit the explicit plain-only config: the actual engine default route must publish native mixed child snapshots.
    const mixedSource = "before **bold** [^late] <em>HTML <strong>nested</strong> [^late]</em> between <InlineChip tone=\"warm\">MDX</InlineChip> after";
    const mixedMessages = await handleAndApply(engine, store, emitted, paragraphInit(mixedSource, false));
    assert.ok(mixedMessages.some((message) => message.type === "INITIALIZED"), "default INIT must publish the actual engine snapshot");
    const mixedId = paragraphId(store);
    const mixedState = paragraphState(store, mixedId);
    const mixedGeneration = mixedState.source.generation;
    const mixedSpans = store.getParagraphSpans(mixedId, mixedGeneration, 0, 64);
    const mixedChildren = mixedSpans.flatMap((span) => span.children ?? []);
    const htmlChild = mixedChildren.find((child) => child.type === "paragraph-html");
    const mdxChild = mixedChildren.find((child) => child.type === "paragraph-mdx");
    const textChild = mixedChildren.find((child) => child.type === "paragraph-text");
    assert.ok(htmlChild, "the engine must publish sanitized native HTML meaning");
    assert.ok(typeof htmlChild.props?.raw === "string" && typeof htmlChild.props?.html === "string" && Array.isArray(htmlChild.props?.htmlTree), "HTML children must retain the producer's sanitized raw/tree payload");
    assert.ok(mdxChild, "the engine must publish native MDX status meaning");
    assert.ok(typeof mdxChild.props?.raw === "string" && typeof mdxChild.props?.status === "string", "MDX children must retain only their raw/status payload");
    const textInline = textChild?.props?.inline;
    assert.ok(Array.isArray(textInline), "native text children must carry prepared inline nodes");
    const htmlTree = htmlChild.props?.htmlTree;
    assert.ok(Array.isArray(htmlTree), "native HTML children must carry their parsed ownership tree");
    assert.ok(mixedSpans.some((span) => span.children?.length && span.nodes.length === 0), "mixed spans must use children as their sole meaning");
    assert.equal(
      collectFootnoteReferences(textInline).length,
      1,
      "default footnotes must be prepared in the native text child",
    );
    assert.equal(
      collectHtmlFootnoteReferences(htmlTree).length,
      1,
      "HTML-tree inline preparation must retain the same canonical footnote occurrence",
    );
    for (const child of mixedChildren) {
      const record = store.getNode(child.id);
      assert.equal(record?.type, child.type, "native child IDs must resolve through the store's node machinery");
      assert.deepEqual(record?.range, child.range, "native child records must retain absolute source ranges");
      assert.ok(child.range.from >= mixedState.source.sourceRange.from && child.range.to <= mixedState.source.sourceRange.to);
    }
    assert.deepEqual(store.getChildren(mixedId), [], "span children must not be duplicated in the paragraph's generic child array");

    const mixedColdBlock = store.getParagraphColdBlock(mixedId);
    assert.ok(mixedColdBlock, "cold Block materialization must be available for a mixed paragraph");
    assert.equal(mixedColdBlock.payload.raw, mixedSource, "cold Block materialization must preserve exact mixed source");
    const mixedNodeSnapshot = createBlockSnapshot(mixedColdBlock);
    assert.deepEqual(mixedNodeSnapshot.children, [], "cold NodeSnapshot roots must not duplicate paragraph span children");
    const coldChildren = mixedNodeSnapshot.paragraph?.spans.flatMap((span) => span.children ?? []) ?? [];
    assert.deepEqual(
      coldChildren.map((child) => ({ id: child.id, type: child.type, range: child.range })),
      mixedChildren.map((child) => ({ id: child.id, type: child.type, range: child.range })),
      "cold NodeSnapshot materialization must retain the complete canonical native child meaning",
    );
    const mixedMeta = mixedColdBlock.payload.meta?.mixedSegments;
    assert.ok(Array.isArray(mixedMeta) && mixedMeta.some((segment) => segment.kind === "html") && mixedMeta.some((segment) => segment.kind === "mdx"));
    assert.equal(container.querySelector("p strong")?.textContent, "bold", "plain prepared inline meaning must remain semantic paragraph DOM");
    assert.equal(container.querySelector("em strong")?.textContent, "nested", "HTML ownership trees must preserve nested inline structure");
    const mountedMdx = container.querySelector(".markdown-mdx-inline");
    assert.equal(
      mountedMdx?.getAttribute("data-mdx-status"),
      typeof mdxChild.props?.status === "string" ? mdxChild.props.status : "pending",
      "MDX children must use the existing trusted/restricted status dispatcher",
    );

    const retainedMixedSource = mixedState.sourceSnapshot;
    const retainedMixedSpans = [...mixedSpans];
    const retainedMixedValues = retainedMixedSpans.map((span) => ({
      range: { ...span.sourceRange },
      nodes: span.nodes,
      children: span.children,
    }));
    const mixedAppend = " plus **tail**";
    const mixedAppendMessages = await handleAndApply(engine, store, emitted, { type: "APPEND", text: mixedAppend });
    assert.ok(patchesOf(mixedAppendMessages).some((patch) => patch.op === "appendParagraph"), "default mixed paragraphs must append through the native paragraph patch");
    assert.equal(paragraphSource(store, mixedId), mixedSource + mixedAppend, "mixed append must preserve the exact authored suffix");
    assert.equal(retainedMixedSource.materialize(), mixedSource, "retained mixed source snapshots must remain immutable");
    assert.deepEqual(
      retainedMixedSpans.map((span) => ({ range: span.sourceRange, nodes: span.nodes, children: span.children })),
      retainedMixedValues,
      "retained mixed span records must not acquire later revisions or child meanings",
    );
    assert.equal(container.querySelector("em strong")?.textContent, "nested", "plain tail append must preserve mounted mixed HTML DOM");
    assert.ok(Array.from(container.querySelectorAll("p strong")).some((node) => node.textContent === "tail"));
    const pinnedMixedStrong = container.querySelector("p strong");
    assert.ok(pinnedMixedStrong, "the mounted mixed paragraph must retain its original native emphasis");
    const eventCountBeforeGrowth = store.getParagraphSegmentProjection(mixedId)?.eventCount;
    assert.ok(eventCountBeforeGrowth !== undefined && eventCountBeforeGrowth < 32, "the mixed fixture must begin below the segment-tree boundary");
    const segmentGrowth = Array.from({ length: 40 }, (_, index) => ` <em>native-growth-${index}</em>`).join("");
    const segmentGrowthMessages = await handleAndApply(engine, store, emitted, { type: "APPEND", text: segmentGrowth });
    assert.ok(patchesOf(segmentGrowthMessages).some((patch) => patch.op === "appendParagraph"), "native segment growth must use the real managed paragraph append");
    const projectionAfterGrowth = store.getParagraphSegmentProjection(mixedId);
    assert.ok(projectionAfterGrowth && projectionAfterGrowth.eventCount > 32, "the real native segment plan must cross 32 events");
    assert.ok(projectionAfterGrowth.eventCount > eventCountBeforeGrowth, "native append must grow the actual segment projection");
    const mixedSourceAfterGrowth = mixedSource + mixedAppend + segmentGrowth;
    assert.equal(paragraphSource(store, mixedId), mixedSourceAfterGrowth, "native segment growth must preserve exact authored source");
    assert.equal(container.querySelector("p strong") === pinnedMixedStrong, true, "completed native paragraph DOM must retain identity across the segment boundary");
    assert.ok(container.textContent?.includes("native-growth-39"), "the appended native HTML tail must be mounted");
    const footnoteDefinitions = "\n\n[^late]: Footnote body";
    await handleAndApply(engine, store, emitted, { type: "APPEND", text: footnoteDefinitions });
    const footnotePublication = await handleAndApply(engine, store, emitted, { type: "APPEND", text: "\n\n---\n\n" });
    assert.ok(patchesOf(footnotePublication).some((patch) => patch.op === "updateParagraphSpans"), "published late footnote definitions must update affected paragraph meaning during streaming");
    assert.equal(paragraphSource(store, mixedId), mixedSourceAfterGrowth, "footnote definitions must not widen paragraph-owned source");
    const finalColdBlock = store.getParagraphColdBlock(mixedId);
    assert.ok(finalColdBlock);
    const finalParagraph = createBlockSnapshot(finalColdBlock).paragraph;
    assert.ok(finalParagraph);
    const finalFootnoteReferences: FootnoteReference[] = [];
    for (const span of finalParagraph.spans) {
      finalFootnoteReferences.push(...collectFootnoteReferences(span.nodes));
      for (const child of span.children ?? []) {
        if (Array.isArray(child.props?.inline)) {
          finalFootnoteReferences.push(...collectFootnoteReferences(child.props.inline as InlineNode[]));
        }
        if (Array.isArray(child.props?.htmlTree)) {
          finalFootnoteReferences.push(...collectHtmlFootnoteReferences(child.props.htmlTree as HtmlTreeNode[]));
        }
      }
    }
    assert.deepEqual(
      finalFootnoteReferences.map((ref) => [ref.label, ref.number, ref.occurrence, ref.defined]),
      [["late", 1, 1, true], ["late", 1, 2, true]],
      "plain and HTML-owned references must preserve canonical numbering and anchor occurrence order",
    );
    const footnotesBlock = store.getBlocks().find((block) => block.type === "footnotes");
    assert.ok(footnotesBlock, "default footnote definitions must publish the canonical footnotes block");
    const footnoteItems = footnotesBlock.payload.meta?.items as Array<{ label: string; number: number; refCount?: number }> | undefined;
    assert.deepEqual(footnoteItems?.map((item) => [item.label, item.number, item.refCount]), [["late", 1, 2]]);
    const mountedFootnoteAnchors = Array.from(container.querySelectorAll(".footnote-ref a[data-label=\"late\"]"));
    assert.deepEqual(
      mountedFootnoteAnchors.map((anchor) => [anchor.getAttribute("href"), anchor.id]),
      [["#fn:1", "fnref:1"], ["#fn:1", "fnref:1:2"]],
      "mounted plain and HTML-owned footnote references must retain semantic anchor order",
    );
    await handleAndApply(engine, store, emitted, paragraphInit("compare a < b and **bold**", false));
    assert.equal(container.querySelector("p")?.textContent, "compare a < b and bold", "literal comparison text must survive the default mixed-content candidate path");
  } finally {
    try {
      if (root) await act(async () => root!.unmount());
    } finally {
      try {
        engine.dispose();
      } finally {
        restoreDomGlobals(globalsBefore);
        dom.window.close();
      }
    }
  }
}

async function runManagedParagraphOverrideRegression(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
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
  const emitted: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => emitted.push(message) });
  const store = createRendererStore();
  const container = dom.window.document.getElementById("root");
  assert.ok(container, "missing custom paragraph render root");
  const root = createRoot(container);
  const authored = "Before **bold** after";
  let finalizedBlockRaw: string | undefined;
  const inlineText = (nodes: readonly InlineNode[]): string => nodes.map((node) => {
    if (node.kind === "text") return node.text;
    if ("children" in node && Array.isArray(node.children)) return inlineText(node.children);
    if ("text" in node && typeof node.text === "string") return node.text;
    return "";
  }).join("");
  const componentRegistry = new ComponentRegistry(
    {
      paragraph: ({ raw, inlines, children }) => createElement(
        "p",
        {
          "data-custom-paragraph": "",
          "data-source": raw,
          "data-inline-source": inlineText(inlines),
        },
        children,
      ),
    },
    {
      strong: ({ children }) => createElement("strong", { "data-managed-inline": "strong" }, children),
    },
    {},
    {
      blockRenderer: ({ block, element }) => {
        if (block.type !== "paragraph") return element;
        finalizedBlockRaw = block.payload.raw;
        return createElement("section", { "data-finalized-managed-block": block.id }, element);
      },
    },
  );
  try {
    await handleAndApply(engine, store, emitted, paragraphInit("Before **bold**"));
    await act(async () => {
      root.render(createElement(MarkdownBlocksRenderer, { blocks: [], store, componentRegistry }));
    });
    await handleAndApply(engine, store, emitted, { type: "APPEND", text: " after" });
    await handleAndApply(engine, store, emitted, { type: "FINALIZE" });

    const paragraph = container.querySelector("p[data-custom-paragraph]");
    assert.ok(paragraph, "the custom paragraph consumer must mount");
    assert.equal(paragraph.getAttribute("data-source"), authored, "custom paragraph raw must update with managed source");
    assert.equal(paragraph.getAttribute("data-inline-source"), "Before bold after", "custom paragraph inlines must reflect prepared meaning");
    assert.equal(paragraph.textContent, "Before bold after", "custom wrapper must preserve native prepared children");
    assert.equal(paragraph.querySelectorAll('strong[data-managed-inline="strong"]').length, 1, "native prepared children must appear exactly once");
    assert.equal(finalizedBlockRaw, authored, "finalized blockRenderer must receive the source-backed managed paragraph");
    assert.ok(
      container.querySelector("section[data-finalized-managed-block] p[data-custom-paragraph]"),
      "finalized blockRenderer output must appear around managed paragraphs",
    );
  } finally {
    try {
      await act(async () => root.unmount());
    } finally {
      try {
        engine.dispose();
      } finally {
        restoreDomGlobals(globalsBefore);
        dom.window.close();
      }
    }
  }
}

async function waitForDom(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function runPublicDefaultParagraphAppendColdReadRegression(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
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
  const container = dom.window.document.getElementById("root");
  assert.ok(container, "missing public append render root");
  const root = createRoot(container);
  const handle = createRef<StreamingMarkdownHandle>();
  let restoreColdBlock: (() => void) | undefined;
  let coldParagraphBlockReads = 0;
  try {
    await act(async () => {
      root.render(createElement(StreamingMarkdown, { ref: handle, engine: "main-thread" }));
    });
    await waitForDom(() => Boolean(handle.current?.getState().workerReady), "main-thread engine readiness");
    const store = handle.current!.getState().store;
    const getColdBlock = store.getParagraphColdBlock.bind(store);
    store.getParagraphColdBlock = (id) => {
      coldParagraphBlockReads += 1;
      return getColdBlock(id);
    };
    restoreColdBlock = () => { store.getParagraphColdBlock = getColdBlock; };

    await act(async () => {
      handle.current!.append("ordinary default append");
    });
    await waitForDom(() => container.textContent?.includes("ordinary default append") ?? false, "first public append");
    await act(async () => {
      handle.current!.append(" + appended");
    });
    await waitForDom(() => container.textContent?.endsWith("+ appended") ?? false, "second public append");
    assert.equal(coldParagraphBlockReads, 0, "ordinary default public append must not materialize a cold paragraph Block");
  } finally {
    restoreColdBlock?.();
    try {
      await act(async () => root.unmount());
    } finally {
      restoreDomGlobals(globalsBefore);
      dom.window.close();
    }
  }
}

await runManagedParagraphOverrideRegression();
await runPublicDefaultParagraphAppendColdReadRegression();
await runManagedParagraphEngineRendererRegression();
