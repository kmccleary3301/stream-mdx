import type { CodeBlockMetadata, CodeLineRange, CodeLineRecord, CodeNodeHandle } from "@stream-mdx/core";
import { useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { NativeCodeViewContext, useCodeHighlightRequester } from "./code-highlight-context";

function assertCodeLineRange(range: CodeLineRange): void {
  if (
    range === null ||
    typeof range !== "object" ||
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 0 ||
    range.to < range.from
  ) {
    throw new RangeError("Code line range must be ordered non-negative safe integers");
  }
}

type DirtyCodeLineRange = {
  readonly from: number;
  readonly to: number;
  readonly sourceRevision: number;
};

type PreviousCodeLineDemand = {
  readonly handle: CodeNodeHandle;
  readonly blockId: string;
  readonly codeOwnerId: string;
  readonly generation: number;
  readonly configurationRevision: number;
  readonly state: CodeBlockMetadata["state"];
  readonly from: number;
  readonly to: number;
  readonly ranges: readonly DirtyCodeLineRange[];
};

type CodeLinesSnapshot = {
  readonly metadata: CodeBlockMetadata;
  readonly lines: readonly CodeLineRecord[];
};

/** Observe stable, bounded metadata from a live code owner. */
export function useCodeBlock(handle: CodeNodeHandle): CodeBlockMetadata {
  const subscribe = useCallback(
    (listener: () => void) => handle.subscribeMetadata(listener),
    [handle],
  );
  const getSnapshot = useCallback(() => handle.readMetadata(), [handle]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useCodeLines(
  handle: CodeNodeHandle,
  range: CodeLineRange,
): readonly CodeLineRecord[] {
  assertCodeLineRange(range);
  const stableRange = useMemo(
    () => Object.freeze({ from: range.from, to: range.to }),
    [range.from, range.to],
  );
  const snapshotRef = useRef<CodeLinesSnapshot | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => handle.subscribeLines(stableRange, listener),
    [handle, stableRange],
  );
  const getSnapshot = useCallback(() => {
    const metadata = handle.readMetadata();
    const lines = handle.readLines(stableRange);
    const previous = snapshotRef.current;
    if (previous?.metadata === metadata && previous.lines === lines) return previous;
    const next = { metadata, lines };
    snapshotRef.current = next;
    return next;
  }, [handle, stableRange]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { metadata, lines } = snapshot;
  const nativeView = useContext(NativeCodeViewContext);
  const highlightRequester = useCodeHighlightRequester();
  const previousDemand = useRef<PreviousCodeLineDemand | null>(null);

  useEffect(() => {
    if (!nativeView || nativeView.handle !== handle || !highlightRequester) {
      previousDemand.current = null;
      return;
    }

    const demandFrom = stableRange.from;
    const demandTo = Math.min(stableRange.to, metadata.lineCount);
    const dirtyRanges: DirtyCodeLineRange[] = [];
    let pendingFrom = -1;
    let pendingTo = -1;
    let pendingSourceRevision = -1;
    const flushPending = () => {
      if (pendingFrom === -1) return;
      dirtyRanges.push({ from: pendingFrom, to: pendingTo, sourceRevision: pendingSourceRevision });
      pendingFrom = -1;
    };

    for (const line of lines) {
      if (line.index < demandFrom || line.index >= demandTo) continue;
      const decoration = line.decoration;
      const isCurrentDecoration =
        decoration?.sourceRevision === line.sourceRevision &&
        decoration.configurationRevision === metadata.configurationRevision;
      if (isCurrentDecoration) {
        flushPending();
        continue;
      }
      if (pendingFrom === -1) {
        pendingFrom = line.index;
        pendingTo = line.index + 1;
        pendingSourceRevision = line.sourceRevision;
      } else if (line.index === pendingTo) {
        pendingTo += 1;
        pendingSourceRevision = Math.max(pendingSourceRevision, line.sourceRevision);
      } else {
        flushPending();
        pendingFrom = line.index;
        pendingTo = line.index + 1;
        pendingSourceRevision = line.sourceRevision;
      }
    }
    flushPending();

    if (dirtyRanges.length === 0) {
      previousDemand.current = null;
      return;
    }

    const previous = previousDemand.current;
    const isDuplicate =
      previous?.handle === handle &&
      previous.blockId === nativeView.blockId &&
      previous.codeOwnerId === metadata.codeOwnerId &&
      previous.generation === metadata.generation &&
      previous.configurationRevision === metadata.configurationRevision &&
      previous.state === metadata.state &&
      previous.from === demandFrom &&
      previous.to === demandTo &&
      previous.ranges.length === dirtyRanges.length &&
      previous.ranges.every((item, index) => {
        const next = dirtyRanges[index];
        return next !== undefined &&
          item.from === next.from &&
          item.to === next.to &&
          item.sourceRevision === next.sourceRevision;
      });
    if (isDuplicate) return;

    previousDemand.current = {
      handle,
      blockId: nativeView.blockId,
      codeOwnerId: metadata.codeOwnerId,
      generation: metadata.generation,
      configurationRevision: metadata.configurationRevision,
      state: metadata.state,
      from: demandFrom,
      to: demandTo,
      ranges: dirtyRanges,
    };
    for (const dirtyRange of dirtyRanges) {
      highlightRequester({
        blockId: nativeView.blockId,
        startLine: dirtyRange.from,
        endLine: dirtyRange.to,
        priority: "visible",
      });
    }
  }, [handle, highlightRequester, lines, metadata, nativeView, stableRange]);

  return lines;
}
