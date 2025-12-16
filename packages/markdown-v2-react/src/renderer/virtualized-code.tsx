import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface VirtualizedCodeConfig {
  enabled: boolean;
  windowSize: number; // Number of visible lines
  bufferSize: number; // Buffer lines above/below visible window
  virtualizeThreshold: number; // Minimum lines to trigger virtualization
}

export const DEFAULT_VIRTUALIZED_CODE_CONFIG: VirtualizedCodeConfig = {
  enabled: true,
  windowSize: 100, // Render 100 lines at a time
  bufferSize: 50, // +50 lines buffer above/below
  virtualizeThreshold: 200, // Only virtualize if 200+ lines
};

export interface VirtualizedLine {
  id: string;
  index: number;
  text: string;
  html?: string | null;
}

export interface VirtualizedCodeWindow {
  startIndex: number;
  endIndex: number;
  visibleLines: VirtualizedLine[];
  totalLines: number;
  mountedLines: number;
}

/**
 * Calculate which lines should be rendered based on scroll position
 */
export function calculateCodeWindow(
  lines: ReadonlyArray<VirtualizedLine>,
  scrollTop: number,
  containerHeight: number,
  lineHeight: number,
  config: VirtualizedCodeConfig,
): VirtualizedCodeWindow {
  const totalLines = lines.length;
  if (!config.enabled || totalLines < config.virtualizeThreshold) {
    // Render all lines if virtualization disabled or below threshold
    return {
      startIndex: 0,
      endIndex: totalLines,
      visibleLines: lines as VirtualizedLine[],
      totalLines,
      mountedLines: totalLines,
    };
  }

  // Calculate visible range
  const firstVisibleLine = Math.floor(scrollTop / lineHeight);
  const lastVisibleLine = Math.ceil((scrollTop + containerHeight) / lineHeight);

  // Apply buffer
  const startIndex = Math.max(0, firstVisibleLine - config.bufferSize);
  const endIndex = Math.min(totalLines, lastVisibleLine + config.bufferSize);

  return {
    startIndex,
    endIndex,
    visibleLines: lines.slice(startIndex, endIndex) as VirtualizedLine[],
    totalLines,
    mountedLines: endIndex - startIndex,
  };
}

/**
 * Hook for virtualized code block scrolling
 */
export function useVirtualizedCode(lines: ReadonlyArray<VirtualizedLine>, config: VirtualizedCodeConfig = DEFAULT_VIRTUALIZED_CODE_CONFIG) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const lineHeightRef = useRef<number>(20); // Default line height, will be measured

  // Measure line height on mount or when lines change
  useEffect(() => {
    if (!containerRef.current || lines.length === 0) return;
    // Wait for next frame to ensure DOM is rendered
    const timeoutId = setTimeout(() => {
      if (!containerRef.current) return;
      const firstLine = containerRef.current.querySelector<HTMLElement>(".line");
      if (firstLine) {
        const measuredHeight = firstLine.offsetHeight || 20;
        if (measuredHeight !== lineHeightRef.current) {
          lineHeightRef.current = measuredHeight;
        }
      }
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [lines.length]);

  // Handle scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    setScrollTop(target.scrollTop);
    setContainerHeight(target.clientHeight);
  }, []);

  // Measure container height on resize
  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // Calculate window
  const window = useMemo(() => {
    return calculateCodeWindow(lines, scrollTop, containerHeight, lineHeightRef.current, config);
  }, [lines, scrollTop, containerHeight, config]);

  // Scroll to line helper
  const scrollToLine = useCallback((lineIndex: number) => {
    if (!containerRef.current) return;
    const targetScrollTop = lineIndex * lineHeightRef.current;
    containerRef.current.scrollTop = targetScrollTop;
    setScrollTop(targetScrollTop);
  }, []);

  return {
    containerRef,
    window,
    handleScroll,
    scrollToLine,
    lineHeight: lineHeightRef.current,
    config,
  };
}
