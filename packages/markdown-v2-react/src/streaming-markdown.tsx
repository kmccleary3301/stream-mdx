import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import { MarkdownRenderer } from "./renderer";
import { MarkdownBlocksRenderer } from "./renderer";
import { CodeHighlightRequestContext, type CodeHighlightRequest } from "./renderer/code-highlight-context";
import { DefaultLinkSafetyModal, type LinkSafetyModalProps } from "./components";
import type { ContentComponentsMap } from "./components/content-components";
import { normalizeContentComponents } from "./components/content-components";
import type { TrustedMdxEngine } from "./trusted-mdx-contract";
import type { Block, CodeHighlightingMode, ContentPolicy, FormatAnticipationConfig, PatchMetrics } from "@stream-mdx/core";
import type { AdaptiveBudgetState, PatchFlushResult } from "./renderer/patch-commit-scheduler";
import { DeferredRenderContext, type DeferredRenderConfig } from "./renderer/deferred-render-context";
import { useRendererBlocks } from "./renderer/hooks";
import { StreamingActivityContext } from "./renderer/streaming-activity-context";
import { capturePreparedRendererStore, type RendererStore } from "./renderer/store";
import { useWorkerSession } from "./worker-session";
import { useStreamInputSession } from "./stream-input-session";
import { TrustedMdxBoundary } from "./trusted-mdx-boundary";
import { getTrustedRevisionFeed } from "./trusted-revision-feed";
import { defaultUrlTransform, type AnimatedProp, type BlockComponents, type BlockRendererOverride, type CodeFenceRenderer, type ControlsComponentProps, type ControlsConfig, type ElementFilterOptions, type HtmlElements, type HtmlOptions, type InlineComponents, type MathRenderer, type RendererConfig, type SyntaxRuleSpec, type TableElements, type TableVirtualizationOptions, type UrlTransform } from "./types";
const EMPTY_BLOCKS: ReadonlyArray<Block> = [];

function createConfigSignature(input: StreamingMarkdownConfigSignature): string {
  return JSON.stringify(input);
}

interface StreamingMarkdownConfigSignature {
  features: StreamingFeatureFlags;
  prewarm: string[];
  scheduling: StreamingSchedulerOptions | undefined;
  contentPolicy?: ContentPolicy;
  contentComponentKeys: string[];
  syntax?: SyntaxRuleSpec[];
  html?: HtmlOptions;
  themes?: { light: string; dark: string };
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
  startupMicrotaskFlushes?: number;
  adaptiveBudgeting?: boolean;
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
  themes?: { light: string; dark: string };
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

export type StreamingCaret = "block" | "circle" | string | false;
export type LinkSafetyCheck = (url: string) => boolean | Promise<boolean>;
export type LinkSafetyConfig = {
  enabled?: boolean;
  onLinkCheck?: LinkSafetyCheck;
  renderModal?: (props: LinkSafetyModalProps) => React.ReactNode;
};

export type MarkdownEngineMode = "worker" | "main-thread" | "auto";

export interface StreamingMarkdownProps extends ElementFilterOptions {
  text?: string;
  stream?: AsyncIterable<string>;
  worker?: Worker | URL | (() => Worker) | string;
  engine?: MarkdownEngineMode;
  managedWorker?: boolean;
  prewarmLangs?: string[];
  features?: StreamingFeatureFlags;
  themes?: { light: string; dark: string };
  components?: Partial<BlockComponents>;
  tableElements?: Partial<TableElements>;
  htmlElements?: Partial<HtmlElements>;
  inlineComponents?: Partial<InlineComponents>;
  scheduling?: StreamingSchedulerOptions;
  contentPolicy?: ContentPolicy;
  contentComponents?: ContentComponentsMap;
  engines?: {
    mdx?: TrustedMdxEngine;
  };
  onMetrics?: (metrics: RendererMetrics) => void;
  onError?: (error: Error) => void;
  className?: string;
  style?: React.CSSProperties;
  caret?: StreamingCaret;
  linkSafety?: LinkSafetyConfig;
  codeRenderers?: Record<string, CodeFenceRenderer>;
  mathRenderer?: MathRenderer;
  deferHeavyBlocks?: boolean | DeferredRenderConfig;
  blockRenderer?: BlockRendererOverride;
  syntax?: SyntaxRuleSpec[];
  html?: HtmlOptions;
  tableVirtualization?: TableVirtualizationOptions;
  urlTransform?: UrlTransform;
  controls?: ControlsConfig;
  controlsComponent?: React.ComponentType<ControlsComponentProps>;
  animated?: AnimatedProp;
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
    engine = "auto",
    prewarmLangs = [],
    features = {},
    themes,
    components,
    tableElements,
    htmlElements,
    contentPolicy = "restricted",
    contentComponents,
    engines,
    inlineComponents,
    scheduling,
    managedWorker = false,
    onMetrics,
    onError,
    className,
    style,
    caret,
    linkSafety,
    codeRenderers,
    allowedElements,
    disallowedElements,
    allowElement,
    unwrapDisallowed,
    disableAutolinkProtocols,
    mathRenderer,
    deferHeavyBlocks,
    blockRenderer,
    syntax,
    html,
    tableVirtualization,
    urlTransform,
    controls,
    controlsComponent,
    animated,
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
  const effectiveThemes = themes ?? features?.themes;
  const normalizedContentComponents = useMemo(
    () => normalizeContentComponents(contentComponents),
    [contentComponents],
  );
  const configSignature = useMemo(
    () =>
      createConfigSignature({
        features,
        prewarm: prewarmLangs,
        scheduling: effectiveScheduling,
        contentPolicy,
        contentComponentKeys: Object.keys(normalizedContentComponents).sort(),
        syntax,
        html,
        themes: effectiveThemes,
      }),
    [features, prewarmLangs, effectiveScheduling, contentPolicy, normalizedContentComponents, syntax, html, effectiveThemes],
  );
  // Stable indirection lets renderers use the current linkSafety handler.
  const linkHandlerRef = useRef<(url: string) => Promise<void>>();
  const rendererRef = useRef<{
    renderer: MarkdownRenderer;
    signature: string;
    trustedEngine: TrustedMdxEngine | undefined;
  }>();
  const [session, setSession] = useState(0);
  const rendererKey = `${configSignature}:${session}`;
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const historyLimit = effectiveScheduling.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const trustedEngine = contentPolicy === "trusted-mdx" ? engines?.mdx : undefined;

  if (!rendererRef.current || rendererRef.current.signature !== rendererKey || rendererRef.current.trustedEngine !== trustedEngine) {
    const rendererConfig: RendererConfig = {
      themes: effectiveThemes,
      codeRenderers,
      allowedElements,
      disallowedElements,
      allowElement,
      unwrapDisallowed,
      disableAutolinkProtocols,
      mathRenderer,
      tableVirtualization,
      urlTransform,
      blockRenderer,
      controls,
      controlsComponent,
      contentPolicy,
      contentComponents: normalizedContentComponents,
      engines,
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
        startupMicrotaskFlushes: effectiveScheduling.startupMicrotaskFlushes,
        adaptiveBudgeting: effectiveScheduling.adaptiveBudgeting,
      },
      syntax,
      html,
    };
    const nextRenderer = new MarkdownRenderer(rendererConfig);
    nextRenderer.getComponentRegistry().setLinkHandler((url) => {
      void linkHandlerRef.current?.(url);
    });
    rendererRef.current = {
      renderer: nextRenderer,
      signature: rendererKey,
      trustedEngine,
    };
  }

  const renderer = rendererRef.current.renderer;
  const trustedRevisionFeed = getTrustedRevisionFeed(renderer);
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
  const imperativeActivityRef = useRef(false);
  const lastMetricsRef = useRef<RendererMetrics | null>(null);
  const patchHistoryRef = useRef<RendererMetrics[]>([]);


  const linkSafetyEnabled = Boolean(linkSafety?.enabled);
  const [linkModalState, setLinkModalState] = useState<{ url: string; isOpen: boolean; isChecking: boolean }>({
    url: "",
    isOpen: false,
    isChecking: false,
  });

  const openLink = useMemo(() => {
    return (url: string) => {
      if (typeof window === "undefined") return;
      const transform = urlTransform ?? defaultUrlTransform;
      const safe = transform(url, "href", { source: "markdown" });
      if (!safe) return;
      if (safe.startsWith("http://") || safe.startsWith("https://")) {
        window.open(safe, "_blank", "noopener,noreferrer");
      } else {
        window.location.assign(safe);
      }
    };
  }, [urlTransform]);

  const handleLinkClick = useMemo(() => {
    return async (url: string) => {
      const transform = urlTransform ?? defaultUrlTransform;
      const safe = transform(url, "href", { source: "markdown" });
      if (!safe) return;
      if (!linkSafetyEnabled) {
        openLink(safe);
        return;
      }
      if (linkSafety?.onLinkCheck) {
        setLinkModalState((prev) => ({ ...prev, isChecking: true }));
        try {
          const allowed = await linkSafety.onLinkCheck(safe);
          if (allowed) {
            setLinkModalState((prev) => ({ ...prev, isChecking: false }));
            openLink(safe);
            return;
          }
        } catch {
          // fall through to modal
        }
        setLinkModalState((prev) => ({ ...prev, isChecking: false }));
      }
      setLinkModalState({ url: safe, isOpen: true, isChecking: false });
    };
  }, [linkSafety, linkSafetyEnabled, openLink, urlTransform]);
  linkHandlerRef.current = handleLinkClick;

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
    if (normalizedContentComponents) {
      renderer.setContentComponents(normalizedContentComponents);
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
    if (codeRenderers) {
      renderer.setCodeRenderers(codeRenderers);
    }
    const reg = renderer.getComponentRegistry();
    if (mathRenderer) {
      renderer.setMathRenderer(mathRenderer);
    }
    reg.setTableVirtualization(tableVirtualization);
  }, [renderer, components, normalizedContentComponents, inlineComponents, resolvedInlineComponents, tableElements, htmlElements, codeRenderers, mathRenderer, tableVirtualization]);

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


  const { workerReady, workerReadyRef, inputReady, inputReadyRef, initializationError, readyRendererRef } = useWorkerSession({
    renderer, workerSource, engine, session, managedWorker, onErrorRef, debug: DEBUG_WORKER,
  });
  const { streamStatus, setStreamStatus, activeIteratorRef } = useStreamInputSession({
    renderer, text, stream, workerReady, inputReady, inputReadyRef, initializationError, session, managedWorker, readyRendererRef,
    imperativeActivityRef, onErrorRef, debug: DEBUG_WORKER,
  });
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
        imperativeActivityRef.current = false;
        activeIteratorRef.current = null;
        setStreamStatus("idle");
        setSession((prev) => prev + 1);
      },
      finalize() {
        renderer.finalize();
        imperativeActivityRef.current = false;
        setStreamStatus(activeIteratorRef.current === null ? "done" : "streaming");
      },
      append(text: string) {
        if (!text || !workerReadyRef.current) return;
        renderer.append(text);
        imperativeActivityRef.current = true;
        setStreamStatus("streaming");
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

  const renderNativeFrame = (frameStore: RendererStore): React.ReactElement => (
    <MarkdownBlocksRenderer
      blocks={EMPTY_BLOCKS}
      componentRegistry={renderer.getComponentRegistry()}
      codeRenderers={codeRenderers}
      blockRenderer={blockRenderer}
      urlTransform={urlTransform}
      controls={controls}
      controlsComponent={controlsComponent}
      animated={animated}
      contentComponents={normalizedContentComponents}
      allowedElements={allowedElements}
      disallowedElements={disallowedElements}
      allowElement={allowElement}
      unwrapDisallowed={unwrapDisallowed}
      disableAutolinkProtocols={disableAutolinkProtocols}
      className={resolvedClassName}
      style={resolvedStyle}
      store={frameStore}
    />
  );

  return (
    <DeferredRenderContext.Provider value={deferredConfig}>
      <CodeHighlightRequestContext.Provider value={highlightRequester}>
      <StreamingActivityContext.Provider value={streamStatus === "streaming" || hasActiveBlocks}>
        <TrustedMdxBoundary
          engine={trustedEngine}
          feed={trustedRevisionFeed}
          captureNativeFrame={() => capturePreparedRendererStore(store)}
          renderNativeFrame={renderNativeFrame}
        >
          {renderNativeFrame(store)}
        </TrustedMdxBoundary>
      </StreamingActivityContext.Provider>
      </CodeHighlightRequestContext.Provider>
      {linkModal}
    </DeferredRenderContext.Provider>
  );
}

const StreamingMarkdownWithRef = forwardRef(StreamingMarkdownComponent);
StreamingMarkdownWithRef.displayName = "StreamingMarkdown";

export const StreamingMarkdown = StreamingMarkdownWithRef as React.ForwardRefExoticComponent<
  StreamingMarkdownProps & React.RefAttributes<StreamingMarkdownHandle>
>;


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
