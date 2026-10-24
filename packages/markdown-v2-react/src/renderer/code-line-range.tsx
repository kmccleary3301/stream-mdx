declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

import type { CodeLineRecord } from "@stream-mdx/core";
import React from "react";
import { CODE_LINE_RANGE_SIZE } from "./code-state";
import { useCodeHighlightRequester } from "./code-highlight-context";
import type { RendererStore } from "./store";
import { NativeCodeLineGroup } from "./native-code-line";
import { getStoreResetVersion } from "./store-reset-version";


const EMPTY_CODE_LINES: readonly CodeLineRecord[] = Object.freeze([]);
type CodeLineRangeCounterStore = RendererStore & {
  campaignCounters?: {
    recordStoreRecordsTouched?(count: number, stage: "view"): void;
    recordRecordSlotsAllocated?(count: number, stage: "view"): void;
  };
};



type DirtyCodeLineRange = {
  readonly startLine: number;
  readonly endLine: number;
  readonly sourceRevision: number;
};

type DemandedCodeLineRange = {
  readonly startLine: number;
  endLine: number;
};

type PreviousHighlightDemand = {
  readonly blockId: string;
  readonly generation: number;
  readonly resetVersion: number;
  readonly configurationRevision: number;
  readonly demandedRanges: readonly DemandedCodeLineRange[];
  readonly ranges: readonly DirtyCodeLineRange[];
};

type CodeLineRangeViewProps = {
  store: RendererStore;
  blockId: string;
  generation: number;
  resetVersion: number;
  configurationRevision: number;
  chunkStart: number;
  rangeStart: number;
  rangeEnd: number;
  visibleStart: number;
  visibleEnd: number;
  renderSegments?: readonly CodeLineRenderSegment[];
  selectedLineIndices?: readonly number[];
};

/** Render disjoint row slices within one fixed-range store subscription. */
type CodeLineRenderSegment = {
  startIndex: number;
  endIndex: number;
  visibleStart: number;
  visibleEnd: number;
  spacerBeforeHeight: number;
};



/** One fixed-range store subscription; completed 64-row snapshots remain stable across tail appends. */
export const CodeLineRangeView = React.memo(function CodeLineRangeView({
  store,
  blockId,
  generation,
  resetVersion,
  configurationRevision,
  chunkStart,
  rangeStart,
  rangeEnd,
  visibleStart,
  visibleEnd,
  renderSegments,
  selectedLineIndices,
}: CodeLineRangeViewProps): React.ReactElement {
  const readRange = React.useCallback(() => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      (store as CodeLineRangeCounterStore).campaignCounters?.recordStoreRecordsTouched?.(1, "view");
    }
    if (getStoreResetVersion(store) !== resetVersion) return EMPTY_CODE_LINES;
    const current = store.getCodeBlock(blockId);
    if (
      !current ||
      current.source.generation !== generation ||
      current.configurationRevision !== configurationRevision
    ) {
      return EMPTY_CODE_LINES;
    }
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      (store as CodeLineRangeCounterStore).campaignCounters?.recordStoreRecordsTouched?.(1, "view");
    }
    return store.getCodeLines(blockId, chunkStart, chunkStart + CODE_LINE_RANGE_SIZE);
  }, [blockId, chunkStart, configurationRevision, generation, resetVersion, store]);
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribeCodeLines(
      blockId,
      chunkStart,
      chunkStart + CODE_LINE_RANGE_SIZE,
      listener,
    ),
    [blockId, chunkStart, store],
  );
  const lines = React.useSyncExternalStore(subscribe, readRange, readRange);
  const highlightRequester = useCodeHighlightRequester();
  const previousDemandRef = React.useRef<PreviousHighlightDemand | null>(null);

  const rows = React.useMemo(() => {
    const mappedRows: React.ReactElement[] = [];
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      const counterStore = store as RendererStore & {
        campaignCounters?: {
          recordStoreRecordsTouched?(count: number, stage: string): void;
        };
      };
      counterStore.campaignCounters?.recordStoreRecordsTouched?.(lines.length, "view");
    }
    const segments = renderSegments ?? [{
      startIndex: rangeStart,
      endIndex: rangeEnd,
      visibleStart,
      visibleEnd,
      spacerBeforeHeight: 0,
    }];
    for (const segment of segments) {
      if (segment.spacerBeforeHeight > 0) {
        mappedRows.push(React.createElement("span", {
          key: `viewport-gap:${segment.startIndex}`,
          "aria-hidden": true,
          style: { display: "block", height: segment.spacerBeforeHeight },
        }));
      }
      for (const line of lines) {
        if (line.index < segment.startIndex || line.index >= segment.endIndex) continue;
        mappedRows.push(React.createElement(NativeCodeLineGroup, {
          key: line.id,
          line,
          generation,
          selectedForNativeSelection: selectedLineIndices?.includes(line.index) ?? false,
        }));
      }
    }
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      (store as CodeLineRangeCounterStore).campaignCounters?.recordRecordSlotsAllocated?.(mappedRows.length, "view");
    }
    return mappedRows;
  }, [
    blockId,
    chunkStart,
    configurationRevision,
    generation,
    lines,
    rangeEnd,
    rangeStart,
    renderSegments,
    selectedLineIndices,
    resetVersion,
    store,
    visibleEnd,
    visibleStart,
  ]);

  React.useEffect(() => {
    const previous = previousDemandRef.current;
    const segments = renderSegments ?? [{
      startIndex: rangeStart,
      endIndex: rangeEnd,
      visibleStart,
      visibleEnd,
      spacerBeforeHeight: 0,
    }];
    const demandedRanges: DemandedCodeLineRange[] = [];
    for (const segment of segments) {
      const startLine = Math.max(segment.startIndex, chunkStart);
      const endLine = Math.min(segment.endIndex, chunkStart + CODE_LINE_RANGE_SIZE);
      if (endLine <= startLine) continue;
      const last = demandedRanges[demandedRanges.length - 1];
      if (last && startLine <= last.endLine) last.endLine = Math.max(last.endLine, endLine);
      else demandedRanges.push({ startLine, endLine });
    }
    if (!highlightRequester || demandedRanges.length === 0) {
      previousDemandRef.current = null;
      return;
    }

    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      (store as CodeLineRangeCounterStore).campaignCounters?.recordStoreRecordsTouched?.(1, "view");
    }
    if (getStoreResetVersion(store) !== resetVersion) {
      previousDemandRef.current = null;
      return;
    }
    const current = store.getCodeBlock(blockId);
    if (
      !current ||
      current.source.generation !== generation ||
      current.configurationRevision !== configurationRevision
    ) {
      previousDemandRef.current = null;
      return;
    }

    const ranges: DirtyCodeLineRange[] = [];
    let pendingStart = -1;
    let pendingEnd = -1;
    let pendingSourceRevision = -1;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      const counterStore = store as RendererStore & {
        campaignCounters?: {
          recordStoreRecordsTouched?(count: number, stage: string): void;
        };
      };
      counterStore.campaignCounters?.recordStoreRecordsTouched?.(lines.length, "view");
    }
    for (const line of lines) {
      if (!demandedRanges.some((range) => line.index >= range.startLine && line.index < range.endLine)) continue;
      const decoration = line.decoration;
      const isCurrentDecoration =
        decoration?.sourceRevision === line.sourceRevision &&
        decoration.configurationRevision === configurationRevision;
      if (isCurrentDecoration) {
        if (pendingStart !== -1) {
          ranges.push({ startLine: pendingStart, endLine: pendingEnd, sourceRevision: pendingSourceRevision });
          pendingStart = -1;
        }
        continue;
      }
      if (pendingStart === -1) {
        pendingStart = line.index;
        pendingEnd = line.index + 1;
        pendingSourceRevision = line.sourceRevision;
      } else if (line.index === pendingEnd) {
        pendingEnd += 1;
        pendingSourceRevision = Math.max(pendingSourceRevision, line.sourceRevision);
      } else {
        ranges.push({ startLine: pendingStart, endLine: pendingEnd, sourceRevision: pendingSourceRevision });
        pendingStart = line.index;
        pendingEnd = line.index + 1;
        pendingSourceRevision = line.sourceRevision;
      }
    }
    if (pendingStart !== -1) {
      ranges.push({ startLine: pendingStart, endLine: pendingEnd, sourceRevision: pendingSourceRevision });
    }
    if (ranges.length === 0) {
      previousDemandRef.current = null;
      return;
    }

    const isDuplicate =
      previous?.blockId === blockId &&
      previous.generation === generation &&
      previous.resetVersion === resetVersion &&
      previous.configurationRevision === configurationRevision &&
      previous.demandedRanges.length === demandedRanges.length &&
      previous.demandedRanges.every((range, index) => {
        const next = demandedRanges[index];
        return next !== undefined &&
          range.startLine === next.startLine &&
          range.endLine === next.endLine;
      }) &&
      previous.ranges.length === ranges.length &&
      previous.ranges.every((range, index) => {
        const next = ranges[index];
        return next !== undefined &&
          range.startLine === next.startLine &&
          range.endLine === next.endLine &&
          range.sourceRevision === next.sourceRevision;
      });
    if (isDuplicate) return;

    previousDemandRef.current = {
      blockId,
      generation,
      resetVersion,
      configurationRevision,
      demandedRanges,
      ranges,
    };
    for (const range of ranges) {
      highlightRequester({
        blockId,
        startLine: range.startLine,
        endLine: range.endLine,
        priority: "visible",
        reason: "scroll",
      });
    }
  }, [
    blockId,
    chunkStart,
    configurationRevision,
    generation,
    resetVersion,
    highlightRequester,
    lines,
    rangeEnd,
    rangeStart,
    store,
    visibleEnd,
    visibleStart,
    renderSegments,
  ]);

  return <>{rows}</>;
});

CodeLineRangeView.displayName = "CodeLineRangeView";
