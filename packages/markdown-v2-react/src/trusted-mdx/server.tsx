import React from "react";
import type { Block, TrustedMdxArtifact } from "@stream-mdx/core";
import type { ComponentType, ElementType } from "react";
import {
  assertTrustedMdxNativeChildContinuations,
  type TrustedMdxCompiledRegionProps,
  type TrustedMdxNativeChildrenFactory,
  type TrustedMdxRenderProps,
} from "../trusted-mdx-contract";
import { evaluateCompiledMdx } from "./evaluate";

import { TrustedMdxNativeChildrenSlot } from "@stream-mdx/react/_internal/trusted-mdx-native-children";
import { projectMdxBlocks } from "./projection";
import type { TrustedMdxServerRegion } from "./server-regions";

export type { TrustedMdxServerRegion } from "./server-regions";

export interface TrustedMdxServerProjectionOptions {
  /** Complete authored document corresponding to both the artifact and worker blocks. */
  readonly source: string;
  readonly blocks: readonly Block[];
  /** Pure artifact compiled once by the explicit trusted compiler. */
  readonly artifact: TrustedMdxArtifact;
  readonly components?: Readonly<Record<string, ElementType>>;
  readonly imports?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface TrustedMdxServerProjection {
  /** Exact native owners carry ReactNode content, never region closures or component maps. */
  readonly regions: readonly TrustedMdxServerRegion[];
  /** Apply on the server around the renderer; never pass this component as client data. */
  readonly layout: ComponentType<TrustedMdxRenderProps> | null;
}

/** Evaluates one complete trusted artifact and projects its regions onto native owners for SSR. */
export async function projectTrustedMdxServerDocument(
  options: TrustedMdxServerProjectionOptions,
): Promise<TrustedMdxServerProjection> {
  const components = options.components ? Object.freeze({ ...options.components }) : Object.freeze({});
  const evaluated = await evaluateCompiledMdx(options.artifact.code, { imports: options.imports }, () => true);
  if (!evaluated) {
    throw new Error("Trusted MDX server evaluation was unexpectedly cancelled.");
  }

  const regionComponents = evaluated.createRegions({ components });
  const projections = projectMdxBlocks(options.source, options.blocks, options.artifact.regions, regionComponents);
  const regions: TrustedMdxServerRegion[] = [];

  for (const [ownerId, projection] of Object.entries(projections)) {
    if (projection.kind === "native-child") {
      regions.push(Object.freeze({ ownerId, kind: "native-child" }));
      continue;
    }
    if (projection.kind === "module") {
      regions.push(Object.freeze({ ownerId, kind: "module", ...(projection.nativeFlowParent ? { nativeFlowParent: true as const } : {}) }));
      continue;
    }
    if (projection.kind === "unmapped") {
      throw new Error(projection.diagnostic);
    }
    if (projection.kind !== "render") {
      throw new Error(`Trusted MDX owner "${ownerId}" has no server-renderable compiler regions.`);
    }

    if (
      projection.nativeChildren &&
      (projection.rootElementName === undefined || projection.regions.length !== 1)
    ) {
      throw new Error(`Trusted MDX owner "${ownerId}" has no unique compiler-authored native-children root.`);
    }

    const nativeChildrenOverride: TrustedMdxNativeChildrenFactory | undefined =
      projection.nativeChildren
        ? (fallback) => {
          const owners = projection.nativeChildOwners;
          const flowChildren = projection.flowChildren;
          if (
            !owners ||
            !flowChildren ||
            owners.length !== flowChildren.length
          ) {
            throw new Error(`Trusted MDX owner "${ownerId}" has misaligned native child owners.`);
          }
          assertTrustedMdxNativeChildContinuations(owners, flowChildren);
          const children = owners.map((owner, index) => {
            if (owner?.kind === "continuation") return null;
            if (owner !== null) {
              return React.createElement(TrustedMdxNativeChildrenSlot, {
                index,
                key: `${owner.kind}:${owner.blockId}:${index}`,
              });
            }
            const flowChild = flowChildren[index];
            if (flowChild === undefined) {
              throw new Error(`Trusted MDX owner "${ownerId}" has a missing native flow child at index ${index}.`);
            }
            return React.createElement(
              React.Fragment,
              { key: `source:${flowChild.kind}:${flowChild.from}:${flowChild.to}` },
              fallback(index),
            );
          });
          return React.createElement(TrustedMdxNativeChildrenSlot, null, children);
        }
      : undefined;
    const content = React.createElement(
      React.Fragment,
      null,
      ...projection.regions.map((Region, index) => {
        // Evaluated regions are compiler-created pure functions; invoke them here so the
        // server-to-client handoff contains React nodes, not evaluator closures.
        return React.createElement(
          React.Fragment,
          { key: `${ownerId}:${index}` },
          Region({
            components,
            ...(nativeChildrenOverride === undefined
              ? {}
              : { children: nativeChildrenOverride }),
          } satisfies TrustedMdxCompiledRegionProps),
        );
      }),
    );
    regions.push(
      Object.freeze({
        ownerId,
        kind: "render",
        content,
        placement: projection.placement,
        ...(projection.nativeChildren ? { nativeChildren: true as const } : {}),
        ...(projection.nativeChildOwners ? { nativeChildOwners: projection.nativeChildOwners } : {}),
        ...(projection.flowChildren ? { flowChildren: projection.flowChildren } : {}),
        ...(projection.nativeFlowOwnedBlockIds ? { nativeFlowOwnedBlockIds: projection.nativeFlowOwnedBlockIds } : {}),
        ...(projection.wholeBlockFlowRoot ? { wholeBlockFlowRoot: true as const } : {}),
        ...(projection.nativeFlowParent ? { nativeFlowParent: true as const } : {}),
        ...(projection.rootElementName === undefined ? {} : { rootElementName: projection.rootElementName }),
      }),
    );
  }

  return Object.freeze({ regions: Object.freeze(regions), layout: evaluated.layout ?? null });
}
