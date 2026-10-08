import type { Block } from "@stream-mdx/core";
import React, { useMemo } from "react";

import { PATCH_ROOT_ID } from "@stream-mdx/core";
import { ComponentRegistry } from "../components";
import type { CodeFenceRenderer } from "../types";
import { useRendererChildren } from "./hooks";
import { BlockNodeRenderer } from "./node-views";
import { createRendererStore, type RendererStore } from "./store";

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
}

export const MarkdownBlocksRenderer = React.memo<MarkdownBlocksRendererProps>(
  ({ blocks, componentRegistry, codeRenderers, className = "markdown-renderer", style, store }) => {
    const resolvedRegistry = useMemo(() => {
      const reg = componentRegistry ?? new ComponentRegistry();
      if (codeRenderers) {
        reg.setCodeRenderers(codeRenderers);
      }
      return reg;
    }, [componentRegistry, codeRenderers]);
    const effectiveStore = useMemo(() => {
      if (store) return store;
      return createRendererStore(blocks as Block[]);
    }, [store, blocks]);

    return React.createElement(
      "div",
      {
        className,
        style: { contain: "content", ...(style ?? {}) }, // CSS containment for performance
      },
      React.createElement(StoreBackedBlocks, { store: effectiveStore, componentRegistry: resolvedRegistry }),
    );
  },
);

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

