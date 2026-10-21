import React from "react";
import { useCodeHighlightRequester } from "./code-highlight-context";
import type { NodeRecord, RendererStore } from "./store";

type LazyCodeHighlightRequestOptions = {
  blockId: string;
  // The store root is stable across patches and replaced by reset.
  documentIdentity: NodeRecord | RendererStore;
  blockEpoch: number;
  blockIsFinalized: boolean;
  lazyEnabled: boolean;
  lazyTokenizedUntil: number;
  totalLazyLineCount: number;
  shouldVirtualize: boolean;
};

export function useLazyCodeHighlightRequest({
  blockId,
  documentIdentity,
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
    documentIdentity: NodeRecord | RendererStore;
    blockEpoch: number;
  } | null>(null);
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (shouldVirtualize || !blockIsFinalized || !lazyEnabled || !highlightRequester) return;
    if (totalLazyLineCount <= 0 || lazyTokenizedUntil >= totalLazyLineCount) return;

    const last = lastRangeRef.current;
    if (
      last?.documentIdentity === documentIdentity &&
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
      documentIdentity,
      blockEpoch,
    };
    lastRangeRef.current = nextRange;

    const requestFullHighlight = () => {
      rafRef.current = null;
      highlightRequester({
        blockId,
        startLine: 0,
        endLine: totalLazyLineCount,
        priority: "visible",
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
    documentIdentity,
    highlightRequester,
    lazyEnabled,
    lazyTokenizedUntil,
    shouldVirtualize,
    totalLazyLineCount,
  ]);
}
