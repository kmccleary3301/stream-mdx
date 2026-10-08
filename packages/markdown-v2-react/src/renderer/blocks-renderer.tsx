import type { Block, UrlTransform } from "@stream-mdx/core";
import React, { useMemo, useRef } from "react";

import { PATCH_ROOT_ID } from "@stream-mdx/core";
import { ComponentRegistry } from "../components";
import type { AllowElementFn, BlockRendererOverride, CodeRenderersConfig } from "../types";
import { useRendererChildren } from "./hooks";
import { BlockNodeRenderer } from "./node-views";
import { createRendererStore, type RendererStore } from "./store";

/**
 * React component for rendering markdown blocks
 */
export interface MarkdownBlocksRendererProps {
  blocks: ReadonlyArray<Block>;
  componentRegistry?: ComponentRegistry;
  codeRenderers?: CodeRenderersConfig;
  className?: string;
  style?: React.CSSProperties;
  store?: RendererStore;
  blockRenderer?: BlockRendererOverride;
  urlTransform?: UrlTransform;
  allowedElements?: string[];
  disallowedElements?: string[];
  allowElement?: AllowElementFn;
  unwrapDisallowed?: boolean;
  disableAutolinkProtocols?: string[];
}

export const MarkdownBlocksRenderer = React.memo<MarkdownBlocksRendererProps>(
  ({
    blocks,
    componentRegistry,
    codeRenderers,
    blockRenderer,
    urlTransform,
    allowedElements,
    disallowedElements,
    allowElement,
    unwrapDisallowed,
    disableAutolinkProtocols,
    className = "markdown-renderer",
    style,
    store,
  }) => {
    // Props override the registry; a prop removed after being set reverts the registry,
    // while overrides configured directly on a caller-provided registry stay untouched.
    const appliedOverrides = useRef<{
      blockRenderer?: BlockRendererOverride;
      urlTransform?: UrlTransform;
      allowedElements?: string[];
      disallowedElements?: string[];
      allowElement?: AllowElementFn;
      unwrapDisallowed?: boolean;
      disableAutolinkProtocols?: string[];
    }>({});
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
      if (allowedElements !== undefined || applied.allowedElements !== undefined) {
        reg.setAllowedElements(allowedElements);
      }
      if (disallowedElements !== undefined || applied.disallowedElements !== undefined) {
        reg.setDisallowedElements(disallowedElements);
      }
      if (allowElement !== undefined || applied.allowElement !== undefined) {
        reg.setAllowElement(allowElement);
      }
      if (unwrapDisallowed !== undefined || applied.unwrapDisallowed !== undefined) {
        reg.setUnwrapDisallowed(unwrapDisallowed);
      }
      if (disableAutolinkProtocols !== undefined || applied.disableAutolinkProtocols !== undefined) {
        reg.setDisableAutolinkProtocols(disableAutolinkProtocols);
      }
      appliedOverrides.current = {
        blockRenderer,
        urlTransform,
        allowedElements,
        disallowedElements,
        allowElement,
        unwrapDisallowed,
        disableAutolinkProtocols,
      };
      return reg;
    }, [
      componentRegistry,
      codeRenderers,
      blockRenderer,
      urlTransform,
      allowedElements,
      disallowedElements,
      allowElement,
      unwrapDisallowed,
      disableAutolinkProtocols,
    ]);
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


