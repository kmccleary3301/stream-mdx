declare const __STREAM_MDX_COUNTERS__: boolean;

import { type InlineNode, type TableCellRecord, type TableHeaderRecord, type TableRowRecord } from "@stream-mdx/core";
import React from "react";
import type { TableElements } from "../types";
import {
  TableControlsBar,
  copyToClipboard,
  downloadFile,
  inlineToPlainText,
  renderInlineNodes,
  resolveTableControls,
  tableToCsv,
  tableToMarkdown,
  tableToTsv,
} from "../components";
import type { ComponentRegistry } from "../components";
import type { TableControlsData } from "../components/controls";
import { useRendererNode } from "./hooks";
import { subscribeRendererNode } from "./node-subscriptions";
import type { RendererStore } from "./store";
import { TABLE_ROW_RANGE_SIZE } from "./table-row-range";
import { StreamingActivityContext } from "./streaming-activity-context";
import { useVirtualizedTable, type IndexedTableRows } from "./virtualized-table";

type ReactTableViewCounterSink = {
  recordStoreRecordsTouched?(count: number, stage: "view"): void;
  recordRecordSlotsAllocated?(count: number, stage: "view"): void;
  recordTableViewRows(count: number): void;
  recordTableViewCells(count: number): void;
};
type TableViewCounterStore = RendererStore & { campaignCounters?: ReactTableViewCounterSink };

function getTableViewCounterSink(store: RendererStore): ReactTableViewCounterSink | undefined {
  return (store as TableViewCounterStore).campaignCounters;
}

function recordViewRecords(store: RendererStore, count: number): void {
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    getTableViewCounterSink(store)?.recordStoreRecordsTouched?.(count, "view");
  }
}

function recordTableRangeDescriptor(store: RendererStore): void {
  if (typeof __STREAM_MDX_COUNTERS__ === "undefined" || !__STREAM_MDX_COUNTERS__) return;
  const counters = getTableViewCounterSink(store);
  counters?.recordStoreRecordsTouched?.(1, "view");
  counters?.recordRecordSlotsAllocated?.(1, "view");
}

function recordTableViewCallbacks(store: RendererStore, rows: number, cells: number): void {
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    const counters = getTableViewCounterSink(store);
    if (!counters) return;
    if (rows > 0) counters.recordTableViewRows(rows);
    if (cells > 0) counters.recordTableViewCells(cells);
  }
}

const EMPTY_MANAGED_TABLE_ROWS: ReadonlyArray<TableRowRecord> = Object.freeze([]);
const EMPTY_TABLE_TEXT_ROWS: string[][] = [];

export const ManagedTableBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const node = useRendererNode(store, blockId);
  const tableState = store.getTableBlock(blockId);
  const streamingActive = React.useContext(StreamingActivityContext);
  const generation = tableState?.source.generation;
  const tableElements = registry.getTableElements();
  const subscribeVirtualization = React.useCallback(
    (listener: () => void) => registry.subscribeTableVirtualization(listener),
    [registry],
  );
  const getVirtualization = React.useCallback(() => registry.getTableVirtualization(), [registry]);
  const virtualizationConfig = React.useSyncExternalStore(subscribeVirtualization, getVirtualization, getVirtualization);
  const virtualizationDisabled =
    typeof process !== "undefined" && typeof process.env === "object" && process.env.STREAM_MDX_DISABLE_VIRTUALIZED_TABLE === "true";
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);

  const rowIdentity = React.useMemo(() => ({}), [blockId, tableState?.source.generation]);
  const rowCount = tableState?.rows.length ?? 0;
  const rowSource = React.useMemo<IndexedTableRows>(
    () => ({ length: rowCount, identity: rowIdentity }),
    [rowCount, rowIdentity],
  );
  const canVirtualize = mounted && typeof window !== "undefined" && !virtualizationDisabled &&
    Boolean(node?.block?.isFinalized) && !streamingActive;
  const virtualization = useVirtualizedTable(rowSource, virtualizationConfig, canVirtualize);
  const { isEligible, isVirtualized, containerRef, handleScroll, window: virtualWindow, config, naturalLayout, headerBackgroundColor } = virtualization;
  const header = tableState?.header;
  const columnCount = Math.max(1, header?.cells.length ?? 0);
  const startIndex = isVirtualized ? virtualWindow.startIndex : 0;
  const endIndex = isVirtualized ? virtualWindow.endIndex : rowCount;
  const committed = tableState?.source.state !== "open";
  const headerText = React.useMemo(
    () => header?.cells.map((cell) => inlineToPlainText(cell.inline as InlineNode[])) ?? [],
    [header],
  );
  const align = React.useMemo(() => header?.align.slice() ?? [], [header]);

  const tableAttrs = {
    "data-table-block": "true",
    "data-block-id": blockId,
    "data-table-virtualized": isVirtualized ? "true" : "false",
    "data-table-total-rows": String(rowCount),
    "data-table-mounted-rows": String(isVirtualized ? virtualWindow.mountedRows : rowCount),
    "data-table-start-index": String(isVirtualized ? virtualWindow.startIndex : 0),
    "data-table-end-index": String(isVirtualized ? virtualWindow.endIndex : rowCount),
  };

  let rowRanges: React.ReactNode;
  if (!isVirtualized && !registry.hasElementFilters()) {
    rowRanges = (
      <ManagedTableRowRangeTail
        key={`${blockId}::rows:${tableState?.source.generation ?? -1}:tail`}
        store={store}
        blockId={blockId}
        generation={tableState?.source.generation ?? -1}
        chunkStart={0}
        align={header?.align}
        registry={registry}
        tableElements={tableElements}
      />
    );
  } else {
    const ranges: React.ReactNode[] = [];
    for (
      let chunkStart = Math.floor(startIndex / TABLE_ROW_RANGE_SIZE) * TABLE_ROW_RANGE_SIZE;
      chunkStart < endIndex;
      chunkStart += TABLE_ROW_RANGE_SIZE
    ) {
      ranges.push(
        <ManagedTableRowRangeView
          key={`${blockId}::rows:${chunkStart}`}
          store={store}
          blockId={blockId}
          generation={tableState?.source.generation ?? -1}
          chunkStart={chunkStart}
          visibleStart={Math.max(startIndex, chunkStart)}
          visibleEnd={Math.min(endIndex, chunkStart + TABLE_ROW_RANGE_SIZE)}
          align={header?.align}
          registry={registry}
          tableElements={tableElements}
        />,
      );
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordTableRangeDescriptor(store);
      }
    }
    rowRanges = ranges;
  }

  // A committed table without rows has no body (GFM); an open one keeps it mounted for the rows still to stream.
  const hasBody = !committed || rowCount > 0;
  const renderSections = () => (
    <>
      {header ? (
        <ManagedTableHeaderView
          store={store}
          header={header}
          sticky={isVirtualized}
          headerBackgroundColor={headerBackgroundColor}
          registry={registry}
          tableElements={tableElements}
        />
      ) : null}
      {hasBody ? <tableElements.Tbody>
        {isVirtualized && virtualWindow.topSpacerHeight > 0 ? (
          <tableElements.Tr
            key={`${blockId}::spacer-top`}
            aria-hidden="true"
            className="markdown-table-spacer markdown-table-spacer-top"
            style={{ height: `${virtualWindow.topSpacerHeight}px`, padding: 0, border: 0 }}
          >
            <tableElements.Td
              colSpan={columnCount}
              style={{ height: `${virtualWindow.topSpacerHeight}px`, padding: 0, border: 0, margin: 0, lineHeight: 0 }}
            />
          </tableElements.Tr>
        ) : null}
        {rowRanges}
        {isVirtualized && virtualWindow.bottomSpacerHeight > 0 ? (
          <tableElements.Tr
            key={`${blockId}::spacer-bottom`}
            aria-hidden="true"
            className="markdown-table-spacer markdown-table-spacer-bottom"
            style={{ height: `${virtualWindow.bottomSpacerHeight}px`, padding: 0, border: 0 }}
          >
            <tableElements.Td
              colSpan={columnCount}
              style={{ height: `${virtualWindow.bottomSpacerHeight}px`, padding: 0, border: 0, margin: 0, lineHeight: 0 }}
            />
          </tableElements.Tr>
        ) : null}
      </tableElements.Tbody> : null}
    </>
  );

  const tableElement = (
    <tableElements.Table
      className="markdown-table w-full caption-bottom text-base"
      style={isVirtualized && naturalLayout?.columnWidths.length
        ? { tableLayout: "fixed", width: naturalLayout.tableWidth }
        : undefined}
      {...(!isEligible ? tableAttrs : {})}
    >
      {isVirtualized && naturalLayout?.columnWidths.length ? (
        <colgroup>
          {naturalLayout.columnWidths.map((width, index) => <col key={index} style={{ width }} />)}
        </colgroup>
      ) : null}
      {renderSections()}
    </tableElements.Table>
  );
  const filteredTable = registry.hasElementFilters()
    ? registry.filterElement(
        { tagName: "table", properties: { className: "markdown-table" }, blockType: "table" },
        { source: "markdown" },
        () => tableElement,
        renderSections,
      )
    : tableElement;

  const renderedContent = isEligible ? (
    <div
      ref={containerRef}
      className="markdown-table-container relative w-full"
      style={{
        overflowY: "auto",
        overflowX: "auto",
        maxHeight: typeof config.maxHeight === "number" ? `${config.maxHeight}px` : config.maxHeight,
        overflowAnchor: "none",
      }}
      onScroll={handleScroll}
      tabIndex={0}
      role="region"
      aria-label="Scrollable table"
      {...tableAttrs}
    >
      {filteredTable}
    </div>
  ) : React.isValidElement(filteredTable) ? filteredTable : <>{filteredTable}</>;

  const resolvedTableControls = resolveTableControls(registry.getControls());
  const ControlsComponent = registry.getControlsComponent();
  const getTableData = React.useCallback((): TableControlsData => {
    const current = store.getTableBlock(blockId);
    if (!current || current.source.generation !== generation) {
      throw new Error("Table content belongs to a replaced or disposed owner");
    }
    const rows = store.getTableRows(blockId, 0, current.rows.length);
    let inspectedRecords = 0;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      inspectedRecords = 1 + current.header.cells.length;
    }
    const textRows = rows.map((row) => {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        inspectedRecords += 1 + row.cells.length;
      }
      return row.cells.map((cell) => inlineToPlainText(cell.inline as InlineNode[]));
    });
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      recordViewRecords(store, inspectedRecords);
    }
    return {
      headers: current.header.cells.map((cell) => inlineToPlainText(cell.inline as InlineNode[])),
      rows: textRows,
      align: current.header.align.slice(),
    };
  }, [blockId, generation, store]);
  if (!node || filteredTable === null || filteredTable === undefined) return null;
  if (!resolvedTableControls.enabled || !tableState) return renderedContent;

  const tableControlsElement = ControlsComponent ? (
    <ControlsComponent
      type="table"
      blockId={blockId}
      headers={headerText}
      align={align}
      getTableData={getTableData}
      isFinalized={committed}
      onCopy={(format) => {
        if (!committed) return;
        const data = getTableData();
        const text = format === "markdown" ? tableToMarkdown(data.headers, data.rows, data.align) : tableToTsv(data.headers, data.rows);
        return copyToClipboard(text);
      }}
      onDownload={(format) => {
        if (!committed) return;
        const data = getTableData();
        if (format === "tsv") {
          downloadFile(tableToTsv(data.headers, data.rows), "table.tsv", "text/tab-separated-values;charset=utf-8");
        } else if (format === "markdown") {
          downloadFile(tableToMarkdown(data.headers, data.rows, data.align), "table.md", "text/markdown;charset=utf-8");
        } else {
          downloadFile(tableToCsv(data.headers, data.rows), "table.csv", "text/csv;charset=utf-8");
        }
      }}
      labels={resolvedTableControls.labels}
    />
  ) : (
    <TableControlsBar
      headers={headerText}
      rows={EMPTY_TABLE_TEXT_ROWS}
      align={align}
      getTableData={getTableData}
      isFinalized={committed}
      config={resolvedTableControls}
    />
  );
  return (
    <div className="stream-mdx-table-wrapper relative">
      {tableControlsElement}
      {renderedContent}
    </div>
  );
});

ManagedTableBlockView.displayName = "ManagedTableBlockView";

const ManagedTableHeaderView: React.FC<{
  store: RendererStore;
  header: TableHeaderRecord;
  sticky: boolean;
  headerBackgroundColor: string;
  registry: ComponentRegistry;
  tableElements: TableElements;
}> = React.memo(({ store, header, sticky, headerBackgroundColor, registry, tableElements }) => {
  let renderedCells = 0;
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordViewRecords(store, header.cells.length + 1);
  }
  const headerCells = header.cells.map((cell, index) => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      renderedCells += 1;
    }
    return (
      <ManagedTableCellView
        key={cell.id}
        cell={cell}
        isHeader
        isFinalized
        align={header.align[index]}
        registry={registry}
        tableElements={tableElements}
      />
    );
  });
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordTableViewCallbacks(store, 0, renderedCells);
  }
  return (
    <tableElements.Thead
      className={sticky ? "sticky top-0 z-10" : undefined}
      style={sticky ? {
        position: "sticky",
        top: 0,
        zIndex: 10,
        backgroundColor: `var(--stream-mdx-table-header-background, ${headerBackgroundColor})`,
      } : undefined}
    >
      <tableElements.Tr>
        {headerCells}
      </tableElements.Tr>
    </tableElements.Thead>
  );
});
ManagedTableHeaderView.displayName = "ManagedTableHeaderView";

const ManagedTableRowRangeView: React.FC<{
  store: RendererStore;
  blockId: string;
  generation: number;
  chunkStart: number;
  visibleStart: number;
  visibleEnd: number;
  align?: ReadonlyArray<"left" | "center" | "right" | null>;
  registry: ComponentRegistry;
  tableElements: TableElements;
}> = React.memo(({ store, blockId, generation, chunkStart, visibleStart, visibleEnd, align, registry, tableElements }) => {
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribeTableRows(blockId, chunkStart, chunkStart + TABLE_ROW_RANGE_SIZE, listener),
    [blockId, chunkStart, store],
  );
  const readRows = React.useCallback(() => {
    const current = store.getTableBlock(blockId);
    if (!current || current.source.generation !== generation) return EMPTY_MANAGED_TABLE_ROWS;
    return store.getTableRows(blockId, chunkStart, chunkStart + TABLE_ROW_RANGE_SIZE);
  }, [blockId, chunkStart, generation, store]);
  const rows = React.useSyncExternalStore(subscribe, readRows, readRows);
  const renderedRows = React.useMemo(() => {
    const elements: React.ReactElement[] = [];
    let inspectedRecords = 0;
    let renderedBodyRows = 0;
    let renderedBodyCells = 0;
    for (const row of rows) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        inspectedRecords += 1;
      }
      if (row.index < visibleStart || row.index >= visibleEnd) continue;
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        inspectedRecords += row.cells.length;
        renderedBodyRows += 1;
      }
      elements.push(
        <tableElements.Tr key={row.id} data-row-id={row.id} data-row-index={row.index}>
          {row.cells.map((cell) => {
            if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
              renderedBodyCells += 1;
            }
            return (
              <ManagedTableCellView
                key={cell.id}
                cell={cell}
                isHeader={false}
                isFinalized={!row.isProvisional}
                align={align?.[cell.index]}
                registry={registry}
                tableElements={tableElements}
              />
            );
          })}
        </tableElements.Tr>,
      );
    }
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      recordViewRecords(store, inspectedRecords);
      recordTableViewCallbacks(store, renderedBodyRows, renderedBodyCells);
    }
    return elements;
  }, [align, registry, rows, store, tableElements, visibleEnd, visibleStart]);
  return <>{renderedRows}</>;
});
ManagedTableRowRangeView.displayName = "ManagedTableRowRangeView";

const ManagedTableRowRangeTail: React.FC<{
  store: RendererStore;
  blockId: string;
  generation: number;
  chunkStart: number;
  align?: ReadonlyArray<"left" | "center" | "right" | null>;
  registry: ComponentRegistry;
  tableElements: TableElements;
}> = React.memo(({ store, blockId, generation, chunkStart, align, registry, tableElements }) => {
  const getFrontier = React.useCallback((): "ready" | "open" | "sealed" | "stale" => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      recordViewRecords(store, 1);
    }
    const current = store.getTableBlock(blockId);
    if (!current || current.source.generation !== generation) return "stale";
    if (current.rows.length > chunkStart) return "ready";
    return current.source.state === "open" ? "open" : "sealed";
  }, [blockId, chunkStart, generation, store]);
  const subscribe = React.useCallback((listener: () => void) => {
    let active = true;
    let unsubscribeRows = () => {};
    let unsubscribeNode = () => {};
    const onOwnerChanged = () => {
      if (!active || getFrontier() === "open") return;
      active = false;
      unsubscribeRows();
      unsubscribeNode();
      listener();
    };
    unsubscribeRows = store.subscribeTableRows(
      blockId,
      chunkStart,
      chunkStart + TABLE_ROW_RANGE_SIZE,
      onOwnerChanged,
    );
    unsubscribeNode = subscribeRendererNode(store, blockId, onOwnerChanged);
    if (getFrontier() !== "open") {
      active = false;
      unsubscribeRows();
      unsubscribeNode();
    }
    return () => {
      active = false;
      unsubscribeRows();
      unsubscribeNode();
    };
  }, [blockId, chunkStart, getFrontier, store]);
  const frontier = React.useSyncExternalStore(subscribe, getFrontier, getFrontier);
  return frontier === "ready" ? (
    <ManagedTableRowRangeChain
      store={store}
      blockId={blockId}
      generation={generation}
      chunkStart={chunkStart}
      align={align}
      registry={registry}
      tableElements={tableElements}
    />
  ) : null;
});

ManagedTableRowRangeTail.displayName = "ManagedTableRowRangeTail";

const ManagedTableRowRangeChain: React.FC<{
  store: RendererStore;
  blockId: string;
  generation: number;
  chunkStart: number;
  align?: ReadonlyArray<"left" | "center" | "right" | null>;
  registry: ComponentRegistry;
  tableElements: TableElements;
}> = React.memo(({ store, blockId, generation, chunkStart, align, registry, tableElements }) => {
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordTableRangeDescriptor(store);
  }
  return (
    <>
      <ManagedTableRowRangeView
        key={`${blockId}::rows:${chunkStart}`}
        store={store}
        blockId={blockId}
        generation={generation}
        chunkStart={chunkStart}
        visibleStart={chunkStart}
        visibleEnd={chunkStart + TABLE_ROW_RANGE_SIZE}
        align={align}
        registry={registry}
        tableElements={tableElements}
      />
      <ManagedTableRowRangeTail
        key={`${blockId}::rows:${chunkStart + TABLE_ROW_RANGE_SIZE}:tail`}
        store={store}
        blockId={blockId}
        generation={generation}
        chunkStart={chunkStart + TABLE_ROW_RANGE_SIZE}
        align={align}
        registry={registry}
        tableElements={tableElements}
      />
    </>
  );
});

ManagedTableRowRangeChain.displayName = "ManagedTableRowRangeChain";

const ManagedTableCellView: React.FC<{
  cell: TableCellRecord;
  isHeader: boolean;
  isFinalized: boolean;
  align?: string | null;
  registry: ComponentRegistry;
  tableElements: TableElements;
}> = React.memo(({ cell, isHeader, isFinalized, align, registry, tableElements }) => {
  const inlineComponents = registry.getInlineComponents();
  const Tag = isHeader ? tableElements.Th : tableElements.Td;
  const tag = isHeader ? "th" : "td";
  const inline = cell.inline as InlineNode[];
  const animCtx = registry.getRenderInlineContext(isFinalized, cell.id);
  const content = renderInlineNodes(inline, inlineComponents, registry.getUrlTransform(), registry, tag, animCtx);
  const alignProps = align ? { align } : undefined;
  const renderElement = () => <Tag {...alignProps}>{content}</Tag>;
  if (!registry.hasElementFilters()) return renderElement();
  const filtered = registry.filterElement(
    { tagName: tag, properties: alignProps ?? {} },
    { source: "markdown", parentTagName: "tr" },
    renderElement,
    () => content,
  );
  if (filtered === null || filtered === undefined) return null;
  return React.isValidElement(filtered) ? filtered : <>{filtered}</>;
});

ManagedTableCellView.displayName = "ManagedTableCellView";

