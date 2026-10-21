import type { RendererStore } from "./store";

export type PrivateRendererStore = RendererStore & {
  getResetVersion(): number;
};

export function getStoreResetVersion(store: RendererStore): number {
  return (store as PrivateRendererStore).getResetVersion();
}
