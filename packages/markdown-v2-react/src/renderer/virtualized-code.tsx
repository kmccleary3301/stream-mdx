import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface VirtualizedCodeConfig {
  enabled: boolean;
  windowSize: number;
  bufferSize: number;
  virtualizeThreshold: number;
}

export const DEFAULT_VIRTUALIZED_CODE_CONFIG: VirtualizedCodeConfig = {
  enabled: true,
  windowSize: 100,
  bufferSize: 50,
  virtualizeThreshold: 200,
};

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

/** Owns viewport geometry and scroll position only; record ranges subscribe separately. */
export function useVirtualizedCode(
  totalLines: number,
  generation: number,
  config: VirtualizedCodeConfig = DEFAULT_VIRTUALIZED_CODE_CONFIG,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [lineHeight, setLineHeight] = useState(20);
  const followTailRef = useRef(false);
  const previousOwnerRef = useRef({ generation, totalLines });

  const range = useMemo(
    () => calculateCodeWindow(totalLines, scrollTop, containerHeight, lineHeight, config),
    [config, containerHeight, lineHeight, scrollTop, totalLines],
  );

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      const container = containerRef.current;
      const firstLine = container?.querySelector<HTMLElement>(".line");
      if (!firstLine) return;
      const measuredHeight = firstLine.offsetHeight || 20;
      setLineHeight((current) => current === measuredHeight ? current : measuredHeight);
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [generation, range.endIndex, range.startIndex]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    setScrollTop(target.scrollTop);
    setContainerHeight(target.clientHeight);
    followTailRef.current = target.scrollHeight - target.clientHeight - target.scrollTop <= lineHeight;
  }, [lineHeight]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const nextHeight = Math.ceil(entry.contentRect.height);
        setContainerHeight((current) => current === nextHeight ? current : nextHeight);
      }
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const previousOwner = previousOwnerRef.current;
    previousOwnerRef.current = { generation, totalLines };
    const container = containerRef.current;
    if (previousOwner.generation !== generation) {
      followTailRef.current = false;
      if (container && container.scrollTop !== 0) container.scrollTop = 0;
      setScrollTop(0);
      return;
    }
    if (previousOwner.totalLines === totalLines || !container || !followTailRef.current) return;
    const nextScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (container.scrollTop !== nextScrollTop) {
      container.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
    }
  }, [generation, totalLines]);

  const scrollToLine = useCallback((lineIndex: number) => {
    const container = containerRef.current;
    if (!container) return;
    const targetScrollTop = Math.max(0, Math.min(lineIndex, totalLines - 1)) * lineHeight;
    container.scrollTop = targetScrollTop;
    setScrollTop(targetScrollTop);
  }, [lineHeight, totalLines]);

  return {
    containerRef,
    window: range,
    handleScroll,
    scrollToLine,
    lineHeight,
    config,
  };
}
