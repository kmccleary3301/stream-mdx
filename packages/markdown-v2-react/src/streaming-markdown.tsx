import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import type { Block, CodeHighlightingMode, CompiledMdxModule, FormatAnticipationConfig, PatchMetrics } from "@stream-mdx/core";
import { MarkdownRenderer } from "./renderer";
import { MarkdownBlocksRenderer } from "./renderer";
import { CodeHighlightRequestContext, type CodeHighlightRequest } from "./renderer/code-highlight-context";
import { DefaultLinkSafetyModal, type LinkSafetyModalProps } from "./components";
import { useMdxCoordinator } from "./mdx-coordinator";
import { MdxHydrationContext, type MdxHydrationOptions, createMdxHydrationController } from "./mdx-hydration-context";
import { type MdxHydrationSummary, getMdxHydrationSummary, recordMdxHydrationLongTask } from "./mdx-hydration-metrics";
import { MdxPrefetchQueue } from "./mdx-prefetch";
import { prefetchMdxRuntime } from "./mdx-runtime";
import type { AdaptiveBudgetState, PatchFlushResult } from "./renderer/patch-commit-scheduler";
import { DeferredRenderContext, type DeferredRenderConfig } from "./renderer/deferred-render-context";
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
  mdxComponentKeys: string[];
  mdxHydration?: MdxHydrationOptions;
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
  adaptiveSwitch?: boolean;
  adaptiveQueueThreshold?: number;
}

export interface StreamingFeatureFlags {
  footnotes?: boolean;
  html?: boolean;
  mdx?: boolean;
  tables?: boolean;
  callouts?: boolean;
  math?: boolean;
  formatAnticipation?: FormatAnticipationConfig;
  codeHighlighting?: CodeHighlightingMode;
  liveCodeHighlighting?: boolean;
  liveTokenization?: boolean;
  emitHighlightTokens?: boolean;
  emitDiffBlocks?: boolean;
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
  mdxHydration?: MdxHydrationSummary & { pending: number };
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

export type StreamingCaret = "block" | "circle" | string | false;
export type LinkSafetyCheck = (url: string) => boolean | Promise<boolean>;
export type LinkSafetyConfig = {
  enabled?: boolean;
  onLinkCheck?: LinkSafetyCheck;
  renderModal?: (props: LinkSafetyModalProps) => React.ReactNode;
};

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
  mdxHydration?: MdxHydrationOptions;
  onMetrics?: (metrics: RendererMetrics) => void;
  onError?: (error: Error) => void;
  className?: string;
  style?: React.CSSProperties;
  caret?: StreamingCaret;
  linkSafety?: LinkSafetyConfig;
  deferHeavyBlocks?: boolean | DeferredRenderConfig;
}

const MdxCoordinatorBridge: React.FC<{ store: RendererStore; mode: "server" | "worker" }> = ({ store, mode }) => {
  const blocks = useRendererBlocks(store);
  useMdxCoordinator(blocks, undefined, { store, mode });
  return null;
};

const MdxPrefetchBridge: React.FC<{ store: RendererStore }> = ({ store }) => {
  const blocks = useRendererBlocks(store);
  const prefetchedRuntimeRef = useRef(false);
  const trackedIdsRef = useRef(new Set<string>());
  const queueRef = useRef<MdxPrefetchQueue | null>(null);

  if (!queueRef.current) {
    queueRef.current = new MdxPrefetchQueue();
  }

  useEffect(() => {
    const queue = queueRef.current;
    if (!queue) return;
    const nextIds = new Map<string, { id: string; compiledModule: CompiledMdxModule | null }>();
    let shouldPrefetchRuntime = false;

    for (const block of blocks) {
      if (block.type === "mdx") {
        shouldPrefetchRuntime = true;
        const compiledModule = block.payload.compiledMdxModule ?? null;
        const compiledRef = block.payload.compiledMdxRef;
        if (compiledModule && typeof compiledModule.id === "string") {
          nextIds.set(compiledModule.id, { id: compiledModule.id, compiledModule });
        } else if (compiledRef?.id && compiledRef.id !== "pending") {
          nextIds.set(compiledRef.id, { id: compiledRef.id, compiledModule: null });
        }
      }
      const meta = block.payload.meta as { mixedSegments?: Array<{ kind?: string }> } | undefined;
      const segments = Array.isArray(meta?.mixedSegments) ? meta?.mixedSegments : [];
      if (segments.some((segment) => segment?.kind === "mdx")) {
        shouldPrefetchRuntime = true;
      }
    }

    if (shouldPrefetchRuntime && !prefetchedRuntimeRef.current) {
      prefetchedRuntimeRef.current = true;
      prefetchMdxRuntime();
    }

    for (const id of trackedIdsRef.current) {
      if (!nextIds.has(id)) {
        queue.cancel(id);
      }
    }

    for (const entry of nextIds.values()) {
      if (!trackedIdsRef.current.has(entry.id)) {
        queue.enqueue({ id: entry.id, compiledModule: entry.compiledModule });
      }
    }

    trackedIdsRef.current = new Set(nextIds.keys());
  }, [blocks]);

  useEffect(() => {
    return () => {
      queueRef.current?.cancelAll();
    };
  }, []);

  return null;
};

interface WorkerInstance {
  worker: Worker | null;
  owned: boolean;
  release?: () => void;
}

const DEFAULT_HISTORY_LIMIT =
  typeof process !== "undefined" && process.env && process.env.NODE_ENV === "production" ? 80 : 200;
const DEFAULT_SCHEDULING: StreamingSchedulerOptions = {
  batch: "microtask",
  frameBudgetMs: 10,
  maxBatchesPerFlush: 12,
  lowPriorityFrameBudgetMs: 6,
  maxLowPriorityBatchesPerFlush: 2,
  urgentQueueThreshold: 4,
};
const DEFAULT_SCHEDULING_SMOOTH: StreamingSchedulerOptions = {
  batch: "rAF",
  frameBudgetMs: 6,
  maxBatchesPerFlush: 4,
  lowPriorityFrameBudgetMs: 3,
  maxLowPriorityBatchesPerFlush: 1,
  urgentQueueThreshold: 2,
};
const DEFAULT_ADAPTIVE_QUEUE_THRESHOLD = 12;

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
    mdxHydration,
    managedWorker = false,
    onMetrics,
    onError,
    className,
    style,
    caret,
    linkSafety,
    deferHeavyBlocks,
  }: StreamingMarkdownProps,
  ref: React.ForwardedRef<StreamingMarkdownHandle>,
) {
  if (text !== undefined && stream !== undefined) {
    throw new Error("StreamingMarkdown expects either `text` or `stream`, not both.");
  }

  const effectiveScheduling = scheduling ?? DEFAULT_SCHEDULING;
  const adaptiveSwitchEnabled =
    effectiveScheduling.batch === "microtask" && (scheduling?.adaptiveSwitch ?? true);
  const adaptiveQueueThreshold =
    scheduling?.adaptiveQueueThreshold ??
    (typeof effectiveScheduling.maxBatchesPerFlush === "number"
      ? effectiveScheduling.maxBatchesPerFlush
      : DEFAULT_ADAPTIVE_QUEUE_THRESHOLD);
  const configSignature = useMemo(
    () =>
      createConfigSignature({
        features,
        prewarm: prewarmLangs,
        scheduling: effectiveScheduling,
        mdxStrategy: mdxCompileMode,
        mdxComponentKeys: mdxComponents ? Object.keys(mdxComponents).sort() : [],
        mdxHydration,
      }),
    [features, prewarmLangs, effectiveScheduling, mdxCompileMode, mdxComponents, mdxHydration],
  );

  const mdxHydrationController = useMemo(() => createMdxHydrationController(mdxHydration), [mdxHydration]);
  const mdxHydrationContextValue = useMemo(
    () => ({
      controller: mdxHydrationController,
      options: mdxHydration,
    }),
    [mdxHydrationController, mdxHydration],
  );
  const rendererRef = useRef<{ renderer: MarkdownRenderer; signature: string }>();
  const [session, setSession] = useState(0);
  const rendererKey = `${configSignature}:${session}`;

  const historyLimit = effectiveScheduling.historyLimit ?? DEFAULT_HISTORY_LIMIT;

  if (!rendererRef.current || rendererRef.current.signature !== rendererKey) {
    const mdxConfig =
      mdxCompileMode || mdxComponents
        ? {
            compileStrategy: mdxCompileMode ?? "server",
            components: mdxComponents,
          }
        : undefined;
    const rendererConfig: RendererConfig = {
      highlight: prewarmLangs.length > 0 ? { langs: prewarmLangs } : undefined,
      plugins: features,
      performance: {
        frameBudgetMs: effectiveScheduling.frameBudgetMs,
        flushTimeoutMs: effectiveScheduling.flushTimeoutMs,
        maxBatchesPerFlush: effectiveScheduling.maxBatchesPerFlush,
        maxLowPriorityBatchesPerFlush: effectiveScheduling.maxLowPriorityBatchesPerFlush,
        lowPriorityFrameBudgetMs: effectiveScheduling.lowPriorityFrameBudgetMs,
        urgentQueueThreshold: effectiveScheduling.urgentQueueThreshold,
        batch: effectiveScheduling.batch,
        historyLimit,
      },
      mdx: mdxConfig,
    };
    rendererRef.current = {
      renderer: new MarkdownRenderer(rendererConfig),
      signature: rendererKey,
    };
  }

  const renderer = rendererRef.current.renderer;
  const highlightRequester = useCallback(
    (request: CodeHighlightRequest) => {
      renderer.requestCodeHighlightRange(request);
    },
    [renderer],
  );
  const store = renderer.getStore();
  const blocks = useRendererBlocks(store);
  const adaptiveSwitchedRef = useRef(false);
  const adaptiveFirstFlushRef = useRef(false);
  const mdxMode: "server" | "worker" = mdxCompileMode ?? "server";
  const [workerReady, setWorkerReady] = useState(false);
  const workerReadyRef = useRef(false);
  const [streamStatus, setStreamStatus] = useState<"idle" | "streaming" | "done">("idle");
  const lastMetricsRef = useRef<RendererMetrics | null>(null);
  const patchHistoryRef = useRef<RendererMetrics[]>([]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") {
      return undefined;
    }
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const duration = entry.duration;
          const start = (entry as PerformanceEntry).startTime;
          if (Number.isFinite(duration) && Number.isFinite(start)) {
            recordMdxHydrationLongTask(start, duration);
          }
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch (error) {
      observer = null;
      console.warn("[streaming-markdown] Long task observer unavailable", error);
    }
    return () => {
      observer?.disconnect();
    };
  }, []);

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

  const linkSafetyEnabled = Boolean(linkSafety?.enabled);
  const [linkModalState, setLinkModalState] = useState<{ url: string; isOpen: boolean; isChecking: boolean }>({
    url: "",
    isOpen: false,
    isChecking: false,
  });

  const openLink = useMemo(() => {
    return (url: string) => {
      if (typeof window === "undefined") return;
      if (url.startsWith("http://") || url.startsWith("https://")) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        window.location.assign(url);
      }
    };
  }, []);

  const handleLinkClick = useMemo(() => {
    return async (url: string) => {
      if (!linkSafetyEnabled) {
        openLink(url);
        return;
      }
      if (linkSafety?.onLinkCheck) {
        setLinkModalState((prev) => ({ ...prev, isChecking: true }));
        try {
          const allowed = await linkSafety.onLinkCheck(url);
          if (allowed) {
            setLinkModalState((prev) => ({ ...prev, isChecking: false }));
            openLink(url);
            return;
          }
        } catch {
          // fall through to modal
        }
        setLinkModalState((prev) => ({ ...prev, isChecking: false }));
      }
      setLinkModalState({ url, isOpen: true, isChecking: false });
    };
  }, [linkSafety, linkSafetyEnabled, openLink]);

  const handleLinkClose = useMemo(() => {
    return () => setLinkModalState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const handleLinkConfirm = useMemo(() => {
    return () => {
      const url = linkModalState.url;
      setLinkModalState((prev) => ({ ...prev, isOpen: false }));
      if (url) {
        openLink(url);
      }
    };
  }, [linkModalState.url, openLink]);

  const handleLinkCopy = useMemo(() => {
    return () => {
      const url = linkModalState.url;
      if (!url || typeof navigator === "undefined") return;
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(url);
        return;
      }
      try {
        const textarea = document.createElement("textarea");
        textarea.value = url;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      } catch {
        // ignore copy failures
      }
    };
  }, [linkModalState.url]);

  const resolvedInlineComponents = useMemo(() => {
    if (!linkSafetyEnabled) {
      return inlineComponents;
    }
    const LinkComponent: InlineComponents["link"] = ({ href, title, children }) => {
      const url = typeof href === "string" ? href : "";
      const isIncomplete = url.startsWith("streamdown:incomplete-link") || url.startsWith("stream-mdx:incomplete-link");
      if (!url || isIncomplete) {
        return React.createElement("span", { className: "markdown-link", title }, children);
      }
      return React.createElement(
        "button",
        {
          type: "button",
          className: "markdown-link",
          title,
          onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            event.stopPropagation();
            void handleLinkClick(url);
          },
        },
        children,
      );
    };
    return { ...(inlineComponents ?? {}), link: LinkComponent };
  }, [handleLinkClick, inlineComponents, linkSafetyEnabled]);

  useEffect(() => {
    setStreamStatus("idle");
  }, [session]);

  useEffect(() => {
    adaptiveSwitchedRef.current = false;
    adaptiveFirstFlushRef.current = false;
  }, [renderer]);

  useEffect(() => {
    if (!adaptiveSwitchEnabled) return undefined;
    const unsubscribe = renderer.addFlushListener((result) => {
      if (adaptiveSwitchedRef.current) return;
      if (!adaptiveFirstFlushRef.current) {
        adaptiveFirstFlushRef.current = true;
        return;
      }
      if (result.remainingQueueSize <= adaptiveQueueThreshold) {
        renderer.setSchedulingOptions({
          frameBudgetMs: DEFAULT_SCHEDULING_SMOOTH.frameBudgetMs,
          maxBatchesPerFlush: DEFAULT_SCHEDULING_SMOOTH.maxBatchesPerFlush,
          lowPriorityFrameBudgetMs: DEFAULT_SCHEDULING_SMOOTH.lowPriorityFrameBudgetMs,
          maxLowPriorityBatchesPerFlush: DEFAULT_SCHEDULING_SMOOTH.maxLowPriorityBatchesPerFlush,
          urgentQueueThreshold: DEFAULT_SCHEDULING_SMOOTH.urgentQueueThreshold,
          batch: DEFAULT_SCHEDULING_SMOOTH.batch,
        });
        adaptiveSwitchedRef.current = true;
      }
    });
    return unsubscribe;
  }, [renderer, adaptiveSwitchEnabled, adaptiveQueueThreshold]);

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
      renderer.setInlineComponents(resolvedInlineComponents ?? inlineComponents);
    } else if (resolvedInlineComponents) {
      renderer.setInlineComponents(resolvedInlineComponents);
    }
    if (tableElements) {
      renderer.getComponentRegistry().setTableElements(tableElements);
    }
    if (htmlElements) {
      renderer.getComponentRegistry().setHtmlElements(htmlElements);
    }
  }, [renderer, components, mdxComponents, inlineComponents, resolvedInlineComponents, tableElements, htmlElements]);

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
        setStreamStatus("streaming");
        renderer.restart();
        renderer.append(text);
        renderer.finalize();
        setStreamStatus("done");
      } catch (error) {
        setStreamStatus("done");
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
        setStreamStatus("streaming");
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
        if (!cancelled) {
          setStreamStatus("done");
        }
      } catch (error) {
        if (onError && !cancelled) {
          setStreamStatus("done");
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
        const currentBlocks = store.getBlocks();
        return {
          blocks: currentBlocks,
          queueDepth: renderer.getPendingQueueSize(),
          pendingBatches: renderer.getPendingQueueSize(),
          isPaused: renderer.isPaused(),
          workerReady: workerReadyRef.current,
          rendererVersion: store.getVersion(),
          store,
          lastMetrics: lastMetricsRef.current,
          mdxHydration: summarizeMdxHydration(currentBlocks),
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

  const hasActiveBlocks = useMemo(() => blocks.some((block) => !block.isFinalized), [blocks]);
  const caretValue = useMemo(() => {
    if (!caret) {
      return null;
    }
    if (caret === "block") {
      return "▋";
    }
    if (caret === "circle") {
      return "●";
    }
    if (typeof caret === "string" && caret.length > 0) {
      return caret;
    }
    return null;
  }, [caret]);
  const showCaret = Boolean(caretValue) && (streamStatus === "streaming" || hasActiveBlocks);
  const resolvedClassName = [className, showCaret ? "stream-mdx-caret" : null].filter(Boolean).join(" ");
  const resolvedStyle = caretValue
    ? ({
        ...(style ?? {}),
        ["--stream-mdx-caret" as string]: JSON.stringify(caretValue),
      } satisfies React.CSSProperties)
    : style;
  const deferredConfig = useMemo(() => {
    if (!deferHeavyBlocks) {
      return null;
    }
    if (deferHeavyBlocks === true) {
      return {};
    }
    return deferHeavyBlocks;
  }, [deferHeavyBlocks]);
  const linkModal = linkSafetyEnabled
    ? (linkSafety?.renderModal ?? DefaultLinkSafetyModal)({
        url: linkModalState.url,
        isOpen: linkModalState.isOpen,
        isChecking: linkModalState.isChecking,
        onClose: handleLinkClose,
        onConfirm: handleLinkConfirm,
        onCopy: handleLinkCopy,
      })
    : null;

  return (
    <MdxHydrationContext.Provider value={mdxHydrationContextValue}>
      <DeferredRenderContext.Provider value={deferredConfig}>
        <MdxPrefetchBridge store={store} />
        {mdxMode === "server" ? <MdxCoordinatorBridge store={store} mode={mdxMode} /> : null}
        <CodeHighlightRequestContext.Provider value={highlightRequester}>
          <MarkdownBlocksRenderer
            blocks={EMPTY_BLOCKS}
            componentRegistry={renderer.getComponentRegistry()}
            className={resolvedClassName}
            style={resolvedStyle}
            store={store}
          />
        </CodeHighlightRequestContext.Provider>
        {linkModal}
      </DeferredRenderContext.Provider>
    </MdxHydrationContext.Provider>
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

function summarizeMdxHydration(blocks: ReadonlyArray<Block>): MdxHydrationSummary & { pending: number } {
  const summary = getMdxHydrationSummary();
  let pending = 0;

  for (const block of blocks) {
    if (block.type !== "mdx") continue;
    const meta = block.payload.meta as { mdxStatus?: unknown } | undefined;
    const status = typeof meta?.mdxStatus === "string" ? meta.mdxStatus : undefined;
    const compiled = block.payload.compiledMdxRef ?? block.payload.compiledMdxModule;
    if (!compiled || status === "pending") {
      pending += 1;
    }
  }

  return { ...summary, pending };
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
