import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import { MarkdownRenderer } from "./renderer";
import { MarkdownBlocksRenderer } from "./renderer";
import { CodeHighlightRequestContext, type CodeHighlightRequest } from "./renderer/code-highlight-context";
import { DefaultLinkSafetyModal, type LinkSafetyModalProps } from "./components";
import type { ContentComponentsMap } from "./components/content-components";
import { normalizeContentComponents } from "./components/content-components";
import type { TrustedMdxEngine } from "./trusted-mdx-contract";
import type { Block, CodeHighlightOutputMode, CodeHighlightingMode, ContentPolicy, FormatAnticipationConfig, PatchMetrics } from "@stream-mdx/core";
import { SourceCapacityError, StreamSessionError, type AppendResult, type FinalizeResult, type WaitForCapacityOptions } from "@stream-mdx/protocol";
import { SOURCE_ADMISSION_HARD_LIMIT, SOURCE_ADMISSION_SOFT_LIMIT } from "./source-admission-limits";
export { SourceCapacityError, StreamSessionError } from "@stream-mdx/protocol";
import { EngineCompatibilityError } from "./worker-session";
export { EngineCompatibilityError };
export type { AppendResult, FinalizeResult, WaitForCapacityOptions } from "@stream-mdx/protocol";
import type { AdaptiveBudgetState, PatchFlushResult } from "./renderer/patch-commit-scheduler";
import { DeferredRenderContext, type DeferredRenderConfig } from "./renderer/deferred-render-context";
import { useRendererHasProvisionalBlocks } from "./renderer/hooks";
import { StreamingActivityContext } from "./renderer/streaming-activity-context";
import { capturePreparedRendererStore, type RendererStore } from "./renderer/store";
import { useWorkerSession } from "./worker-session";
import { useStreamInputSession } from "./stream-input-session";
import { TrustedMdxBoundary } from "./trusted-mdx-boundary";
import { getTrustedRevisionFeed } from "./trusted-revision-feed";
import { DocumentMathMacroScope, DocumentMathMacroScopeContext } from "./components/katex-math";
import { defaultUrlTransform, type AnimatedProp, type ControlsComponentProps, type ControlsConfig, type ElementFilterOptions, type HtmlOptions, type LinkDestinationOptions, type InlineComponents, type MathEngine, type MathOptions, type MermaidEngine, type NodePresentations, type RendererConfig, type SoftBreakMode, type SyntaxExtensionDescriptor, type TableVirtualizationOptions, type UrlTransform, type VirtualizedCodeConfig } from "./types";
import type { CodeEngine } from "./types";
type PendingStreamingCommand = { type: "append"; text: string } | { type: "finalize" };
type PendingCapacityWaiter = {
  resolve(): void;
  reject(error: Error): void;
  options: WaitForCapacityOptions;
  signal?: AbortSignal;
  abort?: () => void;
};
type PendingStreamingCommands = {
  owner: string;
  commands: PendingStreamingCommand[];
  nextIndex: number;
  sealed: boolean;
  acceptedSourceUnits: number;
  pendingSourceUnits: number;
  capacityWaiters: Set<PendingCapacityWaiter>;
  finalizationPromise: Promise<FinalizeResult> | null;
  resolveFinalization?: (result: FinalizeResult) => void;
  rejectFinalization?: (error: Error) => void;
  drainAbortController: AbortController | null;
};
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
  syntax?: SyntaxExtensionDescriptor;
  html?: HtmlOptions;
  linkDestinations?: LinkDestinationOptions;
  themes?: { light: string; dark: string };
  mathOptions?: MathOptions;
  codeEngineId?: string;
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
  softBreaks?: SoftBreakMode;
  formatAnticipation?: FormatAnticipationConfig;
  codeHighlighting?: CodeHighlightingMode;
  outputMode?: CodeHighlightOutputMode;
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
  finalize(): Promise<FinalizeResult>;
  append(text: string): AppendResult;
  waitForCapacity(options: WaitForCapacityOptions): Promise<void>;
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

export type MarkdownEngineMode = "auto" | "main" | "worker";

export interface StreamingMarkdownProps extends ElementFilterOptions {
  text?: string;
  stream?: AsyncIterable<string>;
  worker?: Worker | URL | (() => Worker) | string;
  engine?: MarkdownEngineMode;
  managedWorker?: boolean;
  prewarmLangs?: string[];
  features?: StreamingFeatureFlags;
  themes?: { light: string; dark: string };
  colorScheme?: "light" | "dark" | "system";
  components?: NodePresentations;
  scheduling?: StreamingSchedulerOptions;
  contentPolicy?: ContentPolicy;
  contentComponents?: ContentComponentsMap;
  engines?: {
    code?: CodeEngine;
    math?: MathEngine;
    mermaid?: MermaidEngine;
    mdx?: TrustedMdxEngine;
  };
  onMetrics?: (metrics: RendererMetrics) => void;
  onError?: (error: Error) => void;
  className?: string;
  style?: React.CSSProperties;
  caret?: StreamingCaret;
  linkSafety?: LinkSafetyConfig;
  mathOptions?: MathOptions;
  deferHeavyBlocks?: boolean | DeferredRenderConfig;
  syntax?: SyntaxExtensionDescriptor;
  html?: HtmlOptions;
  linkDestinations?: LinkDestinationOptions;
  tableVirtualization?: TableVirtualizationOptions;
  codeVirtualization?: Partial<VirtualizedCodeConfig>;
  urlTransform?: UrlTransform;
  controls?: ControlsConfig;
  controlsComponent?: React.ComponentType<ControlsComponentProps>;
  animated?: AnimatedProp;
  statusMessage?: string;
}




const DEFAULT_HISTORY_LIMIT =
  typeof process !== "undefined" && process.env && process.env.NODE_ENV === "production" ? 80 : 200;
const DEFAULT_SCHEDULING: StreamingSchedulerOptions = {
  batch: "rAF",
  frameBudgetMs: 4,
  maxBatchesPerFlush: 12,
  lowPriorityFrameBudgetMs: 2,
  maxLowPriorityBatchesPerFlush: 2,
  urgentQueueThreshold: 4,
};
const DEFAULT_SCHEDULING_SMOOTH: StreamingSchedulerOptions = {
  batch: "rAF",
  frameBudgetMs: 4,
  maxBatchesPerFlush: 4,
  lowPriorityFrameBudgetMs: 2,
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
    colorScheme,
    components,
    contentPolicy = "restricted",
    contentComponents,
    engines,
    scheduling,
    managedWorker = false,
    onMetrics,
    onError,
    className,
    style,
    caret,
    linkSafety,
    allowedElements,
    disallowedElements,
    allowElement,
    unwrapDisallowed,
    disableAutolinkProtocols,
    mathOptions,
    deferHeavyBlocks,
    syntax,
    html,
    linkDestinations,
    tableVirtualization,
    codeVirtualization,
    urlTransform,
    controls,
    controlsComponent,
    animated,
    statusMessage,
  }: StreamingMarkdownProps,
  ref: React.ForwardedRef<StreamingMarkdownHandle>,
) {
  if ((engine as string) === "main-thread") {
    throw new Error('engine="main-thread" has been removed; use engine="main" instead.');
  }
  if (engines?.code && engine !== "main") {
    throw new EngineCompatibilityError('The main-realm CodeEngine requires engine="main".');
  }
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
        linkDestinations,
        themes: effectiveThemes,
        mathOptions,
        codeEngineId: engines?.code?.id,
      }),
    [features, prewarmLangs, effectiveScheduling, contentPolicy, normalizedContentComponents, syntax, html, linkDestinations, effectiveThemes, mathOptions, engines?.code?.id],
  );
  const rendererRef = useRef<{
    renderer: MarkdownRenderer;
    signature: string;
    trustedEngine: TrustedMdxEngine | undefined;
    mathEngine: MathEngine | undefined;
    mermaidEngine: MermaidEngine | undefined;
    codeEngine: CodeEngine | undefined;
  }>();
  const [session, setSession] = useState(0);
  const sessionRef = useRef(session);
  if (session > sessionRef.current) sessionRef.current = session;
  const rendererKey = `${configSignature}:${session}`;
  const mathMacroScope = useMemo(
    () => mathOptions?.macroScope === "document" ? new DocumentMathMacroScope() : null,
    [rendererKey, text, stream, mathOptions?.macroScope],
  );
  useEffect(() => () => mathMacroScope?.dispose(), [mathMacroScope]);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const historyLimit = effectiveScheduling.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const trustedEngine = contentPolicy === "trusted-mdx" ? engines?.mdx : undefined;
  const mathEngine = engines?.math;
  const mermaidEngine = engines?.mermaid;
  const codeEngine = engines?.code;

  if (
    !rendererRef.current ||
    rendererRef.current.signature !== rendererKey ||
    rendererRef.current.trustedEngine !== trustedEngine ||
    rendererRef.current.mathEngine !== mathEngine ||
    rendererRef.current.mermaidEngine !== mermaidEngine
    || rendererRef.current.codeEngine !== codeEngine
  ) {
    const rendererConfig: RendererConfig = {
      themes: effectiveThemes,
      components,
      allowedElements,
      disallowedElements,
      allowElement,
      unwrapDisallowed,
      disableAutolinkProtocols,
      tableVirtualization,
      codeVirtualization,
      urlTransform,
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
      mathOptions,
      linkDestinations,
    };
    const nextRenderer = new MarkdownRenderer(rendererConfig);
    rendererRef.current = {
      renderer: nextRenderer,
      signature: rendererKey,
      trustedEngine,
      mathEngine,
      mermaidEngine,
      codeEngine,
    };
  }

  const renderer = rendererRef.current.renderer;
  const sessionDisposedRef = useRef(false);
  const sessionHandleTokenRef = useRef<object | null>(null);
  const trustedRevisionFeed = getTrustedRevisionFeed(renderer);
  const highlightRequester = useCallback(
    (request: CodeHighlightRequest) => {
      renderer.requestCodeHighlightRange(request);
    },
    [renderer],
  );
  const store = renderer.getStore();
  const hasActiveBlocks = useRendererHasProvisionalBlocks(store);
  const adaptiveSwitchedRef = useRef(false);
  const adaptiveFirstFlushRef = useRef(false);
  const imperativeActivityRef = useRef(false);
  const pendingCommandsRef = useRef<PendingStreamingCommands | null>(null);
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

  const resolvedLinkRenderer = useMemo(() => {
    if (!linkSafetyEnabled) {
      return undefined;
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
    return LinkComponent;
  }, [handleLinkClick, linkSafetyEnabled]);

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
    const reg = renderer.getComponentRegistry();
    reg.setNodePresentations(components);
    if (normalizedContentComponents) {
      renderer.setContentComponents(normalizedContentComponents);
    }
    reg.setLinkSafetyRenderer(resolvedLinkRenderer);
    reg.setTableVirtualization(tableVirtualization);
  }, [renderer, components, normalizedContentComponents, resolvedLinkRenderer, tableVirtualization]);

  useEffect(() => {
    renderer.getComponentRegistry().setCodeVirtualization(codeVirtualization);
  }, [renderer, codeVirtualization]);

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


  const { workerReady, workerReadyRef, inputReady, inputReadyRef, initializationEpoch, initializationError, readyRendererRef } = useWorkerSession({
    renderer, workerSource, engine, session, managedWorker, codeEngine, onErrorRef, debug: DEBUG_WORKER,
  });
  const rejectPendingCapacityWaiters = useCallback((pending: PendingStreamingCommands, error: Error) => {
    for (const waiter of pending.capacityWaiters) {
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(error);
    }
    pending.capacityWaiters.clear();
  }, []);
  const invalidatePendingCommands = useCallback((pending: PendingStreamingCommands, error: Error) => {
    pending.drainAbortController?.abort(error);
    pending.drainAbortController = null;
    rejectPendingCapacityWaiters(pending, error);
    pending.rejectFinalization?.(error);
    pending.resolveFinalization = undefined;
    pending.rejectFinalization = undefined;
  }, [rejectPendingCapacityWaiters]);
  useEffect(() => {
    sessionDisposedRef.current = false;
    return () => {
      sessionDisposedRef.current = true;
      const pending = pendingCommandsRef.current;
      if (!pending) return;
      pendingCommandsRef.current = null;
      invalidatePendingCommands(pending, new StreamSessionError("disposed", "The source session was unmounted"));
    };
  }, [invalidatePendingCommands]);
  const resetPendingSourceSession = useCallback(() => {
    const pending = pendingCommandsRef.current;
    if (!pending) return;
    pendingCommandsRef.current = null;
    invalidatePendingCommands(pending, new StreamSessionError("stale-generation", "Source commands belong to an ended generation"));
  }, [invalidatePendingCommands]);
  const { streamStatus, setStreamStatus, activeIteratorRef } = useStreamInputSession({
    renderer, text, stream, workerReady, inputReady, inputReadyRef, initializationEpoch, initializationError, session, managedWorker,
    readyRendererRef, onSourceSessionReset: resetPendingSourceSession,
    imperativeActivityRef, onErrorRef, debug: DEBUG_WORKER,
  });
  const flushPendingCommandsRef = useRef<(() => void) | null>(null);
  const flushPendingCommands = useCallback(() => {
    const pending = pendingCommandsRef.current;
    if (!pending || pending.owner !== rendererKey || !workerReadyRef.current || pending.drainAbortController) return;
    try {
      while (pending.nextIndex < pending.commands.length) {
        const command = pending.commands[pending.nextIndex];
        if (command.type === "append") {
          const result = renderer.append(command.text);
          pending.pendingSourceUnits -= command.text.length;
          pending.acceptedSourceUnits = result.acceptedSourceUnits;
          imperativeActivityRef.current = true;
        } else {
          void renderer.finalize().then(
            (result) => {
              pending.resolveFinalization?.(result);
              pending.resolveFinalization = undefined;
              pending.rejectFinalization = undefined;
            },
            (error: unknown) => {
              pending.rejectFinalization?.(error instanceof Error ? error : new Error(String(error)));
              pending.resolveFinalization = undefined;
              pending.rejectFinalization = undefined;
            },
          );
          imperativeActivityRef.current = false;
        }
        pending.nextIndex += 1;
      }
      if (pending.sealed) {
        rejectPendingCapacityWaiters(pending, new StreamSessionError("sealed", "The source session is sealed"));
      } else {
        if (pendingCommandsRef.current === pending) pendingCommandsRef.current = null;
        for (const waiter of pending.capacityWaiters) {
          if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
          void renderer.waitForCapacity(waiter.options).then(waiter.resolve, waiter.reject);
        }
        pending.capacityWaiters.clear();
      }
    } catch (error) {
      if (error instanceof SourceCapacityError && error.retryable) {
        const command = pending.commands[pending.nextIndex];
        if (command?.type === "append") {
          const controller = new AbortController();
          pending.drainAbortController = controller;
          void renderer.waitForCapacity({ units: command.text.length, signal: controller.signal }).then(() => {
            if (pending.drainAbortController === controller) pending.drainAbortController = null;
            if (pendingCommandsRef.current === pending) flushPendingCommandsRef.current?.();
          }).catch((waitError: unknown) => {
            if (pending.drainAbortController === controller) pending.drainAbortController = null;
            if (pendingCommandsRef.current !== pending) return;
            pendingCommandsRef.current = null;
            const failure = waitError instanceof Error ? waitError : new Error(String(waitError));
            invalidatePendingCommands(pending, failure);
            onErrorRef.current?.(failure);
          });
          return;
        }
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      const sealed = pending.sealed;
      if (pendingCommandsRef.current === pending) pendingCommandsRef.current = null;
      invalidatePendingCommands(pending, failure);
      if (!sealed) throw error;
    }
  }, [renderer, rendererKey, workerReadyRef, rejectPendingCapacityWaiters, invalidatePendingCommands, onErrorRef]);
  flushPendingCommandsRef.current = flushPendingCommands;
  const queuePendingAppend = useCallback((text: string): AppendResult => {
    const owner = `${configSignature}:${sessionRef.current}`;
    let pending = pendingCommandsRef.current;
    if (pending && pending.owner !== owner) {
      invalidatePendingCommands(pending, new StreamSessionError("stale-generation", "Source append belongs to an ended generation"));
      pending = null;
    }
    if (!pending) {
      pending = {
        owner,
        commands: [],
        nextIndex: 0,
        sealed: false,
        acceptedSourceUnits: 0,
        pendingSourceUnits: 0,
        capacityWaiters: new Set(),
        finalizationPromise: null,
        drainAbortController: null,
      };
      pendingCommandsRef.current = pending;
    }
    if (pending.sealed) throw new StreamSessionError("sealed", "Cannot append after FINALIZE; start a new generation first");
    const pendingSourceUnits = pending.pendingSourceUnits;
    if (text.length > SOURCE_ADMISSION_HARD_LIMIT - pendingSourceUnits) {
      throw new SourceCapacityError(text.length, pendingSourceUnits, SOURCE_ADMISSION_HARD_LIMIT);
    }
    pending.commands.push({ type: "append", text });
    pending.acceptedSourceUnits += text.length;
    pending.pendingSourceUnits += text.length;
    return {
      acceptedSourceUnits: pending.acceptedSourceUnits,
      pendingSourceUnits: pending.pendingSourceUnits,
      shouldPause: pending.pendingSourceUnits >= SOURCE_ADMISSION_SOFT_LIMIT,
    };
  }, [configSignature, sessionRef, invalidatePendingCommands]);
  const queuePendingFinalize = useCallback((): Promise<FinalizeResult> => {
    const owner = `${configSignature}:${sessionRef.current}`;
    let pending = pendingCommandsRef.current;
    if (pending && pending.owner !== owner) {
      invalidatePendingCommands(pending, new StreamSessionError("stale-generation", "Finalization belongs to an ended generation"));
      pending = null;
    }
    if (!pending) {
      pending = {
        owner,
        commands: [],
        nextIndex: 0,
        sealed: false,
        acceptedSourceUnits: 0,
        pendingSourceUnits: 0,
        capacityWaiters: new Set(),
        finalizationPromise: null,
        drainAbortController: null,
      };
      pendingCommandsRef.current = pending;
    }
    if (pending.finalizationPromise) return pending.finalizationPromise;
    pending.sealed = true;
    rejectPendingCapacityWaiters(pending, new StreamSessionError("sealed", "The source session is sealed"));
    const finalizationState = pending;
    const promise = new Promise<FinalizeResult>((resolve, reject) => {
      finalizationState.resolveFinalization = resolve;
      finalizationState.rejectFinalization = reject;
    });
    finalizationState.finalizationPromise = promise;
    finalizationState.commands.push({ type: "finalize" });
    return promise;
  }, [configSignature, sessionRef, invalidatePendingCommands, rejectPendingCapacityWaiters]);
  const waitForCapacity = useCallback((options: WaitForCapacityOptions): Promise<void> => {
    const currentRendererKey = `${configSignature}:${sessionRef.current}`;
    if (initializationError) {
      return Promise.reject(new StreamSessionError("disposed", initializationError.message));
    }
    const pending = pendingCommandsRef.current;
    if (pending && pending.owner !== currentRendererKey) {
      pendingCommandsRef.current = null;
      invalidatePendingCommands(pending, new StreamSessionError("stale-generation", "Source capacity wait belongs to an ended generation"));
    }
    const currentPending = pendingCommandsRef.current;
    if (!currentPending || currentPending.owner !== currentRendererKey) {
      try {
        if (workerReadyRef.current) flushPendingCommands();
        return renderer.waitForCapacity(options);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (currentPending.sealed) return Promise.reject(new StreamSessionError("sealed", "The source session is sealed"));
    const { units, signal } = options;
    if (!Number.isSafeInteger(units) || units < 0) return Promise.reject(new RangeError("Capacity units must be a nonnegative safe integer"));
    if (units > SOURCE_ADMISSION_HARD_LIMIT) {
      return Promise.reject(new SourceCapacityError(units, currentPending.pendingSourceUnits, SOURCE_ADMISSION_HARD_LIMIT));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Capacity wait aborted"));
    }
    if (
      currentPending.pendingSourceUnits < SOURCE_ADMISSION_SOFT_LIMIT &&
      currentPending.pendingSourceUnits + units <= SOURCE_ADMISSION_HARD_LIMIT
    ) {
      return Promise.resolve();
    }
    if (workerReadyRef.current) {
      try {
        flushPendingCommands();
        return renderer.waitForCapacity(options);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: PendingCapacityWaiter = { resolve, reject, options, signal };
      if (signal) {
        const abort = () => {
          currentPending.capacityWaiters.delete(waiter);
          signal.removeEventListener("abort", abort);
          const reason = signal.reason;
          const error = reason instanceof Error ? reason : new Error("Capacity wait aborted");
          if (error.name === "Error") error.name = "AbortError";
          reject(error);
        };
        waiter.abort = abort;
        signal.addEventListener("abort", abort, { once: true });
      }
      currentPending.capacityWaiters.add(waiter);
    });
  }, [renderer, configSignature, sessionRef, workerReadyRef, flushPendingCommands, initializationError, invalidatePendingCommands]);
  useEffect(() => {
    const pending = pendingCommandsRef.current;
    if (pending && pending.owner !== rendererKey) {
      pendingCommandsRef.current = null;
      invalidatePendingCommands(pending, new StreamSessionError("stale-generation", "Source append belongs to an ended generation"));
    }
    if (initializationError) {
      const failed = pendingCommandsRef.current;
      pendingCommandsRef.current = null;
      if (failed) invalidatePendingCommands(failed, new StreamSessionError("disposed", initializationError.message));
      return;
    }
    try {
      flushPendingCommands();
    } catch (error) {
      onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
    }
  }, [rendererKey, workerReady, initializationError, flushPendingCommands, onErrorRef, invalidatePendingCommands]);
  useImperativeHandle(
    ref,
    () => {
      const handleToken = {};
      sessionHandleTokenRef.current = handleToken;
      const assertSessionActive = (): void => {
        if (sessionDisposedRef.current) {
          throw new StreamSessionError("disposed", "The source session was unmounted");
        }
        if (sessionHandleTokenRef.current !== handleToken) {
          throw new StreamSessionError("stale-generation", "The source session belongs to an ended generation");
        }
      };
      return {
      pause() {
        assertSessionActive();
        renderer.pause();
      },
      resume() {
        assertSessionActive();
        renderer.resume();
      },
      restart() {
        assertSessionActive();
        workerReadyRef.current = false;
        inputReadyRef.current = false;
        const pending = pendingCommandsRef.current;
        if (pending) {
          pendingCommandsRef.current = null;
          invalidatePendingCommands(pending, new StreamSessionError("stale-generation", "Source append belongs to an ended generation"));
        }
        imperativeActivityRef.current = false;
        activeIteratorRef.current = null;
        renderer.restart({ reinitializeWorker: false });
        setStreamStatus("idle");
        sessionRef.current += 1;
        setSession(sessionRef.current);
      },
      finalize(): Promise<FinalizeResult> {
        try {
          assertSessionActive();
        } catch (error) {
          return Promise.reject(error);
        }
        const promise = queuePendingFinalize();
        if (workerReadyRef.current) flushPendingCommands();
        imperativeActivityRef.current = false;
        setStreamStatus(activeIteratorRef.current === null ? "done" : "streaming");
        return promise;
      },
      append(text: string) {
        assertSessionActive();
        const pending = pendingCommandsRef.current;
        const result = workerReadyRef.current && pending === null
          ? renderer.append(text)
          : queuePendingAppend(text);
        if (workerReadyRef.current && pending !== null) flushPendingCommands();
        if (text.length > 0) {
          imperativeActivityRef.current = true;
          setStreamStatus("streaming");
        }
        return result;
      },
      waitForCapacity(options: WaitForCapacityOptions) {
        try {
          assertSessionActive();
        } catch (error) {
          return Promise.reject(error);
        }
        return waitForCapacity(options);
      },
      setCredits(value: number) {
        assertSessionActive();
        renderer.setCredits(value);
      },
      flushPending() {
        assertSessionActive();
        return renderer.flushPendingPatches();
      },
      waitForIdle() {
        try {
          assertSessionActive();
        } catch (error) {
          return Promise.reject(error);
        }
        return renderer.waitForPatchQueueIdle();
      },
      onFlush(listener: (result: PatchFlushResult) => void) {
        assertSessionActive();
        return renderer.addFlushListener(listener);
      },
      getState() {
        assertSessionActive();
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
        assertSessionActive();
        if (limit === undefined || limit >= patchHistoryRef.current.length) {
          return [...patchHistoryRef.current];
        }
        return patchHistoryRef.current.slice(patchHistoryRef.current.length - limit);
      },
      };
    },
    [renderer, rendererKey, store, flushPendingCommands, queuePendingAppend, queuePendingFinalize, waitForCapacity, invalidatePendingCommands, workerReadyRef, inputReadyRef, activeIteratorRef, imperativeActivityRef, setStreamStatus, sessionRef, setSession],
  );

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
      components={components}
      urlTransform={urlTransform}
      controls={controls}
      controlsComponent={controlsComponent}
      animated={animated}
      statusMessage={statusMessage}
      contentComponents={normalizedContentComponents}
      allowedElements={allowedElements}
      disallowedElements={disallowedElements}
      allowElement={allowElement}
      unwrapDisallowed={unwrapDisallowed}
      disableAutolinkProtocols={disableAutolinkProtocols}
      className={resolvedClassName}
      colorScheme={colorScheme}
      style={resolvedStyle}
      store={frameStore}
    />
  );

  return (
    <DocumentMathMacroScopeContext.Provider value={mathMacroScope}>
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
    </DocumentMathMacroScopeContext.Provider>
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
