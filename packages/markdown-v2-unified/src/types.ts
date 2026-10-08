import type React from "react";
import type { PluggableList } from "unified";
export type { PluggableList } from "unified";
import type { FinalizedBlockRenderProps } from "@stream-mdx/react";

export interface UnifiedRendererOptions {
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
  components?: Record<string, React.ComponentType<Record<string, unknown>>>;
  /**
   * Block types to route through the unified pipeline.
   * Defaults to: ["paragraph", "heading", "blockquote", "list", "table", "code", "hr"]
   */
  blockTypes?: string[];
  /**
   * Optional explicit link reference definitions to resolve reference links.
   * Can be raw markdown definitions (`[ref]: http://...`) or a getter function.
   */
  linkReferences?: string | (() => string);
  /**
   * Enable math support (remark-math). Defaults to false.
   */
  math?: boolean;
  /**
   * Enable GitHub Flavored Markdown (remark-gfm). Defaults to true.
   */
  gfm?: boolean;
}

export interface UnifiedRenderer {
  (props: FinalizedBlockRenderProps): React.ReactNode;
  clearCache(): void;
  options: UnifiedRendererOptions;
}
