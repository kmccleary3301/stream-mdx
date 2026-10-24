import assert from "node:assert/strict";
import type { TableBlockMetadata, TableNodeHandle, TableRowRange, TableRowRecord } from "@stream-mdx/core";
import { NativeNodeView, StreamingMarkdown, useTableBlock, useTableRows, type StreamingMarkdownHandle } from "@stream-mdx/react";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { installTrustedNativeTestDom, waitFor, workerFactory } from "./trusted-native-fixture";

const FIRST_RANGE: TableRowRange = { from: 0, to: 10 };
const SECOND_RANGE: TableRowRange = { from: 10, to: 20 };
const HEADER = "| ID | Description |\n| --- | --- |\n";
const tableRows = (from: number, to: number): string => Array.from(
  { length: to - from },
  (_, offset) => `| Row-${from + offset} | Description-${from + offset} |`,
).join("\n") + "\n";

type RowViewProps = {
  readonly handle: TableNodeHandle;
  readonly range: TableRowRange;
  readonly onRender: (rows: readonly TableRowRecord[]) => void;
};

const TableRowsView = React.memo(function TableRowsView({ handle, range, onRender }: RowViewProps) {
  const rows = useTableRows(handle, range);
  onRender(rows);
  return (
    <ol data-table-row-range={`${range.from}:${range.to}`}>
      {rows.map((row) => <li key={row.id} data-row-index={row.index}>{row.cells[0]?.raw}</li>)}
    </ol>
  );
});

let metadataSnapshots: TableBlockMetadata[] = [];
let rowSnapshots: Array<readonly TableRowRecord[]> = [];
let rowRenderCount = 0;

function HeadlessTable({ handle }: { readonly handle: TableNodeHandle }): React.ReactElement {
  const metadata = useTableBlock(handle);
  const [range, setRange] = React.useState(FIRST_RANGE);
  metadataSnapshots.push(metadata);
  const captureRows = React.useCallback((rows: readonly TableRowRecord[]) => {
    rowRenderCount += 1;
    rowSnapshots.push(rows);
  }, []);
  return (
    <section
      data-headless-table
      data-row-count={metadata.rowCount}
      data-column-count={metadata.header.cells.length}
    >
      <button type="button" data-next-range onClick={() => setRange(SECOND_RANGE)}>Next range</button>
      <TableRowsView handle={handle} range={range} onRender={captureRows} />
      <NativeNodeView handle={handle} />
    </section>
  );
}

async function headlessTableHooksTrackOnlyTheRequestedRows(): Promise<void> {
  metadataSnapshots = [];
  rowSnapshots = [];
  rowRenderCount = 0;
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const stream = React.createRef<StreamingMarkdownHandle>();
  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={stream}
          worker={() => workerFactory()}
          contentPolicy="markdown"
          features={{ tables: true }}
          caret={false}
          components={{ table: { view: HeadlessTable } }}
        />,
      );
    });
    await waitFor(() => stream.current?.getState().workerReady === true, "worker ready");

    await act(async () => {
      stream.current?.append(HEADER + tableRows(0, 10));
    });
    await waitFor(() => Number(container.querySelector("[data-headless-table]")?.getAttribute("data-row-count")) >= 10,
      "headless table receives the first ten rows");
    await waitFor(
      () => container.querySelector("[data-headless-table] table") !== null,
      "the specialized table handle selects the native table fallback without presentation recursion",
    );
    assert.ok(rowRenderCount >= 1, "the requested row range renders while its first rows arrive");
    const rowRenderCountAtTen = rowRenderCount;
    assert.deepEqual(rowSnapshots.at(-1)?.map((row) => row.index), Array.from({ length: 10 }, (_, index) => index));
    const initialMetadata = metadataSnapshots[0];
    assert.ok(initialMetadata);
    const initialHeader = initialMetadata.header;

    await act(async () => {
      stream.current?.append(tableRows(10, 1000));
      await stream.current?.finalize();
    });
    await waitFor(() => container.querySelector("[data-headless-table]")?.getAttribute("data-row-count") === "1000",
      "headless table receives all streamed rows");
    assert.equal(rowRenderCount, rowRenderCountAtTen, "appends outside [0, 10) do not rerender the row-range view");
    assert.equal(metadataSnapshots.at(-1)?.header, initialHeader, "column metadata remains stable while rows append");
    assert.equal(metadataSnapshots.at(-1)?.header.cells.length, 2);
    assert.equal(metadataSnapshots.at(-1)?.rowCount, 1000);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-next-range]")?.click();
    });
    await waitFor(() => container.querySelector("[data-table-row-range]")?.getAttribute("data-table-row-range") === "10:20",
      "the headless row range changes");
    assert.equal(rowRenderCount, rowRenderCountAtTen + 1, "changing the requested range rerenders the row view once");
    assert.deepEqual(rowSnapshots.at(-1)?.map((row) => row.index), Array.from({ length: 10 }, (_, index) => index + 10));
    assert.equal(rowSnapshots.at(-1)?.[0]?.cells[0]?.raw, "Row-10");
  } finally {
    await act(async () => root.unmount());
    restore();
  }
}

await headlessTableHooksTrackOnlyTheRequestedRows();
console.log("native-table-handle-presentation test passed");
process.exit(0);
