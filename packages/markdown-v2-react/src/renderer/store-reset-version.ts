import type { NodeRecord, RendererStore } from "./store";

export type PrivateRendererStore = RendererStore & {
  getResetVersion(): number;
  getRootSourceIdentity(): object | undefined;
};

export function getStoreResetVersion(store: RendererStore): number {
  return (store as PrivateRendererStore).getResetVersion();
}

type TableSourceOwner = {
  readonly tableId: string;
  readonly generation: number | undefined;
};

export function captureNodeSourceGuard(
  store: RendererStore,
  id: string,
  tableOwner?: TableSourceOwner,
): () => void {
  let ownerId = id;
  let ownerRecord: NodeRecord | undefined;
  let tableGeneration: number | undefined;
  let tableGenerationOwnerId: string | undefined;

  if (tableOwner) {
    ownerRecord = store.getNode(id);
    if (id === tableOwner.tableId || !ownerRecord) {
      ownerId = tableOwner.tableId;
      ownerRecord = store.getNode(ownerId);
      tableGeneration = tableOwner.generation;
      tableGenerationOwnerId = tableOwner.tableId;
    }
  } else {
    ownerRecord = store.getNode(ownerId);
    while (ownerRecord && !ownerRecord.block && ownerRecord.parentId) {
      ownerRecord = store.getNode(ownerRecord.parentId);
      if (ownerRecord) ownerId = ownerRecord.id;
    }
    if (ownerRecord?.block) ownerId = ownerRecord.block.id;
    ownerRecord = store.getNode(ownerId);
  }

  const ownerVersion = ownerRecord?.version;
  const resetVersion = getStoreResetVersion(store);
  const rootSourceIdentity = (store as PrivateRendererStore).getRootSourceIdentity();
  return () => {
    const current = store.getNode(ownerId);
    const currentTableGeneration = tableGenerationOwnerId === undefined
      ? undefined
      : store.getTableBlock(tableGenerationOwnerId)?.source.generation;
    if (
      getStoreResetVersion(store) !== resetVersion ||
      (store as PrivateRendererStore).getRootSourceIdentity() !== rootSourceIdentity ||
      !ownerRecord ||
      current !== ownerRecord ||
      current.version !== ownerVersion ||
      (tableGenerationOwnerId !== undefined && currentTableGeneration !== tableGeneration)
    ) {
      throw new Error("Cannot read source from a stale or removed node");
    }
  };
}

