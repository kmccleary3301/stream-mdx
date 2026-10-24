import React from "react";
import { useCodeHighlightRequester } from "./code-highlight-context";
import type { RendererStore } from "./store";
import { getStoreResetVersion } from "./store-reset-version";

type LazyCodeHighlightRequestOptions = {
  store: RendererStore;
  blockId: string;
  resetVersion: number;
  blockEpoch: number;
  blockIsFinalized: boolean;
  lazyEnabled: boolean;
  lazyTokenizedUntil: number;
  totalLazyLineCount: number;
  shouldVirtualize: boolean;
};

export function useLazyCodeHighlightRequest({
  store,
  blockId,
  resetVersion,
  blockEpoch,
  blockIsFinalized,
  lazyEnabled,
  lazyTokenizedUntil,
  totalLazyLineCount,
  shouldVirtualize,
}: LazyCodeHighlightRequestOptions): void {
  const highlightRequester = useCodeHighlightRequester();
  const lastRangeRef = React.useRef<{
    blockId: string;
    endLine: number;
    tokenizedUntil: number;
    resetVersion: number;
    blockEpoch: number;
  } | null>(null);
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (shouldVirtualize || !blockIsFinalized || !lazyEnabled || !highlightRequester) return;
    if (totalLazyLineCount <= 0 || lazyTokenizedUntil >= totalLazyLineCount) return;

    const last = lastRangeRef.current;
    if (
      last?.resetVersion === resetVersion &&
      last.blockEpoch === blockEpoch &&
      last.blockId === blockId &&
      last.endLine === totalLazyLineCount &&
      last.tokenizedUntil === lazyTokenizedUntil
    ) {
      return;
    }
    const nextRange = {
      blockId,
      endLine: totalLazyLineCount,
      tokenizedUntil: lazyTokenizedUntil,
      resetVersion,
      blockEpoch,
    };
    lastRangeRef.current = nextRange;

    const requestFullHighlight = () => {
      rafRef.current = null;
      if (getStoreResetVersion(store) !== resetVersion) return;
      highlightRequester({
        blockId,
        startLine: 0,
        endLine: totalLazyLineCount,
        priority: "prefetch",
        reason: "finalize-full",
      });
    };
    if (typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function") {
      const frameId = requestAnimationFrame(requestFullHighlight);
      rafRef.current = frameId;
      return () => {
        if (rafRef.current !== frameId) return;
        cancelAnimationFrame(frameId);
        rafRef.current = null;
        if (lastRangeRef.current === nextRange) lastRangeRef.current = null;
      };
    }
    requestFullHighlight();
  }, [
    blockId,
    blockIsFinalized,
    blockEpoch,
    resetVersion,
    highlightRequester,
    lazyEnabled,
    lazyTokenizedUntil,
    shouldVirtualize,
    store,
    totalLazyLineCount,
  ]);
}
