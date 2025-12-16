import type { RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

export interface VirtualizedListConfig {
  enabled: boolean;
  depthThreshold: number;
  minItems: number;
  initialBatch: number;
  batchIncrement: number;
  rootMargin?: string;
}

const BOOLEAN_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return BOOLEAN_TRUE_VALUES.has(value.toLowerCase());
}

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const ENV_ENABLED = parseBooleanEnv(process.env.NEXT_PUBLIC_STREAMING_VIRTUALIZE_LISTS, true);

const ENV_INITIAL_BATCH = parseIntegerEnv(process.env.NEXT_PUBLIC_STREAMING_VIRTUALIZE_LISTS_INITIAL_BATCH, 40);

const ENV_BATCH_INCREMENT = parseIntegerEnv(process.env.NEXT_PUBLIC_STREAMING_VIRTUALIZE_LISTS_BATCH, 30);

const ENV_MIN_ITEMS = parseIntegerEnv(process.env.NEXT_PUBLIC_STREAMING_VIRTUALIZE_LISTS_MIN_ITEMS, 60);

const ENV_DEPTH_THRESHOLD = parseIntegerEnv(process.env.NEXT_PUBLIC_STREAMING_VIRTUALIZE_LISTS_DEPTH, 2);

export const DEFAULT_VIRTUALIZED_LIST_CONFIG: VirtualizedListConfig = Object.freeze({
  enabled: ENV_ENABLED,
  depthThreshold: ENV_DEPTH_THRESHOLD,
  minItems: ENV_MIN_ITEMS,
  initialBatch: ENV_INITIAL_BATCH,
  batchIncrement: ENV_BATCH_INCREMENT,
  rootMargin: "256px 0px",
});

export function shouldVirtualizeList(totalChildren: number, depth: number, config: VirtualizedListConfig = DEFAULT_VIRTUALIZED_LIST_CONFIG): boolean {
  if (!config.enabled) {
    return false;
  }
  if (!Number.isFinite(totalChildren) || totalChildren < config.minItems) {
    return false;
  }
  if (!Number.isFinite(depth) || depth < config.depthThreshold) {
    return false;
  }
  return true;
}

export interface VirtualizedListState {
  visibleChildIds: string[];
  sentinelRef: RefObject<HTMLLIElement>;
  visibleCount: number;
  isVirtualized: boolean;
}

export function useVirtualizedList(
  childIds: ReadonlyArray<string>,
  shouldVirtualize: boolean,
  config: VirtualizedListConfig = DEFAULT_VIRTUALIZED_LIST_CONFIG,
): VirtualizedListState {
  const totalChildren = childIds.length;
  const sentinelRef = useRef<HTMLLIElement | null>(null);
  const resolvedInitial = useMemo(() => {
    if (!shouldVirtualize) {
      return totalChildren;
    }
    const baseline = Math.min(totalChildren, Math.max(config.initialBatch, config.batchIncrement));
    return baseline;
  }, [shouldVirtualize, totalChildren, config.initialBatch, config.batchIncrement]);

  const [visibleCount, setVisibleCount] = useState(() => resolvedInitial);

  useEffect(() => {
    if (!shouldVirtualize) {
      setVisibleCount(totalChildren);
      return;
    }
    setVisibleCount((prev) => {
      const clampedPrev = Math.min(prev, totalChildren);
      return Math.max(resolvedInitial, clampedPrev);
    });
  }, [shouldVirtualize, totalChildren, resolvedInitial]);

  useEffect(() => {
    if (!shouldVirtualize) return;
    if (visibleCount >= totalChildren) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry || !entry.isIntersecting) {
          return;
        }
        setVisibleCount((prev) => {
          if (prev >= totalChildren) {
            return prev;
          }
          const next = prev + config.batchIncrement;
          return Math.min(totalChildren, next);
        });
      },
      {
        root: null,
        rootMargin: config.rootMargin ?? "256px 0px",
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [shouldVirtualize, totalChildren, visibleCount, config.batchIncrement, config.rootMargin]);

  const visibleChildIds = useMemo(() => {
    if (!shouldVirtualize) {
      return childIds as string[];
    }
    return childIds.slice(0, visibleCount) as string[];
  }, [childIds, shouldVirtualize, visibleCount]);

  return {
    visibleChildIds,
    sentinelRef,
    visibleCount,
    isVirtualized: shouldVirtualize && visibleCount < totalChildren,
  };
}
