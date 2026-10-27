import React, { useEffect, useMemo, useState } from "react";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { defaultUrlTransform, isForbiddenAttribute, type Block, type BlockResolvedLinkReference, type UrlTransform } from "@stream-mdx/core";
import { ComponentRegistry, createRendererStore, renderNodePresentation, type NodePresentationKey, type NodeViewProps } from "@stream-mdx/react";
import type { UnifiedBlockErrorContext, UnifiedRenderer, UnifiedRendererOptions } from "./types";

function sanitizeHastUrls(node: unknown, transform: UrlTransform): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "element" && record.properties && typeof record.properties === "object") {
    const properties = record.properties as Record<string, unknown>;

    for (const key of Object.keys(properties)) {
      if (isForbiddenAttribute(key)) {
        delete properties[key];
      }
    }

    if (properties.href !== undefined && properties.href !== null) {
      const safe = transform(String(properties.href), "href", { source: "markdown" });
      if (safe != null) {
        properties.href = safe;
      } else {
        delete properties.href;
      }
    }

    if (properties.src !== undefined && properties.src !== null) {
      const safe = transform(String(properties.src), "src", { source: "markdown" });
      if (safe != null) {
        properties.src = safe;
      } else {
        delete properties.src;
      }
    }

    if (properties.action !== undefined && properties.action !== null) {
      const safe = transform(String(properties.action), "href", { source: "html" });
      if (safe != null) {
        properties.action = safe;
      } else {
        delete properties.action;
      }
    }

    if (properties.formAction !== undefined && properties.formAction !== null) {
      const safe = transform(String(properties.formAction), "href", { source: "html" });
      if (safe != null) {
        properties.formAction = safe;
      } else {
        delete properties.formAction;
      }
    }

    if (properties.xlinkHref !== undefined && properties.xlinkHref !== null) {
      const safe = transform(String(properties.xlinkHref), "href", { source: "html" });
      if (safe != null) {
        properties.xlinkHref = safe;
      } else {
        delete properties.xlinkHref;
      }
    }

    if (properties["xlink:href"] !== undefined && properties["xlink:href"] !== null) {
      const safe = transform(String(properties["xlink:href"]), "href", { source: "html" });
      if (safe != null) {
        properties["xlink:href"] = safe;
      } else {
        delete properties["xlink:href"];
      }
    }
  }

  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      sanitizeHastUrls(child, transform);
    }
  }
}

function buildProcessor(options: UnifiedRendererOptions) {
  const transform = options.urlTransform ?? defaultUrlTransform;
  return unified()
    .use(remarkParse)
    .use(options.gfm === false ? [] : [remarkGfm])
    .use(options.math ? [remarkMath] : [])
    .use(options.remarkPlugins ?? [])
    .use(remarkRehype)
    .use(options.rehypePlugins ?? [])
    .use(() => (tree) => {
      sanitizeHastUrls(tree, transform);
    })
    .freeze();
}

export type UnifiedProcessor = ReturnType<typeof buildProcessor>;

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

export function getOrCreateJob(
  cacheKey: string,
  input: string,
  context: UnifiedBlockErrorContext,
  processor: UnifiedProcessor,
  options: UnifiedRendererOptions,
  cache: BoundedLruCache<string, React.ReactNode>,
  inflightJobs: Map<string, UnifiedJob>,
): UnifiedJob {
  const existing = inflightJobs.get(cacheKey);
  if (existing) {
    return existing;
  }

  let resolve!: (outcome: JobOutcome) => void;
  const promise = new Promise<JobOutcome>((res) => {
    resolve = res;
  });

  const job: UnifiedJob = { promise };
  inflightJobs.set(cacheKey, job);

  let mdast: ReturnType<typeof processor.parse>;
  try {
    mdast = processor.parse(input);
  } catch (parseError) {
    const error = parseError instanceof Error ? parseError : new Error(String(parseError));
    const outcome: JobOutcome = { kind: "error", error };
    job.outcome = outcome;
    inflightJobs.delete(cacheKey);
    resolve(outcome);
    if (options.onError) {
      options.onError(error, context);
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
        options.onError(error, context);
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
        components: options.hastComponents,
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
        options.onError(error, context);
      } else {
        console.error("Unified JSX runtime conversion failed:", error);
      }
    }
  });

  return job;
}

interface UnifiedBlockItemProps {
  id: string;
  type: string;
  finalized: boolean;
  source: string;
  linkReferences?: readonly BlockResolvedLinkReference[];
  element: React.ReactElement;
  processor: UnifiedProcessor;
  options: UnifiedRendererOptions;
  cache: BoundedLruCache<string, React.ReactNode>;
  inflightJobs: Map<string, UnifiedJob>;
  registry: ComponentRegistry | null;
}

export const UnifiedBlockItem: React.FC<UnifiedBlockItemProps> = ({
  id,
  type,
  finalized,
  source,
  linkReferences,
  element,
  processor,
  options,
  cache,
  inflightJobs,
  registry,
}) => {
  const block = useMemo<Block>(() => ({
    id,
    type,
    isFinalized: finalized,
    payload: {
      raw: source,
      ...(linkReferences === undefined
        ? {}
        : { meta: { linkReferences: linkReferences as BlockResolvedLinkReference[] } }),
    },
  }), [finalized, id, linkReferences, source, type]);
  const presentationStore = useMemo(
    () => registry === null ? null : createRendererStore([block]),
    [block, registry],
  );
  const metaRefs = linkReferences;
  const serializedRefs = metaRefs && metaRefs.length > 0 ? JSON.stringify(metaRefs) : "";
  const cacheKey = `${id}::${type}::${source}::${serializedRefs}`;

  const cached = cache.get(cacheKey);

  // Retrieve or create the single processing job for this exact cacheKey
  const job = useMemo(() => {
    if (cached !== undefined) {
      return undefined;
    }
    const linkDefs = metaRefs && metaRefs.length > 0 ? formatLinkDefinitions(metaRefs) : "";
    const input = linkDefs ? `${linkDefs}\n\n${source}` : source;
    return getOrCreateJob(cacheKey, input, { id, type, finalized }, processor, options, cache, inflightJobs);
  }, [cacheKey, cached, block, processor, options, cache, inflightJobs, metaRefs, source, finalized, id, type]);

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

  const presentedOutput = registry === null || presentationStore === null
    ? output
    : renderNodePresentation(block, output, presentationStore, registry);
  if (React.isValidElement(presentedOutput)) {
    return presentedOutput;
  }
  return <>{presentedOutput}</>;
};

export function createUnifiedRenderer(options: UnifiedRendererOptions = {}): UnifiedRenderer {
  const cache = new BoundedLruCache<string, React.ReactNode>(options.cacheSize ?? 500);
  const inflightJobs = new Map<string, UnifiedJob>();
  const processor = buildProcessor(options);
  const registry = Object.keys(options.components ?? {}).length > 0
    ? new ComponentRegistry({ components: options.components })
    : null;
  const routedTypeMap: Record<string, true> = options.blockTypes
    ? Object.fromEntries(options.blockTypes.map((type) => [type, true]))
    : DEFAULT_ROUTED_BLOCK_TYPES;
  const presentationTypes = options.blockTypes ?? Object.keys(DEFAULT_ROUTED_BLOCK_TYPES);
  const renderUnifiedBlock: React.FC<NodeViewProps> = ({ metadata, actions, children }) => {
    if (!metadata.isFinalized || !routedTypeMap[metadata.type]) return <>{children}</>;
    const element = React.isValidElement(children)
      ? children
      : <>{children}</>;
    return (
      <UnifiedBlockItem
        key={metadata.id}
        id={metadata.id}
        type={metadata.type}
        finalized={metadata.isFinalized}
        source={actions.readSource()}
        linkReferences={metadata.linkReferences}
        element={element}
        processor={processor}
        options={options}
        cache={cache}
        inflightJobs={inflightJobs}
        registry={registry}
      />
    );
  };
  type UnifiedWrapperKey = Exclude<NodePresentationKey, `block-extension:${string}`>;
  const routedPresentations: Partial<Record<UnifiedWrapperKey, { readonly wrapper: React.FC<NodeViewProps> }>> = {};
  for (const type of presentationTypes) {
    if (type.startsWith("block-extension:")) continue;
    routedPresentations[type as UnifiedWrapperKey] = { wrapper: renderUnifiedBlock };
  }
  const renderer = {
    ...routedPresentations,
    clearCache() {
      cache.clear();
      inflightJobs.clear();
    },
    options,
  } satisfies UnifiedRenderer;
  Object.defineProperties(renderer, {
    clearCache: { enumerable: false },
    options: { enumerable: false },
  });
  return renderer;
}
