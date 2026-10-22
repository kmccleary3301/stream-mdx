import type { TrustedMdxFlowChildSpan } from "@stream-mdx/core";
import React from "react";
import type { ReactNode } from "react";
import { TrustedMdxProjectionContext } from "../trusted-mdx-boundary";
import type {
  TrustedMdxBlockProjection,
  TrustedMdxDocumentSnapshot,
  TrustedMdxNativeChildOwner,
} from "../trusted-mdx-contract";
export type TrustedMdxServerRegion =
  | { readonly ownerId: string; readonly kind: "module"; readonly nativeFlowParent?: true }
  | { readonly ownerId: string; readonly kind: "native-child" }
  | {
      readonly ownerId: string;
      readonly kind: "render";
      /** React content is Flight-safe; compiler closures and component maps stay server-side. */
      readonly content: ReactNode;
      readonly placement: "flow" | "inline";
      readonly nativeFlowOwnedBlockIds?: readonly string[];
      readonly nativeChildren?: true;
      readonly nativeChildOwners?: readonly TrustedMdxNativeChildOwner[];
      readonly flowChildren?: readonly TrustedMdxFlowChildSpan[];
      readonly wholeBlockFlowRoot?: true;
      readonly nativeFlowParent?: true;
      readonly rootElementName?: string | null;
    };

const EMPTY_COMPONENTS = Object.freeze({});

function createSnapshot(regions: readonly TrustedMdxServerRegion[]): TrustedMdxDocumentSnapshot {
  const projections: Record<string, TrustedMdxBlockProjection> = {};

  for (const region of regions) {
    if (region.kind === "module") {
      projections[region.ownerId] = {
        kind: "module",
        ...(region.nativeFlowParent ? { nativeFlowParent: true as const } : {}),
      };
      continue;
    }
    if (region.kind === "native-child") {
      projections[region.ownerId] = { kind: "native-child", nativeFlowParent: true };
      continue;
    }

    projections[region.ownerId] = {
      kind: "server-content",
      content: region.content,
      placement: region.placement,
      ...(region.nativeChildren ? { nativeChildren: true as const } : {}),
      ...(region.nativeChildOwners ? { nativeChildOwners: region.nativeChildOwners } : {}),
      ...(region.flowChildren ? { flowChildren: region.flowChildren } : {}),
      ...(region.nativeFlowOwnedBlockIds ? { nativeFlowOwnedBlockIds: region.nativeFlowOwnedBlockIds } : {}),
      ...(region.wholeBlockFlowRoot ? { wholeBlockFlowRoot: true as const } : {}),
      ...(region.nativeFlowParent ? { nativeFlowParent: true as const } : {}),
      ...(region.rootElementName === undefined ? {} : { rootElementName: region.rootElementName }),
    };
  }

  return Object.freeze({
    requestedRevision: 1,
    projectionRevision: 1,
    renderedRevision: 1,
    status: "ready",
    error: null,
    components: EMPTY_COMPONENTS,
    layout: null,
    projections: Object.freeze(projections),
  });
}

/** Reattaches server-rendered region nodes to native owners without transporting evaluator closures. */
export function TrustedMdxServerRegionProvider({
  regions,
  children,
}: {
  readonly regions: readonly TrustedMdxServerRegion[];
  readonly children: ReactNode;
}): React.ReactElement {
  const snapshot = React.useMemo(() => createSnapshot(regions), [regions]);
  return React.createElement(TrustedMdxProjectionContext.Provider, { value: snapshot }, children);
}
