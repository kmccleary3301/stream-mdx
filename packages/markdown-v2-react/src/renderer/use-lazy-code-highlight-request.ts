import React from "react";
import { useCodeHighlightRequester } from "./code-highlight-context";

type LazyCodeHighlightRequestOptions = {
  blockId: string;
  blockIsFinalized: boolean;
  lazyEnabled: boolean;
  lazyTokenizedUntil: number;
  totalLazyLineCount: number;
  shouldVirtualize: boolean;
};

export function useLazyCodeHighlightRequest({
  blockId,
  blockIsFinalized,
  lazyEnabled,
  lazyTokenizedUntil,
  totalLazyLineCount,
  shouldVirtualize,
}: LazyCodeHighlightRequestOptions): void {
  const highlightRequester = useCodeHighlightRequester();
  const lastRangeRef = React.useRef<{ blockId: string; endLine: number; tokenizedUntil: number } | null>(null);
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (shouldVirtualize || !blockIsFinalized || !lazyEnabled || !highlightRequester) return;
    if (totalLazyLineCount <= 0 || lazyTokenizedUntil >= totalLazyLineCount) return;

    const last = lastRangeRef.current;
    if (last?.blockId === blockId && last.endLine === totalLazyLineCount && last.tokenizedUntil === lazyTokenizedUntil) {
      return;
    }
    lastRangeRef.current = { blockId, endLine: totalLazyLineCount, tokenizedUntil: lazyTokenizedUntil };

    if (rafRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafRef.current);
    }
    const requestFullHighlight = () => {
      highlightRequester({
        blockId,
        startLine: 0,
        endLine: totalLazyLineCount,
        priority: "visible",
        reason: "finalize-full",
      });
      rafRef.current = null;
    };
    if (typeof requestAnimationFrame === "function") {
      rafRef.current = requestAnimationFrame(requestFullHighlight);
    } else {
      requestFullHighlight();
    }
  }, [blockId, blockIsFinalized, highlightRequester, lazyEnabled, lazyTokenizedUntil, shouldVirtualize, totalLazyLineCount]);
}
