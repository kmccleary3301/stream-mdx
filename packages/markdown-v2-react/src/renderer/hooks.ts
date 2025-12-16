import type { Block } from "@stream-mdx/core";
import { useMemo, useSyncExternalStore } from "react";
import type { NodeRecord, RendererStore } from "./store";

export function useRendererBlocks(store: RendererStore): ReadonlyArray<Block> {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getBlocks(),
    () => store.getBlocks(),
  );
}

export function useRendererNode(store: RendererStore, id: string): NodeRecord | undefined {
  const selector = useMemo(() => {
    return () => store.getNodeWithVersion(id);
  }, [store, id]);

  const snapshot = useSyncExternalStore(store.subscribe, selector, selector);
  return snapshot.node;
}

export function useRendererChildren(store: RendererStore, id: string): ReadonlyArray<string> {
  const selector = useMemo(() => {
    return () => store.getChildrenWithVersion(id);
  }, [store, id]);

  const snapshot = useSyncExternalStore(store.subscribe, selector, selector);
  return snapshot.children;
}
