import type { Block } from "@stream-mdx/core";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { subscribeRendererNode } from "./node-subscriptions";
import type { NodeRecord, RendererStore } from "./store";

/**
 * Bumped when render-time registry config (filters, URL policy, block overrides) changes.
 * Node views are memoized on (store, id, registry); consuming this in the shared node hooks
 * re-renders every mounted view on a config change without remounting it.
 */
export const RenderConfigVersionContext = createContext(0);

export function useRendererBlocks(store: RendererStore): ReadonlyArray<Block> {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getBlocks(),
    () => store.getBlocks(),
  );
}

/** Lifecycle-only subscription; never materializes authored blocks or code lines. */
export function useRendererHasProvisionalBlocks(store: RendererStore): boolean {
  return useSyncExternalStore(store.subscribe, store.hasProvisionalBlocks, store.hasProvisionalBlocks);
}

export function useRendererNodeSnapshot(
  store: RendererStore,
  id: string,
): { version: number; node?: NodeRecord } {
  useContext(RenderConfigVersionContext);
  const subscribe = useCallback((listener: () => void) => subscribeRendererNode(store, id, listener), [store, id]);
  const selector = useMemo(() => {
    return () => store.getNodeWithVersion(id);
  }, [store, id]);
  return useSyncExternalStore(subscribe, selector, selector);
}

export function useRendererNode(store: RendererStore, id: string): NodeRecord | undefined {
  return useRendererNodeSnapshot(store, id).node;
}


export function useRendererChildren(store: RendererStore, id: string): ReadonlyArray<string> {
  useContext(RenderConfigVersionContext);
  const subscribe = useCallback((listener: () => void) => subscribeRendererNode(store, id, listener), [store, id]);
  const selector = useMemo(() => {
    return () => store.getChildrenWithVersion(id);
  }, [store, id]);

  const snapshot = useSyncExternalStore(subscribe, selector, selector);
  return snapshot.children;
}
