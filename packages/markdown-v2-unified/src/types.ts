import type { PluggableList } from "unified";
import type { Block, UrlTransform } from "@stream-mdx/core";
import type { NodePresentations } from "@stream-mdx/react";

export interface UnifiedRendererOptions {
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
  components?: NodePresentations;
  hastComponents?: Record<string, React.ComponentType<Record<string, unknown>>>;
  /**
   * Block types to route through the unified pipeline.
   * Defaults to: ["paragraph", "heading", "blockquote", "list", "table", "code", "hr"]
   */
  blockTypes?: string[];
  /**
   * Enable math support (remark-math). Defaults to false.
   */
  math?: boolean;
  /**
   * Enable GitHub Flavored Markdown (remark-gfm). Defaults to true.
   */
  gfm?: boolean;
  /**
   * Maximum number of rendered blocks to retain in LRU cache. Defaults to 500.
   */
  cacheSize?: number;
  /**
   * Explicit callback invoked when a unified plugin encounters an error.
   * When provided, errors are forwarded here instead of only being logged.
   */
  onError?: (error: Error, block: Block) => void;
  urlTransform?: UrlTransform;
}

export type UnifiedRenderer = NodePresentations & {
  clearCache(): void;
  options: UnifiedRendererOptions;
};

export type { PluggableList } from "unified";
