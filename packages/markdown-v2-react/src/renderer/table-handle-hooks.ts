import type { TableBlockMetadata, TableNodeHandle, TableRowRange, TableRowRecord } from "@stream-mdx/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";

/** Observe stable, bounded metadata from a live table owner. */
export function useTableBlock(handle: TableNodeHandle): TableBlockMetadata {
  const subscribe = useCallback(
    (listener: () => void) => handle.subscribeMetadata(listener),
    [handle],
  );
  const getSnapshot = useCallback(() => handle.readMetadata(), [handle]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Observe a bounded half-open range of body rows without subscribing to the whole table. */
export function useTableRows(
  handle: TableNodeHandle,
  range: TableRowRange,
): readonly TableRowRecord[] {
  const stableRange = useMemo(
    () => Object.freeze({ from: range.from, to: range.to }),
    [range.from, range.to],
  );
  const subscribe = useCallback(
    (listener: () => void) => handle.subscribeRows(stableRange, listener),
    [handle, stableRange],
  );
  const getSnapshot = useCallback(() => handle.readRows(stableRange), [handle, stableRange]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
