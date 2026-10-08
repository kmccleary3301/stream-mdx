import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Configuration for table row virtualization.
 */
export interface TableVirtualizationConfig {
  /**
   * Whether table row virtualization is enabled.
   * Default: false (conservative opt-in).
   */
  enabled: boolean;
  /**
   * Minimum number of body rows required to trigger virtualization.
   * Tables with fewer rows render all rows normally.
   * Default: 40.
   */
  minRows: number;
  /**
   * Alias for minRows to align with code virtualization threshold convention.
   */
  virtualizeThreshold?: number;
  /**
   * Initial estimated row height in pixels before concrete measurements occur.
   * Default: 40.
   */
  estimatedRowHeight: number;
  /**
   * Number of buffer rows rendered above and below the visible viewport.
   * Bounded to avoid excessive DOM nodes while preventing blank flashes.
   * Default: 8.
   */
  overscan: number;
  /**
   * Maximum height of the scroll container (CSS string or pixel number).
   * Default: "600px".
   */
  maxHeight: number | string;
}

/**
 * User-facing configuration for table virtualization: boolean or partial config.
 */
export type TableVirtualizationOptions = boolean | Partial<TableVirtualizationConfig>;

export const DEFAULT_TABLE_VIRTUALIZATION_CONFIG: TableVirtualizationConfig = Object.freeze({
  enabled: false,
  minRows: 40,
  virtualizeThreshold: 40,
  estimatedRowHeight: 40,
  overscan: 8,
  maxHeight: "600px",
});

/**
 * Normalizes user options into a complete TableVirtualizationConfig.
 */
export function resolveTableVirtualizationConfig(
  options?: TableVirtualizationOptions,
): TableVirtualizationConfig {
  if (options === true) {
    return { ...DEFAULT_TABLE_VIRTUALIZATION_CONFIG, enabled: true };
  }
  if (!options) {
    return DEFAULT_TABLE_VIRTUALIZATION_CONFIG;
  }
  const minRows = options.minRows ?? options.virtualizeThreshold ?? DEFAULT_TABLE_VIRTUALIZATION_CONFIG.minRows;
  // Bounded overscan: clamp between 1 and 50 rows
  const overscan = Math.min(Math.max(1, options.overscan ?? DEFAULT_TABLE_VIRTUALIZATION_CONFIG.overscan), 50);
  return {
    enabled: options.enabled ?? true,
    minRows,
    virtualizeThreshold: minRows,
    estimatedRowHeight: options.estimatedRowHeight ?? DEFAULT_TABLE_VIRTUALIZATION_CONFIG.estimatedRowHeight,
    overscan,
    maxHeight: options.maxHeight ?? DEFAULT_TABLE_VIRTUALIZATION_CONFIG.maxHeight,
  };
}

export interface TableVirtualWindow {
  startIndex: number;
  endIndex: number;
  visibleStart: number;
  visibleEnd: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalHeight: number;
  mountedRows: number;
}

/**
 * Calculates which table rows should be rendered based on scroll position and variable row heights.
 */
export function calculateTableWindow(
  rowCount: number,
  scrollTop: number,
  containerHeight: number,
  getRowHeight: (index: number) => number,
  config: TableVirtualizationConfig,
): TableVirtualWindow {
  if (rowCount === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      visibleStart: 0,
      visibleEnd: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      totalHeight: 0,
      mountedRows: 0,
    };
  }

  // Precompute cumulative offsets: offsets[i] is the top of row i, offsets[rowCount] is total height
  const offsets = new Float64Array(rowCount + 1);
  offsets[0] = 0;
  for (let i = 0; i < rowCount; i++) {
    offsets[i + 1] = offsets[i] + getRowHeight(i);
  }
  const totalHeight = offsets[rowCount];

  // If container height is unknown (e.g. before initial measurement), estimate from maxHeight or fallback
  const effectiveContainerHeight =
    containerHeight > 0
      ? containerHeight
      : typeof config.maxHeight === "number"
        ? config.maxHeight
        : 600;

  // Viewport boundaries
  const viewportTop = Math.max(0, scrollTop);
  const viewportBottom = viewportTop + effectiveContainerHeight;

  // Binary search for visibleStart: smallest row index i where offsets[i + 1] > viewportTop
  let low = 0;
  let high = rowCount - 1;
  let visibleStart = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid + 1] > viewportTop) {
      visibleStart = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  // Binary search for visibleEnd: largest row index i where offsets[i] < viewportBottom
  low = visibleStart;
  high = rowCount - 1;
  let visibleEnd = visibleStart;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] < viewportBottom) {
      visibleEnd = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const visibleEndIndex = Math.min(rowCount, visibleEnd + 1);

  // Apply bounded overscan
  const overscan = Math.min(Math.max(1, config.overscan), 50);
  const startIndex = Math.max(0, visibleStart - overscan);
  const endIndex = Math.min(rowCount, visibleEndIndex + overscan);

  // Spacer heights accurately reflect unrendered rows
  const topSpacerHeight = offsets[startIndex];
  const bottomSpacerHeight = offsets[rowCount] - offsets[endIndex];
  const mountedRows = endIndex - startIndex;

  return {
    startIndex,
    endIndex,
    visibleStart,
    visibleEnd: visibleEndIndex,
    topSpacerHeight,
    bottomSpacerHeight,
    totalHeight,
    mountedRows,
  };
}

export interface TableVirtualizationProps {
  isVirtualized: boolean;
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  columnCount: number;
}

/**
 * Hook for virtualized table scrolling and variable row height measurement.
 */
export function useVirtualizedTable(
  rowCount: number,
  configInput: TableVirtualizationOptions | undefined,
  enabledCondition: boolean,
) {
  const config = useMemo(() => resolveTableVirtualizationConfig(configInput), [configInput]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const measuredHeightsRef = useRef<Map<number, number>>(new Map());
  const [measureVersion, setMeasureVersion] = useState(0);

  // Fallback getRowHeight using measured cache with fallback to estimatedRowHeight
  const getRowHeight = useCallback(
    (index: number) => {
      return measuredHeightsRef.current.get(index) ?? config.estimatedRowHeight;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.estimatedRowHeight, measureVersion],
  );

  const isVirtualized = enabledCondition && config.enabled && rowCount >= config.minRows;

  // Handle scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    setScrollTop(target.scrollTop);
    setContainerHeight(target.clientHeight);
  }, []);

  // Window calculation
  const window = useMemo(() => {
    if (!isVirtualized) {
      return {
        startIndex: 0,
        endIndex: rowCount,
        visibleStart: 0,
        visibleEnd: rowCount,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0,
        totalHeight: 0,
        mountedRows: rowCount,
      };
    }
    return calculateTableWindow(rowCount, scrollTop, containerHeight, getRowHeight, config);
  }, [rowCount, scrollTop, containerHeight, getRowHeight, config, isVirtualized]);

  // Observe container size (viewport / container resize)
  useEffect(() => {
    if (!isVirtualized || !containerRef.current) return;
    if (typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === containerRef.current) {
          const height = entry.contentRect.height;
          const width = entry.contentRect.width;
          if (height > 0) {
            setContainerHeight((prev) => (Math.abs(prev - height) > 1 ? height : prev));
          }
          if (width > 0) {
            setContainerWidth((prev) => (Math.abs(prev - width) > 1 ? width : prev));
          }
        }
      }
    });

    resizeObserver.observe(containerRef.current);
    if (containerRef.current.clientHeight > 0) {
      setContainerHeight(containerRef.current.clientHeight);
    }
    if (containerRef.current.clientWidth > 0) {
      setContainerWidth(containerRef.current.clientWidth);
    }

    return () => resizeObserver.disconnect();
  }, [isVirtualized]);

  // Observe and measure rendered rows (variable height + resizing column/viewport updates measurements)
  useEffect(() => {
    if (!isVirtualized || !containerRef.current) return;

    const container = containerRef.current;
    const rowElements = container.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-index]");
    let hasChanges = false;

    // Immediate DOM measurement
    rowElements.forEach((tr) => {
      const idxAttr = tr.getAttribute("data-row-index");
      if (idxAttr !== null) {
        const idx = Number.parseInt(idxAttr, 10);
        const measured = tr.getBoundingClientRect().height || tr.offsetHeight;
        if (measured > 0) {
          const prev = measuredHeightsRef.current.get(idx);
          if (prev === undefined || Math.abs(prev - measured) > 0.5) {
            measuredHeightsRef.current.set(idx, measured);
            hasChanges = true;
          }
        }
      }
    });

    if (hasChanges) {
      setMeasureVersion((v) => v + 1);
    }

    if (typeof ResizeObserver === "undefined") return;

    const rowObserver = new ResizeObserver((entries) => {
      let observerChange = false;
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const idxAttr = target.getAttribute("data-row-index");
        if (idxAttr !== null) {
          const idx = Number.parseInt(idxAttr, 10);
          const height = entry.borderBoxSize?.[0]?.blockSize ?? target.offsetHeight;
          if (height > 0) {
            const prev = measuredHeightsRef.current.get(idx);
            if (prev === undefined || Math.abs(prev - height) > 0.5) {
              measuredHeightsRef.current.set(idx, height);
              observerChange = true;
            }
          }
        }
      }
      if (observerChange) {
        setMeasureVersion((v) => v + 1);
      }
    });

    rowElements.forEach((tr) => rowObserver.observe(tr));

    return () => {
      rowObserver.disconnect();
    };
  }, [isVirtualized, window.startIndex, window.endIndex, containerWidth]);

  // Scroll to row helper
  const scrollToRow = useCallback(
    (rowIndex: number) => {
      if (!containerRef.current || rowIndex < 0 || rowIndex >= rowCount) return;
      let targetTop = 0;
      for (let i = 0; i < rowIndex; i++) {
        targetTop += getRowHeight(i);
      }
      containerRef.current.scrollTop = targetTop;
      setScrollTop(targetTop);
    },
    [rowCount, getRowHeight],
  );

  return {
    containerRef,
    window,
    handleScroll,
    scrollToRow,
    config,
    isVirtualized,
  };
}
