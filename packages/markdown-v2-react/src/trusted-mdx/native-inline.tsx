import React, { useContext } from "react";
import { TrustedMdxNativeChildrenContext } from "@stream-mdx/react/_internal/trusted-mdx-native-children";
import { TrustedMdxProjectionContext } from "../trusted-mdx-boundary";
import {
  assertTrustedMdxNativeChildContinuations,
  type TrustedMdxCompiledRegionProps,
  type TrustedMdxDocumentSnapshot,
  type TrustedMdxNativeChildrenFactory,
} from "../trusted-mdx-contract";

export function renderTrustedMdxOwner(
  ownerId: string,
  snapshot: TrustedMdxDocumentSnapshot,
  source: string,
  inline: boolean,
  nativeChildren?: React.ReactNode,
): React.ReactNode {
  const projection = snapshot.projections[ownerId];
  if (projection?.kind === "native-child") return undefined;
  if (projection?.kind === "module") return null;
  if (projection?.kind === "server-content") {
    if (!projection.nativeChildren) return projection.content;
    if (nativeChildren === undefined) {
      throw new Error(`Trusted MDX owner "${ownerId}" has no prepared native children.`);
    }
    return (
      <TrustedMdxNativeChildrenContext.Provider value={nativeChildren}>
        {projection.content}
      </TrustedMdxNativeChildrenContext.Provider>
    );
  }
  if (projection?.kind === "render" && projection.nativeChildren && nativeChildren === undefined) {
    throw new Error(`Trusted MDX owner "${ownerId}" has no prepared native children.`);
  }
  if (projection?.kind === "render") {
    const nativeChildrenFactory: TrustedMdxNativeChildrenFactory | undefined =
      projection.rootElementName === undefined || nativeChildren === undefined
        ? undefined
        : (fallback) => {
            const owners = projection.nativeChildOwners;
            const flowChildren = projection.flowChildren;
            if (
              !owners ||
              !flowChildren ||
              owners.length !== flowChildren.length ||
              !Array.isArray(nativeChildren) ||
              nativeChildren.length !== owners.length
            ) {
              throw new Error(`Trusted MDX owner "${ownerId}" has misaligned native child owners.`);
            }
            assertTrustedMdxNativeChildContinuations(owners, flowChildren);
            return owners.map((owner, index) => {
              if (owner === null) return fallback(index);
              if (owner.kind === "continuation") return undefined;
              const child = nativeChildren[index];
              if (child === undefined) {
                throw new Error(`Trusted MDX owner "${ownerId}" has no rendered native child "${owner.blockId}".`);
              }
              return child;
            });
          };

    return (
      <>
        {projection.regions.map((Region, index) => {
          const regionProps: TrustedMdxCompiledRegionProps = {
            components: snapshot.components,
            ...(nativeChildrenFactory === undefined
              ? {}
              : { children: nativeChildrenFactory }),
          };
          return React.createElement(
            React.Fragment,
            { key: `${ownerId}:${index}` },
            Region(regionProps),
          );
        })}
      </>
    );
  }

  const diagnostic = projection?.kind === "unmapped"
    ? projection.diagnostic
    : snapshot.error ?? `MDX owner "${ownerId}" has no exact trusted source projection.`;
  const status = projection?.kind === "unmapped" ? "unmapped" : snapshot.status === "error" ? "error" : "pending";
  const renderInline = projection?.kind === "unmapped" && projection.placement !== undefined
    ? projection.placement === "inline"
    : inline;
  if (renderInline) {
    return (
      <span className="markdown-mdx-inline" data-mdx-status={status} data-mdx-diagnostic={diagnostic}>
        {source}
        <span className="markdown-mdx-diagnostic" role="note">{diagnostic}</span>
      </span>
    );
  }
  return (
    <div className="markdown-mdx-inert" data-mdx-status={status} data-mdx-diagnostic={diagnostic}>
      <pre><code>{source}</code></pre>
      <span className="markdown-mdx-diagnostic" role="note">{diagnostic}</span>
    </div>
  );
}

export function TrustedMdxInlineOwner({ ownerId, source }: { readonly ownerId: string; readonly source: string }): React.ReactElement {
  const snapshot = useContext(TrustedMdxProjectionContext);
  if (!snapshot) return <span className="markdown-mdx-inline">{source}</span>;
  return <>{renderTrustedMdxOwner(ownerId, snapshot, source, true)}</>;
}
