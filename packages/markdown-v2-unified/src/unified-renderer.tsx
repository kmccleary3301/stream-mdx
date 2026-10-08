import React, { useEffect, useMemo, useRef, useState } from "react";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Block, BlockResolvedLinkReference } from "@stream-mdx/core";
import type { FinalizedBlockRenderProps } from "@stream-mdx/react";
import type { PluggableList, UnifiedRenderer, UnifiedRendererOptions } from "./types";

type HastNode = Parameters<typeof toJsxRuntime>[0];

export interface UnifiedBlockProcessor {
  parse(input: string): unknown;
  runSync(tree: unknown): unknown;
  run(tree: unknown): Promise<unknown>;
  isAsync(): boolean;
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

export function formatLinkDefinitions(refs: readonly BlockResolvedLinkReference[]): string {
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

function isAsyncPluginError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    return msg.includes("finished async") || msg.includes("Use `run` instead") || msg.includes("async");
  }
  return false;
}

function applyPlugins(
  processor: any,
  plugins: PluggableList | undefined,
  markAsync: () => void,
): void {
  if (!plugins || plugins.length === 0) return;
  for (const entry of plugins) {
    if (!entry) continue;
    let plugin: any;
    let settings: any[] = [];
    if (Array.isArray(entry)) {
      [plugin, ...settings] = entry;
    } else {
      plugin = entry;
    }

    if (typeof plugin !== "function") {
      processor.use(entry as any);
      continue;
    }

    const wrappedPlugin = function (this: any, ...args: any[]) {
      const transformer = plugin.apply(this, args);
      if (typeof transformer !== "function") {
        return transformer;
      }
      if (transformer.constructor?.name === "AsyncFunction" || transformer.length >= 3) {
        markAsync();
      }
      if (transformer.length >= 3) {
        return function (this: any, tree: any, file: any, next: any) {
          return transformer.call(this, tree, file, next);
        };
      }
      return function (this: any, tree: any, file: any) {
        const result = transformer.call(this, tree, file);
        if (result && typeof result.then === "function") {
          markAsync();
          result.catch(() => {});
        }
        return result;
      };
    };

    processor.use(wrappedPlugin, ...settings);
  }
}

function buildProcessor(options: UnifiedRendererOptions): UnifiedBlockProcessor {
  const p = unified().use(remarkParse);
  let isAsyncPipeline = false;
  const markAsync = () => {
    isAsyncPipeline = true;
  };

  if (options.gfm !== false) {
    p.use(remarkGfm);
  }

  if (options.math) {
    p.use(remarkMath);
  }

  applyPlugins(p, options.remarkPlugins, markAsync);
  p.use(remarkRehype);
  applyPlugins(p, options.rehypePlugins, markAsync);

  const frozen = p.freeze();

  return {
    parse: (input: string) => frozen.parse(input),
    runSync: (tree: unknown) => frozen.runSync(tree as any),
    run: (tree: unknown) => frozen.run(tree as any),
    isAsync: () => isAsyncPipeline,
  };
}

interface UnifiedBlockItemProps {
  block: Block;
  element: React.ReactElement;
  processor: UnifiedBlockProcessor;
  options: UnifiedRendererOptions;
  cache: BoundedLruCache<string, React.ReactNode>;
  inflightJobs: Map<string, Promise<React.ReactNode>>;
}

export const UnifiedBlockItem: React.FC<UnifiedBlockItemProps> = ({
  block,
  element,
  processor,
  options,
  cache,
  inflightJobs,
}) => {
  const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
  const metaRefs = Array.isArray(block.payload.meta?.linkReferences)
    ? (block.payload.meta.linkReferences as readonly BlockResolvedLinkReference[])
    : undefined;
  const serializedRefs = metaRefs && metaRefs.length > 0 ? JSON.stringify(metaRefs) : "";
  const cacheKey = `${block.id}::${raw}::${serializedRefs}`;

  const cached = cache.get(cacheKey);
  const isAsync = processor.isAsync();

  // Attempt synchronous processing first for sync plugins and SSR support
  const syncAttempt = useMemo(() => {
    if (cached !== undefined || isAsync) {
      return { result: cached, isAsync };
    }
    const linkDefs = metaRefs && metaRefs.length > 0 ? formatLinkDefinitions(metaRefs) : "";
    const input = linkDefs ? `${linkDefs}\n\n${raw}` : raw;

    try {
      const mdast = processor.parse(input);
      const hast = processor.runSync(mdast);
      const result = toJsxRuntime(hast as HastNode, {
        Fragment,
        jsx,
        jsxs,
        components: options.components,
      });
      cache.set(cacheKey, result);
      return { result, isAsync: false };
    } catch (err) {
      if (isAsyncPluginError(err)) {
        return { result: undefined, isAsync: true };
      }
      const error = err instanceof Error ? err : new Error(String(err));
      if (options.onError) {
        options.onError(error, block);
      } else {
        console.error("Unified block synchronous rendering failed:", error);
      }
      return { result: undefined, isAsync: false };
    }
  }, [cacheKey, cached, cache, processor, options, metaRefs, raw, block, isAsync]);

  const [asyncResult, setAsyncResult] = useState<React.ReactNode | undefined>(undefined);
  const currentKeyRef = useRef(cacheKey);
  currentKeyRef.current = cacheKey;

  // Asynchronous processing pipeline for async plugins off the streaming critical path
  useEffect(() => {
    if (cached !== undefined || syncAttempt.result !== undefined || (!syncAttempt.isAsync && !processor.isAsync())) {
      return;
    }

    let cancelled = false;
    const linkDefs = metaRefs && metaRefs.length > 0 ? formatLinkDefinitions(metaRefs) : "";
    const input = linkDefs ? `${linkDefs}\n\n${raw}` : raw;

    let promise = inflightJobs.get(cacheKey);
    if (!promise) {
      promise = (async () => {
        const mdast = processor.parse(input);
        const hast = await processor.run(mdast);
        return toJsxRuntime(hast as HastNode, {
          Fragment,
          jsx,
          jsxs,
          components: options.components,
        });
      })();
      promise.catch(() => {});
      inflightJobs.set(cacheKey, promise);
    }

    promise
      .then((result) => {
        inflightJobs.delete(cacheKey);
        cache.set(cacheKey, result);
        if (!cancelled && currentKeyRef.current === cacheKey) {
          setAsyncResult(result);
        }
      })
      .catch((err: unknown) => {
        inflightJobs.delete(cacheKey);
        if (!cancelled && currentKeyRef.current === cacheKey) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (options.onError) {
            options.onError(error, block);
          } else {
            console.error("Unified block async rendering failed:", error);
          }
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    cacheKey,
    cached,
    syncAttempt.result,
    syncAttempt.isAsync,
    processor,
    options,
    metaRefs,
    raw,
    block,
    cache,
    inflightJobs,
  ]);

  const output = cached ?? syncAttempt.result ?? asyncResult ?? element;

  if (React.isValidElement(output)) {
    return output;
  }
  return <>{output}</>;
};

export function createUnifiedRenderer(options: UnifiedRendererOptions = {}): UnifiedRenderer {
  const cache = new BoundedLruCache<string, React.ReactNode>(options.cacheSize ?? 500);
  const inflightJobs = new Map<string, Promise<React.ReactNode>>();
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
        inflightJobs={inflightJobs}
      />
    );
  };

  renderer.clearCache = () => {
    cache.clear();
    inflightJobs.clear();
  };
  renderer.options = options;

  return renderer;
}
