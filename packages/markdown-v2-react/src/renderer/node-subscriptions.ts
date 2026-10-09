import type { RendererStore } from "./store";

type NodeSubscribe = (id: string, listener: () => void) => () => void;

// Internal (not re-exported from the package): lets node hooks subscribe to one node id so a store notify
// wakes only the subscribers of changed ids instead of every mounted node.
const nodeSubscriptions = new WeakMap<RendererStore, NodeSubscribe>();

export function registerNodeSubscriptions(store: RendererStore, subscribe: NodeSubscribe): void {
  nodeSubscriptions.set(store, subscribe);
}

/** Stores created outside `createRendererStore` fall back to the whole-store subscription. */
export function subscribeRendererNode(store: RendererStore, id: string, listener: () => void): () => void {
  const subscribe = nodeSubscriptions.get(store);
  return subscribe ? subscribe(id, listener) : store.subscribe(listener);
}
