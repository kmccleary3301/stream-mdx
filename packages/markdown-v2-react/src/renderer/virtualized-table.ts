import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface TableVirtualizationConfig {
  /** Disabled by default. Only mounted, finalized tables can virtualize. */
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

export interface TableVirtualizationProps {
  isVirtualized: boolean;
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  columnCount: number;
  headerBackgroundColor: string;
}

interface NaturalTableLayout {
  rowIds: ReadonlyArray<string>;
  viewportWidth: number;
  tableWidth: number;
  columnWidths: number[];
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

/** Measurements follow stable renderer row IDs, not positions in the current window. */
export function useVirtualizedTable(
  rowIds: ReadonlyArray<string>,
  config: TableVirtualizationConfig,
  enabledCondition: boolean,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const measuredWidth = useRef(0);
  const measuredHeights = useRef(new Map<string, number>());
  const [measureVersion, setMeasureVersion] = useState(0);
  const [naturalLayout, setNaturalLayout] = useState<NaturalTableLayout | null>(null);
  const [headerBackgroundColor, setHeaderBackgroundColor] = useState("Canvas");
  const atBottom = useRef(false);
  const rowCount = rowIds.length;
  const isEligible = enabledCondition && config.enabled && rowCount >= config.minRows;
  const isVirtualized = isEligible && naturalLayout?.rowIds === rowIds && naturalLayout.viewportWidth === containerWidth;

  // Rebuild only when measurements or rows change, never for a scroll event.
  const offsets = useMemo(() => {
    void measureVersion;
    const next = new Float64Array(rowCount + 1);
    for (let index = 0; index < rowCount; index++) {
      next[index + 1] = next[index] + (measuredHeights.current.get(rowIds[index]) ?? config.estimatedRowHeight);
    }
    return next;
  }, [rowIds, rowCount, config.estimatedRowHeight, measureVersion]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    atBottom.current = target.scrollTop > 0 && target.scrollHeight - target.clientHeight - target.scrollTop <= 1;
    setScrollTop(target.scrollTop);
    setContainerHeight(target.clientHeight);
  }, []);

  const window = useMemo(() => {
    if (!isVirtualized || rowCount === 0) {
      return { startIndex: 0, endIndex: rowCount, topSpacerHeight: 0, bottomSpacerHeight: 0, mountedRows: rowCount };
    }
    const fallbackHeight = typeof config.maxHeight === "number" ? config.maxHeight : 600;
    const viewportHeight = Math.max(1, (containerHeight || fallbackHeight) - headerHeight);
    const top = Math.min(Math.max(0, scrollTop), Math.max(0, offsets[rowCount] - viewportHeight));
    const bottom = top + viewportHeight;
    let low = 0;
    let high = rowCount;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (offsets[mid + 1] <= top) low = mid + 1;
      else high = mid;
    }
    const startIndex = Math.max(0, low - config.overscan);
    high = rowCount;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (offsets[mid] < bottom) low = mid + 1;
      else high = mid;
    }
    const endIndex = Math.min(rowCount, low + config.overscan);
    return {
      startIndex,
      endIndex,
      topSpacerHeight: offsets[startIndex],
      bottomSpacerHeight: offsets[rowCount] - offsets[endIndex],
      mountedRows: endIndex - startIndex,
    };
  }, [isVirtualized, rowCount, offsets, scrollTop, containerHeight, headerHeight, config.maxHeight, config.overscan]);

  useEffect(() => {
    if (!isEligible) return;
    const container = containerRef.current;
    if (!container) return;
    const header = container.querySelector("thead");
    const measureContainer = () => {
      setScrollTop(container.scrollTop);
      setContainerHeight(container.clientHeight);
      setHeaderHeight(header?.getBoundingClientRect().height ?? 0);
      const width = container.clientWidth;
      if (measuredWidth.current !== width) {
        measuredHeights.current.clear();
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
    return () => observer.disconnect();
  }, [isEligible, config.maxHeight]);

  useEffect(() => {
    if (!isEligible) return;
    const container = containerRef.current;
    const table = container?.querySelector("table");
    if (!container || !table) return;
    return normalizeTableScrollAncestors(table, container);
  }, [isEligible]);

  // The complete auto-layout table is committed before each initial/width-change window.
  useEffect(() => {
    if (!isEligible || isVirtualized) return;
    const container = containerRef.current;
    const table = container?.querySelector("table");
    if (!container || !table) return;
    const cells = table.querySelectorAll<HTMLTableCellElement>("thead tr:first-child > th, thead tr:first-child > td");
    const naturalCells = cells.length ? cells : table.querySelectorAll<HTMLTableCellElement>("tbody tr:first-child > td");
    const columnWidths = Array.from(naturalCells, (cell) => cell.getBoundingClientRect().width);
    setNaturalLayout({
      rowIds,
      viewportWidth: container.clientWidth,
      tableWidth: table.getBoundingClientRect().width,
      columnWidths: columnWidths.every((width) => width > 0) ? columnWidths : [],
    });
  }, [isEligible, isVirtualized, rowIds, containerWidth]);

  useEffect(() => {
    if (!isEligible) return;
    const container = containerRef.current;
    if (!container) return;
    const ancestors: HTMLElement[] = [];
    for (let ancestor: HTMLElement | null = container; ancestor; ancestor = ancestor.parentElement) ancestors.push(ancestor);
    const updateBackground = () => {
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
    if (!isVirtualized) return;
    const container = containerRef.current;
    if (!container) return;
    const rows = container.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]");
    const measureRows = () => {
      let changed = false;
      for (const row of rows) {
        const id = row.dataset.rowId;
        const height = row.getBoundingClientRect().height || row.offsetHeight;
        if (!id || height <= 0) continue;
        const previous = measuredHeights.current.get(id);
        if (previous === undefined || Math.abs(previous - height) > 0.5) {
          measuredHeights.current.set(id, height);
          changed = true;
        }
      }
      if (changed) setMeasureVersion((version) => version + 1);
    };
    measureRows();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureRows);
    for (const row of rows) observer.observe(row);
    return () => observer.disconnect();
  }, [isVirtualized, rowIds, window.startIndex, window.endIndex, containerWidth]);

  // Newly measured tail rows may move the scroll boundary. Keep a bottom scroll at the bottom.
  useEffect(() => {
    const container = containerRef.current;
    if (!isVirtualized || !container || !atBottom.current) return;
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    setScrollTop(container.scrollTop);
  }, [isVirtualized, offsets]);

  return { containerRef, window, handleScroll, config, isEligible, isVirtualized, naturalLayout, headerBackgroundColor };
}
