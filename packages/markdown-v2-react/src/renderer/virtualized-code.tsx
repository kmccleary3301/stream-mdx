import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ViewportHeightIndex } from "./viewport-height-index";

export interface VirtualizedCodeConfig {
  enabled: boolean;
  windowSize: number;
  bufferSize: number;
  virtualizeThreshold: number;
  followTail?: boolean;
}

export const DEFAULT_VIRTUALIZED_CODE_CONFIG: VirtualizedCodeConfig = {
  enabled: true,
  windowSize: 100,
  bufferSize: 50,
  virtualizeThreshold: 200,
  followTail: false,
};

export function resolveVirtualizedCodeConfig(
  options?: Partial<VirtualizedCodeConfig>,
): VirtualizedCodeConfig {
  return {
    ...DEFAULT_VIRTUALIZED_CODE_CONFIG,
    ...options,
    followTail: options?.followTail ?? DEFAULT_VIRTUALIZED_CODE_CONFIG.followTail,
  };
}

const DEFAULT_CODE_LINE_HEIGHT = 20;
const CODE_FOLLOW_TAIL_EPS_BOTTOM_PX = 2;
const CODE_FOLLOW_TAIL_DETACH_SCROLL_DELTA_PX = 1;
const DEFAULT_CODE_VIEWPORT_OWNER = {};


export interface VirtualizedCodeRange {
  startIndex: number;
  endIndex: number;
  visibleStart: number;
  visibleEnd: number;
  totalLines: number;
  mountedLines: number;
}



export function calculateCodeWindow(
  totalLines: number,
  scrollTop: number,
  containerHeight: number,
  lineHeight: number,
  config: VirtualizedCodeConfig,
): VirtualizedCodeRange {
  const lineCount = Math.max(0, totalLines);
  if (!config.enabled || lineCount < config.virtualizeThreshold) {
    return {
      startIndex: 0,
      endIndex: lineCount,
      visibleStart: 0,
      visibleEnd: lineCount,
      totalLines: lineCount,
      mountedLines: lineCount,
    };
  }

  const measuredLineHeight = lineHeight > 0 ? lineHeight : 20;
  const firstVisibleLine = Math.floor(Math.max(0, scrollTop) / measuredLineHeight);
  const visibleLineCount =
    containerHeight > 0 ? Math.max(1, Math.ceil(containerHeight / measuredLineHeight)) : Math.max(1, config.windowSize);
  const visibleStart = Math.min(lineCount, firstVisibleLine);
  const visibleEnd = Math.min(lineCount, visibleStart + visibleLineCount);
  const bufferSize = Math.max(0, config.bufferSize);
  const startIndex = Math.max(0, visibleStart - bufferSize);
  const endIndex = Math.min(lineCount, visibleEnd + bufferSize);

  return {
    startIndex,
    endIndex,
    visibleStart,
    visibleEnd,
    totalLines: lineCount,
    mountedLines: endIndex - startIndex,
  };
}

interface CodeViewportLayout {
  window: VirtualizedCodeRange;
  spacerTopHeight: number;
  spacerBottomHeight: number;
}
interface CodeViewportRenderRange {
  startIndex: number;
  endIndex: number;
  visibleStart: number;
  visibleEnd: number;
  spacerBeforeHeight: number;
}

interface CodeViewportRenderLayout {
  ranges: readonly CodeViewportRenderRange[];
  spacerTopHeight: number;
  spacerBottomHeight: number;
  mountedLines: number;
}

interface CodeViewportSelectionState {
  ownerId: string;
  generation: number;
  lineIndices: readonly number[];
}

const EMPTY_SELECTION_LINE_INDICES: readonly number[] = [];

interface CodeViewportAnchor {
  lineIndex: number;
  offset: number;
  ownerId: string;
  generation: number;
  configurationRevision: number;
  ownerIdentity: object;
}
interface CodeViewportPrintSnapshot {
  identity: object;
  owner: number;
  scrollTop: number;
  followTail: boolean;
  anchor: CodeViewportAnchor | null;
}


interface CodeViewportIdentity {
  ownerId: string;
  ownerIdentity: object;
  generation: number;
  configurationRevision: number;
  enabled: boolean;
  windowSize: number;
  bufferSize: number;
  virtualizeThreshold: number;
}

function calculateMeasuredCodeWindow(
  totalLines: number,
  scrollTop: number,
  containerHeight: number,
  heights: ViewportHeightIndex,
  config: VirtualizedCodeConfig,
): CodeViewportLayout {
  const lineCount = Math.max(0, totalLines);
  if (!config.enabled || lineCount < config.virtualizeThreshold) {
    return {
      window: calculateCodeWindow(lineCount, scrollTop, containerHeight, DEFAULT_CODE_LINE_HEIGHT, config),
      spacerTopHeight: 0,
      spacerBottomHeight: 0,
    };
  }

  const totalHeight = heights.offsetAt(lineCount);
  const viewportHeight = containerHeight > 0
    ? containerHeight
    : Math.max(1, config.windowSize) * DEFAULT_CODE_LINE_HEIGHT;
  const top = Math.min(
    Math.max(0, scrollTop),
    Math.max(0, totalHeight - viewportHeight),
  );
  const bottom = top + viewportHeight;
  const visibleStart = Math.min(lineCount, heights.indexAt(top));
  let visibleEnd = heights.indexAt(bottom);
  if (visibleEnd < lineCount && heights.offsetAt(visibleEnd) < bottom) visibleEnd += 1;
  visibleEnd = Math.min(lineCount, Math.max(visibleStart, visibleEnd));
  const bufferSize = Math.max(0, config.bufferSize);
  const startIndex = Math.max(0, visibleStart - bufferSize);
  const endIndex = Math.min(lineCount, visibleEnd + bufferSize);

  return {
    window: {
      startIndex,
      endIndex,
      visibleStart,
      visibleEnd,
      totalLines: lineCount,
      mountedLines: endIndex - startIndex,
    },
    spacerTopHeight: heights.offsetAt(startIndex),
    spacerBottomHeight: Math.max(0, totalHeight - heights.offsetAt(endIndex)),
  };
}


/** Owns viewport geometry and scroll position only; record ranges subscribe separately. */
export function useVirtualizedCode(
  totalLines: number,
  generation: number,
  config: VirtualizedCodeConfig = DEFAULT_VIRTUALIZED_CODE_CONFIG,
  ownerId = "",
  configurationRevision = 0,
  ownerIdentity: object = DEFAULT_CODE_VIEWPORT_OWNER,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [selectionState, setSelectionState] = useState<CodeViewportSelectionState>(() => ({
    ownerId,
    generation,
    lineIndices: EMPTY_SELECTION_LINE_INDICES,
  }));
  const heightIndexRef = useRef<ViewportHeightIndex | null>(null);
  let heightIndex = heightIndexRef.current;
  if (heightIndex === null) {
    heightIndex = new ViewportHeightIndex();
    heightIndex.reset(totalLines, DEFAULT_CODE_LINE_HEIGHT);
    heightIndexRef.current = heightIndex;
  }
  const indexedCountRef = useRef(totalLines);
  const totalLinesRef = useRef(totalLines);
  totalLinesRef.current = totalLines;
  const measuredWidthRef = useRef<number | null>(null);
  const measurementGenerationRef = useRef(0);
  const previousScrollTopRef = useRef<number | null>(null);
  const followTailRef = useRef(false);
  const followTailOptInRef = useRef(config.followTail === true);
  followTailOptInRef.current = config.followTail === true;
  if (!followTailOptInRef.current) followTailRef.current = false;
  const writeScrollTop = useCallback((container: HTMLDivElement, nextTop: number) => {
    container.scrollTop = nextTop;
    previousScrollTopRef.current = container.scrollTop;
  }, []);
  const viewportAnchorRef = useRef<CodeViewportAnchor | null>(null);
  const geometryIdentityRef = useRef<CodeViewportIdentity | null>(null);
  const printOwnerGenerationRef = useRef(0);
  const [printOwner, setPrintOwner] = useState<{ identity: object; generation: number } | null>(null);
  const isPrintingRef = useRef(false);
  const printGeometrySuspendedRef = useRef(false);
  const restoringPrintScrollRef = useRef(false);
  const printSnapshotRef = useRef<CodeViewportPrintSnapshot | null>(null);
  const rowResizeObserverRef = useRef<ResizeObserver | null>(null);
  const printRowsRef = useRef(new Set<HTMLElement>());
  const printEligible = config.enabled && totalLines >= config.virtualizeThreshold;
  const isPrinting = printOwner?.identity === ownerIdentity &&
    printOwner.generation === printOwnerGenerationRef.current;
  let previousIdentity = geometryIdentityRef.current;
  if (previousIdentity === null) {
    previousIdentity = {
      ownerId,
      ownerIdentity,
      generation,
      configurationRevision,
      enabled: config.enabled,
      windowSize: config.windowSize,
      bufferSize: config.bufferSize,
      virtualizeThreshold: config.virtualizeThreshold,
    };
    geometryIdentityRef.current = previousIdentity;
  }
  const identityMatches =
    previousIdentity.ownerId === ownerId &&
    previousIdentity.ownerIdentity === ownerIdentity &&
    previousIdentity.generation === generation &&
    previousIdentity.configurationRevision === configurationRevision &&
    previousIdentity.enabled === config.enabled &&
    previousIdentity.windowSize === config.windowSize &&
    previousIdentity.bufferSize === config.bufferSize &&
    previousIdentity.virtualizeThreshold === config.virtualizeThreshold;
  const geometryReady = identityMatches && indexedCountRef.current === totalLines;
  const selectionLineIndices =
    selectionState.ownerId === ownerId && selectionState.generation === generation
      ? selectionState.lineIndices
      : EMPTY_SELECTION_LINE_INDICES;
  const selectionTrackingEnabled = config.enabled && totalLines >= config.virtualizeThreshold;

  const refreshSelection = useCallback(() => {
    const container = containerRef.current;
    if (!container || !selectionTrackingEnabled) return;
    const selection = container.ownerDocument.getSelection();
    const nextLineIndices: number[] = [];
    const retainEndpoint = (node: Node | null) => {
      if (!node) return;
      const element = node.nodeType === 1 ? node as Element : node.parentElement;
      const row = element?.closest<HTMLElement>(".line[data-line]");
      if (!row || !container.contains(row)) return;
      const lineNumber = Number(row.getAttribute("data-line"));
      const lineIndex = lineNumber - 1;
      if (
        !Number.isSafeInteger(lineNumber) ||
        lineNumber <= 0 ||
        lineIndex >= totalLinesRef.current ||
        nextLineIndices.includes(lineIndex)
      ) {
        return;
      }
      nextLineIndices.push(lineIndex);
    };
    if (selection && selection.rangeCount > 0) {
      retainEndpoint(selection.anchorNode);
      retainEndpoint(selection.focusNode);
    }
    nextLineIndices.sort((left, right) => left - right);
    setSelectionState((previous) => {
      if (
        previous.ownerId === ownerId &&
        previous.generation === generation &&
        previous.lineIndices.length === nextLineIndices.length &&
        previous.lineIndices.every((lineIndex, index) => lineIndex === nextLineIndices[index])
      ) {
        return previous;
      }
      return { ownerId, generation, lineIndices: nextLineIndices };
    });
  }, [generation, ownerId, selectionTrackingEnabled]);

  const layout = useMemo(() => {
    if (geometryReady) {
      return calculateMeasuredCodeWindow(totalLines, scrollTop, containerHeight, heightIndex, config);
    }
    const window = calculateCodeWindow(
      totalLines,
      scrollTop,
      containerHeight,
      DEFAULT_CODE_LINE_HEIGHT,
      config,
    );
    const virtualized = config.enabled && totalLines >= config.virtualizeThreshold;
    return {
      window,
      spacerTopHeight: virtualized ? window.startIndex * DEFAULT_CODE_LINE_HEIGHT : 0,
      spacerBottomHeight: virtualized ? (window.totalLines - window.endIndex) * DEFAULT_CODE_LINE_HEIGHT : 0,
    };
  }, [config, containerHeight, geometryReady, heightIndex, measureVersion, scrollTop, totalLines]);
  const renderLayout = useMemo<CodeViewportRenderLayout>(() => {
    const intervals: Array<Pick<CodeViewportRenderRange, "startIndex" | "endIndex" | "visibleStart" | "visibleEnd">> = [];
    const primary = layout.window;
    if (primary.endIndex > primary.startIndex) {
      intervals.push({
        startIndex: primary.startIndex,
        endIndex: primary.endIndex,
        visibleStart: primary.visibleStart,
        visibleEnd: primary.visibleEnd,
      });
    }
    for (const lineIndex of selectionLineIndices) {
      if (
        !Number.isSafeInteger(lineIndex) ||
        lineIndex < 0 ||
        lineIndex >= totalLines ||
        (lineIndex >= primary.startIndex && lineIndex < primary.endIndex)
      ) {
        continue;
      }
      const previous = intervals[intervals.length - 1];
      if (
        previous &&
        (previous.startIndex !== primary.startIndex || previous.endIndex !== primary.endIndex) &&
        previous.endIndex === lineIndex
      ) {
        previous.endIndex += 1;
        previous.visibleEnd = lineIndex + 1;
      } else {
        intervals.push({
          startIndex: lineIndex,
          endIndex: lineIndex + 1,
          visibleStart: lineIndex,
          visibleEnd: lineIndex + 1,
        });
      }
    }
    intervals.sort((left, right) => left.startIndex - right.startIndex);
    const offsetAt = geometryReady
      ? (index: number) => heightIndex.offsetAt(index)
      : (index: number) => index * DEFAULT_CODE_LINE_HEIGHT;
    let previousEnd = 0;
    let mountedLines = 0;
    const ranges = intervals.map((interval, index): CodeViewportRenderRange => {
      const spacerBeforeHeight = index === 0
        ? 0
        : Math.max(0, offsetAt(interval.startIndex) - offsetAt(previousEnd));
      previousEnd = interval.endIndex;
      mountedLines += interval.endIndex - interval.startIndex;
      return { ...interval, spacerBeforeHeight };
    });
    return {
      ranges,
      spacerTopHeight: ranges.length > 0 ? offsetAt(ranges[0]!.startIndex) : 0,
      spacerBottomHeight: Math.max(0, offsetAt(totalLines) - offsetAt(previousEnd)),
      mountedLines,
    };
  }, [geometryReady, heightIndex, layout.window, selectionLineIndices, totalLines]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !selectionTrackingEnabled) return;
    const ownerDocument = container.ownerDocument;
    ownerDocument.addEventListener("selectionchange", refreshSelection);
    refreshSelection();
    return () => ownerDocument.removeEventListener("selectionchange", refreshSelection);
  }, [refreshSelection, selectionTrackingEnabled]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || config.followTail !== true) return;
    const scrollTop = container.scrollTop;
    const distanceToBottom = container.scrollHeight - container.clientHeight - scrollTop;
    followTailRef.current = distanceToBottom <= CODE_FOLLOW_TAIL_EPS_BOTTOM_PX;
    previousScrollTopRef.current = scrollTop;
  }, [config.followTail]);

  useEffect(() => {
    if (!printEligible) return;
    const container = containerRef.current;
    if (!container) return;
    const ownerWindow = container.ownerDocument.defaultView;
    if (!ownerWindow) return;
    const owner = ++printOwnerGenerationRef.current;
    let active = true;
    const isCurrentOwner = () =>
      active && printOwnerGenerationRef.current === owner && containerRef.current === container;
    const onBeforePrint = () => {
      if (!isCurrentOwner() || !container.isConnected || isPrintingRef.current) return;
      isPrintingRef.current = true;
      printGeometrySuspendedRef.current = true;
      printSnapshotRef.current = {
        identity: ownerIdentity,
        owner,
        scrollTop: container.scrollTop,
        followTail: followTailRef.current,
        anchor: viewportAnchorRef.current,
      };
      flushSync(() => {
        setPrintOwner({ identity: ownerIdentity, generation: owner });
      });
      const observer = rowResizeObserverRef.current;
      if (observer) {
        for (const row of container.querySelectorAll<HTMLElement>(".line[data-line]")) {
          observer.observe(row);
          printRowsRef.current.add(row);
        }
      }
    };
    const onAfterPrint = () => {
      if (!isCurrentOwner() || !isPrintingRef.current) return;
      const snapshot = printSnapshotRef.current;
      if (!snapshot || snapshot.owner !== owner) return;
      const restoreReader = snapshot.identity === ownerIdentity && container.isConnected;
      if (restoreReader) restoringPrintScrollRef.current = true;
      isPrintingRef.current = false;
      printSnapshotRef.current = null;
      flushSync(() => {
        setPrintOwner((current) => current?.generation === owner ? null : current);
      });
      if (restoreReader) {
        followTailRef.current = snapshot.followTail && followTailOptInRef.current;
        viewportAnchorRef.current = snapshot.anchor;
        flushSync(() => setScrollTop(container.scrollTop));
      }
      const observer = rowResizeObserverRef.current;
      for (const row of printRowsRef.current) {
        if (!container.contains(row)) observer?.unobserve(row);
      }
      printRowsRef.current.clear();
      ownerWindow.requestAnimationFrame(() => {
        if (!isCurrentOwner() || isPrintingRef.current) return;
        if (restoreReader) restoringPrintScrollRef.current = false;
        printGeometrySuspendedRef.current = false;
      });
    };
    ownerWindow.addEventListener("beforeprint", onBeforePrint);
    ownerWindow.addEventListener("afterprint", onAfterPrint);
    return () => {
      active = false;
      ownerWindow.removeEventListener("beforeprint", onBeforePrint);
      ownerWindow.removeEventListener("afterprint", onAfterPrint);
      if (printOwnerGenerationRef.current !== owner) return;
      printOwnerGenerationRef.current++;
      restoringPrintScrollRef.current = false;
      printGeometrySuspendedRef.current = false;
      isPrintingRef.current = false;
      printSnapshotRef.current = null;
      const observer = rowResizeObserverRef.current;
      for (const row of printRowsRef.current) {
        if (!container.contains(row)) observer?.unobserve(row);
      }
      printRowsRef.current.clear();
    };
  }, [ownerIdentity, printEligible]);


  useEffect(() => {
    const previous = geometryIdentityRef.current;
    if (!previous) return;
    const ownerChanged =
      previous.ownerId !== ownerId ||
      previous.ownerIdentity !== ownerIdentity ||
      previous.generation !== generation;
    const sourceConfigurationChanged = previous.configurationRevision !== configurationRevision;
    const presentationOptionsChanged =
      previous.enabled !== config.enabled ||
      previous.windowSize !== config.windowSize ||
      previous.bufferSize !== config.bufferSize ||
      previous.virtualizeThreshold !== config.virtualizeThreshold;
    const lineCountChanged = indexedCountRef.current !== totalLines;
    if (ownerChanged || sourceConfigurationChanged) {
      heightIndex.reset(totalLines, DEFAULT_CODE_LINE_HEIGHT);
      indexedCountRef.current = totalLines;
      viewportAnchorRef.current = null;
    } else if (lineCountChanged) {
      const previousCount = indexedCountRef.current;
      heightIndex.resize(totalLines);
      indexedCountRef.current = totalLines;
      if (totalLines < previousCount) {
        const anchor = viewportAnchorRef.current;
        if (anchor && anchor.lineIndex >= totalLines) viewportAnchorRef.current = null;
      }
      const container = containerRef.current;
      if (
        totalLines > previousCount &&
        container &&
        followTailRef.current &&
        !isPrintingRef.current &&
        !printGeometrySuspendedRef.current &&
        !restoringPrintScrollRef.current
      ) {
        const nextScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (container.scrollTop !== nextScrollTop) {
          writeScrollTop(container, nextScrollTop);
          setScrollTop(nextScrollTop);
        }
      }
    }
    if (ownerChanged) {
      followTailRef.current = false;
      const container = containerRef.current;
      if (container) {
        if (container.scrollTop !== 0) {
          writeScrollTop(container, 0);
        } else {
          previousScrollTopRef.current = 0;
        }
      }
      setScrollTop(0);
    }
    if (ownerChanged || sourceConfigurationChanged || presentationOptionsChanged || lineCountChanged) {
      if (ownerChanged || sourceConfigurationChanged || presentationOptionsChanged) {
        measurementGenerationRef.current += 1;
      }
      setMeasureVersion((version) => version + 1);
    }
    geometryIdentityRef.current = {
      ownerId,
      ownerIdentity,
      generation,
      configurationRevision,
      enabled: config.enabled,
      windowSize: config.windowSize,
      bufferSize: config.bufferSize,
      virtualizeThreshold: config.virtualizeThreshold,
    };
  }, [
    config.bufferSize,
    config.enabled,
    config.virtualizeThreshold,
    config.windowSize,
    configurationRevision,
    generation,
    heightIndex,
    ownerId,
    ownerIdentity,
    totalLines,
    writeScrollTop,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver((entries) => {
      if (
        isPrintingRef.current ||
        printGeometrySuspendedRef.current ||
        restoringPrintScrollRef.current
      ) return;
      for (const entry of entries) {
        if (entry.target !== container) continue;
        const nextHeight = Math.ceil(entry.contentRect.height || container.clientHeight);
        setContainerHeight((current) => current === nextHeight ? current : nextHeight);
        const nextWidth = Math.ceil(container.clientWidth || entry.contentRect.width);
        const previousWidth = measuredWidthRef.current;
        if (previousWidth === null) {
          measuredWidthRef.current = nextWidth;
        } else if (previousWidth !== nextWidth) {
          measuredWidthRef.current = nextWidth;
          const lineCount = totalLinesRef.current;
          heightIndex.reset(lineCount, DEFAULT_CODE_LINE_HEIGHT);
          indexedCountRef.current = lineCount;
          measurementGenerationRef.current += 1;
          viewportAnchorRef.current = null;
          setMeasureVersion((version) => version + 1);
        }
        setContainerWidth((current) => current === nextWidth ? current : nextWidth);
      }
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [heightIndex]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target !== containerRef.current || isPrintingRef.current || restoringPrintScrollRef.current) return;
    refreshSelection();
    const nextScrollTop = target.scrollTop;
    const previousScrollTop = previousScrollTopRef.current;
    const scrolledUp =
      previousScrollTop !== null &&
      previousScrollTop - nextScrollTop > CODE_FOLLOW_TAIL_DETACH_SCROLL_DELTA_PX;
    previousScrollTopRef.current = nextScrollTop;
    setScrollTop(nextScrollTop);
    setContainerHeight(target.clientHeight);
    const distanceToBottom = target.scrollHeight - target.clientHeight - nextScrollTop;
    const atBottom = distanceToBottom <= CODE_FOLLOW_TAIL_EPS_BOTTOM_PX;
    if (config.followTail !== true || scrolledUp) {
      followTailRef.current = false;
    } else if (atBottom) {
      followTailRef.current = true;
    }
    if (atBottom && !scrolledUp) {
      viewportAnchorRef.current = null;
      return;
    }
    const lineIndex = Math.min(
      Math.max(0, totalLines - 1),
      geometryReady
        ? heightIndex.indexAt(nextScrollTop)
        : Math.floor(Math.max(0, nextScrollTop) / DEFAULT_CODE_LINE_HEIGHT),
    );
    const lineTop = geometryReady
      ? heightIndex.offsetAt(lineIndex)
      : lineIndex * DEFAULT_CODE_LINE_HEIGHT;
    viewportAnchorRef.current = {
      lineIndex,
      offset: lineTop - nextScrollTop,
      ownerId,
      ownerIdentity,
      generation,
      configurationRevision,
    };
  }, [config.followTail, configurationRevision, generation, geometryReady, heightIndex, ownerId, ownerIdentity, refreshSelection, totalLines]);

  useEffect(() => {
    const container = containerRef.current;
    if (
      !container ||
      !geometryReady ||
      !config.enabled ||
      totalLines < config.virtualizeThreshold
    ) {
      return;
    }
    const measurementGeneration = measurementGenerationRef.current;
    let active = true;
    const preserveViewport = () => {
      if (
        !active ||
        measurementGenerationRef.current !== measurementGeneration ||
        isPrintingRef.current ||
        printGeometrySuspendedRef.current ||
        restoringPrintScrollRef.current
      ) return;
      if (followTailRef.current) {
        const nextScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (container.scrollTop !== nextScrollTop) {
          writeScrollTop(container, nextScrollTop);
          setScrollTop(nextScrollTop);
        }
        return;
      }
      const anchor = viewportAnchorRef.current;
      if (
        !anchor ||
        anchor.ownerId !== ownerId ||
        anchor.ownerIdentity !== ownerIdentity ||
        anchor.generation !== generation ||
        anchor.configurationRevision !== configurationRevision
      ) {
        return;
      }
      const lineIndex = Math.min(Math.max(0, totalLines - 1), anchor.lineIndex);
      const nextScrollTop = Math.max(0, heightIndex.offsetAt(lineIndex) - anchor.offset);
      if (Math.abs(container.scrollTop - nextScrollTop) > 0.5) {
        writeScrollTop(container, nextScrollTop);
        setScrollTop(nextScrollTop);
      }
    };
    const measureRow = (row: Element): boolean => {
      if (
        isPrintingRef.current ||
        printGeometrySuspendedRef.current ||
        restoringPrintScrollRef.current ||
        !row.matches(".line[data-line]") ||
        !container.contains(row)
      ) return false;
      const lineNumber = Number(row.getAttribute("data-line"));
      const lineIndex = lineNumber - 1;
      if (!Number.isSafeInteger(lineIndex) || lineIndex < 0 || lineIndex >= totalLines) return false;
      const element = row as HTMLElement;
      const height = element.getBoundingClientRect().height || element.offsetHeight;
      return height > 0 && heightIndex.setHeight(lineIndex, height);
    };
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          if (
            !active ||
            measurementGenerationRef.current !== measurementGeneration ||
            isPrintingRef.current ||
            printGeometrySuspendedRef.current ||
            restoringPrintScrollRef.current
          ) return;
          let changed = false;
          for (const entry of entries) changed = measureRow(entry.target) || changed;
          if (!changed) return;
          preserveViewport();
          setMeasureVersion((version) => version + 1);
        });
    rowResizeObserverRef.current = observer;
    let changed = false;
    const rows = container.querySelectorAll<HTMLElement>(".line[data-line]");
    for (const row of rows) {
      observer?.observe(row);
      if (isPrintingRef.current) printRowsRef.current.add(row);
      changed = measureRow(row) || changed;
    }
    if (changed) {
      preserveViewport();
      setMeasureVersion((version) => version + 1);
    }
    return () => {
      if (rowResizeObserverRef.current === observer) rowResizeObserverRef.current = null;
      observer?.disconnect();
      printRowsRef.current.clear();
    };
  }, [
    config.enabled,
    config.virtualizeThreshold,
    configurationRevision,
    generation,
    geometryReady,
    heightIndex,
    layout.window.endIndex,
    layout.window.startIndex,
    ownerIdentity,
    ownerId,
    totalLines,
    containerWidth,
    selectionLineIndices,
    writeScrollTop,
  ]);

  const scrollToLine = useCallback((lineIndex: number) => {
    const container = containerRef.current;
    if (
      !container ||
      isPrintingRef.current ||
      printGeometrySuspendedRef.current ||
      restoringPrintScrollRef.current
    ) return;
    const targetIndex = Math.max(0, Math.min(Math.floor(lineIndex), totalLines - 1));
    const targetScrollTop = geometryReady
      ? heightIndex.offsetAt(targetIndex)
      : targetIndex * DEFAULT_CODE_LINE_HEIGHT;
    writeScrollTop(container, targetScrollTop);
    setScrollTop(targetScrollTop);
    followTailRef.current = false;
    viewportAnchorRef.current = {
      lineIndex: targetIndex,
      offset: 0,
      ownerId,
      ownerIdentity,
      generation,
      configurationRevision,
    };
  }, [configurationRevision, generation, geometryReady, heightIndex, ownerId, ownerIdentity, totalLines, writeScrollTop]);

  const lineHeight = heightIndex.offsetAt(1) - heightIndex.offsetAt(0) || DEFAULT_CODE_LINE_HEIGHT;
  return {
    containerRef,
    isPrinting,
    selectionLineIndices,
    window: layout.window,
    renderRanges: renderLayout.ranges,
    mountedLineCount: renderLayout.mountedLines,
    spacerTopHeight: renderLayout.spacerTopHeight,
    spacerBottomHeight: renderLayout.spacerBottomHeight,
    handleScroll,
    scrollToLine,
    lineHeight,
    config,
  };
}
