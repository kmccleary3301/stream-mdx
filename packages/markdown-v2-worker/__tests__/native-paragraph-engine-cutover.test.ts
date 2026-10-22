import assert from "node:assert/strict";
import {
  STREAM_MDX_SCHEMA_VERSION,
  type Block,
  type InlineNode,
  type WorkerIn,
  type WorkerOut,
} from "@stream-mdx/core";
import { createRendererStore, type RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { MarkdownEngine } from "../src/engine/engine";
import { SourceRangeInput } from "../src/engine/root-code-pipeline";

const rootParagraphPlugins = {
  footnotes: false,
  html: false,
  mdx: false,
  tables: true,
  callouts: false,
  math: true,
} as const;


function applyMessages(store: RendererStore, messages: readonly WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
    else if (message.type === "ERROR") assert.fail(`worker ${message.phase} failed: ${message.error.message}`);
  }
}

function findInline(nodes: readonly InlineNode[] | undefined, kind: string): InlineNode | undefined {
  for (const node of nodes ?? []) {
    if (node.kind === kind) return node;
    if ("children" in node) {
      const nested = findInline(node.children, kind);
      if (nested) return nested;
    }
  }
  return undefined;
}

function paragraphBlock(store: ReturnType<typeof createRendererStore>): Block {
  const block = store.getBlocks().find((candidate) => candidate.type === "paragraph");
  assert.ok(block, "the initialized source must be represented by a paragraph");
  return block;
}

async function runNamedReferenceAndFinalize(): Promise<void> {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
  const store = createRendererStore();
  const initialSource = "See **cold** [site][destination]";
  const init: WorkerIn = {
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: initialSource,
    prewarmLangs: [],
    docPlugins: rootParagraphPlugins,
  };
  await engine.handle(init);
  const initialized = messages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
  assert.ok(initialized, "INIT must publish a cold root snapshot");
  applyMessages(store, messages.splice(0));

  const initialParagraph = paragraphBlock(store);
  assert.equal(store.getParagraphColdBlock(initialParagraph.id)?.payload.raw, initialSource, "cold materialization must retain exact authored source");
  assert.equal(findInline(initialParagraph.payload.inline, "strong")?.kind, "strong", "cold prepared meaning must retain emphasis");
  assert.equal(store.getParagraphBlock(initialParagraph.id)?.source.generation, initialized.generation);

  messages.length = 0;
  const append: WorkerIn = { type: "APPEND", text: "\n\n[destination]: /guide\n" };
  await engine.handle(append);
  const appendMessages = messages.splice(0);
  assert.ok(
    appendMessages.some((message) => message.type === "PATCH" && message.patches.some((patch) => patch.op === "updateParagraphSpans")),
    "a new named definition must publish only the paragraph spans that depend on it",
  );
  applyMessages(store, appendMessages);
  const resolvedParagraph = paragraphBlock(store);
  assert.equal(store.getParagraphColdBlock(resolvedParagraph.id)?.payload.raw, initialSource, "a reference definition must not widen paragraph authored source");
  const resolvedLink = findInline(resolvedParagraph.payload.inline, "link");
  assert.ok(resolvedLink && resolvedLink.kind === "link");
  assert.equal(resolvedLink.href, "/guide", "targeted definition invalidation must update the prepared link meaning");


  messages.length = 0;
  await engine.handle({ type: "APPEND", text: '  "Guide title"' });
  const titleMessages = messages.splice(0);
  assert.ok(
    titleMessages.some((message) => message.type === "PATCH" && message.patches.some((patch) => patch.op === "updateParagraphSpans")),
    "a continued native reference title must publish updated dependent paragraph spans",
  );
  applyMessages(store, titleMessages);
  const titledParagraph = paragraphBlock(store);
  assert.equal(store.getParagraphColdBlock(titledParagraph.id)?.payload.raw, initialSource, "a continued reference title must not widen paragraph authored source");
  const titledLink = findInline(titledParagraph.payload.inline, "link");
  assert.ok(titledLink && titledLink.kind === "link");
  assert.equal(titledLink.href, "/guide");
  assert.equal(titledLink.title, "Guide title", "continued native title text must reach the existing prepared link");

  messages.length = 0;
  await engine.handle({ type: "FINALIZE" });
  const finalMessages = messages.splice(0);
  applyMessages(store, finalMessages);
  assert.equal(finalMessages.at(-1)?.type, "FINALIZED", "FINALIZE must finish after publishing its paragraph patch");
  assert.ok(paragraphBlock(store).isFinalized, "FINALIZE must settle the dirty paragraph tail");
  engine.dispose();
}
async function runFinalizedReferenceSemanticUpdates(): Promise<void> {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
  const store = createRendererStore();
  const initialSource = "See [site][destination]";
  await engine.handle({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: initialSource,
    prewarmLangs: [],
    docPlugins: rootParagraphPlugins,
  });
  applyMessages(store, messages.splice(0));
  messages.length = 0;
  await engine.handle({ type: "FINALIZE" });
  applyMessages(store, messages.splice(0));

  const finalizedBlock = paragraphBlock(store);
  const oldView = store.getParagraphBlock(finalizedBlock.id);
  assert.ok(oldView);
  const sourceSnapshot = oldView.sourceSnapshot;
  const generation = oldView.source.generation;
  assert.equal(oldView.source.state, "finalized");
  assert.equal(sourceSnapshot.materialize(), initialSource);

  await engine.handle({ type: "APPEND", text: '\n\n[destination]: /guide\n' });
  const definitionMessages = messages.splice(0);
  applyMessages(store, definitionMessages);
  const resolvedBlock = paragraphBlock(store);
  const resolvedView = store.getParagraphBlock(resolvedBlock.id);
  assert.ok(resolvedView);
  assert.equal(resolvedView.source.generation, generation, "a native definition after EOF must preserve finalized paragraph ownership");
  assert.strictEqual(resolvedView.sourceSnapshot, sourceSnapshot, "meaning-only invalidation must preserve the finalized source snapshot");
  assert.equal(resolvedView.source.state, "finalized");
  assert.equal(store.getParagraphColdBlock(resolvedBlock.id)?.payload.raw, initialSource);
  const resolvedLink = findInline(resolvedBlock.payload.inline, "link");
  assert.ok(resolvedLink && resolvedLink.kind === "link");
  assert.equal(resolvedLink.href, "/guide");

  await engine.handle({ type: "APPEND", text: '  "Guide title"' });
  const titleMessages = messages.splice(0);
  applyMessages(store, titleMessages);
  const titledBlock = paragraphBlock(store);
  const titledView = store.getParagraphBlock(titledBlock.id);
  assert.ok(titledView);
  assert.equal(titledView.source.generation, generation, "a continued native reference title must retain the finalized paragraph owner");
  assert.strictEqual(titledView.sourceSnapshot, sourceSnapshot);
  assert.equal(titledView.source.state, "finalized");
  const titledLink = findInline(titledBlock.payload.inline, "link");
  assert.ok(titledLink && titledLink.kind === "link");
  assert.equal(titledLink.href, "/guide");
  assert.equal(titledLink.title, "Guide title");
  assert.equal(oldView.source.generation, generation, "the pre-update view must remain immutable");
  assert.equal(findInline(oldView.spans.get(0)?.nodes, "link"), undefined, "the pre-update view must retain its unresolved meaning");
  assert.equal(oldView.sourceSnapshot.materialize(), initialSource);
  engine.dispose();
}

async function runFinalizedMultipleParagraphReferenceUpdatesAvoidRepreparation(): Promise<void> {
  let trackSourceWork = false;
  let sourceUnitsVisited = 0;
  const originalSourceRangeRead = SourceRangeInput.prototype.read;
  const originalSourceRangeChunk = SourceRangeInput.prototype.chunk;
  SourceRangeInput.prototype.read = function (this: SourceRangeInput, from: number, to: number): string {
    const result = originalSourceRangeRead.call(this, from, to);
    if (trackSourceWork) sourceUnitsVisited += result.length;
    return result;
  };
  SourceRangeInput.prototype.chunk = function (this: SourceRangeInput, from: number): string {
    const result = originalSourceRangeChunk.call(this, from);
    if (trackSourceWork) sourceUnitsVisited += result.length;
    return result;
  };

  const measureLateMeaningSourceWork = async (retainedWords: number): Promise<{
    readonly sourceUnitsVisited: number;
    readonly retainedParagraphLength: number;
  }> => {
    const retainedBody = retainedWords === 0 ? "" : ` ${"retained ".repeat(retainedWords)}`;
    const paragraphSources = [
      "First reference [site][destination]",
      `Second unrelated content${retainedBody}`,
    ];
    const initialSource = paragraphSources.join("\n\n");
    const messages: WorkerOut[] = [];
    const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
    const store = createRendererStore();

    try {
      await engine.handle({
        type: "INIT",
        schemaVersion: STREAM_MDX_SCHEMA_VERSION,
        initialContent: initialSource,
        prewarmLangs: [],
        docPlugins: rootParagraphPlugins,
      });
      applyMessages(store, messages.splice(0));
      await engine.handle({ type: "FINALIZE" });
      applyMessages(store, messages.splice(0));

      const initialBlocks = store.getBlocks().filter((block) => block.type === "paragraph");
      assert.equal(initialBlocks.length, paragraphSources.length);
      const oldViews = initialBlocks.map((block) => {
        const view = store.getParagraphBlock(block.id);
        assert.ok(view);
        return view;
      });
      const sourceSnapshots = oldViews.map((view) => view.sourceSnapshot);
      const generations = oldViews.map((view) => view.source.generation);
      for (let index = 0; index < oldViews.length; index += 1) {
        const view = oldViews[index]!;
        assert.equal(view.source.state, "finalized");
        assert.equal(view.sourceSnapshot.materialize(), paragraphSources[index]);
        assert.equal(findInline(view.spans.get(0)?.nodes, "link"), undefined);
      }

      sourceUnitsVisited = 0;
      trackSourceWork = true;
      await engine.handle({ type: "APPEND", text: "\n\n[destination]: /guide\n" });
      applyMessages(store, messages.splice(0));
      await engine.handle({ type: "APPEND", text: '  "Guide title"' });
      applyMessages(store, messages.splice(0));
      trackSourceWork = false;

      const updatedBlocks = store.getBlocks().filter((block) => block.type === "paragraph");
      assert.equal(updatedBlocks.length, paragraphSources.length);
      for (let index = 0; index < updatedBlocks.length; index += 1) {
        const block = updatedBlocks[index]!;
        const view = store.getParagraphBlock(block.id);
        assert.ok(view);
        assert.equal(store.getParagraphColdBlock(block.id)?.payload.raw, paragraphSources[index]);
        assert.equal(view.source.state, "finalized");
        assert.equal(view.source.generation, generations[index]);
        assert.strictEqual(view.sourceSnapshot, sourceSnapshots[index]);
        assert.equal(view.sourceSnapshot.materialize(), paragraphSources[index]);
        if (index === 0) {
          const link = findInline(block.payload.inline, "link");
          assert.ok(link && link.kind === "link");
          assert.equal(link.href, "/guide");
          assert.equal(link.title, "Guide title");
        } else {
          assert.equal(findInline(block.payload.inline, "link"), undefined);
        }

        const oldView = oldViews[index]!;
        assert.equal(oldView.source.generation, generations[index]);
        assert.equal(oldView.sourceSnapshot.materialize(), paragraphSources[index]);
        assert.equal(findInline(oldView.spans.get(0)?.nodes, "link"), undefined);
      }
      return {
        sourceUnitsVisited,
        retainedParagraphLength: paragraphSources[1]!.length,
      };
    } finally {
      trackSourceWork = false;
      engine.dispose();
    }
  };

  try {
    const shortSource = await measureLateMeaningSourceWork(0);
    const retainedSource = await measureLateMeaningSourceWork(8_192);
    assert.ok(retainedSource.retainedParagraphLength >= 64 * 1024);
    assert.ok(
      retainedSource.sourceUnitsVisited <= shortSource.sourceUnitsVisited + 8_192,
      `late meaning source work must not scale with the retained second paragraph (short=${shortSource.sourceUnitsVisited}, retained=${retainedSource.sourceUnitsVisited}, body=${retainedSource.retainedParagraphLength})`,
    );
  } finally {
    trackSourceWork = false;
    SourceRangeInput.prototype.read = originalSourceRangeRead;
    SourceRangeInput.prototype.chunk = originalSourceRangeChunk;
  }
}

async function runFinalizedParagraphBoundaryAndBodyExtension(): Promise<void> {
  const boundaryMessages: WorkerOut[] = [];
  const boundaryEngine = new MarkdownEngine({ post: (message) => boundaryMessages.push(message) });
  const boundaryStore = createRendererStore();
  const boundarySource = "See [site][destination]\n\n[destination]: /guide\n";
  await boundaryEngine.handle({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: boundarySource,
    prewarmLangs: [],
    docPlugins: rootParagraphPlugins,
  });
  applyMessages(boundaryStore, boundaryMessages.splice(0));
  boundaryMessages.length = 0;
  await boundaryEngine.handle({ type: "FINALIZE" });
  applyMessages(boundaryStore, boundaryMessages.splice(0));
  const boundaryParagraph = paragraphBlock(boundaryStore);
  const boundaryGeneration = boundaryStore.getParagraphBlock(boundaryParagraph.id)?.source.generation;
  await boundaryEngine.handle({ type: "APPEND", text: '  "Existing title"' });
  applyMessages(boundaryStore, boundaryMessages.splice(0));
  const updatedBoundaryParagraph = paragraphBlock(boundaryStore);
  const boundaryLink = findInline(updatedBoundaryParagraph.payload.inline, "link");
  assert.ok(boundaryLink && boundaryLink.kind === "link");
  assert.equal(boundaryLink.title, "Existing title");
  assert.equal(
    boundaryStore.getParagraphBlock(updatedBoundaryParagraph.id)?.source.generation,
    boundaryGeneration,
    "a paragraph with a following native definition is not the trailing reopen candidate",
  );
  boundaryEngine.dispose();

  const bodyMessages: WorkerOut[] = [];
  const bodyEngine = new MarkdownEngine({ post: (message) => bodyMessages.push(message) });
  const bodyStore = createRendererStore();
  const bodySource = "Body continued after finalization";
  await bodyEngine.handle({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "Body",
    prewarmLangs: [],
    docPlugins: rootParagraphPlugins,
  });
  applyMessages(bodyStore, bodyMessages.splice(0));
  bodyMessages.length = 0;
  await bodyEngine.handle({ type: "FINALIZE" });
  applyMessages(bodyStore, bodyMessages.splice(0));
  const oldBody = paragraphBlock(bodyStore);
  const oldBodyView = bodyStore.getParagraphBlock(oldBody.id);
  assert.ok(oldBodyView);
  await bodyEngine.handle({ type: "APPEND", text: bodySource.slice("Body".length) });
  applyMessages(bodyStore, bodyMessages.splice(0));
  const extendedBody = paragraphBlock(bodyStore);
  assert.equal(bodyStore.getParagraphColdBlock(extendedBody.id)?.payload.raw, bodySource);
  assert.deepEqual(extendedBody.payload.range, { from: 0, to: bodySource.length });
  assert.equal(oldBodyView.sourceSnapshot.materialize(), "Body", "a genuine source reopen must not mutate an old view");
  bodyEngine.dispose();
}


async function runSetextAndTableReplacement(): Promise<void> {
  const setextMessages: WorkerOut[] = [];
  const setextEngine = new MarkdownEngine({ post: (message) => setextMessages.push(message) });
  const setextStore = createRendererStore();
  const setextSource = "Prior line\nTitle\n---";
  await setextEngine.handle({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "Prior line\nTitle",
    prewarmLangs: [],
    docPlugins: rootParagraphPlugins,
  });
  applyMessages(setextStore, setextMessages.splice(0));
  const formerParagraph = paragraphBlock(setextStore);
  setextMessages.length = 0;
  await setextEngine.handle({ type: "APPEND", text: "\n---" });
  applyMessages(setextStore, setextMessages.splice(0));
  const heading = setextStore.getBlocks().find((block) => block.type === "heading");
  assert.ok(heading, "native Setext reclassification must replace the managed paragraph");
  assert.equal(heading.payload.range?.from, 0, "reclassification must resume at the original paragraph root, not the physical-line window");
  assert.equal(heading.payload.range?.to, setextSource.length, "the replacement must retain the completed authored prefix");
  assert.notEqual(heading.id, formerParagraph.id, "the old paragraph owner must be retired");
  setextMessages.length = 0;
  await setextEngine.handle({ type: "FINALIZE" });
  applyMessages(setextStore, setextMessages.splice(0));
  setextEngine.dispose();

  const tableMessages: WorkerOut[] = [];
  const tableEngine = new MarkdownEngine({ post: (message) => tableMessages.push(message) });
  const tableStore = createRendererStore();
  await tableEngine.handle({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "| head |\r\n",
    prewarmLangs: [],
    docPlugins: rootParagraphPlugins,
  });
  applyMessages(tableStore, tableMessages.splice(0));
  assert.ok(tableStore.getBlocks().some((block) => block.type === "paragraph"));
  tableMessages.length = 0;
  await tableEngine.handle({ type: "APPEND", text: "| --- |" });
  const transitionMessages = tableMessages.splice(0);
  applyMessages(tableStore, transitionMessages);
  await tableEngine.handle({ type: "FINALIZE" });
  const finalizeMessages = tableMessages.splice(0);
  applyMessages(tableStore, finalizeMessages);
  const table = tableStore.getBlocks().find((block) => block.type === "table");
  assert.ok(table, "a finalized native paragraph-to-table replacement must render");
  assert.deepEqual(table.payload.range, { from: 0, to: "| head |\r\n| --- |".length });
  const managedTable = tableStore.getTableBlock(table.id);
  assert.ok(managedTable, "the finalized replacement must retain native table metadata");
  assert.deepEqual(managedTable.source.sourceRange, { from: 0, to: "| head |\r\n| --- |".length });
  assert.equal(managedTable.source.state, "finalized");
  assert.equal(managedTable.header.cells[0]?.raw, "head");
  tableEngine.dispose();

  const streamingMessages: WorkerOut[] = [];
  const streamingEngine = new MarkdownEngine({ post: (message) => streamingMessages.push(message) });
  const streamingStore = createRendererStore();
  const streamingTableSource = "| head |\r\n| --- |\r\n| value |";
  await streamingEngine.handle({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "| head |\r\n",
    prewarmLangs: [],
    docPlugins: rootParagraphPlugins,
  });
  applyMessages(streamingStore, streamingMessages.splice(0));
  await streamingEngine.handle({ type: "APPEND", text: "| --- |\r\n| value |" });
  applyMessages(streamingStore, streamingMessages.splice(0));

  const visibleBlocks = streamingStore.getBlocks();
  assert.equal(visibleBlocks.length, 1, "a completed native table must be the sole visible cold block before EOF");
  const streamingTable = visibleBlocks[0];
  assert.ok(streamingTable?.type === "table", "the native table must replace its preceding paragraph before EOF");
  const streamingManagedTable = streamingStore.getTableBlock(streamingTable.id);
  assert.ok(streamingManagedTable, "the streamed table must retain managed native metadata");
  assert.equal(streamingManagedTable.source.state, "open");
  assert.deepEqual(streamingManagedTable.source.sourceRange, { from: 0, to: streamingTableSource.length });
  assert.equal(streamingManagedTable.header.cells[0]?.raw, "head");
  const streamedBodyCell = streamingStore.getTableRows(streamingTable.id, 0, 1)[0]?.cells[0];
  assert.ok(streamedBodyCell, "the streamed table must expose its body row");
  assert.equal(streamedBodyCell.raw, "value");
  assert.equal(streamingManagedTable.sourceSnapshot.materialize(), streamingTableSource);
  assert.equal(streamingTable.payload.raw, streamingManagedTable.sourceSnapshot.materialize());
  streamingEngine.dispose();
}

async function runResetGeneration(): Promise<void> {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
  const store = createRendererStore();
  const initialize = (initialContent: string): WorkerIn => ({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent,
    prewarmLangs: [],
    docPlugins: rootParagraphPlugins,
  });

  await engine.handle(initialize("generation one"));
  const first = messages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
  assert.ok(first);
  applyMessages(store, messages.splice(0));

  await engine.handle(initialize("generation two"));
  const secondMessages = messages.splice(0);
  const second = secondMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
  assert.ok(second);
  assert.ok(second.generation > first.generation, "reinitialization must advance the document generation");
  applyMessages(store, secondMessages);
  const current = paragraphBlock(store);
  assert.equal(store.getParagraphColdBlock(current.id)?.payload.raw, "generation two", "reset must retire the previous generation's source owner");
  assert.equal(store.getParagraphBlock(current.id)?.source.generation, second.generation, "the reused source-start ID must bind to the new generation");

  messages.length = 0;
  await engine.handle({ type: "FINALIZE" });
  const finalMessages = messages.splice(0);
  applyMessages(store, finalMessages);
  assert.equal(finalMessages.at(-1)?.type, "FINALIZED");
  engine.dispose();
}

async function runStreamingDefinitionTakesNextLineTitle(): Promise<void> {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
  const store = createRendererStore();
  await engine.handle({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "See [site][destination]\n\n[destination]: /guide\n",
    prewarmLangs: [],
    docPlugins: rootParagraphPlugins,
  });
  applyMessages(store, messages.splice(0));
  // CommonMark lets a title-less definition take its title from the following line.
  await engine.handle({ type: "APPEND", text: '  "Existing title"' });
  applyMessages(store, messages.splice(0));
  const paragraphs = store.getBlocks().filter((block) => block.type === "paragraph");
  assert.equal(paragraphs.length, 1, "the title line joins the definition instead of opening a paragraph");
  const link = findInline(paragraphs[0]?.payload.inline, "link");
  assert.ok(link && link.kind === "link");
  assert.equal(link.title, "Existing title");
  engine.dispose();
}


async function runNativeParagraphEngineCutoverTest(): Promise<void> {
  await runNamedReferenceAndFinalize();
  await runFinalizedReferenceSemanticUpdates();
  await runFinalizedMultipleParagraphReferenceUpdatesAvoidRepreparation();
  await runFinalizedParagraphBoundaryAndBodyExtension();
  await runStreamingDefinitionTakesNextLineTitle();
  await runSetextAndTableReplacement();
  await runResetGeneration();
}

void runNativeParagraphEngineCutoverTest().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
