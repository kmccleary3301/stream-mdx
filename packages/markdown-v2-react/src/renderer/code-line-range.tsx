declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

import type { CodeLineRecord } from "@stream-mdx/core";
import React from "react";
import { useCodeHighlightRequester } from "./code-highlight-context";
import type { RendererStore } from "./store";
import { NativeCodeLineGroup } from "./native-code-line";

export const CODE_LINE_RANGE_SIZE = 64;

const EMPTY_CODE_LINES: readonly CodeLineRecord[] = Object.freeze([]);

type DirtyCodeLineRange = {
  readonly startLine: number;
  readonly endLine: number;
  readonly sourceRevision: number;
};

type PreviousHighlightDemand = {
  readonly blockId: string;
  readonly generation: number;
  readonly configurationRevision: number;
  readonly visibleStart: number;
  readonly visibleEnd: number;
  readonly ranges: readonly DirtyCodeLineRange[];
};

type CodeLineRangeViewProps = {
  store: RendererStore;
  blockId: string;
  generation: number;
  configurationRevision: number;
  chunkStart: number;
  rangeStart: number;
  rangeEnd: number;
  visibleStart: number;
  visibleEnd: number;
};

/** One fixed-range store subscription; completed 64-row snapshots remain stable across tail appends. */
export const CodeLineRangeView = React.memo(function CodeLineRangeView({
  store,
  blockId,
  generation,
  configurationRevision,
  chunkStart,
  rangeStart,
  rangeEnd,
  visibleStart,
  visibleEnd,
}: CodeLineRangeViewProps): React.ReactElement {
  const readRange = React.useCallback(() => {
    const current = store.getCodeBlock(blockId);
    if (
      !current ||
      current.source.generation !== generation ||
      current.configurationRevision !== configurationRevision
    ) {
      return EMPTY_CODE_LINES;
    }
    return store.getCodeLines(blockId, chunkStart, chunkStart + CODE_LINE_RANGE_SIZE);
  }, [blockId, chunkStart, configurationRevision, generation, store]);
  const lines = React.useSyncExternalStore(store.subscribe, readRange, readRange);
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
    for (const line of lines) {
      if (line.index < rangeStart || line.index >= rangeEnd) continue;
      mappedRows.push(React.createElement(NativeCodeLineGroup, { key: line.id, line }));
    }
    return mappedRows;
  }, [blockId, chunkStart, configurationRevision, generation, lines, rangeEnd, rangeStart, store]);

  React.useEffect(() => {
    const previous = previousDemandRef.current;
    const demandStart = Math.max(visibleStart, rangeStart, chunkStart);
    const demandEnd = Math.min(visibleEnd, rangeEnd, chunkStart + CODE_LINE_RANGE_SIZE);
    if (!highlightRequester || demandEnd <= demandStart) {
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
      if (line.index < demandStart || line.index >= demandEnd) continue;
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
      previous.configurationRevision === configurationRevision &&
      previous.visibleStart === demandStart &&
      previous.visibleEnd === demandEnd &&
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
      configurationRevision,
      visibleStart: demandStart,
      visibleEnd: demandEnd,
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
    highlightRequester,
    lines,
    rangeEnd,
    rangeStart,
    store,
    visibleEnd,
    visibleStart,
  ]);

  return <>{rows}</>;
});

CodeLineRangeView.displayName = "CodeLineRangeView";
