import assert from "node:assert/strict";

import type { Block, InlineNode, NodeSnapshot, Patch, TableBlockSnapshot, TableBlockSourceMetadata, TableCellRecord, TableRowRecord } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ComponentRegistry } from "../src/components";
import type { ControlsComponentProps } from "../src/types";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const TABLE_ID = "streamed-table";
const INITIAL_RAW = "|h|\r\n|---|\r\n--";
const SOURCE_APPEND = "\r\n|stable|\r\n--";
const DELIMITER_END = 10;

function cell(raw: string, index: number, from: number, to: number, rowId: string): TableCellRecord {
  const inline: InlineNode[] = raw ? [{ kind: "text", text: raw }] : [];
  return { id: `${rowId}::cell:${index}`, index, raw, sourceRange: { from, to }, inline };
}

function row(
  index: number,
  from: number,
  to: number,
  cellRaw: string,
  cellFrom: number,
  cellTo: number,
  sourceRevision: number,
  isProvisional: boolean,
): TableRowRecord {
  const id = `${TABLE_ID}::row:${index}`;
  return {
    id,
    index,
    sourceRange: { from, to },
    sourceRevision,
    isProvisional,
    cells: [cell(cellRaw, 0, cellFrom, cellTo, id)],
  };
}

function metadata(
  revision: number,
  state: TableBlockSourceMetadata["state"],
  processedTo: number,
  rangeTo: number,
  completeRowCount: number,
  rowCount: number,
): TableBlockSourceMetadata {
  return {
    tableOwnerId: TABLE_ID,
    generation: 7,
    revision,
    state,
    processedTo,
    completeRowCount,
    rowCount,
    sourceRange: { from: 0, to: rangeTo },
  };
}

const firstRow = row(0, 12, 14, "--", 12, 14, 0, true);
const initialTable: TableBlockSnapshot = {
  ...metadata(0, "open", 14, 14, 0, 1),
  header: {
    sourceRange: { from: 0, to: DELIMITER_END },
    cells: [cell("h", 0, 1, 2, `${TABLE_ID}::header`)],
    align: [null],
  },
  rows: [firstRow],
  raw: INITIAL_RAW,
};
const initialSnapshot: NodeSnapshot = {
  id: "__root__",
  type: "__root__",
  children: [
    {
      id: TABLE_ID,
      type: "table",
      range: { from: 0, to: INITIAL_RAW.length },
      props: {
        block: {
          id: TABLE_ID,
          type: "table",
          isFinalized: false,
          payload: { raw: "", range: { from: 0, to: INITIAL_RAW.length }, meta: {} },
        } satisfies Block,
      },
      table: initialTable,
      children: [],
    },
  ],
};

const store = createRendererStore();
store.resetSnapshot(initialSnapshot);
const originalView = store.getTableBlock(TABLE_ID);
assert.ok(originalView);
assert.equal(originalView.header.sourceRange.to, DELIMITER_END, "header retains delimiter source floor");
assert.equal(originalView.sourceSnapshot.materialize(), INITIAL_RAW);
const originalRows = store.getTableRows(TABLE_ID, 0, 64);
assert.deepEqual(originalRows[0]?.cells[0]?.inline, [{ kind: "text", text: "--" }]);

const afterAppendRaw = INITIAL_RAW + SOURCE_APPEND;
const stableRow = row(1, 16, 24, "stable", 17, 23, 1, false);
const provisionalRow = row(2, 26, 28, "--", 26, 28, 1, true);
const firstAppendRows = [
  row(0, 12, 14, "--", 12, 14, 1, false),
  stableRow,
  provisionalRow,
];
const firstAppend: Patch = {
  op: "appendTableRows",
  at: { blockId: TABLE_ID },
  table: metadata(1, "open", 28, 28, 2, 3),
  expectedRevision: 0,
  fromRow: 0,
  rows: firstAppendRows,
  sourceAppend: SOURCE_APPEND,
};
store.applyPatches([firstAppend]);
const appendedView = store.getTableBlock(TABLE_ID);
assert.ok(appendedView);
assert.equal(appendedView.sourceSnapshot.materialize(), afterAppendRaw);
const appendedRows = store.getTableRows(TABLE_ID, 0, 64);
assert.equal(originalView.sourceSnapshot.materialize(), INITIAL_RAW, "older prefix readers are immutable");

const retract: Patch = {
  op: "appendTableRows",
  at: { blockId: TABLE_ID },
  table: metadata(2, "open", 29, 24, 2, 2),
  expectedRevision: 1,
  fromRow: 2,
  rows: [],
  sourceAppend: "",
};
store.applyPatches([retract]);
const retractedView = store.getTableBlock(TABLE_ID);
assert.ok(retractedView);
assert.equal(retractedView.sourceSnapshot.length, 24);
assert.equal(retractedView.sourceSnapshot.materialize(), afterAppendRaw.slice(0, 24));
assert.equal(retractedView.source.processedTo, 29, "accepted source frontier stays monotonic");
const retractedRows = store.getTableRows(TABLE_ID, 0, 64);
assert.equal(retractedRows.length, 2);
assert.strictEqual(retractedRows[0], appendedRows[0]);
assert.strictEqual(retractedRows[1], appendedRows[1], "completed row identity survives provisional retraction");

const invalidRetraction: Patch = {
  op: "appendTableRows",
  at: { blockId: TABLE_ID },
  table: metadata(3, "open", 29, 23, 2, 2),
  expectedRevision: 2,
  fromRow: 2,
  rows: [],
  sourceAppend: "",
};
store.applyPatches([invalidRetraction]);
assert.equal(store.getTableBlock(TABLE_ID)?.source.revision, 2, "retraction into a completed row is atomically rejected");
assert.equal(store.getTableBlock(TABLE_ID)?.sourceSnapshot.materialize(), afterAppendRaw.slice(0, 24));

const reextend: Patch = {
  op: "appendTableRows",
  at: { blockId: TABLE_ID },
  table: metadata(3, "open", 29, 28, 2, 3),
  expectedRevision: 2,
  fromRow: 2,
  rows: [row(2, 26, 28, "--", 26, 28, 3, true)],
  sourceAppend: afterAppendRaw.slice(24),
};
store.applyPatches([reextend]);
const reextendedView = store.getTableBlock(TABLE_ID);
assert.ok(reextendedView);
assert.equal(reextendedView.sourceSnapshot.materialize(), afterAppendRaw, "re-extension reuses logged CRLF/tail overlap");
const reextendedRows = store.getTableRows(TABLE_ID, 0, 64);
assert.strictEqual(reextendedRows[0], appendedRows[0]);
assert.strictEqual(reextendedRows[1], appendedRows[1]);
assert.equal(store.getBlocks()[0]?.payload.raw, afterAppendRaw, "cold projection retains authored source");
assert.equal(originalView.sourceSnapshot.materialize(), INITIAL_RAW);

async function verifyMountedTableActions(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const globalNames = [
    "window", "document", "HTMLElement", "Node", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const ambient = globalThis as unknown as Record<string, unknown>;
  const descriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  ambient.window = dom.window;
  ambient.document = dom.window.document;
  ambient.HTMLElement = dom.window.HTMLElement;
  ambient.Node = dom.window.Node;
  ambient.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  ambient.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  ambient.IS_REACT_ACT_ENVIRONMENT = true;
  let root: ReturnType<typeof createRoot> | undefined;
  let savedRead: ControlsComponentProps["getTableData"];
  const registry = new ComponentRegistry();
  registry.setControls(true);
  registry.setTableVirtualization({ enabled: false });
  registry.setControlsComponent((props) => {
    if (props.type === "table" && !savedRead) savedRead = props.getTableData;
    return null;
  });
  const renderedRows = (): Array<string | null> =>
    Array.from(dom.window.document.querySelectorAll("tbody tr"), (element) => element.textContent);
  const notificationFrame = (): Promise<void> => new Promise((resolve) => {
    dom.window.requestAnimationFrame(() => resolve());
  });
  try {
    const container = dom.window.document.getElementById("root");
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(BlockNodeRenderer, { store, blockId: TABLE_ID, registry }));
    });
    assert.deepEqual(renderedRows(), ["--", "stable", "--"]);
    assert.ok(savedRead);
    const readOriginalOwner = savedRead;
    assert.deepEqual(readOriginalOwner().rows, [["--"], ["stable"], ["--"]]);
    const current = store.getTableBlock(TABLE_ID);
    assert.ok(current);
    const revision = current.source.revision + 1;
    await act(async () => {
      store.applyPatches([{
        op: "appendTableRows",
        at: { blockId: TABLE_ID },
        table: metadata(revision, "open", 37, 35, 4, 4),
        expectedRevision: current.source.revision,
        fromRow: 2,
        rows: [
          row(2, 26, 28, "--", 26, 28, revision, false),
          row(3, 30, 35, "new", 31, 34, revision, false),
        ],
        sourceAppend: "\r\n|new|",
      }]);
      await notificationFrame();
    });
    assert.deepEqual(renderedRows(), ["--", "stable", "--", "new"]);
    assert.deepEqual(
      readOriginalOwner().rows,
      [["--"], ["stable"], ["--"], ["new"]],
      "a saved cold action reads current rows within its original owner generation",
    );
    await act(async () => {
      store.resetSnapshot({
        ...initialSnapshot,
        children: [{ ...initialSnapshot.children![0]!, table: { ...initialTable, generation: 8 } }],
      });
      await notificationFrame();
    });
    assert.deepEqual(renderedRows(), ["--"]);
    assert.throws(() => readOriginalOwner(), "a saved cold action cannot read a replacement owner");
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

await verifyMountedTableActions();
