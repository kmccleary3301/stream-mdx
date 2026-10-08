import React, { useMemo } from "react";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Block } from "@stream-mdx/core";
import type { FinalizedBlockRenderProps } from "@stream-mdx/react";
import { extractLinkDefinitions } from "./link-definitions";
import type { UnifiedRenderer, UnifiedRendererOptions } from "./types";

type HastNode = Parameters<typeof toJsxRuntime>[0];

export interface UnifiedBlockProcessor {
  parse(input: string): unknown;
  runSync(tree: unknown): unknown;
}

const DEFAULT_ROUTED_BLOCK_TYPES: Record<string, true> = {
  paragraph: true,
  heading: true,
  blockquote: true,
  list: true,
  table: true,
  code: true,
  hr: true,
};

function buildProcessor(options: UnifiedRendererOptions): UnifiedBlockProcessor {
  const p = unified().use(remarkParse);

  if (options.gfm !== false) {
    p.use(remarkGfm);
  }

  if (options.math) {
    p.use(remarkMath);
  }

  if (options.remarkPlugins && options.remarkPlugins.length > 0) {
    p.use(options.remarkPlugins);
  }

  p.use(remarkRehype);

  if (options.rehypePlugins && options.rehypePlugins.length > 0) {
    p.use(options.rehypePlugins);
  }

  return p.freeze() as unknown as UnifiedBlockProcessor;
}

interface UnifiedBlockItemProps {
  block: Block;
  element: React.ReactElement;
  context?: Record<string, unknown>;
  processor: UnifiedBlockProcessor;
  options: UnifiedRendererOptions;
  cache: Map<string, React.ReactNode>;
}

export const UnifiedBlockItem: React.FC<UnifiedBlockItemProps> = ({
  block,
  element,
  context,
  processor,
  options,
  cache,
}) => {
  const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
  const cacheKey = `${block.id}::${raw}`;

  const rendered = useMemo(() => {
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      let linkDefs = "";
      if (typeof options.linkReferences === "string") {
        linkDefs = options.linkReferences;
      } else if (typeof options.linkReferences === "function") {
        linkDefs = options.linkReferences();
      } else if (typeof context?.linkReferenceDefinitions === "string") {
        linkDefs = context.linkReferenceDefinitions;
      } else if (typeof context?.documentText === "string") {
        linkDefs = extractLinkDefinitions(context.documentText);
      }

      const input = linkDefs ? `${linkDefs}\n\n${raw}` : raw;
      const mdast = processor.parse(input);
      const hast = processor.runSync(mdast);

      const result = toJsxRuntime(hast as HastNode, {
        Fragment,
        jsx,
        jsxs,
        components: options.components,
      });

      cache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.warn("Unified block rendering failed, falling back to default:", error);
      return element;
    }
  }, [cacheKey, element, context?.linkReferenceDefinitions, context?.documentText]);

  if (React.isValidElement(rendered)) {
    return rendered;
  }
  return <>{rendered}</>;
};

export function createUnifiedRenderer(options: UnifiedRendererOptions = {}): UnifiedRenderer {
  const cache = new Map<string, React.ReactNode>();
  const processor = buildProcessor(options);
  const routedTypeMap: Record<string, true> = options.blockTypes
    ? Object.fromEntries(options.blockTypes.map((type) => [type, true]))
    : DEFAULT_ROUTED_BLOCK_TYPES;

  const renderer: UnifiedRenderer = (props: FinalizedBlockRenderProps) => {
    const { block, element, context } = props;
    if (!block.isFinalized || !routedTypeMap[block.type]) {
      return element;
    }

    return (
      <UnifiedBlockItem
        key={block.id}
        block={block}
        element={element}
        context={context}
        processor={processor}
        options={options}
        cache={cache}
      />
    );
  };

  renderer.clearCache = () => {
    cache.clear();
  };
  renderer.options = options;

  return renderer;
}
