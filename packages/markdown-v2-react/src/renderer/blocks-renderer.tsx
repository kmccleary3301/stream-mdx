import type { Block } from "@stream-mdx/core";
import React, { useMemo } from "react";

import { getBlockKey, PATCH_ROOT_ID } from "@stream-mdx/core";
import { ComponentRegistry } from "../components";
import type { BlockRendererOverride, CodeFenceRenderer } from "../types";
import { useRendererChildren } from "./hooks";
import { BlockNodeRenderer } from "./node-views";
import type { RendererStore } from "./store";

/**
 * React component for rendering markdown blocks
 */
export interface MarkdownBlocksRendererProps {
  blocks: ReadonlyArray<Block>;
  componentRegistry?: ComponentRegistry;
  codeRenderers?: Record<string, CodeFenceRenderer>;
  className?: string;
  style?: React.CSSProperties;
  store?: RendererStore;
  blockRenderer?: BlockRendererOverride;
  documentContext?: Record<string, unknown>;
}

export const MarkdownBlocksRenderer = React.memo<MarkdownBlocksRendererProps>(
  ({ blocks, componentRegistry, codeRenderers, blockRenderer, documentContext, className = "markdown-renderer", style, store }) => {
    const resolvedRegistry = useMemo(() => {
      const reg = componentRegistry ?? new ComponentRegistry();
      if (codeRenderers) {
        reg.setCodeRenderers(codeRenderers);
      }
      if (blockRenderer) {
        reg.setBlockRenderer(blockRenderer);
      }
      if (documentContext) {
        reg.setDocumentContext(documentContext);
      }
      return reg;
    }, [componentRegistry, codeRenderers, blockRenderer, documentContext]);
  if (store) {
    return React.createElement(
      "div",
      {
        className,
        style: { contain: "content", ...(style ?? {}) }, // CSS containment for performance
      },
      React.createElement(StoreBackedBlocks, { store, componentRegistry: resolvedRegistry }),
    );
  }

  const renderedBlocks = useMemo(() => {
    return blocks.map((block) => {
      const key = getBlockKey(block);
      return React.createElement(BlockRenderer, {
        key,
        block,
        componentRegistry: resolvedRegistry,
        isFinalized: block.isFinalized,
      });
    });
  }, [blocks, resolvedRegistry]);

  return React.createElement(
    "div",
    {
      className,
      style: { contain: "content", ...(style ?? {}) }, // CSS containment for performance
    },
    renderedBlocks,
  );
});

const StoreBackedBlocks = React.memo<{ store: RendererStore; componentRegistry: ComponentRegistry }>(
  ({ store, componentRegistry }) => {
    const blockIds = useRendererChildren(store, PATCH_ROOT_ID);
    return React.createElement(
      React.Fragment,
      null,
      blockIds.map((blockId) => React.createElement(BlockNodeRenderer, { key: blockId, store, blockId, registry: componentRegistry })),
    );
  },
);

StoreBackedBlocks.displayName = "StoreBackedBlocks";

/**
 * Individual block renderer with memoization
 */
const BlockRenderer = React.memo<{
  block: Block;
  componentRegistry: ComponentRegistry;
  isFinalized: boolean;
}>(({ block, componentRegistry, isFinalized }) => {
  const element = useMemo(() => {
    return componentRegistry.renderBlock(block);
  }, [block, componentRegistry]);

  const finalElement = useMemo(() => {
    return componentRegistry.renderFinalizedBlock(block, element);
  }, [block, componentRegistry, element]);

  // Add finalization indicator for debugging
  const className = `markdown-block markdown-block-${block.type} ${isFinalized ? "finalized" : "dirty"}`;

  if (React.isValidElement(finalElement)) {
    return React.cloneElement(finalElement, {
      className: `${finalElement.props.className || ""} ${className}`.trim(),
      "data-block-id": block.id,
      "data-finalized": isFinalized,
    });
  }

  return React.createElement(React.Fragment, null, finalElement);
});
