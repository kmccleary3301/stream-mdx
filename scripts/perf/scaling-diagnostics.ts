import assert from "node:assert";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type {
  ManagedParagraphViewState,
  ManagedTableViewState,
  ParagraphSpanRecord,
  TableRowRecord,
  WorkerIn,
  WorkerOut,
} from "@stream-mdx/core";
import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
import type { RendererStoreOptions } from "@stream-mdx/react/renderer/store";
import type { MarkdownEngineOptions } from "../../packages/markdown-v2-worker/src/engine/types";
import {
  MarkdownEngine,
  createRendererStore,
  ComponentRegistry,
  MarkdownBlocksRenderer,
  SessionCounterSink,
} from "./diagnostic-dist/index.mjs";
import {
  COUNTER_STAGES,
  type CounterStage,
  type StageCounters,
  type SessionCountersSnapshot,
} from "./counter-sink";
import {
  assertTableSuffixSemanticParity,
  reportTableScalingEvidence,
  type TableBoundaryEvidence,
  type TableScalingObservation,
} from "./table-scaling-evidence";
export interface DivergenceReport {
  fixtureId: string;
  planMode: string;
  seed: number;
  stage: string;
  commitIndex: number;
  frontier: number;
  sourcePrefix: string;
  message: string;
}


export interface StageCounterRatio {
  n: number;
  fourN: number;
  unitWorkN: number;
  unitWork4N: number;
  ratio: number;
  notApplicable?: boolean;
  available?: boolean;
}


export interface ScalingMeasurement {
  workload: string;
  expectedBlockType: string;
  windowUnits: number;
  nPrefixUnits: number;
  fourNPrefixUnits: number;
  workPerUnitN: number;
  workPerUnit4N: number;
  totalRatio: number;
  workMeasure:
    | "sum of observed counter counts; not literal CPU cost"
    | "legacy plus source-read/materialization, directory-copy, record-slot, and code-preparation counters; not literal CPU cost"
    | "table source-reader/materialization, parser-input/inline preparation, and engine/store record-slot counters; semantic patch row slots and native row/cell callbacks reported separately; not literal CPU cost"
    | "legacy plus paragraph source-read/materialization, directory-copy, and span-record allocation counters; emitted span/source records and native view records asserted separately; not literal CPU cost";
  gatePassed: boolean;
  stageRatios: Record<CounterStage, Partial<Record<keyof StageCounters, StageCounterRatio>>>;
  snapshotN: SessionCountersSnapshot;
  snapshot4N: SessionCountersSnapshot;
  tableBoundary?: { n: TableBoundaryEvidence; fourN: TableBoundaryEvidence };
  tableObservations?: TableScalingObservation[];
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

const LEGACY_WORK_COUNTERS: readonly (keyof StageCounters)[] = [
  "lines_tokenized",
  "units_tokenized",
  "inline_source_units_prepared",
  "snapshot_nodes_built",
  "prefix_comparisons",
  "patches_emitted",
  "store_records_touched",
  "blocks_reprepared",
] as const;

const CODE_SOURCE_WORK_COUNTERS: readonly (keyof StageCounters)[] = [
  ...LEGACY_WORK_COUNTERS,
  "source_units_read",
  "source_units_materialized",
  "source_directory_entries_copied",
  "record_slots_allocated",
  "code_source_units_prepared",
] as const;
const TABLE_SOURCE_WORK_COUNTERS: readonly (keyof StageCounters)[] = [
  ...LEGACY_WORK_COUNTERS,
  "source_units_read",
  "source_units_materialized",
  "source_directory_entries_copied",
  "record_slots_allocated",
] as const;
const PARAGRAPH_SOURCE_WORK_COUNTERS: readonly (keyof StageCounters)[] = [
  ...LEGACY_WORK_COUNTERS,
  "source_units_read",
  "source_units_materialized",
  "source_directory_entries_copied",
  "record_slots_allocated",
] as const;



// Append-only source directories legitimately copy zero entries without root growth.
const REQUIRED_CODE_SOURCE_COUNTERS: readonly {
  readonly stage: CounterStage;
  readonly counter: keyof StageCounters;
}[] = [
  { stage: "engine", counter: "source_units_read" },
  { stage: "engine", counter: "record_slots_allocated" },
  { stage: "engine", counter: "code_source_units_prepared" },
  { stage: "store", counter: "record_slots_allocated" },
  { stage: "store", counter: "store_records_touched" },
] as const;

const REQUIRED_PARAGRAPH_SOURCE_COUNTERS: readonly {
  readonly stage: CounterStage;
  readonly counter: keyof StageCounters;
}[] = [
  { stage: "engine", counter: "source_units_read" },
  { stage: "engine", counter: "inline_source_units_prepared" },
  { stage: "engine", counter: "record_slots_allocated" },
  { stage: "store", counter: "record_slots_allocated" },
  { stage: "store", counter: "store_records_touched" },
  { stage: "view", counter: "store_records_touched" },
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

export interface ScalingWorkloadDef {
  name: string;
  expectedBlockType: "paragraph" | "code" | "table" | "list";
  setupPrefixN: string;
  setupPrefix4N: string;
  nPrefixUnits: number;
  fourNPrefixUnits: number;
  appendChunks: string[];
  windowUnits: number;
}

export function createScalingWorkloads(): ScalingWorkloadDef[] {
  const pChunks = Array.from({ length: 10 }, (_, i) => `Appended paragraph line ${i}.\n`);
  const pSetupN = Array.from({ length: 20 }, (_, i) => `Prefix paragraph line ${i} content.\n`).join("");
  const pSetup4N = Array.from({ length: 80 }, (_, i) => `Prefix paragraph line ${i} content.\n`).join("");

  const cChunks = Array.from({ length: 10 }, (_, i) => `  const append_code_${i} = ${100 + i};\n`);
  const cSetupN =
    "```typescript\n" +
    Array.from({ length: 20 }, (_, i) => `  const code_prefix_${i} = ${i};\n`).join("");
  const cSetup4N =
    "```typescript\n" +
    Array.from({ length: 80 }, (_, i) => `  const code_prefix_${i} = ${i};\n`).join("");

  const tChunks = Array.from({ length: 10 }, (_, i) => `| app_a_${i} | app_b_${i} | app_c_${i} |\n`);
  const tSetupN =
    "| Col A | Col B | Col C |\n| :--- | :---: | ---: |\n" +
    Array.from({ length: 20 }, (_, i) => `| cell_a_${i} | cell_b_${i} | cell_c_${i} |\n`).join("");
  const tSetup4N =
    "| Col A | Col B | Col C |\n| :--- | :---: | ---: |\n" +
    Array.from({ length: 80 }, (_, i) => `| cell_a_${i} | cell_b_${i} | cell_c_${i} |\n`).join("");

  const lChunks = Array.from({ length: 10 }, (_, i) => `- appended list item ${i}\n`);
  const lSetupN = Array.from({ length: 20 }, (_, i) => `- list item prefix ${i}\n`).join("");
  const lSetup4N = Array.from({ length: 80 }, (_, i) => `- list item prefix ${i}\n`).join("");

  return [
    {
      name: "paragraph",
      expectedBlockType: "paragraph",
      setupPrefixN: pSetupN,
      setupPrefix4N: pSetup4N,
      nPrefixUnits: pSetupN.length,
      fourNPrefixUnits: pSetup4N.length,
      appendChunks: pChunks,
      windowUnits: pChunks.reduce((acc, c) => acc + c.length, 0),
    },
    {
      name: "code-lines",
      expectedBlockType: "code",
      setupPrefixN: cSetupN,
      setupPrefix4N: cSetup4N,
      nPrefixUnits: cSetupN.length,
      fourNPrefixUnits: cSetup4N.length,
      appendChunks: cChunks,
      windowUnits: cChunks.reduce((acc, c) => acc + c.length, 0),
    },
    {
      name: "table-rows",
      expectedBlockType: "table",
      setupPrefixN: tSetupN,
      setupPrefix4N: tSetup4N,
      nPrefixUnits: tSetupN.length,
      fourNPrefixUnits: tSetup4N.length,
      appendChunks: tChunks,
      windowUnits: tChunks.reduce((acc, c) => acc + c.length, 0),
    },
    {
      name: "list-items",
      expectedBlockType: "list",
      setupPrefixN: lSetupN,
      setupPrefix4N: lSetup4N,
      nPrefixUnits: lSetupN.length,
      fourNPrefixUnits: lSetup4N.length,
      appendChunks: lChunks,
      windowUnits: lChunks.reduce((acc, c) => acc + c.length, 0),
    },
  ];
}

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


interface TablePatchCapture {
  appendPatchCount: number;
  rowSlots: number;
  sourceUnits: number;
  sourceParts: string[];
  unexpectedOperations: string[];
}

interface ParagraphPatchCapture {
  appendPatchCount: number;
  spanRecords: number;
  sourceUnits: number;
  sourceParts: string[];
  unexpectedOperations: string[];
}


async function measureAppendWindowWork(
  workload: ScalingWorkloadDef,
  prefix: string,
  mode: "legacy" | "code-source" | "paragraph-source" | "table-rows" = "legacy",
): Promise<{
  observedWork: number;
  sinkSnapshot: SessionCountersSnapshot;
  establishedBlockType: string;
  tableBoundary?: TableBoundaryEvidence;
}> {
  const includeCodeSourceWork = mode === "code-source";
  const includeParagraphSourceWork = mode === "paragraph-source";
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
  let tableBlockId: string | undefined;
  let observingParagraphAppendWindow = false;
  let observingTableAppendWindow = false;
  const paragraphPatchCapture: ParagraphPatchCapture = {
    appendPatchCount: 0,
    spanRecords: 0,
    sourceUnits: 0,
    sourceParts: [],
    unexpectedOperations: [],
  };
  const tablePatchCapture: TablePatchCapture = {
    appendPatchCount: 0,
    rowSlots: 0,
    sourceUnits: 0,
    sourceParts: [],
    unexpectedOperations: [],
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
        if (observingParagraphAppendWindow) {
          for (const patch of msg.patches) {
            if (
              patch.op === "appendParagraph" &&
              patch.paragraphOwnerId === paragraphBlockId &&
              patch.at.blockId === paragraphBlockId
            ) {
              paragraphPatchCapture.appendPatchCount += 1;
              paragraphPatchCapture.spanRecords += patch.spans.length;
              paragraphPatchCapture.sourceUnits += patch.sourceAppend.length;
              paragraphPatchCapture.sourceParts.push(patch.sourceAppend);
            } else if (
              patch.op === "updateParagraphSpans" &&
              patch.paragraphOwnerId === paragraphBlockId &&
              patch.at.blockId === paragraphBlockId
            ) {
              continue;
            } else {
              paragraphPatchCapture.unexpectedOperations.push(patch.op);
            }
          }
        }
        if (observingTableAppendWindow) {
          for (const patch of msg.patches) {
            if (
              patch.op === "appendTableRows" &&
              "at" in patch &&
              patch.at.blockId === tableBlockId
            ) {
              tablePatchCapture.appendPatchCount += 1;
              tablePatchCapture.rowSlots += patch.rows.length;
              tablePatchCapture.sourceUnits += patch.sourceAppend.length;
              tablePatchCapture.sourceParts.push(patch.sourceAppend);
            } else {
              tablePatchCapture.unexpectedOperations.push(patch.op);
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
    const paragraphBlock = includeParagraphSourceWork
      ? setupBlocks.find((block) => block.type === "paragraph")
      : undefined;
    let initialTableState: ManagedTableViewState | undefined;
    let initialTableRange: { from: number; to: number } | undefined;
    let initialCompleteRows = 0;
    let firstCompletedRow: TableRowRecord | undefined;
    let lastCompletedRow: TableRowRecord | undefined;

    if (includeCodeSourceWork) {
      assert.ok(codeBlock, "code-family workload must establish its managed root code block");
      const codeView = store.getCodeBlock(codeBlock.id);
      assert.ok(codeView, "code-family workload must expose its prepared code view");
      assert.equal(codeView.source.state, "open", "code-family append window starts open");
      codeGeneration = codeView.source.generation;
      assert.equal(store.getChildren(codeBlock.id).length, 0, "owned code rows must not be per-line NodeRecords");
    }

    if (includeParagraphSourceWork) {
      assert.ok(paragraphBlock, "paragraph-family workload must establish its managed root paragraph");
      paragraphBlockId = paragraphBlock.id;
      initialParagraphState = store.getParagraphBlock(paragraphBlockId);
      assert.ok(initialParagraphState, "paragraph-family workload must expose its managed span/source state");
      assert.equal(initialParagraphState.source.state, "open", "paragraph append window starts with an open owner");
      assert.equal(initialParagraphState.source.sourceRange.from, 0, "the workload is a root paragraph from offset zero");
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

    if (includeTableBoundary && tableBlockId) {
      const mountedTable = rootContainer.querySelector<HTMLTableElement>(
        `table[data-table-block="true"][data-block-id="${tableBlockId}"]`,
      );
      assert.ok(mountedTable, "actual native Markdown table view must be mounted before measurement");
    }

    // Reset diagnostic counts AFTER baseline source setup and native mounting.
    sessionSink.reset();

    let expectedCodeSource = prefix;
    let expectedParagraphSuffix = "";
    let expectedTableSuffix = "";
    let nativeDomRows = 0;
    let nativeDomCells = 0;
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
        if (includeCodeSourceWork && codeBlock) {
          expectedCodeSource += chunk;
          const afterAppend = store.getCodeBlock(codeBlock.id);
          assert.ok(afterAppend, "managed root code view remains available during the append window");
          assert.equal(afterAppend.source.state, "open", "measured append window contains no close/finalize");
          assert.equal(afterAppend.source.generation, codeGeneration, "managed code generation stays fixed");
        }

        if (includeParagraphSourceWork && paragraphBlockId && initialParagraphState) {
          expectedParagraphSuffix += chunk;
          const currentParagraph = store.getParagraphBlock(paragraphBlockId);
          assert.ok(currentParagraph, "managed root paragraph remains available during the append window");
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
          assert.equal(
            currentParagraph.sourceSnapshot.length,
            currentParagraph.source.sourceRange.to - currentParagraph.source.sourceRange.from,
            "paragraph source snapshot length matches the advancing owned range",
          );
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
            paragraphPatchCapture.appendPatchCount,
            appendIndex + 1,
            "each paragraph append chunk emits one native appendParagraph patch",
          );
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
          const appendedRow = currentTable.rows.get(initialCompleteRows + appendIndex);
          assert.ok(appendedRow, "each semantic table append exposes its new completed row");
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
      observingParagraphAppendWindow = false;
      observingTableAppendWindow = false;
    }

    const sinkSnapshot = sessionSink.snapshot();
    let tableBoundary: TableBoundaryEvidence | undefined;
    if (includeTableBoundary && tableBlockId && initialTableState && initialTableRange && firstCompletedRow && lastCompletedRow) {
      const fullSource = prefix + expectedTableSuffix;
      const actualSource = sessionSink.readSourceSnapshot();
      assert.equal(actualSource.length, fullSource.length, "actual engine source length includes the complete authored suffix");
      assert.equal(
        actualSource.read(prefix.length, fullSource.length),
        expectedTableSuffix,
        "actual engine source reader preserves every authored appended byte",
      );
      const finalTableState = store.getTableBlock(tableBlockId);
      assert.ok(finalTableState, "managed table remains available after the append window");
      assert.equal(finalTableState.source.state, "open", "table append proof performs no FINALIZE");
      assert.equal(finalTableState.source.generation, initialTableState.source.generation, "table owner generation is unchanged");
      assert.equal(finalTableState.source.processedTo, fullSource.length, "table owner processed the entire authored suffix");
      assert.equal(sinkSnapshot.invalidations.length, 0, "table append window contains no backward invalidation");
      assert.deepEqual(tablePatchCapture.unexpectedOperations, [], "table append window emits no non-append semantic patches");
      assert.equal(tablePatchCapture.appendPatchCount, workload.appendChunks.length, "every append emits a real table semantic patch");
      assert.equal(tablePatchCapture.rowSlots, workload.appendChunks.length, "actual table patches carry each appended row slot");
      assert.equal(nativeDomRows, workload.appendChunks.length, "every appended row is present in the mounted native DOM");
      assert.equal(nativeDomCells, workload.appendChunks.length * 3, "every appended native DOM row exposes its three current cells");

      const finalRange = finalTableState.source.sourceRange;
      const expectedOwnedSuffix = fullSource.slice(initialTableRange.to, finalRange.to);
      const actualOwnedSuffix = finalTableState.sourceSnapshot.read(
        initialTableRange.to - initialTableRange.from,
        finalRange.to - finalRange.from,
      );
      assert.equal(actualOwnedSuffix, expectedOwnedSuffix, "table source reader preserves the exact newly owned authored range");
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
        appendPatchCount: tablePatchCapture.appendPatchCount,
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
      assert.equal(finalParagraphState.spans.length, finalParagraphState.source.spanCount, "final paragraph span index matches metadata");
      assert.equal(
        finalParagraphState.spans.completeSpanCount,
        finalParagraphState.source.completeSpanCount,
        "final paragraph completed-span frontier matches metadata",
      );
      assert.equal(sinkSnapshot.invalidations.length, 0, "paragraph append window contains no backward invalidation");
      assert.deepEqual(paragraphPatchCapture.unexpectedOperations, [], "paragraph append window emits only paragraph semantic patches");
      assert.equal(
        paragraphPatchCapture.appendPatchCount,
        workload.appendChunks.length,
        "every append emits a real appendParagraph patch",
      );
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
      assert.equal(
        sinkSnapshot.source_units_materialized,
        0,
        "ordinary paragraph append avoids full-source materialization",
      );
    }

    if (includeCodeSourceWork && codeBlock) {
      await engine.handle({ type: "DUMP_BLOCKS" });
      assert.equal(dumpedCodeRaw, expectedCodeSource, "cold source export preserves exact authored bytes");
    }

    const counters = includeCodeSourceWork
      ? CODE_SOURCE_WORK_COUNTERS
      : includeParagraphSourceWork
        ? PARAGRAPH_SOURCE_WORK_COUNTERS
        : includeTableBoundary
          ? TABLE_SOURCE_WORK_COUNTERS
          : LEGACY_WORK_COUNTERS;
    const observedWork = counters.reduce((total, counter) => total + sinkSnapshot[counter], 0);

    return {
      observedWork,
      sinkSnapshot,
      establishedBlockType,
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

export async function runScalingDiagnostics(options: {
  codeFamilyOnly?: boolean;
  tableFamilyOnly?: boolean;
} = {}): Promise<{
  measurements: ScalingMeasurement[];
  divergences: DivergenceReport[];
}> {
  if (options.codeFamilyOnly && options.tableFamilyOnly) {
    throw new Error("Select at most one focused scaling family");
  }
  const measurements: ScalingMeasurement[] = [];
  const divergences: DivergenceReport[] = [];
  const includeCodeSourceWork = options.codeFamilyOnly === true;
  const includeTableBoundary = options.tableFamilyOnly === true;
  const selectedWorkload = includeCodeSourceWork
    ? "code-lines"
    : includeTableBoundary
      ? "table-rows"
      : undefined;
  const workloads = createScalingWorkloads().filter(
    (workload) => selectedWorkload === undefined || workload.name === selectedWorkload,
  );

  for (const wl of workloads) {
    const measurementMode = includeCodeSourceWork
      ? "code-source"
      : includeTableBoundary
        ? "table-rows"
        : wl.name === "paragraph"
          ? "paragraph-source"
          : "legacy";
    const workCounters = includeCodeSourceWork
      ? CODE_SOURCE_WORK_COUNTERS
      : includeTableBoundary
        ? TABLE_SOURCE_WORK_COUNTERS
        : wl.name === "paragraph"
          ? PARAGRAPH_SOURCE_WORK_COUNTERS
          : LEGACY_WORK_COUNTERS;
    try {
      const measuredN = await measureAppendWindowWork(wl, wl.setupPrefixN, measurementMode);
      const measured4N = await measureAppendWindowWork(wl, wl.setupPrefix4N, measurementMode);
      const {
        observedWork: observedWorkN,
        sinkSnapshot: snapN,
        establishedBlockType: establishedN,
        tableBoundary: tableBoundaryN,
      } = measuredN;
      const {
        observedWork: observedWork4N,
        sinkSnapshot: snap4N,
        establishedBlockType: established4N,
        tableBoundary: tableBoundary4N,
      } = measured4N;

      if (establishedN !== wl.expectedBlockType || established4N !== wl.expectedBlockType) {
        divergences.push({
          fixtureId: `scaling-${wl.name}`,
          planMode: "window-append",
          seed: 0,
          stage: "diagnostic:block-type",
          commitIndex: 0,
          frontier: wl.windowUnits,
          sourcePrefix: wl.setupPrefixN.slice(0, 40),
          message: `Inherited red: workload '${wl.name}' established block type '${establishedN}' instead of expected '${wl.expectedBlockType}'`,
        });
        // Retain other completed per-stage results without recording a fake pass or bogus paragraph measurement.
        continue;
      }

      const workPerUnitN = observedWorkN / wl.windowUnits;
      const workPerUnit4N = observedWork4N / wl.windowUnits;
      const totalRatio = workPerUnitN > 0 ? workPerUnit4N / workPerUnitN : (workPerUnit4N > 0 ? Infinity : 1.0);
      let gatePassed = totalRatio <= 1.25;
      const requiredSourceCounters = includeCodeSourceWork
        ? REQUIRED_CODE_SOURCE_COUNTERS
        : measurementMode === "paragraph-source"
          ? REQUIRED_PARAGRAPH_SOURCE_COUNTERS
          : undefined;
      if (requiredSourceCounters) {
        for (const { stage, counter } of requiredSourceCounters) {
          const countN = snapN.stages[stage][counter];
          const count4N = snap4N.stages[stage][counter];
          if (countN === 0 || count4N === 0) {
            gatePassed = false;
            divergences.push({
              fixtureId: `scaling-${wl.name}`,
              planMode: "window-append",
              seed: 0,
              stage: `diagnostic:scaling:missing:${stage}:${counter}`,
              commitIndex: wl.appendChunks.length,
              frontier: wl.windowUnits,
              sourcePrefix: wl.appendChunks[0]?.slice(0, 40) ?? "",
              message: `${wl.expectedBlockType}-family counter '${stage}.${counter}' must report observed work in both windows: N=${countN}, 4N=${count4N}`,
            });
          }
        }
      }

      const stageRatios: Record<CounterStage, Partial<Record<keyof StageCounters, StageCounterRatio>>> = {
        engine: {},
        snapshot: {},
        patch: {},
        store: {},
        view: {},
      };

      // A growing stage cannot hide behind a flat aggregate.
      for (const stage of COUNTER_STAGES) {
        for (const counter of workCounters) {
          const countN = snapN.stages[stage][counter];
          const count4N = snap4N.stages[stage][counter];

          if (countN > 0 || count4N > 0) {
            const unitWorkN = countN / wl.windowUnits;
            const unitWork4N = count4N / wl.windowUnits;
            const ratio = unitWorkN > 0 ? unitWork4N / unitWorkN : (unitWork4N > 0 ? Infinity : 1.0);

            stageRatios[stage][counter] = {
              n: countN,
              fourN: count4N,
              unitWorkN,
              unitWork4N,
              ratio,
              ...(stage === "view" && counter === "store_records_touched"
                ? { available: countN > 0 && count4N > 0 }
                : {}),
            };

            if (ratio > 1.25) {
              gatePassed = false;
              divergences.push({
                fixtureId: `scaling-${wl.name}`,
                planMode: "window-append",
                seed: 0,
                stage: `diagnostic:scaling:${stage}:${counter}`,
                commitIndex: wl.appendChunks.length,
                frontier: wl.windowUnits,
                sourcePrefix: wl.appendChunks[0]?.slice(0, 40) ?? "",
                message: `Inherited scaling red: stage '${stage}' counter '${counter}' ratio ${ratio.toFixed(2)}x exceeds 1.25x gate on ${wl.name} (N work/unit: ${unitWorkN.toFixed(4)}, 4N work/unit: ${unitWork4N.toFixed(4)})`,
              });
            }
          } else {
            stageRatios[stage][counter] = {
              n: 0,
              fourN: 0,
              unitWorkN: 0,
              unitWork4N: 0,
              ratio: 1.0,
              ...(stage === "view" && counter === "store_records_touched"
                ? { available: false }
                : { notApplicable: true }),
            };
          }
        }
      }

      const viewWorkN = snapN.stages.view.store_records_touched;
      const viewWork4N = snap4N.stages.view.store_records_touched;
      if (viewWorkN === 0 || viewWork4N === 0) {
        gatePassed = false;
        divergences.push({
          fixtureId: `scaling-${wl.name}`,
          planMode: "window-append",
          seed: 0,
          stage: "diagnostic:scaling:view",
          commitIndex: wl.appendChunks.length,
          frontier: wl.windowUnits,
          sourcePrefix: wl.appendChunks[0]?.slice(0, 40) ?? "",
          message: `Observed view work unavailable for ${wl.expectedBlockType} consumer on ${wl.name}: N=${viewWorkN}, 4N=${viewWork4N}; both measurements require nonzero view records`,
        });
      }

      const tableObservations: TableScalingObservation[] = [];
      let tableBoundary: { n: TableBoundaryEvidence; fourN: TableBoundaryEvidence } | undefined;
      if (includeTableBoundary) {
        const evidence = reportTableScalingEvidence(
          {
            workloadName: wl.name,
            windowUnits: wl.windowUnits,
            appendChunkCount: wl.appendChunks.length,
            sourcePrefix: wl.appendChunks[0]?.slice(0, 40) ?? "",
            snapshotN: snapN,
            snapshot4N: snap4N,
            tableBoundaryN,
            tableBoundary4N,
            gatePassed,
          },
          (divergence) => {
            divergences.push(divergence);
          },
        );
        gatePassed = evidence.gatePassed;
        tableObservations.push(...evidence.observations);
        tableBoundary = evidence.boundary;
      }

      if (totalRatio > 1.25) {
        divergences.push({
          fixtureId: `scaling-${wl.name}`,
          planMode: "window-append",
          seed: 0,
          stage: "diagnostic:scaling",
          commitIndex: wl.appendChunks.length,
          frontier: wl.windowUnits,
          sourcePrefix: wl.appendChunks[0]?.slice(0, 40) ?? "",
          message: `Inherited scaling red: observed-work ratio ${totalRatio.toFixed(2)}x exceeds 1.25x gate on ${wl.name} (N observed work/input-unit: ${workPerUnitN.toFixed(4)}, 4N observed work/input-unit: ${workPerUnit4N.toFixed(4)})`,
        });
      }

      measurements.push({
        workload: wl.name,
        expectedBlockType: wl.expectedBlockType,
        windowUnits: wl.windowUnits,
        nPrefixUnits: wl.nPrefixUnits,
        workMeasure: includeTableBoundary
          ? "table source-reader/materialization, parser-input/inline preparation, and engine/store record-slot counters; semantic patch row slots and native row/cell callbacks reported separately; not literal CPU cost"
          : includeCodeSourceWork
            ? "legacy plus source-read/materialization, directory-copy, record-slot, and code-preparation counters; not literal CPU cost"
            : measurementMode === "paragraph-source"
              ? "legacy plus paragraph source-read/materialization, directory-copy, and span-record allocation counters; emitted span/source records and native view records asserted separately; not literal CPU cost"
              : "sum of observed counter counts; not literal CPU cost",
        fourNPrefixUnits: wl.fourNPrefixUnits,
        workPerUnitN,
        workPerUnit4N,
        totalRatio,
        gatePassed,
        stageRatios,
        snapshotN: snapN,
        snapshot4N: snap4N,
        ...(tableBoundary ? { tableBoundary } : {}),
        ...(includeTableBoundary ? { tableObservations } : {}),
      });
    } catch (err) {
      divergences.push({
        fixtureId: `scaling-${wl.name}`,
        planMode: "window-append",
        seed: 0,
        stage: "diagnostic:scaling:error",
        commitIndex: 0,
        frontier: wl.windowUnits,
        sourcePrefix: wl.setupPrefixN.slice(0, 40),
        message: `Workload '${wl.name}' failed during measurement: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
  }

  return { measurements, divergences };
}
