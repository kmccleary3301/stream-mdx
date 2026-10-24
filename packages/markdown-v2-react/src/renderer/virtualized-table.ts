import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

export interface TableVirtualizationConfig {
  /** Enables opt-in table row virtualization. */
  enabled: boolean;
  /** Minimum body row count. Default: 40. */
  minRows: number;
  /** Alias for minRows. */
  virtualizeThreshold?: number;
  /** Height in pixels used until a row is measured. Default: 40. */
  estimatedRowHeight: number;
  /** Buffer rows on each side of the viewport, bounded to 1–50. Default: 8. */
  overscan: number;
  /** Scroll container maximum height. Default: "600px". */
  maxHeight: number | string;
}

export type TableVirtualizationOptions = boolean | Partial<TableVirtualizationConfig>;

export const DEFAULT_TABLE_VIRTUALIZATION_CONFIG: TableVirtualizationConfig = Object.freeze({
  enabled: false,
  minRows: 40,
  virtualizeThreshold: 40,
  estimatedRowHeight: 40,
  overscan: 8,
  maxHeight: "600px",
});

export function resolveTableVirtualizationConfig(options?: TableVirtualizationOptions): TableVirtualizationConfig {
  if (options === true) return { ...DEFAULT_TABLE_VIRTUALIZATION_CONFIG, enabled: true };
  if (!options) return DEFAULT_TABLE_VIRTUALIZATION_CONFIG;
  const threshold = options.minRows ?? options.virtualizeThreshold ?? 40;
  const minRows = Number.isFinite(threshold) ? Math.max(1, Math.floor(threshold)) : 40;
  const buffer = options.overscan ?? 8;
  const overscan = Number.isFinite(buffer) ? Math.min(50, Math.max(1, Math.floor(buffer))) : 8;
  const estimate = options.estimatedRowHeight ?? 40;
  return {
    enabled: options.enabled ?? true,
    minRows,
    virtualizeThreshold: minRows,
    estimatedRowHeight: Number.isFinite(estimate) && estimate > 0 ? estimate : 40,
    overscan,
    maxHeight: options.maxHeight ?? "600px",
  };
}

export interface TableVirtualizationRowRange {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly spacerBeforeHeight: number;
}

export interface TableVirtualizationProps {
  isVirtualized: boolean;
  rowRanges: ReadonlyArray<TableVirtualizationRowRange>;
  bottomSpacerHeight: number;
  columnCount: number;
  headerBackgroundColor: string;
}

interface NaturalTableLayout {
  table: HTMLTableElement;
  rowIdentity: object;
  viewportWidth: number;
  tableWidth: number;
  columnWidths: number[];
}

export interface IndexedTableRows {
  readonly length: number;
  readonly identity: object;
}

type TableRows = ReadonlyArray<string> | IndexedTableRows;

function indexedRows(rows: TableRows): rows is IndexedTableRows {
  return !Array.isArray(rows);
}

function fenwickPrefix(tree: ReadonlyMap<number, number>, count: number): number {
  let total = 0;
  for (let index = count; index > 0; index -= index & -index) total += tree.get(index) ?? 0;
  return total;
}

function fenwickAdd(tree: Map<number, number>, index: number, rowCount: number, delta: number): void {
  if (delta === 0) return;
  for (let cursor = index; cursor <= rowCount; cursor += cursor & -cursor) {
    const next = (tree.get(cursor) ?? 0) + delta;
    if (next === 0) tree.delete(cursor);
    else tree.set(cursor, next);
  }
}


// Only custom Table wrappers inside our viewport are managed, never consumer ancestors.
function normalizeTableScrollAncestors(table: HTMLTableElement, container: HTMLDivElement): () => void {
  const restore: Array<() => void> = [];
  const properties = ["overflow", "overflow-x", "overflow-y"];
  for (let ancestor = table.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
    const computed = ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor);
    if (!computed || ![computed.overflow, computed.overflowX, computed.overflowY].some(
      (value) => /^(auto|scroll|hidden|clip|overlay)$/.test(value),
    )) continue;
    const style = ancestor.style;
    const original = Array.from(style).filter((property) => properties.includes(property)).map((property) => ({
      property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property),
    }));
    for (const property of properties) style.removeProperty(property);
    style.setProperty("overflow", "visible", "important");
    const owned = properties.map((property) => ({
      property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property),
    }));
    restore.push(() => {
      // An inline author change transfers ownership. Do not overwrite it during cleanup.
      if (owned.some(({ property, value, priority }) =>
        style.getPropertyValue(property) !== value || style.getPropertyPriority(property) !== priority,
      )) return;
      for (const property of properties) style.removeProperty(property);
      for (const { property, value, priority } of original) style.setProperty(property, value, priority);
    });
  }
  return () => {
    for (const cleanup of restore) cleanup();
  };
}

interface TableDOMTargets {
  table: HTMLTableElement;
  header: HTMLTableSectionElement | null;
  rows: HTMLTableRowElement[];
}

interface TableViewportAnchor {
  rowId: string;
  offset: number;
  identity: object;
}

interface TablePrintSnapshot {
  identity: object;
  owner: number;
  scrollTop: number;
  atBottom: boolean;
  anchor: TableViewportAnchor | null;
}
interface RetainedTableRows {
  focusedRowIndex: number | null;
  selectionAnchorRowIndex: number | null;
  selectionFocusRowIndex: number | null;
  identity: object;
  owner: number;
}
/** Measurements follow stable renderer row IDs, not positions in the current window. */
export function useVirtualizedTable(
  rowIds: TableRows,
  config: TableVirtualizationConfig,
  enabledCondition: boolean,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [domTargets, setDOMTargets] = useState<TableDOMTargets | null>(null);
  const targetsRef = useRef<TableDOMTargets | null>(null);
  const viewportGeneration = useRef(0);
  const measurementGeneration = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const measuredWidth = useRef(0);
  const [retainedRows, setRetainedRows] = useState<RetainedTableRows | null>(null);
  const focusOwnerGeneration = useRef(0);
  const measuredHeights = useRef(new Map<string, number>());
  const indexedHeights = useRef(new Map<number, number>());
  const indexedOffsets = useRef(new Map<number, number>());
  const indexedRowCount = useRef<number | null>(null);
  const indexedIdentity = useRef<object | null>(null);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [naturalLayout, setNaturalLayout] = useState<NaturalTableLayout | null>(null);
  const [headerBackgroundColor, setHeaderBackgroundColor] = useState("Canvas");
  const atBottom = useRef(false);
  const viewportAnchor = useRef<TableViewportAnchor | null>(null);
  const printOwnerGeneration = useRef(0);
  const [printOwner, setPrintOwner] = useState<{ identity: object; generation: number } | null>(null);
  const [printGeometryOwner, setPrintGeometryOwner] = useState<number | null>(null);
  const isPrintingRef = useRef(false);
  const printGeometrySuspendedRef = useRef(false);
  const restoringPrintScrollRef = useRef(false);
  const printSnapshot = useRef<TablePrintSnapshot | null>(null);
  const rowCount = rowIds.length;
  const hasIndexedRows = indexedRows(rowIds);
  const rowIdentity = hasIndexedRows ? rowIds.identity : rowIds;
  const isPrinting = printOwner !== null && printOwner.identity === rowIdentity &&
    printOwner.generation === printOwnerGeneration.current;
  const isPrintGeometrySuspended = printGeometryOwner === printOwnerGeneration.current;
  const isEligible = enabledCondition && config.enabled && rowCount >= config.minRows;
  const isVirtualized = isEligible && domTargets !== null && naturalLayout?.table === domTargets.table &&
    naturalLayout.rowIdentity === rowIdentity && naturalLayout.viewportWidth === containerWidth;
  useEffect(() => {
    const container = containerRef.current;
    if (!isEligible || !container) return;
    const ownerWindow = container.ownerDocument.defaultView;
    if (!ownerWindow) return;
    const owner = ++printOwnerGeneration.current;
    const isCurrentOwner = () => printOwnerGeneration.current === owner && containerRef.current === container;
    const onBeforePrint = () => {
      if (!isCurrentOwner() || !container.isConnected || isPrintingRef.current) return;
      isPrintingRef.current = true;
      printGeometrySuspendedRef.current = true;
      printSnapshot.current = {
        identity: rowIdentity,
        owner,
        scrollTop: container.scrollTop,
        atBottom: atBottom.current,
        anchor: viewportAnchor.current,
      };
      measurementGeneration.current++;
      flushSync(() => {
        setPrintOwner({ identity: rowIdentity, generation: owner });
        setPrintGeometryOwner(owner);
      });
    };
    const onAfterPrint = () => {
      if (!isCurrentOwner() || !isPrintingRef.current) return;
      const snapshot = printSnapshot.current;
      if (!snapshot || snapshot.owner !== owner) return;
      measurementGeneration.current++;
      isPrintingRef.current = false;
      printSnapshot.current = null;
      flushSync(() => setPrintOwner(null));
      const restoreReader = snapshot.identity === rowIdentity && container.isConnected;
      if (restoreReader) {
        restoringPrintScrollRef.current = true;
        container.scrollTop = snapshot.scrollTop;
        atBottom.current = snapshot.atBottom;
        viewportAnchor.current = snapshot.anchor;
        flushSync(() => setScrollTop(container.scrollTop));
      }
      ownerWindow.requestAnimationFrame(() => {
        if (!isCurrentOwner() || isPrintingRef.current) return;
        if (restoreReader) restoringPrintScrollRef.current = false;
        printGeometrySuspendedRef.current = false;
        setPrintGeometryOwner((current) => current === owner ? null : current);
      });
    };
    ownerWindow.addEventListener("beforeprint", onBeforePrint);
    ownerWindow.addEventListener("afterprint", onAfterPrint);
    return () => {
      ownerWindow.removeEventListener("beforeprint", onBeforePrint);
      ownerWindow.removeEventListener("afterprint", onAfterPrint);
      if (printOwnerGeneration.current !== owner) return;
      printOwnerGeneration.current++;
      restoringPrintScrollRef.current = false;
      printGeometrySuspendedRef.current = false;
      if (printSnapshot.current?.owner !== owner) return;
      measurementGeneration.current++;
      isPrintingRef.current = false;
      printSnapshot.current = null;
    };
  }, [isEligible, rowIdentity]);
  const retainedRowIndices = useMemo(() => {
    if (!isVirtualized || !retainedRows || retainedRows.identity !== rowIdentity ||
      retainedRows.owner !== focusOwnerGeneration.current) return [];
    const indices: number[] = [];
    const focusIndex = retainedRows.focusedRowIndex;
    if (focusIndex !== null && Number.isSafeInteger(focusIndex) && focusIndex >= 0 &&
      focusIndex < rowCount) indices.push(focusIndex);
    const anchorIndex = retainedRows.selectionAnchorRowIndex;
    if (anchorIndex !== null && Number.isSafeInteger(anchorIndex) && anchorIndex >= 0 &&
      anchorIndex < rowCount && !indices.includes(anchorIndex)) indices.push(anchorIndex);
    const selectionFocusIndex = retainedRows.selectionFocusRowIndex;
    if (selectionFocusIndex !== null && Number.isSafeInteger(selectionFocusIndex) &&
      selectionFocusIndex >= 0 && selectionFocusIndex < rowCount && !indices.includes(selectionFocusIndex)) {
      indices.push(selectionFocusIndex);
    }
    for (let index = 1; index < indices.length; index++) {
      const current = indices[index];
      let insertAt = index;
      while (insertAt > 0 && indices[insertAt - 1] > current) {
        indices[insertAt] = indices[insertAt - 1];
        insertAt--;
      }
      indices[insertAt] = current;
    }
    return indices;
  }, [isVirtualized, retainedRows, rowIdentity, rowCount]);

  const offsets = useMemo(() => {
    void measureVersion;
    if (hasIndexedRows) return null;
    const next = new Float64Array(rowCount + 1);
    const ids = rowIds as ReadonlyArray<string>;
    for (let index = 0; index < rowCount; index++) {
      next[index + 1] = next[index] + (measuredHeights.current.get(ids[index]) ?? config.estimatedRowHeight);
    }
    return next;
  }, [rowIds, rowCount, hasIndexedRows, config.estimatedRowHeight, measureVersion]);
  const offsetAt = useCallback((index: number) => {
    if (hasIndexedRows) {
      const measuredCount = indexedIdentity.current === rowIdentity ? indexedRowCount.current ?? 0 : 0;
      return index * config.estimatedRowHeight +
        fenwickPrefix(indexedOffsets.current, Math.min(index, measuredCount));
    }
    return offsets?.[index] ?? index * config.estimatedRowHeight;
  }, [hasIndexedRows, rowIdentity, offsets, config.estimatedRowHeight, rowIds, measureVersion]);

  useEffect(() => {
    if (!hasIndexedRows) return;
    if (indexedIdentity.current !== rowIdentity) {
      indexedIdentity.current = rowIdentity;
      indexedOffsets.current.clear();
      indexedHeights.current.clear();
      indexedRowCount.current = rowCount;
      setMeasureVersion((version) => version + 1);
      return;
    }
    const previousCount = indexedRowCount.current ?? rowCount;
    if (rowCount < previousCount) {
      indexedOffsets.current.clear();
      indexedHeights.current.clear();
    } else {
      for (let index = previousCount + 1; index <= rowCount; index++) {
        const start = index - (index & -index);
        const offset = fenwickPrefix(indexedOffsets.current, index - 1) -
          fenwickPrefix(indexedOffsets.current, start);
        if (offset !== 0) indexedOffsets.current.set(index, offset);
      }
    }
    indexedRowCount.current = rowCount;
    if (rowCount !== previousCount) setMeasureVersion((version) => version + 1);
  }, [hasIndexedRows, rowIdentity, rowCount]);
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target !== containerRef.current || isPrintingRef.current || restoringPrintScrollRef.current) return;
    atBottom.current = target.scrollTop > 0 && target.scrollHeight - target.clientHeight - target.scrollTop <= 1;
    viewportAnchor.current = null;
    const targets = targetsRef.current;
    if (!atBottom.current && targets) {
      const top = target.getBoundingClientRect().top + target.clientTop;
      const headerCell = targets.header?.rows.item((targets.header?.rows.length ?? 1) - 1)?.cells.item(0);
      const visibleTop = Math.max(top, headerCell?.getBoundingClientRect().bottom ?? top);
      for (const row of targets.rows) {
        const id = row.dataset.rowId;
        if (!id || !row.isConnected) continue;
        const rect = row.getBoundingClientRect();
        if (rect.bottom > visibleTop && rect.top < top + target.clientHeight) {
          viewportAnchor.current = { rowId: id, offset: rect.top - top, identity: rowIdentity };
          break;
        }
      }
    }
    setScrollTop(target.scrollTop);
    setContainerHeight(target.clientHeight);
  }, [rowIdentity]);

  const window = useMemo(() => {
    if (!isVirtualized || rowCount === 0) {
      return {
        startIndex: 0,
        endIndex: rowCount,
        rowRanges: [] as TableVirtualizationRowRange[],
        bottomSpacerHeight: 0,
        mountedRows: rowCount,
      };
    }
    const fallbackHeight = typeof config.maxHeight === "number" ? config.maxHeight : 600;
    const viewportHeight = Math.max(1, (containerHeight || fallbackHeight) - headerHeight);
    const totalHeight = offsetAt(rowCount);
    const top = Math.min(Math.max(0, scrollTop), Math.max(0, totalHeight - viewportHeight));
    const bottom = top + viewportHeight;
    let low = 0;
    let high = rowCount;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (offsetAt(mid + 1) <= top) low = mid + 1;
      else high = mid;
    }
    const startIndex = Math.max(0, low - config.overscan);
    high = rowCount;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (offsetAt(mid) < bottom) low = mid + 1;
      else high = mid;
    }
    const endIndex = Math.min(rowCount, low + config.overscan);
    const intervals: Array<{ startIndex: number; endIndex: number; spacerBeforeHeight: number }> = [
      { startIndex, endIndex, spacerBeforeHeight: 0 },
    ];
    for (const index of retainedRowIndices) {
      if (index < startIndex || index >= endIndex) {
        intervals.push({ startIndex: index, endIndex: index + 1, spacerBeforeHeight: 0 });
      }
    }
    for (let index = 1; index < intervals.length; index++) {
      const current = intervals[index];
      let insertAt = index;
      while (insertAt > 0 && intervals[insertAt - 1].startIndex > current.startIndex) {
        intervals[insertAt] = intervals[insertAt - 1];
        insertAt--;
      }
      intervals[insertAt] = current;
    }
    let intervalCount = 0;
    for (const interval of intervals) {
      const previous = intervals[intervalCount - 1];
      if (previous && interval.startIndex <= previous.endIndex) {
        previous.endIndex = Math.max(previous.endIndex, interval.endIndex);
      } else {
        intervals[intervalCount++] = interval;
      }
    }
    intervals.length = intervalCount;
    let previousEnd = 0;
    let mountedRows = 0;
    for (const range of intervals) {
      range.spacerBeforeHeight = Math.max(0, offsetAt(range.startIndex) - offsetAt(previousEnd));
      previousEnd = range.endIndex;
      mountedRows += range.endIndex - range.startIndex;
    }
    return {
      startIndex,
      endIndex,
      rowRanges: intervals,
      bottomSpacerHeight: Math.max(0, totalHeight - offsetAt(previousEnd)),
      mountedRows,
    };
  }, [
    isVirtualized,
    rowCount,
    offsetAt,
    scrollTop,
    containerHeight,
    headerHeight,
    config.maxHeight,
    config.overscan,
    retainedRowIndices,
  ]);

  const invalidateMeasurements = useCallback(() => {
    measurementGeneration.current++;
    measuredHeights.current.clear();
    indexedHeights.current.clear();
    indexedOffsets.current.clear();
    measuredWidth.current = 0;
    atBottom.current = false;
    viewportAnchor.current = null;
    setNaturalLayout(null);
    setMeasureVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (container && container.scrollTop !== 0) container.scrollTop = 0;
    setScrollTop(0);
    invalidateMeasurements();
  }, [rowIdentity, invalidateMeasurements]);

  // Track actual DOM replacements, including adapters which replace their own native nodes.
  useEffect(() => {
    const container = containerRef.current;
    if (!isEligible || !container) return;
    const owner = ++viewportGeneration.current;
    const updateTargets = () => {
      if (viewportGeneration.current !== owner) return;
      const table = container.querySelector("table");
      if (!table) {
        if (targetsRef.current) {
          targetsRef.current = null;
          setDOMTargets(null);
          invalidateMeasurements();
        }
        return;
      }
      const header = table.querySelector("thead");
      const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]"));
      const previous = targetsRef.current;
      if (previous?.table === table && previous.header === header &&
        previous.rows.length === rows.length && previous.rows.every((row, index) => row === rows[index])) return;
      if (previous?.table !== table || previous.header !== header) invalidateMeasurements();
      const next = { table, header, rows };
      targetsRef.current = next;
      setDOMTargets(next);
    };
    updateTargets();
    const Observer = container.ownerDocument.defaultView?.MutationObserver;
    const observer = Observer ? new Observer(updateTargets) : null;
    observer?.observe(container, { childList: true, subtree: true });
    return () => {
      observer?.disconnect();
      if (viewportGeneration.current !== owner) return;
      viewportGeneration.current++;
      targetsRef.current = null;
      setDOMTargets(null);
      invalidateMeasurements();
    };
  }, [isEligible, invalidateMeasurements]);
  useEffect(() => {
    const container = containerRef.current;
    if (!isEligible || !domTargets || !container || container.querySelector("table") !== domTargets.table) return;
    const owner = ++focusOwnerGeneration.current;
    const updateOwnedRows = (update: (current: RetainedTableRows) => RetainedTableRows) => {
      setRetainedRows((current) => {
        if (focusOwnerGeneration.current !== owner) return current;
        const owned = current?.owner === owner && current.identity === rowIdentity
          ? current
          : {
            focusedRowIndex: null,
            selectionAnchorRowIndex: null,
            selectionFocusRowIndex: null,
            identity: rowIdentity,
            owner,
          };
        const next = update(owned);
        return next.focusedRowIndex === null &&
          next.selectionAnchorRowIndex === null && next.selectionFocusRowIndex === null
          ? null
          : next;
      });
    };
    const rowIndexForNode = (node: Node | null) => {
      const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
      const row = element?.closest<HTMLTableRowElement>("tr[data-row-index]") ?? null;
      const index = row && container.contains(row) ? Number(row.dataset.rowIndex) : Number.NaN;
      return Number.isSafeInteger(index) && index >= 0 ? index : null;
    };
    const onFocusIn = (event: FocusEvent) => {
      if (focusOwnerGeneration.current !== owner) return;
      const focusedRowIndex = rowIndexForNode(event.target as Node | null);
      updateOwnedRows((current) => current.focusedRowIndex === focusedRowIndex
        ? current
        : { ...current, focusedRowIndex });
    };
    const onFocusOut = (event: FocusEvent) => {
      if (focusOwnerGeneration.current !== owner) return;
      const nextTarget = event.relatedTarget;
      if (nextTarget && "nodeType" in nextTarget && container.contains(nextTarget as Node)) return;
      updateOwnedRows((current) => current.focusedRowIndex === null
        ? current
        : { ...current, focusedRowIndex: null });
    };
    const onSelectionChange = () => {
      if (focusOwnerGeneration.current !== owner) return;
      const selection = container.ownerDocument.getSelection();
      const selectionAnchorRowIndex = rowIndexForNode(selection?.anchorNode ?? null);
      const selectionFocusRowIndex = rowIndexForNode(selection?.focusNode ?? null);
      updateOwnedRows((current) =>
        current.selectionAnchorRowIndex === selectionAnchorRowIndex &&
        current.selectionFocusRowIndex === selectionFocusRowIndex
          ? current
          : { ...current, selectionAnchorRowIndex, selectionFocusRowIndex });
    };
    container.addEventListener("focusin", onFocusIn);
    container.addEventListener("focusout", onFocusOut);
    container.ownerDocument.addEventListener("selectionchange", onSelectionChange);
    return () => {
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("focusout", onFocusOut);
      container.ownerDocument.removeEventListener("selectionchange", onSelectionChange);
      if (focusOwnerGeneration.current !== owner) return;
      focusOwnerGeneration.current++;
      setRetainedRows((current) => current?.owner === owner ? null : current);
    };
  }, [isEligible, domTargets?.table, rowIdentity]);

  useEffect(() => {
    if (!isEligible || !domTargets || isPrintGeometrySuspended || printGeometrySuspendedRef.current || isPrintingRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const { header } = domTargets;
    const generation = measurementGeneration.current;
    let active = true;
    const measureContainer = () => {
      if (!active || measurementGeneration.current !== generation || isPrintGeometrySuspended || printGeometrySuspendedRef.current || isPrintingRef.current) return;
      if (container.querySelector("table") !== domTargets.table) return;
      setScrollTop(container.scrollTop);
      setContainerHeight(container.clientHeight);
      setHeaderHeight(header?.getBoundingClientRect().height ?? 0);
      const width = container.clientWidth;
      if (measuredWidth.current !== width) {
        measuredHeights.current.clear();
        indexedHeights.current.clear();
        indexedOffsets.current.clear();
        measuredWidth.current = width;
        setContainerWidth(width);
        setMeasureVersion((version) => version + 1);
      }
    };
    measureContainer();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureContainer);
    observer.observe(container);
    if (header) observer.observe(header);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [isEligible, domTargets?.table, domTargets?.header, config.maxHeight, isPrinting, isPrintGeometrySuspended]);

  useEffect(() => {
    if (!isEligible || !domTargets) return;
    const container = containerRef.current;
    const table = domTargets.table;
    if (!container || !table) return;
    return normalizeTableScrollAncestors(table, container);
  }, [isEligible, domTargets?.table]);

  // Commit the header and first bounded row chunk before each initial or width-change measurement.
  useEffect(() => {
    if (!isEligible || isVirtualized || !domTargets || isPrintGeometrySuspended || printGeometrySuspendedRef.current || isPrintingRef.current) return;
    const container = containerRef.current;
    const table = domTargets.table;
    if (!container || !table) return;
    const cells = table.querySelectorAll<HTMLTableCellElement>("thead tr:first-child > th, thead tr:first-child > td");
    const naturalCells = cells.length ? cells : table.querySelectorAll<HTMLTableCellElement>("tbody tr:first-child > td");
    const columnWidths = Array.from(naturalCells, (cell) => cell.getBoundingClientRect().width);
    setNaturalLayout({
      table,
      rowIdentity,
      viewportWidth: container.clientWidth,
      tableWidth: table.getBoundingClientRect().width,
      columnWidths: columnWidths.every((width) => width > 0) ? columnWidths : [],
    });
  }, [isEligible, isVirtualized, domTargets?.table, rowIdentity, containerWidth, isPrinting, isPrintGeometrySuspended]);

  useEffect(() => {
    if (!isEligible) return;
    const container = containerRef.current;
    if (!container) return;
    const ancestors: HTMLElement[] = [];
    const owner = viewportGeneration.current;
    for (let ancestor: HTMLElement | null = container; ancestor; ancestor = ancestor.parentElement) ancestors.push(ancestor);
    const updateBackground = () => {
      if (!container.isConnected || viewportGeneration.current !== owner) return;
      for (const ancestor of ancestors) {
        const color = ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor).backgroundColor;
        if (!color || color === "transparent") continue;
        if (color.startsWith("rgba(") && !/,\s*1(?:\.0*)?\)$/.test(color)) continue;
        if (color.includes("/") && !/\/\s*1(?:\.0*)?\)$/.test(color)) continue;
        setHeaderBackgroundColor(color);
        return;
      }
      setHeaderBackgroundColor("Canvas");
    };
    updateBackground();
    const Observer = container.ownerDocument.defaultView?.MutationObserver;
    if (!Observer) return;
    const observer = new Observer(updateBackground);
    for (const ancestor of ancestors) observer.observe(ancestor, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, [isEligible]);

  useEffect(() => {
    if (!isVirtualized || !domTargets || isPrintGeometrySuspended || printGeometrySuspendedRef.current || isPrintingRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const { rows } = domTargets;
    const generation = measurementGeneration.current;
    let active = true;
    const measureRows = () => {
      if (!active || measurementGeneration.current !== generation || isPrintGeometrySuspended || printGeometrySuspendedRef.current || isPrintingRef.current) return;
      if (container.querySelector("table") !== domTargets.table || naturalLayout?.viewportWidth !== container.clientWidth) return;
      const top = container.getBoundingClientRect().top + container.clientTop;
      const anchor = viewportAnchor.current;
      if (!atBottom.current && anchor?.identity === rowIdentity) {
        const row = rows.find((candidate) => candidate.dataset.rowId === anchor.rowId);
        if (row?.isConnected && container.contains(row)) {
          const delta = row.getBoundingClientRect().top - top - anchor.offset;
          if (Math.abs(delta) > 0.5) {
            container.scrollTop += delta;
            setScrollTop(container.scrollTop);
          }
        }
      }
      const headerCell = domTargets.header?.rows.item((domTargets.header?.rows.length ?? 1) - 1)?.cells.item(0);
      const visibleTop = Math.max(top, headerCell?.getBoundingClientRect().bottom ?? top);
      let nextAnchor: TableViewportAnchor | null = null;
      let changed = false;
      for (const row of rows) {
        if (!row.isConnected || !container.contains(row)) continue;
        const id = row.dataset.rowId;
        const rect = row.getBoundingClientRect();
        const height = rect.height || row.offsetHeight;
        if (!id || height <= 0) continue;
        if (!nextAnchor && rect.bottom > visibleTop && rect.top < top + container.clientHeight) {
          nextAnchor = { rowId: id, offset: rect.top - top, identity: rowIdentity };
        }
        if (hasIndexedRows) {
          const rowIndex = Number(row.dataset.rowIndex);
          if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || rowIndex >= rowCount) continue;
          const previous = indexedHeights.current.get(rowIndex);
          if (previous === undefined || Math.abs(previous - height) > 0.5) {
            indexedHeights.current.set(rowIndex, height);
            fenwickAdd(indexedOffsets.current, rowIndex + 1, rowCount, height - (previous ?? config.estimatedRowHeight));
            changed = true;
          }
        } else {
          const previous = measuredHeights.current.get(id);
          if (previous === undefined || Math.abs(previous - height) > 0.5) {
            measuredHeights.current.set(id, height);
            changed = true;
          }
        }
      }
      viewportAnchor.current = nextAnchor;
      if (changed) setMeasureVersion((version) => version + 1);
    };
    measureRows();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureRows);
    for (const row of rows) observer.observe(row);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [isVirtualized, domTargets?.rows, rowIds, rowCount, rowIdentity, hasIndexedRows, window.startIndex, window.endIndex, containerWidth, config.estimatedRowHeight, isPrinting, isPrintGeometrySuspended]);

  // Newly measured tail rows may move the scroll boundary. Keep a bottom scroll at the bottom.
  useEffect(() => {
    const container = containerRef.current;
    if (!isVirtualized || !container || !atBottom.current || isPrintGeometrySuspended || printGeometrySuspendedRef.current || isPrintingRef.current) return;
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    setScrollTop(container.scrollTop);
  }, [isVirtualized, offsetAt, isPrinting, isPrintGeometrySuspended]);

  return { containerRef, window, handleScroll, config, isEligible, isVirtualized, isPrinting, naturalLayout, headerBackgroundColor };
}
