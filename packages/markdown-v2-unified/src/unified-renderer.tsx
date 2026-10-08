import React, { useEffect, useMemo, useState } from "react";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Root as MdastRoot } from "mdast";
import type { Root as HastRoot } from "hast";
import type { Block, BlockResolvedLinkReference } from "@stream-mdx/core";
import type { FinalizedBlockRenderProps } from "@stream-mdx/react";
import type { UnifiedRenderer, UnifiedRendererOptions } from "./types";

export type UnifiedProcessor = Processor<MdastRoot, MdastRoot, HastRoot, HastRoot, string>;

export type JobOutcome =
  | { readonly kind: "success"; readonly node: React.ReactNode }
  | { readonly kind: "error"; readonly error: Error };

export interface UnifiedJob {
  readonly promise: Promise<JobOutcome>;
  outcome?: JobOutcome;
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

function buildProcessor(options: UnifiedRendererOptions): UnifiedProcessor {
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

  return p.freeze() as unknown as UnifiedProcessor;
}

export function getOrCreateJob(
  cacheKey: string,
  input: string,
  block: Block,
  processor: UnifiedProcessor,
  options: UnifiedRendererOptions,
  cache: BoundedLruCache<string, React.ReactNode>,
  inflightJobs: Map<string, UnifiedJob>,
): UnifiedJob {
  const existing = inflightJobs.get(cacheKey);
  if (existing) {
    return existing;
  }

  const { promise, resolve } = Promise.withResolvers<JobOutcome>();
  promise.catch(() => {});

  const job: UnifiedJob = { promise };
  inflightJobs.set(cacheKey, job);

  let mdast: MdastRoot;
  try {
    mdast = processor.parse(input);
  } catch (parseError) {
    const error = parseError instanceof Error ? parseError : new Error(String(parseError));
    const outcome: JobOutcome = { kind: "error", error };
    job.outcome = outcome;
    inflightJobs.delete(cacheKey);
    resolve(outcome);
    if (options.onError) {
      options.onError(error, block);
    } else {
      console.error("Unified markdown parse failed:", error);
    }
    return job;
  }

  // Exactly one processor.run invocation per cache key.
  // Unified calls the callback synchronously for sync transformers, and asynchronously for async ones.
  processor.run(mdast, (runError, hast) => {
    if (runError || !hast) {
      const error =
        runError instanceof Error
          ? runError
          : new Error(String(runError ?? "Unified block transformation failed"));
      const outcome: JobOutcome = { kind: "error", error };
      job.outcome = outcome;
      inflightJobs.delete(cacheKey);
      resolve(outcome);
      if (options.onError) {
        options.onError(error, block);
      } else {
        console.error("Unified block transformation failed:", error);
      }
      return;
    }

    try {
      const node = toJsxRuntime(hast, {
        Fragment,
        jsx,
        jsxs,
        components: options.components,
      });
      const outcome: JobOutcome = { kind: "success", node };
      job.outcome = outcome;
      cache.set(cacheKey, node);
      inflightJobs.delete(cacheKey);
      resolve(outcome);
    } catch (renderError) {
      const error = renderError instanceof Error ? renderError : new Error(String(renderError));
      const outcome: JobOutcome = { kind: "error", error };
      job.outcome = outcome;
      inflightJobs.delete(cacheKey);
      resolve(outcome);
      if (options.onError) {
        options.onError(error, block);
      } else {
        console.error("Unified JSX runtime conversion failed:", error);
      }
    }
  });

  return job;
}

interface UnifiedBlockItemProps {
  block: Block;
  element: React.ReactElement;
  processor: UnifiedProcessor;
  options: UnifiedRendererOptions;
  cache: BoundedLruCache<string, React.ReactNode>;
  inflightJobs: Map<string, UnifiedJob>;
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

  // Retrieve or create the single processing job for this exact cacheKey
  const job = useMemo(() => {
    if (cached !== undefined) {
      return undefined;
    }
    const linkDefs = metaRefs && metaRefs.length > 0 ? formatLinkDefinitions(metaRefs) : "";
    const input = linkDefs ? `${linkDefs}\n\n${raw}` : raw;
    return getOrCreateJob(cacheKey, input, block, processor, options, cache, inflightJobs);
  }, [cacheKey, cached, block, processor, options, cache, inflightJobs, metaRefs, raw]);

  // Keyed async state: if cacheKey changes while an async job is pending,
  // asyncState.key !== cacheKey, so it immediately displays the new default element!
  const [asyncState, setAsyncState] = useState<{
    readonly key: string;
    readonly node: React.ReactNode;
  } | null>(null);

  useEffect(() => {
    if (!job || job.outcome !== undefined) {
      return;
    }

    let cancelled = false;
    job.promise.then((outcome) => {
      if (!cancelled && outcome.kind === "success") {
        setAsyncState({ key: cacheKey, node: outcome.node });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, job]);

  // Determine what to render based on:
  // 1. Cached result
  // 2. Synchronous job outcome (for sync plugins / sync SSR)
  // 3. Key-matched async completed result
  // 4. Default element (while pending async or on error)
  let output: React.ReactNode = element;
  if (cached !== undefined) {
    output = cached;
  } else if (job?.outcome !== undefined) {
    if (job.outcome.kind === "success") {
      output = job.outcome.node;
    }
  } else if (asyncState !== null && asyncState.key === cacheKey) {
    output = asyncState.node;
  }

  if (React.isValidElement(output)) {
    return output;
  }
  return <>{output}</>;
};

export function createUnifiedRenderer(options: UnifiedRendererOptions = {}): UnifiedRenderer {
  const cache = new BoundedLruCache<string, React.ReactNode>(options.cacheSize ?? 500);
  const inflightJobs = new Map<string, UnifiedJob>();
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
