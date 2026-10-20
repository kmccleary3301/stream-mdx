import assert from "node:assert/strict";
import {
  STREAM_MDX_SCHEMA_VERSION,
  createBlockSnapshot,
  type Block,
  type HtmlTreeNode,
  type InlineNode,
  type NodeSnapshot,
  type ParagraphBlockSnapshot,
  type WorkerIn,
  type WorkerOut,
} from "@stream-mdx/core";
import { createRendererStore, type RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { MarkdownEngine } from "../src/engine/engine";

function applyMessages(store: RendererStore, messages: readonly WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
    else if (message.type === "ERROR") assert.fail(`worker ${message.phase} failed: ${message.error.message}`);
  }
}

function paragraphSnapshots(root: NodeSnapshot): ParagraphBlockSnapshot[] {
  const paragraphs: ParagraphBlockSnapshot[] = [];
  const visit = (node: NodeSnapshot): void => {
    const paragraph = (node as NodeSnapshot & { paragraph?: ParagraphBlockSnapshot }).paragraph;
    if (paragraph) paragraphs.push(paragraph);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return paragraphs;
}

function coldParagraph(store: RendererStore, raw: string): { block: Block; paragraph: ParagraphBlockSnapshot } {
  const view = store.getBlocks().find((block) => block.type === "paragraph" && block.payload.raw === raw);
  assert.ok(view, `expected paragraph block with exact source ${JSON.stringify(raw)}`);
  const block = store.getParagraphColdBlock(view.id);
  assert.ok(block, "the managed paragraph cold owner must remain available");
  const snapshot = createBlockSnapshot(block) as NodeSnapshot & { paragraph?: ParagraphBlockSnapshot };
  assert.ok(snapshot.paragraph, "explicit cold export must retain the canonical paragraph span snapshot");
  return { block, paragraph: snapshot.paragraph };
}

function footnoteRefs(nodes: readonly InlineNode[]): Array<Extract<InlineNode, { kind: "footnote-ref" }>> {
  const refs: Array<Extract<InlineNode, { kind: "footnote-ref" }>> = [];
  for (const node of nodes) {
    if (node.kind === "footnote-ref") refs.push(node);
    if ("children" in node && Array.isArray(node.children)) refs.push(...footnoteRefs(node.children));
  }
  return refs;
}

function htmlFootnoteRefs(tree: readonly HtmlTreeNode[]): Array<Extract<InlineNode, { kind: "footnote-ref" }>> {
  const refs: Array<Extract<InlineNode, { kind: "footnote-ref" }>> = [];
  for (const node of tree) {
    if (node.kind === "text" && node.inline) refs.push(...footnoteRefs(node.inline));
    else if (node.kind === "element") {
      if (node.inlineNode?.kind === "footnote-ref") refs.push(node.inlineNode);
      refs.push(...htmlFootnoteRefs(node.children));
    } else if (node.kind === "block" && node.block.payload.inline) {
      refs.push(...footnoteRefs(node.block.payload.inline));
    }
  }
  return refs;
}

function spanFootnoteRefs(paragraph: ParagraphBlockSnapshot): Array<Extract<InlineNode, { kind: "footnote-ref" }>> {
  const refs: Array<Extract<InlineNode, { kind: "footnote-ref" }>> = [];
  for (const span of paragraph.spans) {
    refs.push(...footnoteRefs(span.nodes));
    for (const child of span.children ?? []) {
      if (Array.isArray(child.props?.inline)) refs.push(...footnoteRefs(child.props.inline as InlineNode[]));
      const tree = child.props?.htmlTree;
      if (Array.isArray(tree)) refs.push(...htmlFootnoteRefs(tree as HtmlTreeNode[]));
    }
  }
  return refs;
}

function linkHref(nodes: readonly InlineNode[], label: string): string | undefined {
  for (const node of nodes) {
    if (node.kind === "link" && node.children.some((child) => child.kind === "text" && child.text === label)) return node.href;
    if ("children" in node && Array.isArray(node.children)) {
      const href = linkHref(node.children, label);
      if (href !== undefined) return href;
    }
  }
  return undefined;
}

function linkTitle(nodes: readonly InlineNode[], label: string): string | undefined {
  for (const node of nodes) {
    if (node.kind === "link" && node.children.some((child) => child.kind === "text" && child.text === label)) return node.title;
    if ("children" in node && Array.isArray(node.children)) {
      const title = linkTitle(node.children, label);
      if (title !== undefined) return title;
    }
  }
  return undefined;
}


async function runDefaultMixedReferencesAndNestedFootnotes(): Promise<void> {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
  const store = createRendererStore();
  const literal = "Keep < and { literally";
  const mixedInitial = "First [^late] <span>inside [^late]</span> with <Badge>preview";
  const initialSource = `${literal}\n\n${mixedInitial}`;
  const appended = " output</Badge> [guide][manual]\n\n> nested [^late]";
  const init: WorkerIn = {
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: initialSource,
    prewarmLangs: [],
    // All default builtins remain enabled; only opt in to the existing anticipation feature.
    docPlugins: { formatAnticipation: true },
  };
  try {
    await engine.handle(init);
    const initialized = messages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
    assert.ok(initialized, "default WorkerIn must publish a root snapshot");
    const initialWire = JSON.stringify(initialized.snapshot);
    const initialParagraphs = paragraphSnapshots(initialized.snapshot);
    const literalParagraph = initialParagraphs.find((paragraph) => paragraph.raw === literal);
    assert.ok(literalParagraph, "literal angle/brace characters must stay on the ordinary paragraph route");
    assert.ok(literalParagraph.spans.every((span) => span.children === undefined), "characters alone must not fabricate native children");
    const initialMixedParagraph = initialParagraphs.find((paragraph) => paragraph.raw === mixedInitial);
    assert.ok(initialMixedParagraph, "mixed default paragraph must use managed source ownership");
    const provisional = initialMixedParagraph.spans.find((span) => span.nodes.some((node) => node.kind === "text" && node.text === "<Badge>preview"));
    assert.ok(provisional, "unregistered incomplete MDX must remain a literal text span until authored closure arrives");
    assert.equal(initialSource.slice(provisional.sourceRange.from, provisional.sourceRange.to), "<Badge>preview");
    applyMessages(store, messages.splice(0));

    await engine.handle({ type: "APPEND", text: appended });
    const appendMessages = messages.splice(0);
    applyMessages(store, appendMessages);
    const completedMixed = `${mixedInitial} output</Badge> [guide][manual]`;
    const mixedBlock = coldParagraph(store, completedMixed);
    const mixedSnapshot = mixedBlock.paragraph;
    const authoredSource = initialSource + appended;
    const mixedChildren = mixedSnapshot.spans.flatMap((span) => span.children ?? []);
    assert.ok(mixedChildren.length > 0, "mixed spans must expose native child ownership");
    for (const span of mixedSnapshot.spans) {
      if (!span.children) continue;
      assert.equal(span.nodes.length, 0, "native child spans must not duplicate inline meaning");
      let cursor = span.sourceRange.from;
      for (const child of span.children) {
        assert.equal(child.range.from, cursor, "native child ranges must retain exact source order without gaps or overlaps");
        assert.ok(child.range.to <= authoredSource.length, "native child ranges must stay inside the authored stream");
        assert.ok(store.getNode(child.id), `native child ${child.id} must be indexed by the actual consumer`);
        cursor = child.range.to;
      }
      assert.equal(cursor, span.sourceRange.to, "native child ranges must cover their owned authored span exactly");
    }
    assert.deepEqual(store.getChildren(mixedBlock.block.id), [], "paragraph children are span-owned and must not be duplicated in root NodeSnapshot.children");
    const mixedColdNode = createBlockSnapshot(mixedBlock.block) as NodeSnapshot & { paragraph?: ParagraphBlockSnapshot };
    assert.deepEqual(mixedColdNode.children, [], "cold export must not duplicate the span-owned child payload");
    for (const span of mixedSnapshot.spans) {
      assert.equal(mixedColdNode.paragraph?.spans.find((item) => item.index === span.index)?.children?.length, span.children?.length);
    }
    const htmlChild = mixedChildren.find((child) =>
      child.type === "paragraph-html"
      && authoredSource.slice(child.range.from, child.range.to) === "<span>inside [^late]</span>",
    );
    assert.ok(htmlChild, "complete default HTML must use its actual public child type and exact authored range");

    const sourceStart = initialSource.indexOf(mixedInitial);
    const badgeSource = "<Badge>preview output</Badge>";
    const badgeFrom = authoredSource.indexOf(badgeSource, sourceStart);
    assert.ok(badgeFrom >= sourceStart, "the completed authored tag must remain inside the mixed paragraph's source window");
    const badgeTo = badgeFrom + badgeSource.length;
    let badgeCursor = badgeFrom;
    for (const span of mixedSnapshot.spans) {
      const from = Math.max(badgeFrom, span.sourceRange.from);
      const to = Math.min(badgeTo, span.sourceRange.to);
      if (from >= to) continue;
      assert.equal(from, badgeCursor, "paragraph-owned spans must cover the authored tag without source gaps");
      badgeCursor = to;
    }
    assert.equal(badgeCursor, badgeTo, "authored JSX must remain within native paragraph source ownership");

    const linkDefinition = "\n\n[manual]: /guide\n";
    await engine.handle({ type: "APPEND", text: linkDefinition });
    const linkDefinitionMessages = messages.splice(0);
    const linkDefinitionPatches = linkDefinitionMessages.flatMap((message) => message.type === "PATCH" ? message.patches : []);
    assert.ok(linkDefinitionPatches.some((patch) => patch.op === "updateParagraphSpans"), "late canonical link definitions must patch only affected paragraph meaning");
    applyMessages(store, linkDefinitionMessages);
    const beforeTitleMixed = coldParagraph(store, completedMixed);
    const beforeTitleLiteral = coldParagraph(store, literal).paragraph;

    await engine.handle({ type: "APPEND", text: '  "Guide title"' });
    const titleMessages = messages.splice(0);
    const titlePatches = titleMessages.flatMap((message) => message.type === "PATCH" ? message.patches : []);
    const titleSpanPatches = titlePatches.filter((patch) => patch.op === "updateParagraphSpans");
    assert.ok(titleSpanPatches.length > 0, "a continued native reference title must update dependent paragraph spans");
    assert.ok(titleSpanPatches.every((patch) => patch.op === "updateParagraphSpans" && patch.paragraphOwnerId === beforeTitleMixed.block.id), "title continuation must not invalidate completed unrelated paragraphs");
    applyMessages(store, titleMessages);
    const titledMixed = coldParagraph(store, completedMixed);
    assert.equal(titledMixed.paragraph.raw, completedMixed, "reference metadata must not widen paragraph authored source");
    assert.deepEqual(coldParagraph(store, literal).paragraph, beforeTitleLiteral, "completed unrelated literal spans must remain untouched");
    const updatedSpanIndices = new Set(titleSpanPatches.flatMap((patch) => patch.op === "updateParagraphSpans" ? patch.updates.map((update) => update.index) : []));
    for (const previousSpan of beforeTitleMixed.paragraph.spans) {
      if (updatedSpanIndices.has(previousSpan.index)) continue;
      assert.deepEqual(titledMixed.paragraph.spans.find((span) => span.index === previousSpan.index), previousSpan, "continued title must not touch unrelated spans in its paragraph");
    }
    await engine.handle({ type: "APPEND", text: "\n\n[^late]: Footnote body" });
    const footnoteDefinitionMessages = messages.splice(0);
    applyMessages(store, footnoteDefinitionMessages);


    assert.equal(JSON.stringify(initialized.snapshot), initialWire, "late publication must not mutate previously published native span snapshots");
    await engine.handle({ type: "FINALIZE" });
    const finalMessages = messages.splice(0);
    applyMessages(store, finalMessages);
    assert.equal(finalMessages.at(-1)?.type, "FINALIZED", "FINALIZE must publish the dirty paragraph tail before completion");
    const finalized = coldParagraph(store, completedMixed).paragraph;
    const refs = spanFootnoteRefs(finalized);
    assert.deepEqual(refs.map((ref) => [ref.label, ref.number, ref.occurrence, ref.defined]), [
      ["late", 1, 1, true],
      ["late", 1, 2, true],
    ], "plain and HTML-owned references must preserve canonical number and anchor occurrence order");
    const guide = finalized.spans.flatMap((span) => [
      ...span.nodes,
      ...(span.children?.flatMap((child) =>
        Array.isArray(child.props?.inline) ? child.props.inline as InlineNode[] : []
      ) ?? []),
    ]);
    assert.equal(linkHref(guide, "guide"), "/guide", "the same canonical reference registry must resolve late named targets");
    assert.equal(linkTitle(guide, "guide"), "Guide title", "continued definition titles must reach existing native link nodes");
    assert.ok(finalized.spans.every((span) => !span.isProvisional), "FINALIZE must retire the provisional native tail");

    const nestedQuote = store.getBlocks().find((block) => block.type === "blockquote");
    assert.ok(nestedQuote, "nested source must remain in the actual default parser path");
    const prepared = nestedQuote.payload.meta?.preparedNested as { children?: NodeSnapshot[] } | undefined;
    assert.ok(prepared?.children?.length, "the native nested paragraph snapshot must be retained");
    const nestedRefs: Array<Extract<InlineNode, { kind: "footnote-ref" }>> = [];
    const visit = (node: NodeSnapshot): void => {
      const nestedBlock = node.props?.block as Block | undefined;
      if (Array.isArray(node.props?.inline)) nestedRefs.push(...footnoteRefs(node.props.inline as InlineNode[]));
      else if (nestedBlock?.payload.inline) nestedRefs.push(...footnoteRefs(nestedBlock.payload.inline));
      for (const child of node.children ?? []) visit(child);
    };
    for (const child of prepared.children) visit(child);
    assert.deepEqual(nestedRefs.map((ref) => [ref.label, ref.number, ref.occurrence, ref.defined]), [["late", 1, 3, true]], "nested native source must follow exact document-wide anchor order");
    const footnotes = store.getBlocks().find((block) => block.type === "footnotes");
    const items = footnotes?.payload.meta?.items as Array<{ label: string; number: number; refCount?: number }> | undefined;
    assert.deepEqual(items?.map((item) => [item.label, item.number, item.refCount]), [["late", 1, 3]], "canonical footnote publication must retain every occurrence");
  } finally {
    engine.dispose();
  }
}

async function runDefaultOriginalRootReclassification(): Promise<void> {
  const setextMessages: WorkerOut[] = [];
  const setextEngine = new MarkdownEngine({ post: (message) => setextMessages.push(message) });
  const setextStore = createRendererStore();
  try {
    const original = "Prior line\nTitle";
    await setextEngine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: original, prewarmLangs: [] });
    applyMessages(setextStore, setextMessages.splice(0));
    const priorOwner = setextStore.getBlocks().find((block) => block.type === "paragraph");
    assert.ok(priorOwner);
    await setextEngine.handle({ type: "APPEND", text: "\n---" });
    applyMessages(setextStore, setextMessages.splice(0));
    const heading = setextStore.getBlocks().find((block) => block.type === "heading");
    assert.ok(heading, "default native Setext anticipation must reclassify the original root paragraph");
    assert.equal(heading.payload.range?.from, 0);
    assert.equal(heading.payload.range?.to, original.length + "\n---".length);
    assert.notEqual(heading.id, priorOwner.id, "the old paragraph generation owner must be retired");
    await setextEngine.handle({ type: "FINALIZE" });
    applyMessages(setextStore, setextMessages.splice(0));
  } finally {
    setextEngine.dispose();
  }

  const tableMessages: WorkerOut[] = [];
  const tableEngine = new MarkdownEngine({ post: (message) => tableMessages.push(message) });
  const tableStore = createRendererStore();
  try {
    await tableEngine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "| head |\r\n", prewarmLangs: [] });
    applyMessages(tableStore, tableMessages.splice(0));
    await tableEngine.handle({ type: "APPEND", text: "| --- |" });
    applyMessages(tableStore, tableMessages.splice(0));
    const table = tableStore.getBlocks().find((block) => block.type === "table");
    assert.ok(table, "the configured default native parser must replace an ambiguous paragraph with a table owner");
    assert.equal(table.payload.range?.from, 0, "table reclassification must retain the original source root");
    await tableEngine.handle({ type: "FINALIZE" });
    applyMessages(tableStore, tableMessages.splice(0));
  } finally {
    tableEngine.dispose();
  }
}

async function runNativeParagraphDefaultBridgeTest(): Promise<void> {
  await runDefaultMixedReferencesAndNestedFootnotes();
  await runDefaultOriginalRootReclassification();
}

void runNativeParagraphDefaultBridgeTest().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
