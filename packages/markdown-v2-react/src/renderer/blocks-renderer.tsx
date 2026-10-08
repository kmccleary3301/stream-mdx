import type { Block, UrlTransform } from "@stream-mdx/core";
import React, { useMemo, useRef } from "react";

import { PATCH_ROOT_ID } from "@stream-mdx/core";
import { ComponentRegistry } from "../components";
import type { BlockRendererOverride, CodeFenceRenderer } from "../types";
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
  blockRenderer?: BlockRendererOverride;
  urlTransform?: UrlTransform;
}

export const MarkdownBlocksRenderer = React.memo<MarkdownBlocksRendererProps>(
  ({ blocks, componentRegistry, codeRenderers, blockRenderer, urlTransform, className = "markdown-renderer", style, store }) => {
    // Props override the registry; a prop removed after being set reverts the registry,
    // while overrides configured directly on a caller-provided registry stay untouched.
    const appliedOverrides = useRef<{ blockRenderer?: BlockRendererOverride; urlTransform?: UrlTransform }>({});
    const resolvedRegistry = useMemo(() => {
      const reg = componentRegistry ?? new ComponentRegistry();
      if (codeRenderers) {
        reg.setCodeRenderers(codeRenderers);
      }
      const applied = appliedOverrides.current;
      if (blockRenderer !== undefined || applied.blockRenderer !== undefined) {
        reg.setBlockRenderer(blockRenderer);
      }
      if (urlTransform !== undefined || applied.urlTransform !== undefined) {
        reg.setUrlTransform(urlTransform);
      }
      appliedOverrides.current = { blockRenderer, urlTransform };
      return reg;
    }, [componentRegistry, codeRenderers, blockRenderer, urlTransform]);
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
      React.createElement(StoreBackedBlocks, { store: effectiveStore, componentRegistry: resolvedRegistry, blockRenderer }),
    );
  },
);

const StoreBackedBlocks = React.memo<{ store: RendererStore; componentRegistry: ComponentRegistry; blockRenderer?: BlockRendererOverride }>(
  ({ store, componentRegistry, blockRenderer }) => {
    const blockIds = useRendererChildren(store, PATCH_ROOT_ID);
    return React.createElement(
      React.Fragment,
      null,
      blockIds.map((blockId) =>
        React.createElement(BlockNodeRenderer, {
          key: `${blockId}:${blockRenderer ? "custom" : "default"}`,
          store,
          blockId,
          registry: componentRegistry,
        }),
      ),
    );
  },
);

StoreBackedBlocks.displayName = "StoreBackedBlocks";


