import type React from "react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import type { Block, PatchMetrics } from "@stream-mdx/core";
import { MarkdownRenderer } from "./renderer";
import { MarkdownBlocksRenderer } from "./renderer";
import { useMdxCoordinator } from "./mdx-coordinator";
import type { AdaptiveBudgetState, PatchFlushResult } from "./renderer/patch-commit-scheduler";
import { useRendererBlocks } from "./renderer/hooks";
import type { RendererStore } from "./renderer/store";
import { createDefaultWorker, releaseDefaultWorker } from "@stream-mdx/worker";
import type { BlockComponents, HtmlElements, InlineComponents, RendererConfig, TableElements } from "./types";

const EMPTY_BLOCKS: ReadonlyArray<Block> = [];

function createConfigSignature(input: StreamingMarkdownConfigSignature): string {
  return JSON.stringify(input);
}

interface StreamingMarkdownConfigSignature {
  features: StreamingFeatureFlags;
  prewarm: string[];
  scheduling: StreamingSchedulerOptions | undefined;
  mdxStrategy?: "server" | "worker";
}

export interface StreamingSchedulerOptions {
  frameBudgetMs?: number;
  flushTimeoutMs?: number;
  maxBatchesPerFlush?: number;
  maxLowPriorityBatchesPerFlush?: number;
  lowPriorityFrameBudgetMs?: number;
  urgentQueueThreshold?: number;
  batch?: "rAF" | "microtask" | "timeout";
  historyLimit?: number;
}

export interface StreamingFeatureFlags {
  footnotes?: boolean;
  html?: boolean;
  mdx?: boolean;
  tables?: boolean;
  callouts?: boolean;
  math?: boolean;
  formatAnticipation?: boolean;
  liveCodeHighlighting?: boolean;
}

/**
 * Metrics emitted after each flush (high-priority + low-priority batches).
 */
export interface RendererMetrics {
  tx?: number | null;
  receivedAt: number;
  committedAt: number;
  durationMs: number;
  patchToDomMs: number;
  totalPatches: number;
  appliedPatches: number;
  queueDepthBefore: number;
  remainingQueueSize: number;
  batchCount: number;
  queueDelay: {
    avg: number;
    max: number;
    p95: number;
  };
  priorities: Array<"high" | "low">;
  workerMetrics?: PatchMetrics;
  adaptiveBudget?: AdaptiveBudgetState;
  flush: PatchFlushResult;
}

export interface RendererStateSnapshot {
  blocks: ReadonlyArray<Block>;
  queueDepth: number;
  pendingBatches: number;
  isPaused: boolean;
  workerReady: boolean;
  rendererVersion: number;
  store: RendererStore;
  lastMetrics: RendererMetrics | null;
}

export interface StreamingMarkdownHandle {
  pause(): void;
  resume(): void;
  restart(): void;
  finalize(): void;
  append(text: string): void;
  setCredits(value: number): void;
  flushPending(): PatchFlushResult | null;
  waitForIdle(): Promise<void>;
  onFlush(listener: (result: PatchFlushResult) => void): () => void;
  getState(): RendererStateSnapshot;
  getPatchHistory(limit?: number): ReadonlyArray<RendererMetrics>;
}

export interface StreamingMarkdownProps {
  text?: string;
  stream?: AsyncIterable<string>;
  worker?: Worker | URL | (() => Worker) | string;
  managedWorker?: boolean;
  prewarmLangs?: string[];
  features?: StreamingFeatureFlags;
  components?: Partial<BlockComponents>;
  tableElements?: Partial<TableElements>;
  htmlElements?: Partial<HtmlElements>;
  mdxComponents?: Record<string, React.ComponentType<unknown>>;
  inlineComponents?: Partial<InlineComponents>;
  scheduling?: StreamingSchedulerOptions;
  mdxCompileMode?: "server" | "worker";
  onMetrics?: (metrics: RendererMetrics) => void;
  onError?: (error: Error) => void;
  className?: string;
  style?: React.CSSProperties;
}

const MdxCoordinatorBridge: React.FC<{ store: RendererStore; mode: "server" | "worker" }> = ({ store, mode }) => {
  const blocks = useRendererBlocks(store);
  useMdxCoordinator(blocks, undefined, { store, mode });
  return null;
};

interface WorkerInstance {
  worker: Worker | null;
  owned: boolean;
  release?: () => void;
}

const DEFAULT_HISTORY_LIMIT = 200;

type StreamingDebugFlags = {
  worker?: boolean;
};

function isStreamingDebugEnabled(flag: keyof StreamingDebugFlags): boolean {
  try {
    if (typeof process !== "undefined" && process.env) {
      const value = process.env.NEXT_PUBLIC_STREAMING_DEBUG_WORKER;
      if (flag === "worker" && (value === "1" || value === "true")) {
        return true;
      }
    }
  } catch {
    // ignore env read errors
  }
  try {
    const globalDebug = (globalThis as { __STREAMING_DEBUG__?: StreamingDebugFlags }).__STREAMING_DEBUG__;
    if (flag === "worker" && globalDebug?.worker) {
      return true;
    }
  } catch {
    // ignore global read errors
  }
  return false;
}

const DEBUG_WORKER = isStreamingDebugEnabled("worker");

function StreamingMarkdownComponent(
  {
    text,
    stream,
    worker: workerSource,
    prewarmLangs = [],
    features = {},
    components,
    tableElements,
    htmlElements,
    mdxComponents,
    inlineComponents,
    scheduling,
    mdxCompileMode,
    managedWorker = false,
    onMetrics,
    onError,
    className,
    style,
  }: StreamingMarkdownProps,
  ref: React.ForwardedRef<StreamingMarkdownHandle>,
) {
  if (text !== undefined && stream !== undefined) {
    throw new Error("StreamingMarkdown expects either `text` or `stream`, not both.");
  }

  const configSignature = useMemo(
    () =>
      createConfigSignature({
        features,
        prewarm: prewarmLangs,
        scheduling,
        mdxStrategy: mdxCompileMode,
      }),
    [features, prewarmLangs, scheduling, mdxCompileMode],
  );

  const rendererRef = useRef<{ renderer: MarkdownRenderer; signature: string }>();
  const [session, setSession] = useState(0);
  const rendererKey = `${configSignature}:${session}`;

  if (!rendererRef.current || rendererRef.current.signature !== rendererKey) {
    const rendererConfig: RendererConfig = {
      highlight: prewarmLangs.length > 0 ? { langs: prewarmLangs } : undefined,
      plugins: features,
      performance: {
        frameBudgetMs: scheduling?.frameBudgetMs,
        flushTimeoutMs: scheduling?.flushTimeoutMs,
        maxBatchesPerFlush: scheduling?.maxBatchesPerFlush,
        maxLowPriorityBatchesPerFlush: scheduling?.maxLowPriorityBatchesPerFlush,
        lowPriorityFrameBudgetMs: scheduling?.lowPriorityFrameBudgetMs,
        urgentQueueThreshold: scheduling?.urgentQueueThreshold,
        batch: scheduling?.batch,
        historyLimit: scheduling?.historyLimit,
      },
          mdx: mdxCompileMode ? { compileStrategy: mdxCompileMode, components: mdxComponents } : undefined,
        };
    rendererRef.current = {
      renderer: new MarkdownRenderer(rendererConfig),
      signature: rendererKey,
    };
  }

  const renderer = rendererRef.current.renderer;
  const historyLimit = scheduling?.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const store = renderer.getStore();
  const mdxMode: "server" | "worker" = mdxCompileMode ?? "server";
  const [workerReady, setWorkerReady] = useState(false);
  const workerReadyRef = useRef(false);
  const lastMetricsRef = useRef<RendererMetrics | null>(null);
  const patchHistoryRef = useRef<RendererMetrics[]>([]);

  const previousTextRef = useRef<string | undefined>();
  useEffect(() => {
    if (text !== undefined && text !== previousTextRef.current) {
      previousTextRef.current = text;
      setSession((prev) => prev + 1);
    }
  }, [text]);

  const previousStreamRef = useRef<AsyncIterable<string> | undefined>();
  useEffect(() => {
    if (stream && stream !== previousStreamRef.current) {
      previousStreamRef.current = stream;
      setSession((prev) => prev + 1);
    }
  }, [stream]);

  useEffect(() => {
    lastMetricsRef.current = null;
    patchHistoryRef.current = [];
    void renderer;
  }, [renderer]);

  useEffect(() => {
    if (components) {
      renderer.setBlockComponents(components);
    }
    if (mdxComponents) {
      renderer.setMdxComponents(mdxComponents);
    }
    if (inlineComponents) {
      renderer.setInlineComponents(inlineComponents);
    }
    if (tableElements) {
      renderer.getComponentRegistry().setTableElements(tableElements);
    }
    if (htmlElements) {
      renderer.getComponentRegistry().setHtmlElements(htmlElements);
    }
  }, [renderer, components, mdxComponents, inlineComponents, tableElements, htmlElements]);

  useEffect(() => {
    const removeListener = renderer.addFlushListener((result) => {
      const metrics = summarizeFlush(result);
      lastMetricsRef.current = metrics;
      patchHistoryRef.current.push(metrics);
      if (patchHistoryRef.current.length > historyLimit) {
        patchHistoryRef.current.splice(0, patchHistoryRef.current.length - historyLimit);
      }
      if (onMetrics) {
        try {
          onMetrics(metrics);
        } catch (error) {
          console.error("StreamingMarkdown onMetrics handler failed", error);
        }
      }
    });
    return removeListener;
  }, [renderer, historyLimit, onMetrics]);

  useEffect(() => {
    if (patchHistoryRef.current.length > historyLimit) {
      patchHistoryRef.current.splice(0, patchHistoryRef.current.length - historyLimit);
    }
  }, [historyLimit]);

  useEffect(() => {
    const restartToken = session;
    void restartToken;
    if (process.env.NODE_ENV !== "production" && DEBUG_WORKER) {
      // eslint-disable-next-line no-console
      console.info("[debug] instantiate worker effect");
    }
    if (typeof window === "undefined" || typeof Worker === "undefined") {
      return undefined;
    }
    setWorkerReady(false);
    workerReadyRef.current = false;
    const { worker, owned, release } = instantiateWorker(workerSource);
    if (process.env.NODE_ENV !== "production" && DEBUG_WORKER) {
      // eslint-disable-next-line no-console
      console.info("[debug] instantiate worker result", Boolean(worker));
    }
    if (!worker) {
      if (onError) {
        onError(new Error("Failed to create markdown worker instance"));
      }
      return undefined;
    }
    renderer.detachWorker();
    renderer.attachWorker(worker, { skipInit: managedWorker });
    if (managedWorker) {
      setWorkerReady(true);
      workerReadyRef.current = true;
      return () => {
        setWorkerReady(false);
        workerReadyRef.current = false;
        renderer.detachWorker();
        if (owned) {
          try {
            worker.terminate();
          } catch (error) {
            console.warn("Unable to terminate markdown worker", error);
          }
          release?.();
        }
      };
    }
    setWorkerReady(true);
    workerReadyRef.current = true;

    return () => {
      setWorkerReady(false);
      workerReadyRef.current = false;
      renderer.detachWorker();
      if (owned) {
        try {
          worker.terminate();
        } catch (error) {
          console.warn("Unable to terminate markdown worker", error);
        }
        release?.();
      }
    };
  }, [renderer, workerSource, session, onError, managedWorker]);

  useEffect(() => {
    const restartToken = session;
    void restartToken;
    let cancelled = false;
    if (!workerReady) {
      return () => {
        cancelled = true;
      };
    }

    if (managedWorker) {
      return () => {
        cancelled = true;
      };
    }

    if (text !== undefined) {
      try {
        renderer.restart();
        renderer.append(text);
        renderer.finalize();
      } catch (error) {
        if (onError) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
      return () => {
        cancelled = true;
      };
    }

    if (!stream) {
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        renderer.restart();
        for await (const chunk of stream) {
          if (cancelled) {
            break;
          }
          renderer.append(chunk);
          if (process.env.NODE_ENV !== "production" && DEBUG_WORKER) {
            // eslint-disable-next-line no-console
            console.info("[debug] streaming chunk", chunk.length);
          }
        }
      } catch (error) {
        if (onError && !cancelled) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [renderer, text, stream, workerReady, session, onError, managedWorker]);

  useImperativeHandle(
    ref,
    () => ({
      pause() {
        renderer.pause();
      },
      resume() {
        renderer.resume();
      },
      restart() {
        setSession((prev) => prev + 1);
      },
      finalize() {
        renderer.finalize();
      },
      append(text: string) {
        if (!text || !workerReadyRef.current) return;
        renderer.append(text);
      },
      setCredits(value: number) {
        renderer.setCredits(value);
      },
      flushPending() {
        return renderer.flushPendingPatches();
      },
      waitForIdle() {
        return renderer.waitForPatchQueueIdle();
      },
      onFlush(listener: (result: PatchFlushResult) => void) {
        return renderer.addFlushListener(listener);
      },
      getState() {
        return {
          blocks: store.getBlocks(),
          queueDepth: renderer.getPendingQueueSize(),
          pendingBatches: renderer.getPendingQueueSize(),
          isPaused: renderer.isPaused(),
          workerReady: workerReadyRef.current,
          rendererVersion: store.getVersion(),
          store,
          lastMetrics: lastMetricsRef.current,
        };
      },
      getPatchHistory(limit) {
        if (limit === undefined || limit >= patchHistoryRef.current.length) {
          return [...patchHistoryRef.current];
        }
        return patchHistoryRef.current.slice(patchHistoryRef.current.length - limit);
      },
    }),
    [renderer, store],
  );

  return (
    <>
      {mdxMode === "server" ? <MdxCoordinatorBridge store={store} mode={mdxMode} /> : null}
      <MarkdownBlocksRenderer blocks={EMPTY_BLOCKS} componentRegistry={renderer.getComponentRegistry()} className={className} style={style} store={store} />
    </>
  );
}

const StreamingMarkdownWithRef = forwardRef(StreamingMarkdownComponent);
StreamingMarkdownWithRef.displayName = "StreamingMarkdown";

export const StreamingMarkdown = StreamingMarkdownWithRef as React.ForwardRefExoticComponent<
  StreamingMarkdownProps & React.RefAttributes<StreamingMarkdownHandle>
>;

function instantiateWorker(source?: Worker | URL | (() => Worker) | string): WorkerInstance {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return { worker: null, owned: false };
  }
  if (source instanceof Worker) {
    return { worker: source, owned: false };
  }
  if (typeof source === "function") {
    try {
      const worker = source();
      return { worker, owned: false };
    } catch (error) {
      console.warn("StreamingMarkdown: worker factory failed", error);
      return { worker: null, owned: false };
    }
  }
  const name = "markdown-v2";
  const createWorkerFromUrl = (url: string | URL): WorkerInstance => {
    try {
      return { worker: new Worker(url, { type: "module", name }), owned: true };
    } catch (error) {
      console.warn("StreamingMarkdown: unable to instantiate worker", error);
      return { worker: null, owned: false };
    }
  };
  if (source instanceof URL || typeof source === "string") {
    return createWorkerFromUrl(source);
  }
  const autoWorker = createDefaultWorker();
  if (autoWorker) {
    return {
      worker: autoWorker,
      owned: true,
      release: () => releaseDefaultWorker(autoWorker),
    };
  }
  return createWorkerFromUrl("/workers/markdown-worker.js");
}

function summarizeFlush(result: PatchFlushResult): RendererMetrics {
  const batches = result.batches;
  const totalPatches = result.totalPatches;
  const appliedPatches = result.totalAppliedPatches;
  const queueDepthBefore = result.queueDepthBefore;
  const remainingQueue = result.remainingQueueSize;
  const receivedAt = Math.min(...batches.map((batch) => batch.receivedAt));
  const committedAt = result.flushCompletedAt;
  const durationMs = result.totalDurationMs;
  const patchToDomMs = committedAt - receivedAt;
  const queueDelays = batches.map((batch) => batch.queueDelayMs);
  const queueDelayAvg = average(queueDelays);
  const queueDelayMax = Math.max(...queueDelays);
  const queueDelayP95 = percentile(queueDelays, 0.95);
  const priorities = batches.map((batch) => batch.priority);
  const tx = batches[batches.length - 1]?.tx ?? null;
  const workerMetrics = batches.find((batch) => batch.metrics)?.metrics;

  return {
    tx,
    receivedAt,
    committedAt,
    durationMs,
    patchToDomMs,
    totalPatches,
    appliedPatches,
    queueDepthBefore,
    remainingQueueSize: remainingQueue,
    batchCount: batches.length,
    queueDelay: {
      avg: queueDelayAvg,
      max: queueDelayMax,
      p95: queueDelayP95,
    },
    priorities,
    workerMetrics,
    adaptiveBudget: result.adaptiveBudgetState,
    flush: result,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(ratio * sorted.length)));
  return sorted[index];
}
