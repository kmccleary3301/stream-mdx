import type { Block } from "@stream-mdx/core";
import React, { useMemo } from "react";

import { getBlockKey, PATCH_ROOT_ID } from "@stream-mdx/core";
import { ComponentRegistry } from "../components";
import { useRendererChildren } from "./hooks";
import { BlockNodeRenderer } from "./node-views";
import { createRendererStore } from "./store";

/**
 * React component for rendering markdown blocks
 */
export const MarkdownBlocksRenderer = React.memo<{
  blocks: ReadonlyArray<Block>;
  componentRegistry: ComponentRegistry;
  className?: string;
  style?: React.CSSProperties;
  store?: ReturnType<typeof createRendererStore>;
}>(({ blocks, componentRegistry, className = "markdown-renderer", style, store }) => {
  if (store) {
    return React.createElement(
      "div",
      {
        className,
        style: { contain: "content", ...(style ?? {}) }, // CSS containment for performance
      },
      React.createElement(StoreBackedBlocks, { store, componentRegistry }),
    );
  }

  const renderedBlocks = useMemo(() => {
    return blocks.map((block) => {
      const key = getBlockKey(block);
      return React.createElement(BlockRenderer, {
        key,
        block,
        componentRegistry,
        isFinalized: block.isFinalized,
      });
    });
  }, [blocks, componentRegistry]);

  return React.createElement(
    "div",
    {
      className,
      style: { contain: "content", ...(style ?? {}) }, // CSS containment for performance
    },
    renderedBlocks,
  );
});

const StoreBackedBlocks = React.memo<{ store: ReturnType<typeof createRendererStore>; componentRegistry: ComponentRegistry }>(
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

  // Add finalization indicator for debugging
  const className = `markdown-block markdown-block-${block.type} ${isFinalized ? "finalized" : "dirty"}`;

  return React.cloneElement(element, {
    className: `${element.props.className || ""} ${className}`.trim(),
    "data-block-id": block.id,
    "data-finalized": isFinalized,
  });
});
