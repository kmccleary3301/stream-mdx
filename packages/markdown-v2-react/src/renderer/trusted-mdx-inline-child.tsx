import type { Block } from "@stream-mdx/core";
import React from "react";
import { renderInlineNodes, type ComponentRegistry } from "../components";
import { useRendererNode } from "./hooks";
import type { RendererStore } from "./store";

export function renderTrustedMdxInlineChild(
  block: Block,
  registry: ComponentRegistry,
  parentTagName: string | undefined,
): React.ReactNode {
  const inline = block.payload.inline;
  if (inline === undefined) {
    throw new Error(`Trusted MDX inline child "${block.id}" has no prepared native inline content.`);
  }
  return renderInlineNodes(
    inline,
    registry.getInlineComponents(),
    registry.getUrlTransform(),
    registry,
    parentTagName,
    registry.getRenderInlineContext(block.isFinalized, `${block.id}:trusted-inline`),
  );
}

export const TrustedMdxInlineBlockView: React.FC<{
  store: RendererStore;
  blockId: string;
  registry: ComponentRegistry;
  parentTagName: string | undefined;
}> = React.memo(({ store, blockId, registry, parentTagName }) => {
  const block = useRendererNode(store, blockId)?.block;
  if (!block) return null;
  return renderTrustedMdxInlineChild(block, registry, parentTagName);
});

TrustedMdxInlineBlockView.displayName = "TrustedMdxInlineBlockView";
