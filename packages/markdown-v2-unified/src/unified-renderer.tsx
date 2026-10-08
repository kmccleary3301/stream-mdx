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
import type { UnifiedRenderer, UnifiedRendererOptions } from "./types";

type HastNode = Parameters<typeof toJsxRuntime>[0];

export interface UnifiedBlockProcessor {
  parse(input: string): unknown;
  runSync(tree: unknown): unknown;
}

export interface ResolvedLinkReference {
  label: string;
  href: string;
  title?: string;
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

export class BoundedLruCache<K, V> {
  private readonly maxEntries: number;
  private readonly map = new Map<K, V>();

  constructor(maxEntries = 500) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export function formatLinkDefinitions(refs: readonly ResolvedLinkReference[]): string {
  const lines: string[] = [];
  for (const ref of refs) {
    if (!ref.label || !ref.href) continue;
    const cleanHref = `<${ref.href.replace(/>/g, "%3E")}>`;
    if (ref.title) {
      const cleanTitle = ref.title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      lines.push(`[${ref.label}]: ${cleanHref} "${cleanTitle}"`);
    } else {
      lines.push(`[${ref.label}]: ${cleanHref}`);
    }
  }
  return lines.join("\n");
}

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
  processor: UnifiedBlockProcessor;
  options: UnifiedRendererOptions;
  cache: BoundedLruCache<string, React.ReactNode>;
}

export const UnifiedBlockItem: React.FC<UnifiedBlockItemProps> = ({
  block,
  element,
  processor,
  options,
  cache,
}) => {
  const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
  const metaRefs = Array.isArray(block.payload.meta?.linkReferences)
    ? (block.payload.meta.linkReferences as ResolvedLinkReference[])
    : undefined;
  const serializedRefs = metaRefs && metaRefs.length > 0 ? JSON.stringify(metaRefs) : "";
  const cacheKey = `${block.id}::${raw}::${serializedRefs}`;

  // Note: processor, options, and cache are immutable per createUnifiedRenderer instance
  // and created once upon initialization; all read variables are listed in the dependency array.
  const rendered = useMemo(() => {
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const linkDefs = metaRefs && metaRefs.length > 0 ? formatLinkDefinitions(metaRefs) : "";
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
  }, [cacheKey, element, cache, processor, options, metaRefs, raw]);

  if (React.isValidElement(rendered)) {
    return rendered;
  }
  return <>{rendered}</>;
};

export function createUnifiedRenderer(options: UnifiedRendererOptions = {}): UnifiedRenderer {
  const cache = new BoundedLruCache<string, React.ReactNode>(options.cacheSize ?? 500);
  const processor = buildProcessor(options);
  const routedTypeMap: Record<string, true> = options.blockTypes
    ? Object.fromEntries(options.blockTypes.map((type) => [type, true]))
    : DEFAULT_ROUTED_BLOCK_TYPES;

  const renderer: UnifiedRenderer = (props: FinalizedBlockRenderProps) => {
    const { block, element } = props;
    if (!block.isFinalized || !routedTypeMap[block.type]) {
      return element;
    }

    return (
      <UnifiedBlockItem
        key={block.id}
        block={block}
        element={element}
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
