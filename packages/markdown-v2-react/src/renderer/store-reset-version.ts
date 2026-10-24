import type { RendererStore } from "./store";

export type PrivateRendererStore = RendererStore & {
  getResetVersion(): number;
  getRootSourceIdentity(): object | undefined;
};

export function getStoreResetVersion(store: RendererStore): number {
  return (store as PrivateRendererStore).getResetVersion();
}

export function captureNodeSourceGuard(store: RendererStore, id: string): () => void {
  let ownerId = id;
  let ownerRecord = store.getNode(ownerId);
  while (ownerRecord && !ownerRecord.block && ownerRecord.parentId) {
    ownerRecord = store.getNode(ownerRecord.parentId);
    if (ownerRecord) ownerId = ownerRecord.id;
  }
  if (ownerRecord?.block) ownerId = ownerRecord.block.id;
  ownerRecord = store.getNode(ownerId);
  const ownerVersion = ownerRecord?.version;
  const resetVersion = getStoreResetVersion(store);
  const rootSourceIdentity = (store as PrivateRendererStore).getRootSourceIdentity();
  return () => {
    const current = store.getNode(ownerId);
    if (
      getStoreResetVersion(store) !== resetVersion ||
      (store as PrivateRendererStore).getRootSourceIdentity() !== rootSourceIdentity ||
      !ownerRecord ||
      current !== ownerRecord ||
      current.version !== ownerVersion
    ) {
      throw new Error("Cannot read source from a stale or removed node");
    }
  };
}

