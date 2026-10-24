import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { NodeChildRange, NodeHandle, NodeHandleMetadata } from "../types";

/** Observe stable metadata from one generation-bound node handle. */
export function useNode(handle: NodeHandle): NodeHandleMetadata {
  const subscribe = useCallback((listener: () => void) => handle.subscribeMetadata(listener), [handle]);
  const getSnapshot = useCallback(() => handle.readMetadata(), [handle]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Observe an explicit half-open child range from one generation-bound node handle. */
export function useNodeChildren(handle: NodeHandle, range: NodeChildRange): readonly NodeHandle[] {
  const stableRange = useMemo(
    () => Object.freeze({ from: range.from, to: range.to }),
    [range.from, range.to],
  );
  const subscribe = useCallback(
    (listener: () => void) => handle.subscribeChildren(stableRange, listener),
    [handle, stableRange],
  );
  const getSnapshot = useCallback(() => handle.readChildren(stableRange), [handle, stableRange]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
