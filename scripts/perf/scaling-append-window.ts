import assert from "node:assert";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { type ManagedParagraphViewState, type ManagedTableViewState, type ParagraphSpanRecord, type Patch, type TableHeaderRecord, type TableRowRecord, type WorkerIn, type WorkerOut, PATCH_ROOT_ID, STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
import type { RendererStore, RendererStoreOptions } from "@stream-mdx/react/renderer/store";
import type { MarkdownEngineOptions } from "../../packages/markdown-v2-worker/src/engine/types";
import { MarkdownEngine, createRendererStore, ComponentRegistry, MarkdownBlocksRenderer, SessionCounterSink } from "./diagnostic-dist/index.mjs";
import type { StageCounters, SessionCountersSnapshot } from "./counter-sink";
import { assertTableSuffixSemanticParity, type TableBoundaryEvidence } from "./table-scaling-evidence";
import type { ScalingWorkloadDef } from "./scaling-diagnostics";

export interface NativeListPrimaryParagraphOwnerWitness {
  listBlockId: string;
  listItemId: string;
  paragraphOwnerId: string;
  generation: number;
  state: ManagedParagraphViewState["source"]["state"];
  sourceRange: { from: number; to: number };
}

export interface NativeListOwnerSetupEvidence {
  sourceMode: "native-list-primary-paragraph";
  primaryOwnerCount: number;
  witnessOwners: NativeListPrimaryParagraphOwnerWitness[];
}

const DOM_GLOBALS = [
  "window",
  "document",
  "HTMLElement",
  "Node",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "navigator",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

type DomGlobalSnapshot = {
  [K in (typeof DOM_GLOBALS)[number]]?: PropertyDescriptor;
};

function captureDomGlobals(): DomGlobalSnapshot {
  const target = globalThis as unknown as Record<string, unknown>;
  const snapshot: DomGlobalSnapshot = {};
  for (const name of DOM_GLOBALS) {
    snapshot[name] = Object.getOwnPropertyDescriptor(target, name);
  }
  return snapshot;
}

function restoreDomGlobals(snapshot: DomGlobalSnapshot): void {
  const target = globalThis as unknown as Record<string, unknown>;
  for (const name of DOM_GLOBALS) {
    const descriptor = snapshot[name];
    if (descriptor) {
      Object.defineProperty(target, name, descriptor);
    } else {
      delete target[name];
    }
  }
}

// Session aggregates exclude table-only render callbacks, which are collected from stage snapshots.
type SessionWorkCounter = Extract<keyof StageCounters, keyof SessionCountersSnapshot>;

const BASE_SOURCE_WORK_COUNTERS: readonly SessionWorkCounter[] = [
  "lines_tokenized",
  "units_tokenized",
  "inline_source_units_prepared",
  "snapshot_nodes_built",
  "prefix_comparisons",
  "patches_emitted",
  "store_records_touched",
  "blocks_reprepared",
] as const;

export const CODE_SOURCE_WORK_COUNTERS: readonly SessionWorkCounter[] = [
  ...BASE_SOURCE_WORK_COUNTERS,
  "source_units_read",
  "source_units_materialized",
  "source_directory_entries_copied",
  "record_slots_allocated",
  "code_source_units_prepared",
] as const;

export const TABLE_SOURCE_WORK_COUNTERS: readonly SessionWorkCounter[] = [
  ...BASE_SOURCE_WORK_COUNTERS,
  "source_units_read",
  "source_units_materialized",
  "source_directory_entries_copied",
  "record_slots_allocated",
] as const;

export const NATIVE_LIST_SOURCE_WORK_COUNTERS: readonly SessionWorkCounter[] = [
  ...BASE_SOURCE_WORK_COUNTERS,
  "source_units_read",
  "source_units_materialized",
  "source_directory_entries_copied",
  "record_slots_allocated",
] as const;

export const PARAGRAPH_SOURCE_WORK_COUNTERS: readonly SessionWorkCounter[] = [
  ...BASE_SOURCE_WORK_COUNTERS,
  "source_units_read",
  "source_units_materialized",
  "source_directory_entries_copied",
  "record_slots_allocated",
] as const;

const SCALING_INIT: WorkerIn = { type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
prewarmLangs: ["typescript", "javascript", "markdown"],
docPlugins: {
  footnotes: true,
  html: true,
  mdx: false,
  tables: true,
  callouts: false,
  math: true,
  formatAnticipation: { inline: true, mathInline: true, mathBlock: true, html: true, mdx: false, regex: false },
  codeHighlighting: "incremental",
  outputMode: "both",
  emitHighlightTokens: true,
  emitDiffBlocks: false,
  themes: { dark: "github-dark", light: "github-light" },
},
mdx: { compileMode: "server" }, };

async function coldFinalizedTableState(source: string, sourceRangeFrom: number): Promise<ManagedTableViewState | undefined> {
  const store = createRendererStore();
  const engine = new MarkdownEngine({
    post: (msg: WorkerOut) => {
      if (msg.type === "INITIALIZED") {
        store.resetSnapshot(msg.snapshot);
      } else if (msg.type === "PATCH") {
        store.applyPatches(msg.patches);
      }
    },
  });
  try {
    await engine.handle(SCALING_INIT);
    if (source.length > 0) await engine.handle({ type: "APPEND", text: source });
    await engine.handle({ type: "FINALIZE" });
    const tableBlock = store.getBlocks().find(
      (block) => block.type === "table" && block.payload.range?.from === sourceRangeFrom,
    );
    return tableBlock ? store.getTableBlock(tableBlock.id) : undefined;
  } finally {
    engine.dispose();
  }
}

type InputSourceAppendPatch = Extract<Patch, { op: "appendInputSource" }>;

interface TablePatchCapture {
  rowSlots: number;
  sourceUnits: number;
  sourceParts: string[];
  rows: Map<number, TableRowRecord>;
  header?: TableHeaderRecord;
}

interface ParagraphPatchCapture {
  spanRecords: number;
  sourceUnits: number;
  sourceParts: string[];
  spans: Map<number, ParagraphSpanRecord>;
}

interface NativeListPrimaryOwner {
  listItemId: string;
  paragraphOwnerId: string;
  state: ManagedParagraphViewState;
}

interface NativeListOwnerInspection {
  taggedPrimaryParagraphCount: number;
  owners: NativeListPrimaryOwner[];
}

function inspectNativeListPrimaryOwners(store: RendererStore, listBlockId: string): NativeListOwnerInspection {
  const owners: NativeListPrimaryOwner[] = [];
  let taggedPrimaryParagraphCount = 0;
  for (const listItemId of store.getChildren(listBlockId)) {
    const item = store.getNode(listItemId);
    if (item?.type !== "list-item") continue;
    for (const childId of store.getChildren(listItemId)) {
      const child = store.getNode(childId);
      if (child?.type !== "paragraph" || child.props.listItemPrimary !== true) continue;
      taggedPrimaryParagraphCount += 1;
      const state = store.getParagraphBlock(childId);
      if (state) owners.push({ listItemId, paragraphOwnerId: childId, state });
    }
  }
  return { taggedPrimaryParagraphCount, owners };
}

function mountedNativeList(root: HTMLElement): HTMLElement {
  const lists = root.querySelectorAll<HTMLElement>(".markdown-list[data-list-depth='0']");
  assert.equal(lists.length, 1, "native list workload mounts one top-level Markdown list element");
  const list = lists[0];
  assert.ok(list, "native list workload exposes its mounted top-level list element");
  assert.equal(list.tagName, "UL", "native list fixtures render unordered Markdown list markup");
  return list;
}

function mountedNativeListItems(list: HTMLElement): HTMLElement[] {
  return Array.from(
    list.querySelectorAll<HTMLLIElement>(":scope > li.markdown-list-item[data-list-depth='0']"),
  );
}

function normalizeListText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function captureNativeListOwnerSetupEvidence(
  listBlockId: string,
  inspection: NativeListOwnerInspection,
): NativeListOwnerSetupEvidence {
  const first = inspection.owners[0];
  const last = inspection.owners[inspection.owners.length - 1];
  assert.ok(first, "native list setup must expose at least one managed primary-paragraph owner");
  const witnessOwners = [first];
  if (last && last.paragraphOwnerId !== first.paragraphOwnerId) witnessOwners.push(last);
  return {
    sourceMode: "native-list-primary-paragraph",
    primaryOwnerCount: inspection.owners.length,
    witnessOwners: witnessOwners.map(({ listItemId, paragraphOwnerId, state }) => ({
      listBlockId,
      listItemId,
      paragraphOwnerId,
      generation: state.source.generation,
      state: state.source.state,
      sourceRange: { from: state.source.sourceRange.from, to: state.source.sourceRange.to },
    })),
  };
}

export async function measureAppendWindowWork(
  workload: ScalingWorkloadDef,
  prefix: string,
  mode: "code-source" | "paragraph-source" | "table-rows" | "native-list-source",
): Promise<{
  observedWork: number;
  sinkSnapshot: SessionCountersSnapshot;
  establishedBlockType: string;
  ownerEvidence?: NativeListOwnerSetupEvidence;
  tableBoundary?: TableBoundaryEvidence;
}> {
  const codeSourceFrom = workload.codeSourceFrom ?? 0;
  const includeCodeSourceWork = mode === "code-source";
  const includeNativeListSourceWork = mode === "native-list-source";
  const includeListPrimaryParagraphWork =
    includeNativeListSourceWork && workload.name === "list-primary-paragraph";
  const includeParagraphSourceWork = mode === "paragraph-source" || includeListPrimaryParagraphWork;
  const includeTableBoundary = mode === "table-rows";
  const snapshot = captureDomGlobals();
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });

  const target = globalThis as unknown as Record<string, unknown>;
  target.window = dom.window;
  target.document = dom.window.document;
  target.HTMLElement = dom.window.HTMLElement;
  target.Node = dom.window.Node;
  target.IS_REACT_ACT_ENVIRONMENT = true;
  target.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  target.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: dom.window.navigator,
  });

  const rootContainer = dom.window.document.getElementById("root");
  assert.ok(rootContainer, "JSDOM root container must exist");
  const root = createRoot(rootContainer);
  const registry = new ComponentRegistry();

  const sessionSink = new SessionCounterSink();
  let codeGeneration: number | undefined;
  let paragraphBlockId: string | undefined;
  let initialParagraphState: ManagedParagraphViewState | undefined;
  let firstCompletedParagraphSpan: ParagraphSpanRecord | undefined;
  let lastCompletedParagraphSpan: ParagraphSpanRecord | undefined;
  let listBlockId: string | undefined;
  let nativeListOwnerInspection: NativeListOwnerInspection | undefined;
  let nativeListOwnerEvidence: NativeListOwnerSetupEvidence | undefined;
  let observedNativeListOwnerIds: Set<string> | undefined;
  let tableBlockId: string | undefined;
  let observingInputSourceWindow = false;
  let observingParagraphAppendWindow = false;
  let observingTableAppendWindow = false;
  const inputSourceAppendPatches: InputSourceAppendPatch[] = [];
  const paragraphPatchCapture: ParagraphPatchCapture = {
    spanRecords: 0,
    sourceUnits: 0,
    sourceParts: [],
    spans: new Map(),
  };
  const tablePatchCapture: TablePatchCapture = {
    rowSlots: 0,
    sourceUnits: 0,
    sourceParts: [],
    rows: new Map(),
  };
  const store = createRendererStore(undefined, {
    campaignCounters: sessionSink,
  } as RendererStoreOptions & { campaignCounters?: SessionCounterSink });

  let dumpedCodeRaw: string | undefined;
  const engine = new MarkdownEngine({
    post: (msg: WorkerOut) => {
      if (msg.type === "INITIALIZED") {
        store.resetSnapshot(msg.snapshot);
      } else if (msg.type === "PATCH") {
        if (observingInputSourceWindow) {
          for (const patch of msg.patches) {
            if (patch.op === "appendInputSource") inputSourceAppendPatches.push(patch);
          }
        }
        if (observingParagraphAppendWindow) {
          for (const patch of msg.patches) {
            if (
              patch.op === "appendParagraph" &&
              (patch.paragraphOwnerId === paragraphBlockId || patch.at.blockId === paragraphBlockId)
            ) {
              paragraphPatchCapture.spanRecords += patch.spans.length;
              paragraphPatchCapture.sourceUnits += patch.sourceAppend.length;
              paragraphPatchCapture.sourceParts.push(patch.sourceAppend);
              for (const span of patch.spans) paragraphPatchCapture.spans.set(span.index, span);
            } else if (
              patch.op === "updateParagraphSpans" &&
              (patch.paragraphOwnerId === paragraphBlockId || patch.at.blockId === paragraphBlockId)
            ) {
              paragraphPatchCapture.spanRecords += patch.updates.length;
              for (const update of patch.updates) paragraphPatchCapture.spans.set(update.index, update.span);
            }
          }
        }
        if (observingTableAppendWindow) {
          for (const patch of msg.patches) {
            if (
              patch.op === "appendTableRows" &&
              (patch.at.blockId === tableBlockId || patch.table.tableOwnerId === tableBlockId)
            ) {
              tablePatchCapture.rowSlots += patch.rows.length;
              tablePatchCapture.sourceUnits += patch.sourceAppend.length;
              tablePatchCapture.sourceParts.push(patch.sourceAppend);
              for (const row of patch.rows) tablePatchCapture.rows.set(row.index, row);
            } else if (
              patch.op === "updateTableRows" &&
              (patch.tableOwnerId === tableBlockId || patch.at.blockId === tableBlockId)
            ) {
              tablePatchCapture.rowSlots += patch.updates.length;
              for (const update of patch.updates) tablePatchCapture.rows.set(update.index, update.row);
              if (patch.header) tablePatchCapture.header = patch.header;
            }
          }
        }
        store.applyPatches(msg.patches);
      } else if (msg.type === "DUMP_BLOCKS") {
        dumpedCodeRaw = msg.blocks.find((block) => block.type === "code")?.payload.raw;
      }
    },
    campaignCounters: sessionSink,
  } as MarkdownEngineOptions & { campaignCounters?: SessionCounterSink });

  try {
    await engine.handle(SCALING_INIT);
    if (prefix.length > 0) {
      await engine.handle({ type: "APPEND", text: prefix });
    }

    // Inspect actual resulting block type before resetting counters.
    const setupBlocks = store.getBlocks();
    const matchingBlock = setupBlocks.find((block) => block.type === workload.expectedBlockType);
    const establishedBlockType = matchingBlock ? matchingBlock.type : (setupBlocks[0]?.type ?? "none");
    const codeBlock = includeCodeSourceWork ? setupBlocks.find((block) => block.type === "code") : undefined;
    const paragraphBlock = includeParagraphSourceWork && !includeListPrimaryParagraphWork
      ? setupBlocks.find((block) => block.type === "paragraph")
      : undefined;
    const listBlock = includeNativeListSourceWork ? setupBlocks.find((block) => block.type === "list") : undefined;
    let initialTableState: ManagedTableViewState | undefined;
    let initialTableRange: { from: number; to: number } | undefined;
    let initialCompleteRows = 0;
    let firstCompletedRow: TableRowRecord | undefined;
    let lastCompletedRow: TableRowRecord | undefined;
    if (includeCodeSourceWork) {
      assert.ok(codeBlock, "code-family workload must establish its managed root code block");
      const codeView = store.getCodeBlock(codeBlock.id);
      assert.ok(codeView, "code-family workload must expose its prepared code view");
      assert.equal(
        codeView.source.sourceRange.from,
        codeSourceFrom,
        "managed code source range starts at the test-owned authored code offset",
      );
      assert.equal(codeView.source.state, "open", "code-family append window starts open");
      codeGeneration = codeView.source.generation;
    }

    if (includeNativeListSourceWork) {
      assert.ok(listBlock, "native list workload must establish a list-family block");
      const listNode = store.getNode(listBlock.id);
      assert.ok(listNode && listNode.type === "list", "native list setup must identify the actual list-family owner");
      listBlockId = listBlock.id;
      nativeListOwnerInspection = inspectNativeListPrimaryOwners(store, listBlockId);
      assert.ok(
        nativeListOwnerInspection.taggedPrimaryParagraphCount > 0,
        "native list setup must expose at least one listItemPrimary paragraph",
      );
      assert.equal(
        nativeListOwnerInspection.owners.length,
        nativeListOwnerInspection.taggedPrimaryParagraphCount,
        "every listItemPrimary paragraph must have its actual managed paragraph source owner",
      );
      const expectedPrimaryOwnerCount = prefix.match(/^- /gm)?.length ?? 0;
      assert.equal(
        nativeListOwnerInspection.owners.length,
        expectedPrimaryOwnerCount,
        "native list fixture admits each authored primary paragraph through a managed owner",
      );
      if (includeListPrimaryParagraphWork) {
        assert.equal(nativeListOwnerInspection.owners.length, 1, "growing list-primary fixture has exactly one primary owner");
      }
      nativeListOwnerEvidence = captureNativeListOwnerSetupEvidence(listBlockId, nativeListOwnerInspection);
      const setupOwnerIds = new Set(
        nativeListOwnerInspection.owners.map((owner) => owner.paragraphOwnerId),
      );
      assert.equal(
        setupOwnerIds.size,
        nativeListOwnerInspection.owners.length,
        "native-list setup captures each actual primary owner identity exactly once",
      );
      observedNativeListOwnerIds = setupOwnerIds;
    }

    if (includeParagraphSourceWork) {
      if (includeListPrimaryParagraphWork) {
        const primaryOwner = nativeListOwnerInspection?.owners[0];
        assert.ok(primaryOwner, "list-primary paragraph workload must expose its managed owner");
        paragraphBlockId = primaryOwner.paragraphOwnerId;
        initialParagraphState = primaryOwner.state;
      } else {
        assert.ok(paragraphBlock, "paragraph-family workload must establish its managed root paragraph");
        paragraphBlockId = paragraphBlock.id;
        initialParagraphState = store.getParagraphBlock(paragraphBlockId);
      }
      assert.ok(initialParagraphState, "paragraph-family workload must expose its managed span/source state");
      assert.equal(initialParagraphState.source.state, "open", "paragraph append window starts with an open owner");
      if (includeListPrimaryParagraphWork) {
        assert.ok(initialParagraphState.source.sourceRange.from > 0, "list-primary owner range begins after its container marker");
        assert.equal(
          initialParagraphState.source.paragraphOwnerId,
          paragraphBlockId,
          "listItemPrimary node id matches its managed paragraph source owner",
        );
      } else {
        assert.equal(initialParagraphState.source.sourceRange.from, 0, "the workload is a root paragraph from offset zero");
      }
      assert.equal(initialParagraphState.source.processedTo, prefix.length, "the paragraph owner admits the complete setup prefix");
      assert.equal(
        initialParagraphState.sourceSnapshot.length,
        initialParagraphState.source.sourceRange.to - initialParagraphState.source.sourceRange.from,
        "managed paragraph source snapshot matches its owned source range",
      );
      assert.equal(initialParagraphState.spans.length, initialParagraphState.source.spanCount, "managed paragraph span index matches metadata");
      assert.equal(
        initialParagraphState.spans.completeSpanCount,
        initialParagraphState.source.completeSpanCount,
        "managed paragraph completed-span frontier matches metadata",
      );
      if (initialParagraphState.source.completeSpanCount > 0) {
        firstCompletedParagraphSpan = initialParagraphState.spans.get(0);
        lastCompletedParagraphSpan = initialParagraphState.spans.get(initialParagraphState.source.completeSpanCount - 1);
        assert.ok(firstCompletedParagraphSpan, "paragraph setup must expose its first completed span");
        assert.ok(lastCompletedParagraphSpan, "paragraph setup must expose its last completed span");
      }
    }


    if (includeTableBoundary) {
      const tableBlock = setupBlocks.find((block) => block.type === "table");
      assert.ok(tableBlock, "table-family workload must establish an admitted native table block");
      tableBlockId = tableBlock.id;
      initialTableState = store.getTableBlock(tableBlockId);
      assert.ok(initialTableState, "native table admission must expose the managed table row owner");
      assert.equal(initialTableState.source.state, "open", "table append window starts with an open owner");
      assert.equal(initialTableState.source.sourceRange.from, 0, "the workload is a root table from offset zero");
      assert.equal(initialTableState.source.processedTo, prefix.length, "the table owner admits the complete setup prefix");
      assert.equal(initialTableState.rows.length, initialTableState.source.rowCount, "managed table row index matches metadata");
      assert.equal(initialTableState.rows.completeRowCount, initialTableState.rows.length, "setup prefix has only completed rows");
      assert.ok(initialTableState.rows.completeRowCount > 0, "table setup must provide completed-row identity witnesses");
      initialTableRange = {
        from: initialTableState.source.sourceRange.from,
        to: initialTableState.source.sourceRange.to,
      };
      initialCompleteRows = initialTableState.source.completeRowCount;
      firstCompletedRow = initialTableState.rows.get(0);
      lastCompletedRow = initialTableState.rows.get(initialCompleteRows - 1);
      assert.ok(firstCompletedRow, "table setup must expose its first completed row");
      assert.ok(lastCompletedRow, "table setup must expose its last completed row");
      assert.equal(initialTableState.header.cells.length, 3, "table workload retains its original three-column fixture");
      const setupSourceSnapshot = sessionSink.readSourceSnapshot();
      assert.equal(setupSourceSnapshot.length, prefix.length, "actual engine source retains the exact setup prefix");
      assert.equal(setupSourceSnapshot.read(0, prefix.length), prefix, "actual engine source preserves authored setup bytes");
    }

    await act(async () => {
      root.render(
        createElement(MarkdownBlocksRenderer, {
          blocks: setupBlocks,
          componentRegistry: registry,
          store,
        }),
      );
      await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    });

    if (includeNativeListSourceWork && nativeListOwnerInspection) {
      const listElement = mountedNativeList(rootContainer);
      const listItems = mountedNativeListItems(listElement);
      assert.equal(
        listItems.length,
        nativeListOwnerInspection.owners.length,
        "mounted native list item count matches the managed primary-owner count before measurement",
      );
      const firstListItem = listItems[0];
      const lastListItem = listItems[listItems.length - 1];
      assert.ok(firstListItem, "mounted native list exposes its first semantic item");
      assert.ok(lastListItem, "mounted native list exposes its last semantic item");
      if (includeListPrimaryParagraphWork) {
        const listText = normalizeListText(firstListItem.textContent ?? "");
        assert.ok(listText.includes("list primary prefix 00 content."), "mounted primary item renders its authored first line");
        assert.ok(
          listText.includes(`list primary prefix ${String(listItems.length - 1).padStart(2, "0")} content.`),
          "mounted primary item renders its authored last setup line",
        );
      } else {
        assert.ok(
          normalizeListText(firstListItem.textContent ?? "").includes("list item prefix 00 content."),
          "mounted first list item renders its authored setup text",
        );
        assert.ok(
          normalizeListText(lastListItem.textContent ?? "").includes(
            `list item prefix ${String(listItems.length - 1).padStart(2, "0")} content.`,
          ),
          "mounted last list item renders its authored setup text",
        );
      }
    }

    if (includeTableBoundary && tableBlockId) {
      const mountedTable = rootContainer.querySelector<HTMLTableElement>(
        `table[data-table-block="true"][data-block-id="${tableBlockId}"]`,
      );
      assert.ok(mountedTable, "actual native Markdown table view must be mounted before measurement");
    }

    // Reset diagnostic counts AFTER baseline source setup and native mounting.
    sessionSink.reset();

    let expectedCodeSource = prefix.slice(codeSourceFrom);
    let expectedParagraphSuffix = "";
    let expectedListSuffix = "";
    let expectedTableSuffix = "";
    let expectedInputSuffix = "";
    const appendSourceGeneration = codeGeneration ??
      initialParagraphState?.source.generation ??
      initialTableState?.source.generation ??
      nativeListOwnerInspection?.owners[0]?.state.source.generation;
    assert.ok(appendSourceGeneration !== undefined, "append window has an actual managed source generation");
    let observedInputSourcePatchIndex = 0;
    let inputSourceFrontier = prefix.length;
    let nativeDomRows = 0;
    let nativeDomCells = 0;
    observingInputSourceWindow = true;
    observingParagraphAppendWindow = includeParagraphSourceWork;
    observingTableAppendWindow = includeTableBoundary;
    try {
      for (let appendIndex = 0; appendIndex < workload.appendChunks.length; appendIndex += 1) {
        const chunk = workload.appendChunks[appendIndex]!;
        await act(async () => {
          await engine.handle({ type: "APPEND", text: chunk });
          // Observe the real store rAF notification and native subscribers, not a forced duplicate view.
          await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
        });

        const inputParts: string[] = [];
        while (observedInputSourcePatchIndex < inputSourceAppendPatches.length) {
          const patch = inputSourceAppendPatches[observedInputSourcePatchIndex++]!;
          assert.equal(patch.at.blockId, PATCH_ROOT_ID, "canonical appendInputSource targets the document root");
          assert.equal(patch.at.nodeId, undefined, "canonical appendInputSource has no node target");
          assert.equal(patch.at.indexPath, undefined, "canonical appendInputSource has no child index path");
          assert.equal(patch.meta?.kind, "semantic", "canonical appendInputSource is a semantic barrier");
          assert.equal(patch.generation, appendSourceGeneration, "input-source barrier retains the managed generation");
          assert.equal(patch.from, inputSourceFrontier, "input-source barrier starts at the exact current source frontier");
          inputSourceFrontier += patch.text.length;
          inputParts.push(patch.text);
        }
        assert.equal(inputParts.join(""), chunk, "input-source barriers preserve the exact authored append bytes");
        expectedInputSuffix += chunk;
        assert.equal(
          inputSourceFrontier,
          prefix.length + expectedInputSuffix.length,
          "input-source barrier frontier matches every accepted append byte",
        );
        if (includeCodeSourceWork && codeBlock) {
          expectedCodeSource += chunk;
          const afterAppend = store.getCodeBlock(codeBlock.id);
          assert.ok(afterAppend, "managed root code view remains available during the append window");
          assert.equal(
            afterAppend.source.sourceRange.from,
            codeSourceFrom,
            "managed code source range retains its test-owned authored origin",
          );
          assert.equal(afterAppend.source.state, "open", "measured append window contains no close/finalize");
          assert.equal(afterAppend.source.generation, codeGeneration, "managed code generation stays fixed");
        }
        if (includeNativeListSourceWork && listBlockId && nativeListOwnerInspection) {
          const observedOwnerIds = observedNativeListOwnerIds;
          assert.ok(observedOwnerIds, "native-list append window retains its captured setup owner identities");
          expectedListSuffix += chunk;
          const currentOwners = inspectNativeListPrimaryOwners(store, listBlockId);
          assert.equal(
            currentOwners.owners.length,
            currentOwners.taggedPrimaryParagraphCount,
            "every current listItemPrimary paragraph retains its managed source owner",
          );
          if (includeListPrimaryParagraphWork) {
            assert.equal(
              currentOwners.owners.length,
              nativeListOwnerInspection.owners.length,
              "growing list-primary paragraph retains its single native owner",
            );
            assert.ok(
              currentOwners.owners.some((owner) => owner.paragraphOwnerId === paragraphBlockId),
              "growing list-primary paragraph retains its setup owner identity",
            );
          } else {
            assert.equal(
              currentOwners.owners.length,
              nativeListOwnerInspection.owners.length + appendIndex + 1,
              "each list-item append admits one additional native primary owner",
            );
            const addedOwners = currentOwners.owners.filter(
              (owner) => !observedOwnerIds.has(owner.paragraphOwnerId),
            );
            assert.equal(addedOwners.length, 1, "each appended list item exposes exactly one newly managed primary owner");
            for (const owner of addedOwners) {
              assert.equal(owner.state.source.state, "open", "new list-item paragraph owner remains open");
              assert.equal(
                owner.state.sourceSnapshot.length,
                owner.state.source.sourceRange.to - owner.state.source.sourceRange.from,
                "new list-item owner source snapshot matches its authored range",
              );
              assert.ok(
                owner.state.source.sourceRange.to <= prefix.length + expectedListSuffix.length,
                "new list-item owner remains within the admitted source prefix",
              );
              observedOwnerIds.add(owner.paragraphOwnerId);
            }
          }
          const listElement = mountedNativeList(rootContainer);
          const renderedListItems = mountedNativeListItems(listElement);
          assert.equal(
            renderedListItems.length,
            currentOwners.owners.length,
            "mounted native list item count tracks current managed primary owners",
          );
          if (includeListPrimaryParagraphWork) {
            const primaryItem = renderedListItems[0];
            assert.ok(primaryItem, "mounted growing primary paragraph retains its list item");
            const renderedText = normalizeListText(primaryItem.textContent ?? "");
            assert.ok(
              renderedText.includes("list primary prefix 00 content."),
              "mounted growing primary item retains its authored setup meaning",
            );
            assert.ok(
              renderedText.includes(normalizeListText(chunk)),
              "mounted growing primary item renders the current authored append text",
            );
          } else {
            const appendedItem = renderedListItems[renderedListItems.length - 1];
            assert.ok(appendedItem, "mounted native list exposes the newly appended item");
            assert.equal(
              normalizeListText(appendedItem.textContent ?? ""),
              normalizeListText(chunk.replace(/^\s*-\s*/, "")),
              "mounted new list item text matches its authored append content",
            );
          }
        }

        if (includeParagraphSourceWork && paragraphBlockId && initialParagraphState) {
          expectedParagraphSuffix += chunk;
          const currentParagraph = store.getParagraphBlock(paragraphBlockId);
          assert.ok(currentParagraph, "managed paragraph remains available during the append window");
          assert.equal(currentParagraph.source.state, "open", "measured paragraph append window contains no close/finalize");
          assert.equal(
            currentParagraph.source.generation,
            initialParagraphState.source.generation,
            "managed paragraph generation stays fixed",
          );
          assert.equal(
            currentParagraph.source.sourceRange.from,
            initialParagraphState.source.sourceRange.from,
            "managed paragraph source origin stays fixed",
          );
          assert.ok(
            currentParagraph.source.sourceRange.to >= initialParagraphState.source.sourceRange.to,
            "paragraph owner does not retreat behind its initialized source frontier",
          );
          assert.equal(
            currentParagraph.source.processedTo,
            initialParagraphState.source.processedTo + expectedParagraphSuffix.length,
            "paragraph parser frontier advances over every accepted append byte",
          );
          for (const [index, patchedSpan] of paragraphPatchCapture.spans) {
            assert.ok(index >= 0 && index < currentParagraph.spans.length, "semantic paragraph span patch stays within the actual affected record range");
            assert.deepEqual(
              currentParagraph.spans.get(index),
              patchedSpan,
              `managed paragraph state contains the exact semantic record published for span ${index}`,
            );
          }
          assert.equal(
            currentParagraph.spans.length,
            currentParagraph.source.spanCount,
            "paragraph append publishes a span index matching current metadata",
          );
          assert.equal(
            currentParagraph.spans.completeSpanCount,
            currentParagraph.source.completeSpanCount,
            "paragraph append publishes the current completed-span frontier",
          );
          if (firstCompletedParagraphSpan) {
            assert.strictEqual(
              currentParagraph.spans.get(firstCompletedParagraphSpan.index),
              firstCompletedParagraphSpan,
              "paragraph append retains the first completed span record",
            );
          }
          if (lastCompletedParagraphSpan) {
            assert.strictEqual(
              currentParagraph.spans.get(lastCompletedParagraphSpan.index),
              lastCompletedParagraphSpan,
              "paragraph append retains the last pre-window completed span record",
            );
          }
          assert.equal(
            paragraphPatchCapture.sourceUnits,
            currentParagraph.source.sourceRange.to - initialParagraphState.source.sourceRange.to,
            "paragraph patch source units match the advancing owned source range",
          );
        }
        if (includeTableBoundary && tableBlockId && initialTableState && firstCompletedRow && lastCompletedRow) {
          expectedTableSuffix += chunk;
          const currentTable = store.getTableBlock(tableBlockId);
          assert.ok(currentTable, "managed native table remains available during the append window");
          assert.equal(currentTable.source.state, "open", "measured table append window contains no finalize");
          assert.equal(currentTable.source.generation, initialTableState.source.generation, "table generation stays fixed");
          assert.equal(currentTable.source.processedTo, prefix.length + expectedTableSuffix.length, "table owner advances over accepted append bytes");
          assert.equal(currentTable.rows.completeRowCount, initialCompleteRows + appendIndex + 1, "each authored suffix chunk settles one row");
          assert.equal(currentTable.rows.length, currentTable.rows.completeRowCount, "bounded append leaves no provisional row");
          assert.strictEqual(currentTable.rows.get(firstCompletedRow.index), firstCompletedRow, "first completed row identity is retained");
          assert.strictEqual(currentTable.rows.get(lastCompletedRow.index), lastCompletedRow, "last pre-window completed row identity is retained");
          for (const [index, patchedRow] of tablePatchCapture.rows) {
            assert.ok(index >= 0 && index < currentTable.rows.length, "semantic table row patch stays within the current row index");
            assert.deepEqual(
              currentTable.rows.get(index),
              patchedRow,
              `managed table state contains the exact semantic record published for row ${index}`,
            );
          }
          if (tablePatchCapture.header) {
            assert.deepEqual(currentTable.header, tablePatchCapture.header, "managed table state contains the exact published semantic header");
          }
          const appendedRow = currentTable.rows.get(initialCompleteRows + appendIndex);
          assert.ok(appendedRow, "each semantic table append exposes its new completed row");
          assert.ok(tablePatchCapture.rows.has(appendedRow.index), "actual semantic table patch carries each appended row");
          assert.equal(appendedRow.isProvisional, false, "newline-terminated table append is a completed row");
          assert.equal(appendedRow.cells.length, 3, "native row projection retains three cells");

          const currentTableElement = rootContainer.querySelector<HTMLTableElement>(
            `table[data-table-block="true"][data-block-id="${tableBlockId}"]`,
          );
          assert.ok(currentTableElement, "current native table DOM remains mounted");
          const domRow = currentTableElement.querySelector<HTMLTableRowElement>(
            `tbody tr[data-row-index="${appendedRow.index}"]`,
          );
          assert.ok(domRow, "current native table DOM contains the appended row");
          assert.equal(domRow.cells.length, 3, "current native table DOM exposes all appended cells");
          const expectedCells = [`app_a_${appendIndex}`, `app_b_${appendIndex}`, `app_c_${appendIndex}`];
          for (let cellIndex = 0; cellIndex < expectedCells.length; cellIndex += 1) {
            const domCell = domRow.cells[cellIndex];
            assert.ok(domCell, `native table DOM cell ${cellIndex} exists`);
            assert.equal(domCell.tagName, "TD", "native body cell retains table-cell markup");
            assert.equal(domCell.textContent, expectedCells[cellIndex], "native DOM cell matches authored suffix value");
          }
          nativeDomRows += 1;
          nativeDomCells += domRow.cells.length;
        }
      }
    } finally {
      observingInputSourceWindow = false;
      observingParagraphAppendWindow = false;
      observingTableAppendWindow = false;
    }

    const sinkSnapshot = sessionSink.snapshot();
    const fullInputSource = prefix + expectedInputSuffix;
    assert.equal(inputSourceFrontier, fullInputSource.length, "input-source barrier frontier reaches the exact canonical source length");
    const canonicalInputSource = sessionSink.readSourceSnapshot();
    assert.equal(canonicalInputSource.length, fullInputSource.length, "actual engine source retains the complete canonical input");
    assert.equal(
      canonicalInputSource.read(0, fullInputSource.length),
      fullInputSource,
      "actual engine source preserves the exact canonical setup and append bytes",
    );
    let tableBoundary: TableBoundaryEvidence | undefined;
    if (includeTableBoundary && tableBlockId && initialTableState && initialTableRange && firstCompletedRow && lastCompletedRow) {
      const fullSource = prefix + expectedTableSuffix;
      const finalTableState = store.getTableBlock(tableBlockId);
      assert.ok(finalTableState, "managed table remains available after the append window");
      assert.equal(finalTableState.source.state, "open", "table append proof performs no FINALIZE");
      assert.equal(finalTableState.source.generation, initialTableState.source.generation, "table owner generation is unchanged");
      assert.equal(finalTableState.source.processedTo, fullSource.length, "table owner processed the entire authored suffix");
      assert.equal(sinkSnapshot.invalidations.length, 0, "table append window contains no backward invalidation");
      assert.equal(nativeDomRows, workload.appendChunks.length, "every appended row is present in the mounted native DOM");
      assert.equal(nativeDomCells, workload.appendChunks.length * 3, "every appended native DOM row exposes its three current cells");

      const finalRange = finalTableState.source.sourceRange;
      assert.equal(finalRange.from, initialTableRange.from, "table source owner retains its exact source origin");
      assert.equal(
        finalTableState.sourceSnapshot.length,
        finalRange.to - finalRange.from,
        "table source snapshot retains exactly its owned canonical range",
      );
      assert.equal(
        finalTableState.sourceSnapshot.read(0, finalTableState.sourceSnapshot.length),
        fullSource.slice(finalRange.from, finalRange.to),
        "table source snapshot preserves the exact canonical owner range",
      );
      const expectedOwnedSuffix = fullSource.slice(initialTableRange.to, finalRange.to);
      const actualOwnedSuffix = finalTableState.sourceSnapshot.read(
        initialTableRange.to - initialTableRange.from,
        finalRange.to - finalRange.from,
      );
      assert.equal(actualOwnedSuffix, expectedOwnedSuffix, "table source reader preserves the exact newly owned authored range");
      for (const [index, patchedRow] of tablePatchCapture.rows) {
        assert.ok(index >= 0 && index < finalTableState.rows.length, "semantic table row patch stays within the final row index");
        assert.deepEqual(
          finalTableState.rows.get(index),
          patchedRow,
          `final managed table state contains the exact semantic record published for row ${index}`,
        );
      }
      if (tablePatchCapture.header) {
        assert.deepEqual(finalTableState.header, tablePatchCapture.header, "final managed table state contains the exact published semantic header");
      }
      assert.equal(tablePatchCapture.sourceParts.join(""), expectedOwnedSuffix, "semantic patch source appends match the exact owned suffix");
      assert.equal(tablePatchCapture.sourceUnits, expectedOwnedSuffix.length, "patch source length matches the owned authored suffix");

      const coldTable = await coldFinalizedTableState(fullSource, finalRange.from);
      assert.ok(coldTable, "cold finalized parser exposes its managed table row owner");
      assertTableSuffixSemanticParity(finalTableState, coldTable, initialCompleteRows);
      tableBoundary = {
        ownerId: tableBlockId,
        generation: initialTableState.source.generation,
        initialCompleteRows,
        finalCompleteRows: finalTableState.source.completeRowCount,
        appendedRows: workload.appendChunks.length,
        patchRowSlots: tablePatchCapture.rowSlots,
        sourcePatchUnits: tablePatchCapture.sourceUnits,
        sourceSuffixUnits: expectedTableSuffix.length,
        exactAuthoredSuffix: true,
        coldSemanticParity: true,
        retainedFirstCompletedRow: true,
        retainedLastCompletedRow: true,
        nativeDomRows,
        nativeDomCells,
        noFinalizeOrInvalidation: true,
      };
    }

    if (includeParagraphSourceWork && paragraphBlockId && initialParagraphState) {
      const fullSource = prefix + expectedParagraphSuffix;
      const finalParagraphState = store.getParagraphBlock(paragraphBlockId);
      assert.ok(finalParagraphState, "managed paragraph remains available after the append window");
      assert.equal(finalParagraphState.source.state, "open", "paragraph append proof performs no FINALIZE");
      assert.equal(
        finalParagraphState.source.generation,
        initialParagraphState.source.generation,
        "paragraph owner generation is unchanged",
      );
      assert.ok(
        finalParagraphState.source.sourceRange.to > initialParagraphState.source.sourceRange.to,
        "paragraph owner advances its authored source frontier",
      );
      assert.ok(finalParagraphState.source.sourceRange.to <= fullSource.length, "paragraph owner stays within authored source");
      assert.equal(finalParagraphState.source.processedTo, fullSource.length, "paragraph parser processes the complete authored source");
      assert.equal(
        finalParagraphState.sourceSnapshot.length,
        finalParagraphState.source.sourceRange.to - finalParagraphState.source.sourceRange.from,
        "paragraph source snapshot retains exactly the owned source range",
      );
      assert.equal(
        finalParagraphState.sourceSnapshot.read(0, finalParagraphState.sourceSnapshot.length),
        fullSource.slice(
          finalParagraphState.source.sourceRange.from,
          finalParagraphState.source.sourceRange.to,
        ),
        "paragraph source snapshot preserves its exact canonical owner range",
      );
      assert.equal(finalParagraphState.spans.length, finalParagraphState.source.spanCount, "final paragraph span index matches metadata");
      assert.equal(
        finalParagraphState.spans.completeSpanCount,
        finalParagraphState.source.completeSpanCount,
        "final paragraph completed-span frontier matches metadata",
      );
      assert.equal(sinkSnapshot.invalidations.length, 0, "paragraph append window contains no backward invalidation");
      assert.ok(paragraphPatchCapture.spanRecords > 0, "paragraph append patches carry actual changed span records");
      const expectedOwnedSuffix = fullSource.slice(
        initialParagraphState.source.sourceRange.to,
        finalParagraphState.source.sourceRange.to,
      );
      assert.ok(expectedOwnedSuffix.length > 0, "paragraph source owner accepts authored append bytes");
      assert.equal(
        paragraphPatchCapture.sourceParts.join(""),
        expectedOwnedSuffix,
        "paragraph append patches preserve the exact newly owned authored suffix",
      );
      assert.equal(
        paragraphPatchCapture.sourceUnits,
        expectedOwnedSuffix.length,
        "paragraph patch source units match the exact owned authored suffix",
      );
      if (!includeListPrimaryParagraphWork) {
        assert.equal(
          sinkSnapshot.source_units_materialized,
          0,
          "ordinary root paragraph append avoids full-source materialization",
        );
      }
    }

    if (includeCodeSourceWork && codeBlock) {
      await engine.handle({ type: "DUMP_BLOCKS" });
      assert.equal(dumpedCodeRaw, expectedCodeSource, "cold source export preserves exact authored bytes");
    }

    const counters = mode === "code-source"
      ? CODE_SOURCE_WORK_COUNTERS
      : mode === "native-list-source"
        ? NATIVE_LIST_SOURCE_WORK_COUNTERS
        : mode === "paragraph-source"
          ? PARAGRAPH_SOURCE_WORK_COUNTERS
          : TABLE_SOURCE_WORK_COUNTERS;
    const observedWork = counters.reduce((total, counter) => total + sinkSnapshot[counter], 0);

    return {
      observedWork,
      sinkSnapshot,
      establishedBlockType,
      ...(nativeListOwnerEvidence ? { ownerEvidence: nativeListOwnerEvidence } : {}),
      ...(tableBoundary ? { tableBoundary } : {}),
    };
  } finally {
    try {
      await act(async () => root.unmount());
    } finally {
      restoreDomGlobals(snapshot);
      dom.window.close();
      engine.dispose();
    }
  }
}
