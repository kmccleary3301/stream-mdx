import type { Block, UrlTransform } from "@stream-mdx/core";
import React, { useMemo, useRef } from "react";

import { PATCH_ROOT_ID } from "@stream-mdx/core";
import { ComponentRegistry } from "../components";
import type { BlockRendererOverride, CodeFenceRenderer, ElementFilterOptions } from "../types";
import { RenderConfigVersionContext, useRendererChildren } from "./hooks";
import { BlockNodeRenderer } from "./node-views";
import { createRendererStore, type RendererStore } from "./store";

/**
 * React component for rendering markdown blocks
 */
export interface MarkdownBlocksRendererProps extends ElementFilterOptions {
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
    const applied = useRef<{
      blockRenderer?: BlockRendererOverride;
      urlTransform?: UrlTransform;
      filters?: ElementFilterOptions;
      version: number;
    }>({ version: 0 });
    const { registry: resolvedRegistry, version: renderConfigVersion } = useMemo(() => {
      const reg = componentRegistry ?? new ComponentRegistry();
      if (codeRenderers) {
        reg.setCodeRenderers(codeRenderers);
      }
      const previous = applied.current;
      if (blockRenderer !== undefined || previous.blockRenderer !== undefined) {
        reg.setBlockRenderer(blockRenderer);
      }
      if (urlTransform !== undefined || previous.urlTransform !== undefined) {
        reg.setUrlTransform(urlTransform);
      }
      const filters: ElementFilterOptions | undefined =
        allowedElements !== undefined ||
        disallowedElements !== undefined ||
        allowElement !== undefined ||
        unwrapDisallowed !== undefined ||
        disableAutolinkProtocols !== undefined
          ? { allowedElements, disallowedElements, allowElement, unwrapDisallowed, disableAutolinkProtocols }
          : undefined;
      if (filters || previous.filters) {
        reg.setElementFilters(filters ?? {});
      }
      // Inline array literals re-run this memo every render; only an effective change re-renders mounted blocks.
      const changed = urlTransform !== previous.urlTransform || !sameElementFilters(filters, previous.filters);
      const version = changed ? previous.version + 1 : previous.version;
      applied.current = { blockRenderer, urlTransform, filters, version };
      return { registry: reg, version };
    }, [componentRegistry, codeRenderers, blockRenderer, urlTransform, allowedElements, disallowedElements, allowElement, unwrapDisallowed, disableAutolinkProtocols]);
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
      React.createElement(
        RenderConfigVersionContext.Provider,
        { value: renderConfigVersion },
        React.createElement(StoreBackedBlocks, { store: effectiveStore, componentRegistry: resolvedRegistry, blockRenderer }),
      ),
    );
  },
);

function sameStringList(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function sameElementFilters(a?: ElementFilterOptions, b?: ElementFilterOptions): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.allowElement === b.allowElement &&
    a.unwrapDisallowed === b.unwrapDisallowed &&
    sameStringList(a.allowedElements, b.allowedElements) &&
    sameStringList(a.disallowedElements, b.disallowedElements) &&
    sameStringList(a.disableAutolinkProtocols, b.disableAutolinkProtocols)
  );
}

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


