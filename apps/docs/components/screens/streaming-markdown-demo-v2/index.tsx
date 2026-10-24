"use client";

import type { Block, CodeHighlightingMode, FormatAnticipationConfig, Patch, PerformanceMetrics, WorkerIn } from "@stream-mdx/core";
import type { PatchFlushResult } from "@stream-mdx/react/renderer/patch-commit-scheduler";
import type { RendererStore } from "@stream-mdx/react/renderer/store";
import type {
  AutomationCodeBlockSnapshot,
  DebugEvent,
  FlushBatchSample,
  PatchSummary,
  StatSummary,
  StreamingDemoAutomationApiV2,
  TimingSummary,
} from "./automation-api";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { components as trustedMdxElements } from "@/mdx-components";
import { createDemoComponents } from "@/lib/streaming-demo-registry";
import { DEFAULT_BACKPRESSURE_CONFIG, calculateSmoothedCredit, clampCredit } from "@stream-mdx/core";
import { defineContentComponent, SourceCapacityError, StreamingMarkdown, type AppendResult, type FinalizeResult, type ContentComponentHostProps, type ContentComponentProps, type ContentComponentRegistration, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { MarkdownWorkerClient, type MarkdownWorkerClientOptions } from "@stream-mdx/worker/worker-client";
import type { DefaultWorkerMode } from "@stream-mdx/worker";

import { createElement, Fragment, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

const METRIC_SAMPLE_LIMIT = process.env.NODE_ENV === "production" ? 300 : 1000;
const COALESCING_RECENT_BATCH_COUNT = 8;
const COALESCING_SPARKLINE_POINTS = 24;
const COALESCING_WARN_REDUCTION_PCT = 5;
const COALESCING_WARN_DURATION_MS = 5;
const SHOULD_EXPOSE_AUTOMATION_API = process.env.NEXT_PUBLIC_STREAMING_DEMO_API === "true";
const LIST_DEBUG_ENABLED = process.env.NEXT_PUBLIC_STREAMING_LIST_DEBUG === "true";
const LIST_AUTO_EXPORT_ENABLED = process.env.NEXT_PUBLIC_STREAMING_LIST_AUTO_EXPORT === "true";
const AUTOMATION_DOC_LINK = "docs/STREAMING_MARKDOWN_V2_STATUS.md#54-automation-api-availability";
const ENABLE_WORKER_HELPER = process.env.NEXT_PUBLIC_STREAMING_WORKER_HELPER === "true";
const WORKER_HELPER_MODE: DefaultWorkerMode = process.env.NEXT_PUBLIC_STREAMING_WORKER_HELPER_MODE === "blob" ? "blob" : "auto";
const MAX_SOURCE_OFFER_UNITS = 65_536;
const FINALIZE_TIMEOUT_MS = 30_000;

const demoContentComponents: Record<string, ContentComponentRegistration> = {};
for (const [name, component] of Object.entries(trustedMdxElements)) {
  const first = name.charAt(0);
  if (first.toUpperCase() !== first || first.toLowerCase() === first) continue;
  if (typeof component !== "function") continue;

  demoContentComponents[name] = defineContentComponent({
    component: (props: ContentComponentProps & ContentComponentHostProps) => createElement(component, props),
  });
}
const DEMO_CONTENT_DESCRIPTORS = Object.entries(demoContentComponents).map(([name, registration]) => ({
  name,
  renderWhen: registration.renderWhen,
}));

type FormatAnticipationOptions = Exclude<FormatAnticipationConfig, boolean>;
type DocPluginConfig = NonNullable<Extract<WorkerIn, { type: "INIT" }>["docPlugins"]>;
type ListDebugStoreList = {
  id: string;
  depth: number | null;
  ordered: boolean;
  itemIds: string[];
  itemCount: number;
  childTypes: string[];
};

type ListDebugMismatch = {
  listId: string;
  domCount: number;
  storeCount: number;
};

type ListDebugEvent = {
  t: number;
  sinceStartMs: number;
  idx: number;
  total: number;
  queueDepth: number | null;
  lists: Array<{
    listId: string | null;
    depth: number | null;
    ordered: boolean;
    itemCount: number;
    totalItemCount: number;
    itemIds: string[];
    firstItemText: string | null;
  }>;
  storeLists: ListDebugStoreList[] | null;
  listMismatches: ListDebugMismatch[] | null;
};


function escapeHtmlForAutomation(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttributeForAutomation(value: string): string {
  return value.replace(/"/g, "&quot;");
}

function attrsToStringForAutomation(attrs?: Record<string, string>): string {
  if (!attrs) return "";
  return Object.entries(attrs)
    .map(([key, val]) => ` ${key}="${escapeAttributeForAutomation(val)}"`)
    .join("");
}

function composeAutomationHighlightedHtml(
  lines: ReadonlyArray<{ index: number; text: string; html?: string | null }>,
  preAttrs?: Record<string, string>,
  codeAttrs?: Record<string, string>,
): string {
  const lineMarkup = lines
    .map((line) => {
      const content = line.html ?? escapeHtmlForAutomation(line.text);
      const dataLine = Number.isFinite(line.index) ? ` data-line="${line.index + 1}"` : "";
      return `<span class="line"${dataLine}>${content}</span>`;
    })
    .join("\n");
  const preAttr = attrsToStringForAutomation(preAttrs);
  const codeAttr = attrsToStringForAutomation(codeAttrs);
  return `<pre${preAttr}><code${codeAttr}>${lineMarkup}\n</code></pre>`;
}

function collectCodeBlockLines(store: RendererStore, blockId: string) {
  const childIds = store.getChildren(blockId);
  const seenIndices = new Set<number>();
  const lines: Array<{ index: number; text: string; html?: string | null }> = [];

  for (const childId of childIds) {
    const child = store.getNode(childId);
    if (!child || child.type !== "code-line") continue;
    const index = typeof child.props?.index === "number" ? Number(child.props?.index) : lines.length;
    if (seenIndices.has(index)) continue;
    seenIndices.add(index);
    const text = typeof child.props?.text === "string" ? String(child.props?.text) : "";
    const html = typeof child.props?.html === "string" ? String(child.props?.html) : null;
    lines.push({ index, text, html });
  }

  lines.sort((a, b) => a.index - b.index);
  return lines;
}

function findCodeBlockIds(store: RendererStore) {
  const blocks = store.getBlocks();
  return blocks.filter((block) => block.type === "code").map((block) => block.id);
}

function computeStats(values: readonly number[]): StatSummary | null {
  if (!values || values.length === 0) {
    return null;
  }
  const count = values.length;
  const total = values.reduce((sum, value) => sum + value, 0);
  const sorted = [...values].sort((a, b) => a - b);
  const maxMs = sorted[sorted.length - 1] ?? 0;
  const percentile = (p: number) => {
    if (sorted.length === 0) return 0;
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[rank] ?? 0;
  };
  const p50Ms = percentile(50);
  const p95Index = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95) - 1));
  const p95Ms = sorted[p95Index] ?? maxMs;
  const p99Ms = percentile(99);
  const avgMs = total / count;
  const latestMs = values[values.length - 1] ?? maxMs;
  return {
    count,
    avgMs,
    p50Ms,
    p95Ms,
    p99Ms,
    maxMs,
    latestMs,
  };
}

function formatMs(value: number | null | undefined, fraction = 1): string {
  if (!Number.isFinite(value ?? Number.NaN)) return "—";
  return `${Number(value).toFixed(fraction)} ms`;
}

function formatCount(value: number | null | undefined, fraction = 2): string {
  if (!Number.isFinite(value ?? Number.NaN)) return "—";
  return Number(value).toFixed(fraction);
}

function formatPercent(value: number | null | undefined, fraction = 1): string {
  if (!Number.isFinite(value ?? Number.NaN)) return "—";
  return `${Number(value).toFixed(fraction)}%`;
}

type SparklineDirection = "above" | "below";
type SparklinePoint = { key: string; value: number };

type CoalescingSparklineProps = {
  label: string;
  values: SparklinePoint[];
  maxValue: number;
  warnThreshold?: number;
  warnDirection?: SparklineDirection;
  unit?: string;
};

function CoalescingSparkline({ label, values, maxValue, warnThreshold, warnDirection = "below", unit = "" }: CoalescingSparklineProps): JSX.Element {
  const safeMax = Math.max(1, maxValue);
  const lastValue = values.length > 0 ? (values[values.length - 1]?.value ?? null) : null;
  const decimals = unit === "%" ? 1 : 2;
  const warnActive =
    lastValue !== null && warnThreshold !== undefined ? (warnDirection === "above" ? lastValue > warnThreshold : lastValue < warnThreshold) : false;
  const formattedValue = lastValue !== null ? `${lastValue.toFixed(decimals)}${unit}` : "—";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-muted text-xs">
        <span>{label}</span>
        <span className={cn("font-mono", warnActive && "text-destructive")}>{formattedValue}</span>
      </div>
      {values.length === 0 ? (
        <div className="flex h-8 items-center justify-center rounded border border-border/40 border-dashed text-[11px] text-muted">No samples yet</div>
      ) : (
        <div className="flex h-8 items-end gap-0.5 rounded bg-muted/30 p-1">
          {values.map(({ value, key }, idx) => {
            const ratio = Math.min(1, Math.max(0, value / safeMax));
            const warn = warnThreshold !== undefined ? (warnDirection === "above" ? value > warnThreshold : value < warnThreshold) : false;
            return (
              <div
                key={`${key}-${idx}`}
                className={cn("flex-1 rounded-sm bg-primary/70", warn && "bg-destructive/70")}
                style={{ height: `${Math.max(5, ratio * 100)}%` }}
                title={`${label} sample: ${value.toFixed(decimals)}${unit}`}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatBytes(value: number | null | undefined): string {
  if (!Number.isFinite(value ?? Number.NaN)) return "—";
  const bytes = Number(value);
  if (bytes < 1024) {
    return `${bytes.toFixed(0)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatStatSummary(stat: StatSummary | null, unit: "ms" | "count" = "ms"): string {
  if (!stat || stat.count === 0) {
    return "—";
  }
  const digits = unit === "ms" ? 1 : 2;
  const suffix = unit === "ms" ? " ms" : "";
  const fmt = (value: number) => `${value.toFixed(digits)}${suffix}`;
  return `avg ${fmt(stat.avgMs)} · p50 ${fmt(stat.p50Ms)} · p95 ${fmt(stat.p95Ms)} · p99 ${fmt(stat.p99Ms)} · max ${fmt(stat.maxMs)} · last ${fmt(stat.latestMs)} · n=${stat.count}`;
}

function createEmptyTimingSummary(): TimingSummary {
  return {
    patchApply: null,
    longTasks: null,
    recvToFlush: null,
    flushApply: null,
    reactCommit: null,
    paint: null,
    queueDepth: null,
  };
}

function isListDebugEnabled(): boolean {
  if (typeof window !== "undefined") {
    const flag = (window as { __STREAMING_LIST_DEBUG__?: boolean }).__STREAMING_LIST_DEBUG__;
    if (flag === true) return true;
  }
  return LIST_DEBUG_ENABLED;
}

function isListAutoExportEnabled(): boolean {
  if (typeof window !== "undefined") {
    const flag = (window as { __STREAMING_LIST_AUTO_EXPORT__?: boolean }).__STREAMING_LIST_AUTO_EXPORT__;
    if (flag === true) return true;
  }
  return LIST_AUTO_EXPORT_ENABLED;
}

function collectStoreListSnapshots(store: RendererStore): ListDebugStoreList[] {
  const blocks = store.getBlocks();
  const listBlocks = blocks.filter((block) => block.type === "list");
  const seen = new Set<string>();
  const results: ListDebugStoreList[] = [];

  const visitList = (listId: string) => {
    if (seen.has(listId)) return;
    seen.add(listId);
    const node = store.getNode(listId);
    if (!node) return;
    const childIds = store.getChildren(listId);
    const childTypes = childIds.map((childId) => store.getNode(childId)?.type ?? "missing");
    const itemIds = childIds.filter((childId) => store.getNode(childId)?.type === "list-item");
    const ordered = Boolean(node.props?.ordered ?? node.block?.payload.meta?.ordered);
    const depth = typeof node.props?.depth === "number" ? Number(node.props?.depth) : null;
    results.push({ id: listId, depth, ordered, itemIds, itemCount: itemIds.length, childTypes });

    for (const itemId of itemIds) {
      const itemChildren = store.getChildren(itemId);
      for (const childId of itemChildren) {
        const child = store.getNode(childId);
        if (child?.type === "list") {
          visitList(childId);
        }
      }
    }
  };

  for (const block of listBlocks) {
    visitList(block.id);
  }

  return results;
}

// moved to streaming-demo-registry helper

const SCHEDULING_PRESETS = {
  latency: {
    batch: "rAF",
    frameBudgetMs: 6,
    maxBatchesPerFlush: 4,
    lowPriorityFrameBudgetMs: 3,
    maxLowPriorityBatchesPerFlush: 1,
    urgentQueueThreshold: 2,
  },
  throughput: {
    batch: "microtask",
    frameBudgetMs: 10,
    maxBatchesPerFlush: 12,
    lowPriorityFrameBudgetMs: 6,
    maxLowPriorityBatchesPerFlush: 2,
    urgentQueueThreshold: 4,
  },
} as const;

type SchedulingPreset = keyof typeof SCHEDULING_PRESETS;

type SourceSessionStatus = {
  isFinalizing: boolean;
  isHostComplete: boolean;
  streamError: string | null;
};

export function StreamingMarkdownDemoV2({
  fullText,
  className = "",
  initialStreamLimit = null,
  initialIsRunning = true,
}: {
  fullText: string;
  className?: string;
  initialStreamLimit?: number | null;
  initialIsRunning?: boolean;
}) {
  const PREWARM_LANGS = useMemo(() => ["typescript", "tsx", "javascript", "json", "python", "bash", "html", "css", "sql", "yaml", "markdown"], []);
  const [schedulingPreset, setSchedulingPreset] = useState<SchedulingPreset>("throughput");
  const rendererScheduling = useMemo(
    () => SCHEDULING_PRESETS[schedulingPreset],
    [schedulingPreset],
  );
  const [idx, setIdx] = useState<number>(0);
  const [rate, setRate] = useState<number>(500); // characters per second
  const [tickMs, setTickMs] = useState<number>(50); // update cadence in ms
  const [isRunning, setIsRunning] = useState<boolean>(initialIsRunning);
  const [runToken, bumpRunToken] = useState<number>(0);
  const [isPending, startTransition] = useTransition();
  const [showRendering, setShowRendering] = useState<boolean>(false);
  const renderTimerRef = useRef<NodeJS.Timeout | null>(null);
  const renderStartRef = useRef<number | null>(null);
  const [renderTimes, setRenderTimes] = useState<{ ms: number; idx: number; total: number }[]>([]);
  const [logWindow, setLogWindow] = useState<number>(50);
  const [noCap, setNoCap] = useState<boolean>(false);
  const [prewarm, setPrewarm] = useState<boolean>(true);
  const [debugTiming, setDebugTiming] = useState<boolean>(false);
  const [metricsTab, setMetricsTab] = useState<"coalescing" | "timing">("coalescing");
  const [showInspector, setShowInspector] = useState<boolean>(false);
  const [showCodeMeta, setShowCodeMeta] = useState<boolean>(false);
  const demoComponents = useMemo(() => createDemoComponents(showCodeMeta), [showCodeMeta]);
  const [formatAnticipationEnabled, setFormatAnticipationEnabled] = useState<boolean>(true);
  const [formatAnticipationConfig, setFormatAnticipationConfig] = useState<FormatAnticipationOptions>({
    inline: true,
    mathInline: true,
    mathBlock: true,
    html: true,
    mdx: true,
    regex: false,
  });
  const [htmlEnabled, setHtmlEnabled] = useState<boolean>(true);
  const [mdxEnabled, setMdxEnabled] = useState<boolean>(true);
  const [mathEnabled, setMathEnabled] = useState<boolean>(true);
  const [codeHighlightingMode, setCodeHighlightingMode] = useState<CodeHighlightingMode>("incremental");
  const liveCodeHighlightingEnabled = codeHighlightingMode === "live";
  const debugTimingRef = useRef(debugTiming);
  const showInspectorRef = useRef(showInspector);
  const modeRef = useRef<"classic" | "worker">("worker");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const listDebugEventsRef = useRef<ListDebugEvent[]>([]);
  const listDebugStartRef = useRef<number | null>(null);
  const listMismatchCountRef = useRef(0);
  const listAutoExportedRef = useRef(false);
  const schedulingPresetRef = useRef<SchedulingPreset>(schedulingPreset);

  useEffect(() => {
    debugTimingRef.current = debugTiming;
  }, [debugTiming]);

  useEffect(() => {
    showInspectorRef.current = showInspector;
  }, [showInspector]);

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      // eslint-disable-next-line no-console
      console.error("[StreamingMarkdown demo] window error", event.message, event.filename, event.lineno, event.colno);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      // eslint-disable-next-line no-console
      console.error("[StreamingMarkdown demo] unhandled rejection", event.reason);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const workerSentIdxRef = useRef<number>(0);
  const latestIdxRef = useRef(0);
  const fullTextRef = useRef(fullText);
  const automationWarningLoggedRef = useRef(false);
  const sourceGenerationRef = useRef(0);
  const nativeAdmissionGenerationRef = useRef<number | null>(null);
  const nativeFinalizedGenerationRef = useRef<number | null>(null);
  const sourceAdmissionTargetRef = useRef(0);
  const sourceAdmissionTaskRef = useRef<Promise<void> | null>(null);
  const sourceAdmissionTaskGenerationRef = useRef<number | null>(null);
  const sourceAdmissionAbortRef = useRef<AbortController | null>(null);
  const finalizationPromiseRef = useRef<Promise<FinalizeResult> | null>(null);
  useEffect(() => {
    latestIdxRef.current = idx;
  }, [idx]);
  useEffect(() => {
    fullTextRef.current = fullText;
  }, [fullText]);
  const bufferedCharsRef = useRef<number>(0);
  const debugEventsRef = useRef<DebugEvent[]>([]);
  const [lastMetrics, setLastMetrics] = useState<PerformanceMetrics | null>(null);
  const lastMetricsRef = useRef<PerformanceMetrics | null>(null);

  const normalizeInitialStreamLimit = useCallback(
    (value: number | null | undefined, textLength: number) =>
      typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(value, textLength)) : null,
    [],
  );
  const [streamLimit, setStreamLimit] = useState<number | null>(() => normalizeInitialStreamLimit(initialStreamLimit, fullText.length));
  const streamLimitRef = useRef<number | null>(normalizeInitialStreamLimit(initialStreamLimit, fullText.length));
  const updateStreamLimit = useCallback((value: number | null) => {
    const normalized = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(value, fullTextRef.current.length)) : null;
    streamLimitRef.current = normalized;
    setStreamLimit(normalized);
    if (normalized !== null && latestIdxRef.current > normalized) {
      setIdx(normalized);
    }
  }, []);

  useEffect(() => {
    if (streamLimitRef.current !== null && streamLimitRef.current > fullText.length) {
      updateStreamLimit(streamLimitRef.current);
    }
  }, [fullText.length, updateStreamLimit]);

  useEffect(() => {
    const normalized = normalizeInitialStreamLimit(initialStreamLimit, fullText.length);
    if (normalized !== streamLimitRef.current) {
      updateStreamLimit(normalized);
    }
  }, [fullText.length, initialStreamLimit, normalizeInitialStreamLimit, updateStreamLimit]);

  const maxLen = fullText.length;
  const effectiveTotal = streamLimit ?? maxLen;
  const finished = idx >= effectiveTotal;
  const [sourceSessionStatus, setSourceSessionStatus] = useState<SourceSessionStatus>({
    isFinalizing: false,
    isHostComplete: false,
    streamError: null,
  });
  const sourceSessionStatusRef = useRef(sourceSessionStatus);
  const updateSourceSessionStatus = useCallback((status: SourceSessionStatus) => {
    sourceSessionStatusRef.current = status;
    setSourceSessionStatus(status);
  }, []);
  const { isFinalizing, isHostComplete, streamError } = sourceSessionStatus;
  const [sourceAdmissionEpoch, bumpSourceAdmissionEpoch] = useState(0);
  const current = useMemo(() => fullText.slice(0, Math.min(idx, effectiveTotal)), [fullText, idx, effectiveTotal]);
  const exportListDebug = useCallback(() => {
    try {
      const payload = {
        capturedAt: new Date().toISOString(),
        location: typeof window !== "undefined" ? window.location.href : null,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
        listDebugEnabled: isListDebugEnabled(),
        state: {
          idx,
          total: effectiveTotal,
          isRunning,
          rate,
          tickMs,
          schedulingPreset,
          mode: modeRef.current,
        },
        listEvents: listDebugEventsRef.current,
        patchHistory: patchHistoryRef.current,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `streaming-list-debug-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Failed to export list debug log", e);
    }
  }, [idx, effectiveTotal, isRunning, rate, tickMs, schedulingPreset]);
  const handleRendererError = useCallback((error: Error) => {
    console.error("StreamingMarkdown render error", error);
  }, []);


  // V2 Markdown Worker State
  const [blocks, setBlocks] = useState<Block[]>([]);
  const workerRef = useRef<MarkdownWorkerClient | null>(null);
  const streamingRef = useRef<StreamingMarkdownHandle | null>(null);
  const rendererFlushUnsubscribeRef = useRef<(() => void) | null>(null);
  const [streamingHandleEpoch, bumpStreamingHandleEpoch] = useState(0);
  const [rendererWorker, setRendererWorker] = useState<Worker | null>(null);
  const [workerInitEpoch, bumpWorkerInitEpoch] = useState(0);
  const streamingHandleRef = useCallback((handle: StreamingMarkdownHandle | null) => {
    if (streamingRef.current === handle) {
      return;
    }
    streamingRef.current = handle;
    bumpStreamingHandleEpoch((value) => value + 1);
  }, []);
  const workerReadyStateRef = useRef(false);
  const workerCleanupRef = useRef<(() => void) | null>(null);
  const workerInitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingWorkerInitRef = useRef<MarkdownWorkerClient | null>(null);
  const hasPatchPipelineRef = useRef(false);
  const docPluginConfigRef = useRef<DocPluginConfig>({
    footnotes: true,
    html: htmlEnabled,
    mdx: mdxEnabled,
    tables: true,
    callouts: true,
    math: mathEnabled,
    formatAnticipation: formatAnticipationConfig,
    codeHighlighting: "incremental",
    liveCodeHighlighting: false,
  });
  const finalizedOnceRef = useRef(false);
  const restartPendingRef = useRef(false);
  const [rendererVersion, setRendererVersion] = useState(0);
  const lastPatchSummaryRef = useRef<PatchSummary | null>(null);
  // Keep a generous patch history so captures can replay the full stream.
  const PATCH_HISTORY_CAP = 2000;
  const HIGH_QUEUE_THRESHOLD = 3;
  const SOFT_QUEUE_THRESHOLD = 1.5;
  const SOFT_DRAIN_BASE_MS = 6;
  const SOFT_DRAIN_MAX_MS = 24;

  const computeSoftDrainDelayMs = useCallback((queueDepth: number, result: PatchFlushResult): number => {
    const boundedDepth = Math.max(0, queueDepth - 1);
    const depthRange = Math.max(1, HIGH_QUEUE_THRESHOLD - 1);
    const depthRatio = Math.min(1, boundedDepth / depthRange);

    const batches = Array.isArray(result.batches) ? result.batches : [];
    const largestBatch = batches.reduce<number>((max, batch) => {
      const count = Number.isFinite(batch.patchCount) ? batch.patchCount : 0;
      return count > max ? count : max;
    }, 0);
    const totalPatches = Number.isFinite(result.totalPatches) ? Math.max(result.totalPatches, largestBatch) : largestBatch;

    const patchRatio = Math.min(1, totalPatches / 90);
    const batchRatio = Math.min(1, largestBatch / 45);
    const dominantRatio = Math.max(patchRatio, batchRatio);

    const computed = SOFT_DRAIN_BASE_MS + depthRatio * 6 + dominantRatio * 8 + (patchRatio + batchRatio) * 2;
    return Math.round(Math.min(SOFT_DRAIN_MAX_MS, Math.max(SOFT_DRAIN_BASE_MS, computed)));
  }, []);
  const patchHistoryRef = useRef<Array<{ tx: number; patches: Patch[]; timestamp: number }>>([]);
  const patchListenersRef = useRef<Set<() => void>>(new Set());
  const patchTotalsRef = useRef<{
    totalMessages: number;
    totalOps: number;
    byOp: Record<string, number>;
    lastTx: number;
  }>({
    totalMessages: 0,
    totalOps: 0,
    byOp: {},
    lastTx: 0,
  });
  const pendingDrainRef = useRef(false);
  const patchDurationsRef = useRef<number[]>([]);
  const longTaskDurationsRef = useRef<number[]>([]);
  const recvToFlushRef = useRef<number[]>([]);
  const flushApplyRef = useRef<number[]>([]);
  const reactCommitRef = useRef<number[]>([]);
  const paintRef = useRef<number[]>([]);
  const queueDepthRef = useRef<number[]>([]);
  const flushBatchLogRef = useRef<FlushBatchSample[]>([]);
  const schedulerBudgetRef = useRef<{ active: boolean; p95: number | null; sampleCount: number }>({
    active: false,
    p95: null,
    sampleCount: 0,
  });
  const streamTickAtRef = useRef<number | null>(null);
  const coalescingTotalsRef = useRef<{
    input: number;
    output: number;
    coalesced: number;
    setProps: number;
    insertChild: number;
    durationMs: number;
  }>({
    input: 0,
    output: 0,
    coalesced: 0,
    setProps: 0,
    insertChild: 0,
    durationMs: 0,
  });
  const softDrainTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingCommitMeasuresRef = useRef<number[]>([]);
  const streamStartRef = useRef<number | null>(null);
  const firstMeaningfulMsRef = useRef<number | null>(null);
  const completionMsRef = useRef<number | null>(null);
  const workerCreditsRef = useRef<number>(1);
  const [timingSummary, setTimingSummary] = useState<TimingSummary>(() => createEmptyTimingSummary());
  const [coalescingVersion, setCoalescingVersion] = useState(0);

  const timingRows = useMemo(
    () => [
      {
        label: "recv→flush",
        stat: timingSummary.recvToFlush,
        unit: "ms" as const,
      },
      {
        label: "flush apply",
        stat: timingSummary.flushApply,
        unit: "ms" as const,
      },
      {
        label: "React commit",
        stat: timingSummary.reactCommit,
        unit: "ms" as const,
      },
      {
        label: "Paint spacing",
        stat: timingSummary.paint,
        unit: "ms" as const,
      },
      {
        label: "Patch scheduler",
        stat: timingSummary.patchApply,
        unit: "ms" as const,
      },
      {
        label: "Long tasks",
        stat: timingSummary.longTasks,
        unit: "ms" as const,
      },
      {
        label: "Queue depth",
        stat: timingSummary.queueDepth,
        unit: "count" as const,
      },
    ],
    [timingSummary],
  );

  const workerMetricsSummary = useMemo(() => {
    if (!lastMetrics) return null;
    const parseMs = lastMetrics.parseMs ?? lastMetrics.parseTime ?? null;
    return [
      {
        label: "tx",
        value: lastMetrics.tx !== undefined ? String(lastMetrics.tx) : "—",
      },
      { label: "parse", value: formatMs(parseMs) },
      { label: "enrich", value: formatMs(lastMetrics.enrichMs) },
      { label: "diff", value: formatMs(lastMetrics.diffMs) },
      { label: "serialize", value: formatMs(lastMetrics.serializeMs) },
      { label: "highlight", value: formatMs(lastMetrics.shikiMs) },
      { label: "mdx detect", value: formatMs(lastMetrics.mdxDetectMs) },
      {
        label: "patch ops",
        value: formatCount(lastMetrics.patchCount ?? null, 0),
      },
      {
        label: "patch bytes",
        value: formatBytes(lastMetrics.patchBytes ?? null),
      },
      {
        label: "worker queue",
        value: formatCount(lastMetrics.queueDepth ?? null, 1),
      },
      {
        label: "blocks",
        value: formatCount(lastMetrics.blocksProduced ?? null, 0),
      },
      { label: "grammar", value: lastMetrics.grammarEngine ?? "—" },
    ];
  }, [lastMetrics]);

  const coalescingPanel = useMemo(() => {
    const versionKey = coalescingVersion;
    const totals = { ...coalescingTotalsRef.current };
    const input = totals.input;
    const reductionPct = input > 0 ? (totals.coalesced / input) * 100 : null;
    const appliedPct = input > 0 ? (totals.output / input) * 100 : null;
    const batches = flushBatchLogRef.current;
    const sparklineWindow = batches.slice(-COALESCING_SPARKLINE_POINTS);
    const buildPointKey = (sample: FlushBatchSample, idx: number) =>
      `${sample.tx ?? "none"}-${sample.appliedAt ?? sample.receivedAt ?? idx}-${sample.priority}-${idx}`;
    const reductionSeries = sparklineWindow.map((sample, idx) => {
      const metrics = sample.coalescing;
      const value = metrics?.inputPatchCount ? (metrics.coalescedCount / metrics.inputPatchCount) * 100 : metrics?.coalescedCount ? 0 : 0;
      return {
        key: `${buildPointKey(sample, idx)}-reduction`,
        value: Number.isFinite(value) ? value : 0,
      };
    });
    const durationSeries = sparklineWindow.map((sample, idx) => {
      const duration = sample.coalescing?.durationMs;
      const value = typeof duration === "number" && Number.isFinite(duration) ? duration : 0;
      return {
        key: `${buildPointKey(sample, idx)}-duration`,
        value,
      };
    });
    const durationMax =
      durationSeries.length > 0
        ? Math.max(...durationSeries.map((entry) => entry.value), COALESCING_WARN_DURATION_MS * 2, 1)
        : Math.max(COALESCING_WARN_DURATION_MS * 2, 1);
    const recent = batches
      .slice(-COALESCING_RECENT_BATCH_COUNT)
      .reverse()
      .map((sample) => {
        const metrics = sample.coalescing;
        const recentReduction = metrics?.inputPatchCount ? (metrics.coalescedCount / metrics.inputPatchCount) * 100 : metrics?.coalescedCount ? 0 : null;
        const duration = metrics?.durationMs ?? null;
        return {
          tx: sample.tx ?? null,
          priority: sample.priority,
          reductionPct: typeof recentReduction === "number" && Number.isFinite(recentReduction) ? recentReduction : null,
          durationMs: typeof duration === "number" && Number.isFinite(duration) ? duration : null,
          input: metrics?.inputPatchCount ?? null,
          output: metrics?.outputPatchCount ?? null,
          coalesced: metrics?.coalescedCount ?? null,
        };
      });
    return {
      version: versionKey,
      totals,
      reductionPct,
      appliedPct,
      sparkline: {
        reduction: reductionSeries,
        duration: durationSeries,
        durationMax,
      },
      recent,
      adaptiveState: schedulerBudgetRef.current,
    };
  }, [coalescingVersion]);

  const resetCoalescingStats = useCallback(() => {
    coalescingTotalsRef.current = {
      input: 0,
      output: 0,
      coalesced: 0,
      setProps: 0,
      insertChild: 0,
      durationMs: 0,
    };
    flushBatchLogRef.current = [];
    setCoalescingVersion((value) => value + 1);
  }, []);

  const handleResetCoalescing = useCallback(() => {
    resetCoalescingStats();
  }, [resetCoalescingStats]);

  const recordSample = useCallback((buffer: number[], value: number) => {
    if (!Number.isFinite(value)) {
      return;
    }
    buffer.push(value);
    if (buffer.length > METRIC_SAMPLE_LIMIT) {
      buffer.splice(0, buffer.length - METRIC_SAMPLE_LIMIT);
    }
  }, []);

  const recomputeTimingSummary = useCallback(() => {
    setTimingSummary({
      patchApply: computeStats(patchDurationsRef.current),
      longTasks: computeStats(longTaskDurationsRef.current),
      recvToFlush: computeStats(recvToFlushRef.current),
      flushApply: computeStats(flushApplyRef.current),
      reactCommit: computeStats(reactCommitRef.current),
      paint: computeStats(paintRef.current),
      queueDepth: computeStats(queueDepthRef.current),
    });
  }, []);

  const uiSyncScheduledRef = useRef(false);
  const scheduleUiSync = useCallback(() => {
    if (uiSyncScheduledRef.current) {
      return;
    }
    uiSyncScheduledRef.current = true;

    const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 16);

    schedule(() => {
      uiSyncScheduledRef.current = false;
      const handle = streamingRef.current;
      const store = handle?.getState?.().store;
      if (!store) {
        return;
      }
      const nextBlocks = showInspectorRef.current ? [...store.getBlocks()] : null;
      const nextVersion = store.getVersion();
      const commitStart = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
      pendingCommitMeasuresRef.current.push(commitStart);
      if (nextBlocks) {
        setBlocks(nextBlocks);
      }
      setRendererVersion(nextVersion);
      setCoalescingVersion((value) => value + 1);
    });
  }, []);

  const updateWorkerCredits = useCallback((credits: number) => {
    const clamped = clampCredit(credits);
    if (Math.abs(workerCreditsRef.current - clamped) < 0.01) {
      return;
    }
    workerCreditsRef.current = clamped;
    workerRef.current?.setCredits?.(clamped);
    streamingRef.current?.setCredits(clamped);
  }, []);

  const reportStreamError = useCallback((error: unknown, generation: number) => {
    if (generation !== sourceGenerationRef.current) return;
    const message = error instanceof Error ? error.message : String(error);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRunning(false);
    updateSourceSessionStatus({ isFinalizing: false, isHostComplete: false, streamError: message });
    console.error("[StreamingMarkdown demo] source session failed", error);
  }, [updateSourceSessionStatus]);

  const requestSourceAdmission = useCallback((requestedTarget: number): Promise<void> => {
    const target = Math.min(Math.max(0, requestedTarget), fullTextRef.current.length);
    sourceAdmissionTargetRef.current = Math.max(sourceAdmissionTargetRef.current, target);
    const currentTask = sourceAdmissionTaskRef.current;
    if (currentTask) {
      if (sourceAdmissionTaskGenerationRef.current === sourceGenerationRef.current) return currentTask;
      return currentTask.then(
        () => requestSourceAdmission(target),
        () => requestSourceAdmission(target),
      );
    }

    const handle = streamingRef.current;
    if (!handle) return Promise.reject(new Error("StreamingMarkdown handle is unavailable for source admission."));
    const generation = sourceGenerationRef.current;
    let controller = sourceAdmissionAbortRef.current;
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      sourceAdmissionAbortRef.current = controller;
    }
    const signal = controller.signal;
    const task = (async () => {
      while (workerSentIdxRef.current < sourceAdmissionTargetRef.current) {
        if (generation !== sourceGenerationRef.current) throw new Error("Source admission generation changed.");
        if (signal.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error("Source admission cancelled.");
        }
        const start = workerSentIdxRef.current;
        const end = Math.min(sourceAdmissionTargetRef.current, start + MAX_SOURCE_OFFER_UNITS);
        const sourcePart = fullTextRef.current.slice(start, end);
        if (sourcePart.length !== end - start) {
          throw new Error("Source text changed before host admission reached its requested frontier.");
        }

        let admission: AppendResult;
        for (;;) {
          try {
            admission = handle.append(sourcePart);
            break;
          } catch (error) {
            if (!(error instanceof SourceCapacityError) || !error.retryable) throw error;
            await handle.waitForCapacity({ units: sourcePart.length, signal });
            if (generation !== sourceGenerationRef.current) throw new Error("Source admission generation changed while waiting for capacity.");
          }
        }
        if (admission.acceptedSourceUnits !== end) {
          throw new Error(`Host admitted ${admission.acceptedSourceUnits} source units; expected ${end}.`);
        }
        workerSentIdxRef.current = end;
        bumpSourceAdmissionEpoch((value) => value + 1);
        debugEventsRef.current.push({
          at: Date.now(),
          type: "APPEND",
          start,
          end,
          appendedLen: sourcePart.length,
          totalBlocks: blocks.length,
        });
        if (debugEventsRef.current.length > 500) {
          debugEventsRef.current.splice(0, debugEventsRef.current.length - 500);
        }

        const remainingSourceUnits = sourceAdmissionTargetRef.current - end;
        if (admission.shouldPause && remainingSourceUnits > 0) {
          await handle.waitForCapacity({
            units: Math.min(MAX_SOURCE_OFFER_UNITS, remainingSourceUnits),
            signal,
          });
        }
      }
    })();
    sourceAdmissionTaskRef.current = task;
    sourceAdmissionTaskGenerationRef.current = generation;
    void task.then(
      () => {
        if (sourceAdmissionTaskRef.current !== task) return;
        sourceAdmissionTaskRef.current = null;
        sourceAdmissionTaskGenerationRef.current = null;
        if (workerSentIdxRef.current < sourceAdmissionTargetRef.current) {
          void requestSourceAdmission(sourceAdmissionTargetRef.current);
        }
      },
      () => {
        if (sourceAdmissionTaskRef.current !== task) return;
        sourceAdmissionTaskRef.current = null;
        sourceAdmissionTaskGenerationRef.current = null;
        if (generation !== sourceGenerationRef.current && workerSentIdxRef.current < sourceAdmissionTargetRef.current) {
          void requestSourceAdmission(sourceAdmissionTargetRef.current);
        }
      },
    );
    return task;
  }, [blocks.length]);

  const ensureSourceThrough = useCallback(async (target: number): Promise<void> => {
    const generation = sourceGenerationRef.current;
    const acceptedTarget = Math.min(Math.max(0, target), fullTextRef.current.length);
    sourceAdmissionTargetRef.current = Math.max(sourceAdmissionTargetRef.current, acceptedTarget);
    while (workerSentIdxRef.current < acceptedTarget) {
      if (generation !== sourceGenerationRef.current) throw new Error("Source admission was cancelled by a new generation.");
      await requestSourceAdmission(acceptedTarget);
    }
  }, [requestSourceAdmission]);

  const finalizeHostSession = useCallback((): Promise<FinalizeResult> => {
    if (finalizationPromiseRef.current) return finalizationPromiseRef.current;
    const handle = streamingRef.current;
    if (!handle) return Promise.reject(new Error("StreamingMarkdown handle is unavailable for finalization."));

    const generation = sourceGenerationRef.current;
    const target = Math.min(latestIdxRef.current, streamLimitRef.current ?? fullTextRef.current.length);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    bufferedCharsRef.current = 0;
    streamTickAtRef.current = null;
    setIsRunning(false);
    updateSourceSessionStatus({
      isFinalizing: true,
      isHostComplete: false,
      streamError: sourceSessionStatusRef.current.streamError,
    });

    let promise: Promise<FinalizeResult>;
    promise = (async () => {
      let timer: number | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(`Host finalization and renderer idle exceeded ${FINALIZE_TIMEOUT_MS}ms.`)), FINALIZE_TIMEOUT_MS);
      });
      try {
        await ensureSourceThrough(target);
        if (generation !== sourceGenerationRef.current || streamingRef.current !== handle) {
          throw new Error("Finalization was cancelled by a new source generation.");
        }
        const result = await Promise.race([handle.finalize(), timeout]);
        if (generation !== sourceGenerationRef.current || streamingRef.current !== handle) {
          throw new Error("Finalization was cancelled by a new source generation.");
        }
        if (
          result.acceptedSourceUnits !== workerSentIdxRef.current ||
          result.committedSourceUnits !== result.acceptedSourceUnits
        ) {
          throw new Error(
            `Host finalization covered ${result.committedSourceUnits}/${result.acceptedSourceUnits} source units; expected ${workerSentIdxRef.current}.`,
          );
        }
        if (
          result.acceptedSourceUnits > 0 &&
          (result.generation !== nativeAdmissionGenerationRef.current ||
            result.generation !== nativeFinalizedGenerationRef.current)
        ) {
          throw new Error(
            `Host finalization generation ${result.generation} does not match native admissions/finalization ` +
              `(${nativeAdmissionGenerationRef.current}/${nativeFinalizedGenerationRef.current}).`,
          );
        }
        handle.flushPending();
        await Promise.race([handle.waitForIdle(), timeout]);
        if (generation !== sourceGenerationRef.current || streamingRef.current !== handle) {
          throw new Error("Finalization was cancelled by a new source generation.");
        }
        updateSourceSessionStatus({ isFinalizing: false, isHostComplete: true, streamError: null });
        return result;
      } catch (error) {
        reportStreamError(error, generation);
        throw error;
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
      }
    })();
    finalizationPromiseRef.current = promise;
    return promise;
  }, [ensureSourceThrough, reportStreamError, updateSourceSessionStatus]);


  const notifyPatchListeners = useCallback(() => {
    for (const listener of patchListenersRef.current) {
      try {
        listener();
      } catch (error) {
        console.error("patch listener failure", error);
      }
    }
  }, []);

  const collectListDebugSnapshot = useCallback(() => {
    if (!isListDebugEnabled() || typeof document === "undefined") return;
    const now = Date.now();
    if (listDebugStartRef.current === null) {
      listDebugStartRef.current = now;
    }
    const lists = Array.from(document.querySelectorAll(".markdown-v2-output ol, .markdown-v2-output ul")).map((list) => {
      const children = Array.from(list.children);
      const directItems = children.filter((child) => child.tagName.toLowerCase() === "li");
      const itemIds = directItems
        .map((item) => item.getAttribute("data-list-item-id"))
        .filter((value): value is string => Boolean(value));
      const totalItems = list.querySelectorAll("li").length;
      return {
        listId: list.getAttribute("data-list-id"),
        depth: list.hasAttribute("data-list-depth") ? Number(list.getAttribute("data-list-depth")) : null,
        ordered: list.tagName.toLowerCase() === "ol",
        itemCount: directItems.length,
        totalItemCount: totalItems,
        itemIds,
        firstItemText: directItems[0]?.textContent?.trim().slice(0, 120) ?? null,
      };
    });
    const store = streamingRef.current?.getState?.().store;
    const storeLists = store ? collectStoreListSnapshots(store) : null;
    let listMismatches: ListDebugMismatch[] | null = null;
    if (storeLists && storeLists.length > 0) {
      const domMap = new Map<string, number>();
      for (const list of lists) {
        if (list.listId) {
          domMap.set(list.listId, list.itemCount);
        }
      }
      listMismatches = [];
      for (const storeList of storeLists) {
        const domCount = domMap.get(storeList.id);
        if (typeof domCount === "number" && domCount !== storeList.itemCount) {
          listMismatches.push({ listId: storeList.id, domCount, storeCount: storeList.itemCount });
        }
      }
      if (listMismatches.length === 0) {
        listMismatches = null;
      }
    }
    listDebugEventsRef.current.push({
      t: now,
      sinceStartMs: Math.max(0, now - (listDebugStartRef.current ?? now)),
      idx: latestIdxRef.current,
      total: effectiveTotal,
      queueDepth: streamingRef.current?.getState?.().queueDepth ?? null,
      lists,
      storeLists,
      listMismatches,
    });
    const LIST_DEBUG_CAP = 2000;
    if (listDebugEventsRef.current.length > LIST_DEBUG_CAP) {
      listDebugEventsRef.current.splice(0, listDebugEventsRef.current.length - LIST_DEBUG_CAP);
    }

    if (listMismatches && listMismatches.length > 0) {
      listMismatchCountRef.current += 1;
    } else {
      listMismatchCountRef.current = 0;
    }

    const SHOULD_AUTO_EXPORT = isListAutoExportEnabled();
    if (SHOULD_AUTO_EXPORT && !listAutoExportedRef.current && listMismatchCountRef.current >= 3) {
      listAutoExportedRef.current = true;
      setTimeout(() => exportListDebug(), 0);
    }
  }, [effectiveTotal, exportListDebug]);

  const handleRendererFlush = useCallback(
    (result: PatchFlushResult) => {
      if (!result || result.batches.length === 0) {
        return;
      }

      schedulerBudgetRef.current = {
        active: Boolean(result.adaptiveBudgetActive),
        p95: typeof result.coalescingDurationP95 === "number" && Number.isFinite(result.coalescingDurationP95) ? result.coalescingDurationP95 : null,
        sampleCount: Number.isFinite(result.coalescingDurationSampleCount ?? Number.NaN) ? Number(result.coalescingDurationSampleCount) : 0,
      };

      if (streamStartRef.current === null) {
        streamStartRef.current = result.flushStartedAt;
        firstMeaningfulMsRef.current = null;
        completionMsRef.current = null;
      }

      const averageQueueDepth = (result.queueDepthBefore + result.remainingQueueSize) / 2;
      const effectiveQueueDepth = Math.max(result.queueDepthBefore, result.remainingQueueSize, averageQueueDepth);

      for (const batch of result.batches) {
        recordSample(patchDurationsRef.current, batch.durationMs);
        recordSample(flushApplyRef.current, batch.durationMs);
        recordSample(recvToFlushRef.current, batch.queueDelayMs);
        if (batch.coalescing) {
          const totals = coalescingTotalsRef.current;
          totals.input += batch.coalescing.inputPatchCount;
          totals.output += batch.coalescing.outputPatchCount;
          totals.coalesced += batch.coalescing.coalescedCount;
          totals.setProps += batch.coalescing.setPropsCoalesced;
          totals.insertChild += batch.coalescing.insertChildCoalesced;
          totals.durationMs += batch.coalescing.durationMs;
        }
        const sample: FlushBatchSample = {
          tx: batch.tx ?? null,
          patchCount: batch.patchCount,
          appliedPatchCount: batch.appliedPatchCount,
          queueDelayMs: Number(batch.queueDelayMs.toFixed(3)),
          durationMs: Number(batch.durationMs.toFixed(3)),
          priority: batch.priority,
          coalescing: batch.coalescing ?? null,
          receivedAt: typeof batch.receivedAt === "number" ? batch.receivedAt : null,
          appliedAt: typeof batch.appliedAt === "number" ? batch.appliedAt : null,
          queueDepthBefore: Number.isFinite(result.queueDepthBefore) ? result.queueDepthBefore : undefined,
          remainingQueue: Number.isFinite(result.remainingQueueSize) ? result.remainingQueueSize : undefined,
          effectiveQueueDepth: Number.isFinite(effectiveQueueDepth) ? effectiveQueueDepth : undefined,
          flushStartedAt: Number.isFinite(result.flushStartedAt) ? result.flushStartedAt : undefined,
          flushCompletedAt: Number.isFinite(result.flushCompletedAt) ? result.flushCompletedAt : undefined,
        };
        flushBatchLogRef.current.push(sample);
        if (flushBatchLogRef.current.length > METRIC_SAMPLE_LIMIT) {
          flushBatchLogRef.current.splice(0, flushBatchLogRef.current.length - METRIC_SAMPLE_LIMIT);
        }
      }
      recordSample(queueDepthRef.current, effectiveQueueDepth);
      const nextCredits = calculateSmoothedCredit(effectiveQueueDepth, workerCreditsRef.current, DEFAULT_BACKPRESSURE_CONFIG);
      updateWorkerCredits(nextCredits);

      if (!pendingDrainRef.current && result.remainingQueueSize > 0 && effectiveQueueDepth >= HIGH_QUEUE_THRESHOLD) {
        pendingDrainRef.current = true;
        setTimeout(() => {
          pendingDrainRef.current = false;
          streamingRef.current?.flushPending();
        }, 0);
      }

      if (result.remainingQueueSize > 0) {
        if (effectiveQueueDepth >= SOFT_QUEUE_THRESHOLD && effectiveQueueDepth < HIGH_QUEUE_THRESHOLD) {
          if (!softDrainTimeoutRef.current) {
            const softDrainDelayMs = computeSoftDrainDelayMs(effectiveQueueDepth, result);
            softDrainTimeoutRef.current = setTimeout(() => {
              softDrainTimeoutRef.current = null;
              streamingRef.current?.flushPending();
            }, softDrainDelayMs);
          }
        }
      } else if (softDrainTimeoutRef.current) {
        clearTimeout(softDrainTimeoutRef.current);
        softDrainTimeoutRef.current = null;
      }

      if (firstMeaningfulMsRef.current === null && result.batches.length > 0 && streamStartRef.current !== null) {
        const firstBatch = result.batches[0];
        const appliedAt = typeof firstBatch.appliedAt === "number" ? firstBatch.appliedAt : result.flushStartedAt;
        firstMeaningfulMsRef.current = Math.max(0, appliedAt - streamStartRef.current);
      }

      const latestMetrics = [...result.batches].reverse().find((batch) => batch.metrics)?.metrics;
      debugEventsRef.current.push({
        at: Date.now(),
        type: "PATCH_FLUSH",
        totalPatches: result.totalPatches,
        queueDepthBefore: result.queueDepthBefore,
        remainingQueue: result.remainingQueueSize,
        batches: result.batches.map((batch) => ({
          tx: batch.tx ?? null,
          patchCount: batch.patchCount,
          appliedPatchCount: batch.appliedPatchCount,
          durationMs: Number(batch.durationMs.toFixed(3)),
          queueDelayMs: Number(batch.queueDelayMs.toFixed(3)),
          priority: batch.priority,
          coalescing: batch.coalescing,
        })),
      });
      const MAX_DEBUG_EVENTS = 500;
      if (debugEventsRef.current.length > MAX_DEBUG_EVENTS) {
        debugEventsRef.current.splice(0, debugEventsRef.current.length - MAX_DEBUG_EVENTS);
      }

      collectListDebugSnapshot();
      notifyPatchListeners();
      scheduleUiSync();
    },
    [notifyPatchListeners, recordSample, updateWorkerCredits, computeSoftDrainDelayMs, scheduleUiSync, collectListDebugSnapshot],
  );

  useEffect(() => {
    rendererFlushUnsubscribeRef.current?.();
    rendererFlushUnsubscribeRef.current = null;

    const handle = streamingRef.current;
    if (typeof window !== "undefined") {
      window.__STREAMING_RENDERER_STORE__ = handle?.getState?.().store ?? null;
    }

    if (!handle) {
      return () => {
        if (typeof window !== "undefined") {
          window.__STREAMING_RENDERER_STORE__ = undefined;
        }
      };
    }

    rendererFlushUnsubscribeRef.current = handle.onFlush(handleRendererFlush);

    return () => {
      rendererFlushUnsubscribeRef.current?.();
      rendererFlushUnsubscribeRef.current = null;
      if (typeof window !== "undefined") {
        window.__STREAMING_RENDERER_STORE__ = undefined;
      }
    };
  }, [handleRendererFlush, streamingHandleEpoch]);

  useEffect(() => {
    if (rendererVersion < 0) {
      return;
    }
    if (pendingCommitMeasuresRef.current.length === 0) {
      return;
    }
    const starts = pendingCommitMeasuresRef.current.splice(0, pendingCommitMeasuresRef.current.length);
    const commitEnd = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
    for (const start of starts) {
      const duration = commitEnd - start;
      if (Number.isFinite(duration)) {
        recordSample(reactCommitRef.current, duration);
      }
    }
    recomputeTimingSummary();

    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        const paintEnd = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
        for (const start of starts) {
          const duration = paintEnd - start;
          if (Number.isFinite(duration)) {
            recordSample(paintRef.current, duration);
          }
        }
        recomputeTimingSummary();
      });
    }
  }, [recordSample, recomputeTimingSummary, rendererVersion]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") {
      return undefined;
    }

    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (!entries || entries.length === 0) {
          return;
        }
        for (const entry of entries) {
          const duration = entry.duration;
          if (typeof duration === "number" && Number.isFinite(duration)) {
            recordSample(longTaskDurationsRef.current, duration);
          }
        }
        recomputeTimingSummary();
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch (error) {
      observer = null;
      console.warn("[streaming-demo] Long task observer unavailable", error);
    }

    return () => {
      observer?.disconnect();
    };
  }, [recordSample, recomputeTimingSummary]);

  // Initialize V2 worker
  const setupWorker = useCallback(() => {
    workerCleanupRef.current?.();
    if (workerInitTimerRef.current) {
      clearTimeout(workerInitTimerRef.current);
      workerInitTimerRef.current = null;
    }
    pendingWorkerInitRef.current = null;
    patchDurationsRef.current.length = 0;
    flushApplyRef.current.length = 0;
    longTaskDurationsRef.current.length = 0;
    recvToFlushRef.current.length = 0;
    reactCommitRef.current.length = 0;
    paintRef.current.length = 0;
    queueDepthRef.current.length = 0;
    flushBatchLogRef.current.length = 0;
    workerReadyStateRef.current = false;
    resetCoalescingStats();
    if (softDrainTimeoutRef.current) {
      clearTimeout(softDrainTimeoutRef.current);
      softDrainTimeoutRef.current = null;
    }
    pendingCommitMeasuresRef.current.length = 0;
    setTimingSummary(createEmptyTimingSummary());
    workerCreditsRef.current = 1;

    const workerClientOptions: MarkdownWorkerClientOptions = ENABLE_WORKER_HELPER
      ? {
          defaultWorker: {
            mode: WORKER_HELPER_MODE,
            url: "/workers/markdown-worker.js",
          },
        }
      : {};
    const client = new MarkdownWorkerClient(workerClientOptions);
    workerRef.current = client;
    pendingWorkerInitRef.current = client;
    setRendererWorker(client.getWorker() ?? null);
    client.setCredits(workerCreditsRef.current);
    streamingRef.current?.setCredits(workerCreditsRef.current);

    const unsubscribe = client.onMessage((msg) => {
      if (msg.type === "SOURCE_ADMITTED") {
        nativeAdmissionGenerationRef.current = msg.generation;
        return;
      }
      if (msg.type === "FINALIZED") {
        nativeFinalizedGenerationRef.current = msg.generation;
        return;
      }
      if (msg.type === "INITIALIZED") {
        workerReadyStateRef.current = true;
        bumpWorkerInitEpoch((epoch) => epoch + 1);
        patchDurationsRef.current.length = 0;
        flushApplyRef.current.length = 0;
        longTaskDurationsRef.current.length = 0;
        recvToFlushRef.current.length = 0;
        reactCommitRef.current.length = 0;
        paintRef.current.length = 0;
        queueDepthRef.current.length = 0;
        flushBatchLogRef.current.length = 0;
        resetCoalescingStats();
        if (softDrainTimeoutRef.current) {
          clearTimeout(softDrainTimeoutRef.current);
          softDrainTimeoutRef.current = null;
        }
        pendingCommitMeasuresRef.current.length = 0;
        setTimingSummary(createEmptyTimingSummary());
        workerCreditsRef.current = 1;
        client.setCredits(workerCreditsRef.current);
        streamingRef.current?.setCredits(workerCreditsRef.current);
        hasPatchPipelineRef.current = false;
        patchTotalsRef.current = {
          totalMessages: 0,
          totalOps: 0,
          byOp: {},
          lastTx: 0,
        };
        lastPatchSummaryRef.current = null;
        patchHistoryRef.current = [];
        setBlocks([]);
        setRendererVersion(0);
        scheduleUiSync();
        workerSentIdxRef.current = 0;
        if (restartPendingRef.current) {
          restartPendingRef.current = false;
          setIsRunning(true);
        }
        return;
      }

      if (msg.type === "PATCH") {
        hasPatchPipelineRef.current = true;
        const receivedAt = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
        const summary: PatchSummary = {
          tx: msg.tx,
          count: msg.patches.length,
          byOp: {},
        };
        for (const patch of msg.patches) {
          summary.byOp[patch.op] = (summary.byOp[patch.op] || 0) + 1;
          patchTotalsRef.current.byOp[patch.op] = (patchTotalsRef.current.byOp[patch.op] || 0) + 1;
        }
        patchTotalsRef.current.totalMessages += 1;
        patchTotalsRef.current.totalOps += summary.count;
        patchTotalsRef.current.lastTx = msg.tx;
        lastPatchSummaryRef.current = summary;
        const history = patchHistoryRef.current;
        history.push({
          tx: msg.tx,
          patches: msg.patches,
          timestamp: receivedAt,
        });
        if (history.length > PATCH_HISTORY_CAP) {
          history.shift();
        }
        const queueSize = streamingRef.current?.getState?.().queueDepth ?? 0;
        debugEventsRef.current.push({
          at: Date.now(),
          type: "PATCH_BUFFER",
          tx: msg.tx,
          patchCount: msg.patches.length,
          queueSize,
          priority: "high",
        });
        const MAX_DEBUG_EVENTS = 500;
        if (debugEventsRef.current.length > MAX_DEBUG_EVENTS) {
          debugEventsRef.current.splice(0, debugEventsRef.current.length - MAX_DEBUG_EVENTS);
        }
        return;
      }

      if (msg.type === "RESET") {
        hasPatchPipelineRef.current = false;
        patchTotalsRef.current = {
          totalMessages: 0,
          totalOps: 0,
          byOp: {},
          lastTx: 0,
        };
        lastPatchSummaryRef.current = null;
        resetCoalescingStats();
        if (softDrainTimeoutRef.current) {
          clearTimeout(softDrainTimeoutRef.current);
          softDrainTimeoutRef.current = null;
        }
        return;
      }

      if (msg.type === "METRICS") {
        if (msg.metrics) {
          lastMetricsRef.current = msg.metrics;
          if (debugTimingRef.current) {
            setLastMetrics(msg.metrics);
          }
        }
        return;
      }
    });

    workerCleanupRef.current = () => {
      unsubscribe();
      if (workerInitTimerRef.current) {
        clearTimeout(workerInitTimerRef.current);
        workerInitTimerRef.current = null;
      }
      pendingWorkerInitRef.current = null;
      client.terminate();
      setRendererWorker(null);
      workerReadyStateRef.current = false;
    };
  }, [
    PREWARM_LANGS,
    prewarm,
    resetCoalescingStats,
    scheduleUiSync,
  ]);

  useEffect(() => {
    if (!pendingWorkerInitRef.current) {
      return;
    }
    if (!rendererWorker) {
      return;
    }
    if (workerInitTimerRef.current) {
      clearTimeout(workerInitTimerRef.current);
      workerInitTimerRef.current = null;
    }

    const client = pendingWorkerInitRef.current;
    workerInitTimerRef.current = setTimeout(() => {
      if (workerRef.current !== client) {
        return;
      }
      client.init("", prewarm ? PREWARM_LANGS : [], docPluginConfigRef.current, "restricted", DEMO_CONTENT_DESCRIPTORS);
      pendingWorkerInitRef.current = null;
      workerInitTimerRef.current = null;
    }, 0);

    return () => {
      if (workerInitTimerRef.current) {
        clearTimeout(workerInitTimerRef.current);
        workerInitTimerRef.current = null;
      }
    };
  }, [rendererWorker, prewarm, PREWARM_LANGS]);

  useEffect(() => {
    setupWorker();
    return () => {
      sourceGenerationRef.current += 1;
      sourceAdmissionAbortRef.current?.abort(new Error("Streaming demo unmounted during source admission."));
      sourceAdmissionAbortRef.current = null;
      workerCleanupRef.current?.();
      workerCleanupRef.current = null;
      workerRef.current = null;
    };
  }, [setupWorker]);

  useEffect(() => {
    if (!workerReadyStateRef.current || !streamingRef.current) return;
    const target = Math.min(idx, streamLimitRef.current ?? fullText.length);
    if (target <= workerSentIdxRef.current) return;
    const generation = sourceGenerationRef.current;
    void requestSourceAdmission(target).catch((error: unknown) => {
      reportStreamError(error, generation);
    });
  }, [idx, fullText, workerInitEpoch, streamingHandleEpoch, requestSourceAdmission, reportStreamError]);

  // Streaming control logic
  useEffect(() => {
    // Clear any prior timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (!isRunning || finished) {
      bufferedCharsRef.current = 0;
      streamTickAtRef.current = null;
      return;
    }

    if (streamStartRef.current === null) {
      streamStartRef.current = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
      firstMeaningfulMsRef.current = null;
      completionMsRef.current = null;
    }

    const tickInterval = tickMs;
    streamTickAtRef.current = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
    const useDirectIdxUpdate =
      typeof process !== "undefined" && process.env?.NEXT_PUBLIC_STREAMING_DEBUG_DIRECT_IDX === "1"
        ? true
        : typeof (globalThis as { __STREAMING_DEBUG__?: { directIdx?: boolean } }).__STREAMING_DEBUG__?.directIdx === "boolean"
          ? Boolean((globalThis as { __STREAMING_DEBUG__?: { directIdx?: boolean } }).__STREAMING_DEBUG__?.directIdx)
          : false;

    const interval = setInterval(() => {
      const targetCeiling = streamLimitRef.current ?? maxLen;
      if (workerSentIdxRef.current >= targetCeiling) {
        // Nothing left to send; stop timer.
        clearInterval(interval);
        if (timerRef.current === interval) {
          timerRef.current = null;
        }
        return;
      }
      const now = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
      const lastTickAt = streamTickAtRef.current;
      streamTickAtRef.current = now;
      const elapsedMs = typeof lastTickAt === "number" ? Math.max(0, now - lastTickAt) : tickInterval;
      const buffered = bufferedCharsRef.current;
      const targetChars = (rate * elapsedMs) / 1000 + buffered;
      const totalChars = Math.floor(targetChars);
      bufferedCharsRef.current = targetChars - totalChars;
      if (totalChars <= 0) return;
      const applyDelta = () => {
        setIdx((prev) => {
          if (prev >= targetCeiling) return prev;
          const remaining = targetCeiling - prev;
          const delta = Math.min(remaining, totalChars);
          return prev + delta;
        });
      };

      renderStartRef.current = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
      if (useDirectIdxUpdate) {
        applyDelta();
      } else {
        startTransition(applyDelta);
      }
    }, tickInterval);
    timerRef.current = interval;

    return () => {
      clearInterval(interval);
      if (timerRef.current === interval) {
        timerRef.current = null;
      }
      bufferedCharsRef.current = 0;
      streamTickAtRef.current = null;
    };
  }, [rate, tickMs, isRunning, finished, maxLen, runToken]);

  useEffect(() => {
    const hasActiveStreamLimit = streamLimitRef.current !== null && streamLimitRef.current < fullTextRef.current.length;
    if (!workerReadyStateRef.current || !streamingRef.current) return;
    if (finished && !hasActiveStreamLimit && !isHostComplete && workerSentIdxRef.current >= effectiveTotal) {
      if (!finalizedOnceRef.current) {
        finalizedOnceRef.current = true;
        updateWorkerCredits(1);
        const generation = sourceGenerationRef.current;
        void finalizeHostSession().catch((error: unknown) => {
          if (generation === sourceGenerationRef.current) {
            console.error("[StreamingMarkdown demo] automatic host finalization rejected", error);
          }
        });
      }
    } else if (!finished && finalizedOnceRef.current) {
      finalizedOnceRef.current = false;
    }
  }, [
    finished,
    effectiveTotal,
    workerInitEpoch,
    sourceAdmissionEpoch,
    streamingHandleEpoch,
    isHostComplete,
    updateWorkerCredits,
    finalizeHostSession,
  ]);

  useEffect(() => {
    if (finished) {
      if (streamStartRef.current !== null && completionMsRef.current === null) {
        const now = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
        completionMsRef.current = Math.max(0, now - streamStartRef.current);
      }
    }
  }, [finished]);

  // Render timing tracking
  useEffect(() => {
    if (renderTimerRef.current) {
      clearTimeout(renderTimerRef.current);
      renderTimerRef.current = null;
    }
    if (isPending) {
      renderTimerRef.current = setTimeout(() => setShowRendering(true), 25);
    } else {
      if (renderStartRef.current !== null) {
        const ms = performance.now() - renderStartRef.current;
        renderStartRef.current = null;
        if (debugTiming) {
          setRenderTimes((prev) => {
            const entry = { ms: Number(ms.toFixed(1)), idx, total: maxLen };
            if (noCap) return [...prev, entry];
            const cap = Math.max(1, logWindow);
            const next = [...prev, entry];
            return next.length > cap ? next.slice(next.length - cap) : next;
          });
        }
      }
      if (showRendering) {
        renderTimerRef.current = setTimeout(() => setShowRendering(false), 25);
      } else {
        setShowRendering(false);
      }
    }
    return () => {
      if (renderTimerRef.current) {
        clearTimeout(renderTimerRef.current);
        renderTimerRef.current = null;
      }
    };
  }, [debugTiming, isPending, showRendering, idx, maxLen, logWindow, noCap]);

  // MDX coordinator: derive display blocks with compiled MDX refs
  const onRestart = useCallback(() => {
    const wasRunning = isRunning;
    sourceGenerationRef.current += 1;
    sourceAdmissionTargetRef.current = 0;
    nativeAdmissionGenerationRef.current = null;
    nativeFinalizedGenerationRef.current = null;
    sourceAdmissionAbortRef.current?.abort(new Error("Source admission cancelled by restart."));
    sourceAdmissionAbortRef.current = null;
    streamingRef.current?.restart();
    finalizationPromiseRef.current = null;
    latestIdxRef.current = 0;
    restartPendingRef.current = wasRunning;
    setIsRunning(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    updateSourceSessionStatus({ isFinalizing: false, isHostComplete: false, streamError: null });
    setIdx(0);
    setRenderTimes([]);
    workerSentIdxRef.current = 0;
    bufferedCharsRef.current = 0;
    lastMetricsRef.current = null;
    setLastMetrics(null);
    debugEventsRef.current = [];
    patchTotalsRef.current = {
      totalMessages: 0,
      totalOps: 0,
      byOp: {},
      lastTx: 0,
    };
    lastPatchSummaryRef.current = null;
    patchHistoryRef.current = [];
    hasPatchPipelineRef.current = false;
    setBlocks([]);
    setRendererVersion(0);
    patchDurationsRef.current.length = 0;
    flushApplyRef.current.length = 0;
    longTaskDurationsRef.current.length = 0;
    recvToFlushRef.current.length = 0;
    reactCommitRef.current.length = 0;
    paintRef.current.length = 0;
    queueDepthRef.current.length = 0;
    pendingCommitMeasuresRef.current.length = 0;
    listDebugEventsRef.current = [];
    listDebugStartRef.current = null;
    listMismatchCountRef.current = 0;
    listAutoExportedRef.current = false;
    streamStartRef.current = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
    firstMeaningfulMsRef.current = null;
    completionMsRef.current = null;
    setTimingSummary(createEmptyTimingSummary());
    finalizedOnceRef.current = false;
    bumpRunToken((token) => token + 1);
    setupWorker();
  }, [isRunning, setupWorker, bumpRunToken, updateSourceSessionStatus]);

  useEffect(() => {
    if (schedulingPresetRef.current === schedulingPreset) return;
    schedulingPresetRef.current = schedulingPreset;
    onRestart();
  }, [onRestart, schedulingPreset]);

  const getCodeBlockSnapshot = useCallback(
    (options?: {
      blockId?: string;
      blockIndex?: number;
    }): AutomationCodeBlockSnapshot | null => {
      const store = streamingRef.current?.getState?.().store;
      if (!store) return null;

      let targetBlockId = options?.blockId ?? null;
      if (!targetBlockId) {
        const blockIds = findCodeBlockIds(store);
        const index = options?.blockIndex ?? 0;
        targetBlockId = blockIds[index] ?? null;
      }
      if (!targetBlockId) return null;

      const node = store.getNode(targetBlockId);
      if (!node || !node.block) return null;

      const lines = collectCodeBlockLines(store, targetBlockId);
      const preAttrs = (node.props?.preAttrs as Record<string, string> | undefined) ?? undefined;
      const codeAttrs = (node.props?.codeAttrs as Record<string, string> | undefined) ?? undefined;

      let html: string | null = null;
      const blockHighlighted = typeof node.block.payload.highlightedHtml === "string" ? node.block.payload.highlightedHtml : null;
      if (blockHighlighted && blockHighlighted.trim().length > 0) {
        html = blockHighlighted;
      } else if (lines.length > 0) {
        html = composeAutomationHighlightedHtml(lines, preAttrs, codeAttrs);
      } else {
        const raw = typeof node.block.payload.raw === "string" ? node.block.payload.raw : "";
        if (raw.trim().length > 0) {
          html = composeAutomationHighlightedHtml([{ index: 0, text: raw, html: null }], preAttrs, codeAttrs);
        }
      }

      const langProp = typeof node.props?.lang === "string" ? (node.props.lang as string) : undefined;
      const langMeta = typeof node.block.payload.meta?.lang === "string" ? (node.block.payload.meta.lang as string) : undefined;

      return {
        blockId: targetBlockId,
        html,
        lang: langProp ?? langMeta,
        lineCount: lines.length,
      };
    },
    [],
  );

  const exportDebug = () => {
    try {
      const payload = {
        now: new Date().toISOString(),
        env: {
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
          prewarm,
          rate,
          tickMs,
          fileLen: maxLen,
          version: "2.0.0",
        },
        lastMetrics: lastMetricsRef.current,
        blocksPreview: blocks.slice(Math.max(0, blocks.length - 15)).map((b) => ({
          id: b.id,
          type: b.type,
          final: b.isFinalized,
          rawLen: b.payload.raw.length,
          hasHighlight: !!b.payload.highlightedHtml,
          hasInline: !!b.payload.inline,
          meta: b.payload.meta,
        })),
        events: debugEventsRef.current,
        renderTimes: renderTimes.slice(-20),
        renderer: {
          version: rendererVersion,
          patchMode: hasPatchPipelineRef.current,
        },
        patching: {
          last: lastPatchSummaryRef.current,
          totals: patchTotalsRef.current,
        },
        timings: timingSummary,
        perfSummary: timingSummary,
        perfSamples: {
          recvToFlushMs: Array.from(recvToFlushRef.current),
          flushApplyMs: Array.from(flushApplyRef.current),
          reactCommitMs: Array.from(reactCommitRef.current),
          paintMs: Array.from(paintRef.current),
          queueDepth: Array.from(queueDepthRef.current),
          patchApplyMs: Array.from(patchDurationsRef.current),
          longTasksMs: Array.from(longTaskDurationsRef.current),
        },
        streamMetrics: {
          startedAt: streamStartRef.current,
          firstMeaningfulMs: firstMeaningfulMsRef.current,
          completionMs: completionMsRef.current,
        },
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `streaming-debug-v2-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Failed to export debug log", e);
    }
  };

  useEffect(() => {
    if (!SHOULD_EXPOSE_AUTOMATION_API) return;
    if (typeof window === "undefined") return;
    if (typeof console !== "undefined" && !automationWarningLoggedRef.current) {
      console.warn(
        `[StreamingMarkdown demo] window.__STREAMING_DEMO__ is a demo-only automation shim. Prefer the StreamingMarkdownHandle ref.\nSee ${AUTOMATION_DOC_LINK}`,
      );
      automationWarningLoggedRef.current = true;
    }
    const waitForWorkerReady = async () => {
      const startedAt = Date.now();
      while (!workerReadyStateRef.current || !streamingRef.current) {
        if (Date.now() - startedAt >= 15_000) {
          throw new Error("Worker and StreamingMarkdown handle did not become ready within 15000ms.");
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      }
    };
    const waitForHandleIdle = async () => {
      const handle = streamingRef.current;
      if (!handle) throw new Error("StreamingMarkdown handle is unavailable while waiting for renderer idle.");
      let timer: number | undefined;
      try {
        await Promise.race([
          handle.waitForIdle(),
          new Promise<never>((_, reject) => {
            timer = window.setTimeout(
              () => reject(new Error(`Renderer idle exceeded ${FINALIZE_TIMEOUT_MS}ms.`)),
              FINALIZE_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
      }
    };
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));
    const api = (window.__STREAMING_DEMO__ ?? {}) as StreamingDemoAutomationApiV2;
    api.onPatch = (listener) => {
      patchListenersRef.current.add(listener);
      return () => patchListenersRef.current.delete(listener);
    };
    api.getRendererNode = (id: string) => streamingRef.current?.getState?.().store?.getNode(id)?.block as Block | undefined;
    api.getRendererChildren = (id: string) => [...(streamingRef.current?.getState?.().store?.getChildren(id) ?? [])];
    api.getPatchHistory = () => [...patchHistoryRef.current];
    api.getCodeBlockSnapshot = (options) => getCodeBlockSnapshot(options);
    api.getCodeBlockHtml = (options) => getCodeBlockSnapshot(options)?.html ?? null;
    api.getCoalescingTotals = () => ({ ...coalescingTotalsRef.current });
    api.setRate = (value: number) => setRate(clamp(value, 50, 20000));
    api.setTick = (value: number) => setTickMs(clamp(value, 1, 200));
    api.setStreamLimit = (limit: number | null) => {
      if (typeof limit === "number" && Number.isFinite(limit)) {
        updateStreamLimit(limit);
      } else {
        updateStreamLimit(null);
      }
    };
    api.setMode = (mode: "classic" | "worker") => {
      modeRef.current = mode;
    };
    api.setSchedulingPreset = (preset: "latency" | "throughput") => {
      setSchedulingPreset(preset);
    };
    api.fastForward = async () => {
      await waitForWorkerReady();
      if (!streamingRef.current) throw new Error("StreamingMarkdown handle is unavailable for fastForward.");
      const target = streamLimitRef.current ?? fullTextRef.current.length;
      const generation = sourceGenerationRef.current;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      bufferedCharsRef.current = 0;
      streamTickAtRef.current = null;
      setIsRunning(false);
      try {
        await ensureSourceThrough(target);
        if (generation !== sourceGenerationRef.current) throw new Error("fastForward was cancelled by a new source generation.");
        latestIdxRef.current = target;
        setIdx(target);
      } catch (error) {
        reportStreamError(error, generation);
        throw error;
      }
    };
    api.setMdxEnabled = (enabled: boolean) => {
      docPluginConfigRef.current = {
        ...docPluginConfigRef.current,
        mdx: Boolean(enabled),
      };
      onRestart();
    };
    api.restart = () => onRestart();
    api.pause = () => setIsRunning(false);
    api.resume = () => setIsRunning(true);
    api.finalize = () => finalizeHostSession();
    api.getHandle = () => streamingRef.current;
    api.getWorker = () => workerRef.current?.getWorker() ?? null;
    api.flushPending = async () => {
      const handle = streamingRef.current;
      if (!handle) throw new Error("StreamingMarkdown handle is unavailable while flushing pending work.");
      handle.flushPending();
      await waitForHandleIdle();
    };
    api.waitForIdle = waitForHandleIdle;
    api.waitForWorker = waitForWorkerReady;
    api.getPerf = () => ({
      summary: timingSummary,
      samples: {
        recvToFlushMs: [...recvToFlushRef.current],
        flushApplyMs: [...flushApplyRef.current],
        reactCommitMs: [...reactCommitRef.current],
        paintMs: [...paintRef.current],
        queueDepth: [...queueDepthRef.current],
        patchApplyMs: [...patchDurationsRef.current],
        longTasksMs: [...longTaskDurationsRef.current],
      },
      worker: lastMetricsRef.current,
      stream: {
        startedAt: streamStartRef.current,
        firstMeaningfulMs: firstMeaningfulMsRef.current,
        completionMs: completionMsRef.current,
      },
      patchTotals: patchTotalsRef.current,
      coalescingTotals: { ...coalescingTotalsRef.current },
      scheduler: {
        adaptiveBudgetActive: schedulerBudgetRef.current.active,
        coalescingDurationP95: schedulerBudgetRef.current.p95,
        coalescingSampleCount: schedulerBudgetRef.current.sampleCount,
      },
      flushBatches: flushBatchLogRef.current.map((entry) => ({ ...entry })),
    });
    api.getState = () => {
      const sourceStatus = sourceSessionStatusRef.current;
      const sourceIdx = latestIdxRef.current;
      const sourceTotal = streamLimitRef.current ?? fullTextRef.current.length;
      return {
        idx: sourceIdx,
        total: sourceTotal,
        isRunning,
        isPending,
        fullTextLength: fullTextRef.current.length,
        finished: sourceIdx >= sourceTotal,
        isFinalizing: sourceStatus.isFinalizing,
        isHostComplete: sourceStatus.isHostComplete,
        nativeAdmissionGeneration: nativeAdmissionGenerationRef.current,
        nativeFinalizedGeneration: nativeFinalizedGenerationRef.current,
        streamError: sourceStatus.streamError,
        streamLimit: streamLimitRef.current,
        workerSentIdx: workerSentIdxRef.current,
        workerCredits: workerCreditsRef.current,
        timerActive: Boolean(timerRef.current),
        mode: modeRef.current,
        schedulingPreset,
        rate,
        tickMs,
        renderer: {
          version: rendererVersion,
          patchMode: hasPatchPipelineRef.current,
        },
        patchStats: { last: lastPatchSummaryRef.current, totals: patchTotalsRef.current },
        renderTimes,
        timings: timingSummary,
      };
    };
    window.__STREAMING_DEMO__ = api;
  }, [
    idx,
    effectiveTotal,
    isRunning,
    isPending,
    finished,
    schedulingPreset,
    rate,
    tickMs,
    rendererVersion,
    renderTimes,
    timingSummary,
    onRestart,
    getCodeBlockSnapshot,
    updateStreamLimit,
    ensureSourceThrough,
    reportStreamError,
    finalizeHostSession,
  ]);

  const coalescingTotalsSnapshot = coalescingPanel.totals;
  const coalescingRecent = coalescingPanel.recent;
  const coalescingSparkline = coalescingPanel.sparkline;
  const coalescingAdaptiveState = coalescingPanel.adaptiveState;
  const demoTitle = useMemo(() => {
    const match = fullText.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim() || "Streaming Output";
  }, [fullText]);
  const activeStreamLimit = streamLimitRef.current !== null && streamLimitRef.current < fullText.length;
  const pendingSourceUnits = workerSentIdxRef.current < Math.min(idx, streamLimitRef.current ?? fullText.length);
  const streamStatus = streamError
    ? "Error"
    : isHostComplete
      ? "Completed"
      : isFinalizing || (finished && !activeStreamLimit && !pendingSourceUnits)
        ? "Finalizing…"
        : pendingSourceUnits
          ? "Sending…"
          : finished || !isRunning
            ? "Paused"
            : showRendering
              ? "Rendering…"
              : "Streaming";
  const statusTone =
    streamStatus === "Streaming"
      ? "bg-emerald-50 text-emerald-700"
      : streamStatus === "Paused"
        ? "bg-amber-50 text-amber-700"
        : streamStatus === "Rendering…"
          ? "bg-slate-100 text-slate-600"
          : streamStatus === "Finalizing…" || streamStatus === "Sending…"
            ? "bg-sky-50 text-sky-700"
            : streamStatus === "Error"
              ? "bg-red-50 text-red-700"
              : "bg-foreground/5 text-foreground/70";
  const summaryCards = [
    { label: "First flush", value: formatMs(firstMeaningfulMsRef.current) },
    { label: "Latency p95", value: formatMs(timingSummary.recvToFlush?.p95Ms) },
    { label: "Patch p95", value: formatMs(timingSummary.flushApply?.p95Ms) },
    { label: "Long tasks", value: formatCount(timingSummary.longTasks?.count ?? null, 0) },
    { label: "Shiki ms", value: formatMs(lastMetrics?.shikiMs) },
    { label: "Coalescing", value: formatPercent(coalescingPanel.reductionPct) },
  ];

  return (
    <div className={cn("flex w-full flex-col gap-6", className)}>
      {SHOULD_EXPOSE_AUTOMATION_API && (
        <details className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
          <summary className="cursor-pointer font-semibold">Automation API (demo-only)</summary>
          <div className="mt-2">
            <p>
              The <code>window.__STREAMING_DEMO__</code> shim only exists for internal tooling. Use the <code>StreamingMarkdownHandle</code> ref instead.
            </p>
            <p className="mt-1">See {AUTOMATION_DOC_LINK}.</p>
          </div>
        </details>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold text-foreground">{demoTitle}</h2>
                  <span className={cn("studio-live-status rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", statusTone)}>
                    {streamStatus}
                  </span>
                </div>
                <div className="text-xs text-muted">
                  {idx.toLocaleString()} / {effectiveTotal.toLocaleString()} chars streamed
                </div>
                {streamError && <div role="alert" className="text-xs text-red-700">{streamError}</div>}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {summaryCards.map((card) => (
                <div key={card.label} className="studio-live-stat rounded-lg border border-border/60 bg-background p-2">
                  <div className="text-[11px] uppercase tracking-wide text-muted">{card.label}</div>
                  <div className="mt-1 text-sm font-semibold text-foreground">{card.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="studio-live-output-frame rounded-xl border border-border bg-background p-4 shadow-sm">
            <div data-testid="markdown-output" className={cn("prose max-w-none", theme === "dark" ? "prose-invert" : "")}>
              <StreamingMarkdown
                ref={streamingHandleRef}
                worker={rendererWorker ?? undefined}
                managedWorker={Boolean(rendererWorker)}
                className="markdown-v2-output"
                features={docPluginConfigRef.current}
                scheduling={rendererScheduling}
                contentPolicy="restricted"
                contentComponents={demoContentComponents}
                prewarmLangs={prewarm ? PREWARM_LANGS : []}
                components={demoComponents}
                caret="block"
                linkSafety={{ enabled: true }}
                deferHeavyBlocks={{ rootMargin: "200px 0px", debounceMs: 120 }}
                style={{ contain: "content" }}
                onError={handleRendererError}
              />
            </div>
          </div>

          <details className="studio-live-panel rounded-xl border border-border bg-background/60 p-4">
            <summary className="cursor-pointer text-sm font-semibold">Metrics</summary>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <Button size="sm" variant={metricsTab === "coalescing" ? "default" : "ghost"} onClick={() => setMetricsTab("coalescing")}>
                Coalescing
              </Button>
              <Button size="sm" variant={metricsTab === "timing" ? "default" : "ghost"} onClick={() => setMetricsTab("timing")}>
                Timing
              </Button>
              <span className="text-muted">Run the stream to populate batch metrics.</span>
            </div>

            {metricsTab === "coalescing" ? (
              <div className="studio-live-subpanel mt-3 rounded-md border border-border bg-background/60 p-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="font-semibold text-muted text-xs uppercase tracking-wide">Coalescing</div>
                    <div
                      className={cn(
                        "font-semibold text-lg leading-tight",
                        typeof coalescingPanel.reductionPct === "number" && coalescingPanel.reductionPct < COALESCING_WARN_REDUCTION_PCT
                          ? "text-destructive"
                          : "text-foreground",
                      )}
                    >
                      {formatPercent(coalescingPanel.reductionPct)}
                    </div>
                    <div className="text-muted text-xs">
                      input {formatCount(coalescingTotalsSnapshot.input, 0)} → output {formatCount(coalescingTotalsSnapshot.output, 0)} (
                      {formatCount(coalescingTotalsSnapshot.coalesced, 0)} merged)
                    </div>
                  </div>
                  <div className="text-right text-muted text-xs">
                    <div>duration total {formatMs(coalescingTotalsSnapshot.durationMs, 2)}</div>
                    <Button size="sm" variant="ghost" className="mt-2" onClick={handleResetCoalescing}>
                      Reset
                    </Button>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 font-semibold uppercase tracking-wide",
                      coalescingAdaptiveState.active ? "bg-destructive/10 text-destructive" : "bg-foreground/5 text-foreground/70",
                    )}
                  >
                    {coalescingAdaptiveState.active ? "Adaptive budget" : "Normal budget"}
                  </span>
                  <span className="font-mono">
                    duration p95 {typeof coalescingAdaptiveState.p95 === "number" ? `${coalescingAdaptiveState.p95.toFixed(2)} ms` : "—"} (
                    {coalescingAdaptiveState.sampleCount} samples)
                  </span>
                </div>
                <div className="mt-3 grid gap-3">
                  <CoalescingSparkline
                    label="Reduction"
                    unit="%"
                    values={coalescingSparkline.reduction}
                    maxValue={100}
                    warnThreshold={COALESCING_WARN_REDUCTION_PCT}
                    warnDirection="below"
                  />
                  <CoalescingSparkline
                    label="Accumulator duration"
                    unit="ms"
                    values={coalescingSparkline.duration}
                    maxValue={coalescingSparkline.durationMax}
                    warnThreshold={COALESCING_WARN_DURATION_MS}
                    warnDirection="above"
                  />
                </div>
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between text-muted text-xs">
                    <span>Recent batches</span>
                    <span>
                      target reduction ≥ {COALESCING_WARN_REDUCTION_PCT}% · duration ≤ {COALESCING_WARN_DURATION_MS}ms
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {coalescingRecent.length === 0 ? (
                      <div className="rounded border border-border/60 border-dashed px-3 py-2 text-muted text-xs">Run the stream to populate batch metrics.</div>
                    ) : (
                      coalescingRecent.map((batch, index) => {
                        const reductionWarn = typeof batch.reductionPct === "number" && batch.reductionPct < COALESCING_WARN_REDUCTION_PCT;
                        const durationWarn = typeof batch.durationMs === "number" && batch.durationMs > COALESCING_WARN_DURATION_MS;
                        return (
                          <div
                            key={`coalesce-${batch.tx ?? index}-${index}`}
                            className={cn(
                              "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,0.9fr)] gap-2 rounded border px-2 py-1 font-mono text-xs",
                              reductionWarn || durationWarn
                                ? "border-destructive/40 bg-destructive/10 text-destructive"
                                : "border-border/40 bg-background/50 text-foreground",
                            )}
                          >
                            <span className="text-muted">
                              tx {batch.tx ?? "—"} {batch.priority === "low" ? "(L)" : "(H)"}
                            </span>
                            <span>
                              {formatCount(batch.input ?? 0, 0)}→{formatCount(batch.output ?? 0, 0)} (-{formatCount(batch.coalesced ?? 0, 0)})
                            </span>
                            <span className={cn(reductionWarn && "font-semibold")}>
                              {typeof batch.reductionPct === "number" ? `${batch.reductionPct.toFixed(1)}%` : "—"}
                            </span>
                            <span className={cn(durationWarn && "font-semibold")}>
                              {typeof batch.durationMs === "number" ? `${batch.durationMs.toFixed(2)} ms` : "—"}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                <label className="inline-flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={debugTiming} onChange={(e) => setDebugTiming(e.target.checked)} />
                  <span>Enable timing details</span>
                </label>

                {!debugTiming ? (
                  <div className="studio-live-subpanel rounded-md border border-border/60 bg-background/50 p-3 text-xs text-muted">
                    Enable timing to view render timings and main-thread stats.
                  </div>
                ) : (
                  <>
                    <div className="studio-live-subpanel rounded-md border border-border bg-background/50 p-2">
                      <div className="mb-1 flex items-center justify-between text-muted text-xs">
                        <span>
                          V2 Render times (showing {renderTimes.length}
                          {noCap ? "" : `/${Math.max(1, logWindow)}`})
                        </span>
                        <span className="flex gap-3">
                          <span>avg {renderTimes.length ? (renderTimes.reduce((a, b) => a + b.ms, 0) / renderTimes.length).toFixed(1) : "-"} ms</span>
                          <span>
                            p95{" "}
                            {renderTimes.length
                              ? (() => {
                                  const arr = [...renderTimes.map((r) => r.ms)].sort((a, b) => a - b);
                                  const p = arr[Math.floor(0.95 * (arr.length - 1))];
                                  return p?.toFixed(1) ?? "-";
                                })()
                              : "-"}{" "}
                            ms
                          </span>
                          <span>max {renderTimes.length ? Math.max(...renderTimes.map((r) => r.ms)).toFixed(1) : "-"} ms</span>
                        </span>
                      </div>
                      <div className="max-h-28 overflow-y-auto font-mono text-xs">
                        {renderTimes.map((t) => (
                          <div key={`${t.idx}-${t.total}-${t.ms}`}>
                            {t.ms.toFixed(1)} ms — {t.idx.toLocaleString()}/{t.total.toLocaleString()} chars
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="studio-live-subpanel rounded-md border border-border bg-background/50 p-2 font-mono text-[11px]">
                      <div className="mb-1 flex items-center justify-between text-muted text-xs">
                        <span>Main-thread timings</span>
                        <span>samples {timingSummary.patchApply?.count ?? 0}</span>
                      </div>
                      <div className="grid gap-1">
                        {timingRows.map((row) => (
                          <div key={`timing-row-${row.label}`} className="flex justify-between gap-2">
                            <span>{row.label}</span>
                            <span className="text-right text-foreground/80">{formatStatSummary(row.stat, row.unit)}</span>
                          </div>
                        ))}
                      </div>
                      {workerMetricsSummary && (
                        <div className="mt-3 border-border/60 border-t pt-2">
                          <div className="mb-1 text-muted text-xs">Last worker metrics</div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                            {workerMetricsSummary.map((item) => (
                              <Fragment key={`worker-metric-${item.label}`}>
                                <span>{item.label}</span>
                                <span className="text-right text-foreground/80">{item.value}</span>
                              </Fragment>
                            ))}
                          </div>
                        </div>
                      )}
                      {(() => {
                        const totals = coalescingTotalsRef.current;
                        const input = totals.input;
                        const output = totals.output;
                        const coalesced = totals.coalesced;
                        const reductionPct = input > 0 ? (coalesced / input) * 100 : null;
                        const appliedPct = input > 0 ? (output / input) * 100 : null;
                        return (
                          <div className="mt-3 border-border/60 border-t pt-2">
                            <div className="mb-1 text-muted text-xs">Coalescing totals</div>
                            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                              <Fragment>
                                <span>input patches</span>
                                <span className="text-right text-foreground/80">{formatCount(input, 0)}</span>
                              </Fragment>
                              <Fragment>
                                <span>applied patches</span>
                                <span className="text-right text-foreground/80">{formatCount(output, 0)}</span>
                              </Fragment>
                              <Fragment>
                                <span>coalesced</span>
                                <span className="text-right text-foreground/80">{formatCount(coalesced, 0)}</span>
                              </Fragment>
                              <Fragment>
                                <span>setProps merged</span>
                                <span className="text-right text-foreground/80">{formatCount(totals.setProps, 0)}</span>
                              </Fragment>
                              <Fragment>
                                <span>insertChild merged</span>
                                <span className="text-right text-foreground/80">{formatCount(totals.insertChild, 0)}</span>
                              </Fragment>
                              <Fragment>
                                <span>reduction</span>
                                <span className="text-right text-foreground/80">{formatPercent(reductionPct)}</span>
                              </Fragment>
                              <Fragment>
                                <span>applied / input</span>
                                <span className="text-right text-foreground/80">{formatPercent(appliedPct)}</span>
                              </Fragment>
                              <Fragment>
                                <span>coalesce time</span>
                                <span className="text-right text-foreground/80">{formatMs(totals.durationMs, 2)}</span>
                              </Fragment>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </>
                )}
              </div>
            )}
          </details>
        </div>

        <aside className="flex flex-col gap-4">
          <div className="studio-live-panel rounded-xl border border-border bg-background p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Streaming</div>
              <div className="studio-live-status rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted">{demoTitle}</div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" variant="default" onClick={() => setIsRunning((r) => !r)}>
                {isRunning ? "Pause" : "Resume"}
              </Button>
              <Button size="sm" variant="secondary" onClick={onRestart}>
                Restart
              </Button>
            </div>

            <div className="mt-4 space-y-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Rate & update interval</div>
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-muted text-xs">
                  <span>Stream rate</span>
                  <span>{rate} chars/s</span>
                </div>
                <Slider className="mt-4" min={50} max={20000} step={50} value={[rate]} onValueChange={(v) => setRate(v[0] ?? 500)} />
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-muted text-xs">
                  <span>Update interval</span>
                  <span>{tickMs} ms</span>
                </div>
                <Slider className="mt-4" min={1} max={200} step={1} value={[tickMs]} onValueChange={(v) => setTickMs(v[0] ?? 50)} />
              </div>
            </div>

            <div className="mt-4 space-y-2 text-xs text-muted">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Features</div>
              <label className="flex items-center justify-between gap-2">
                <span>Math block ($$...$$)</span>
                <input
                  type="checkbox"
                  checked={mathEnabled}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    setMathEnabled(enabled);
                    docPluginConfigRef.current = { ...docPluginConfigRef.current, math: enabled };
                    onRestart();
                  }}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span>HTML segments</span>
                <input
                  type="checkbox"
                  checked={htmlEnabled}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    setHtmlEnabled(enabled);
                    docPluginConfigRef.current = { ...docPluginConfigRef.current, html: enabled };
                    onRestart();
                  }}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span>Registered MDX components</span>
                <input
                  type="checkbox"
                  checked={mdxEnabled}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    setMdxEnabled(enabled);
                    docPluginConfigRef.current = { ...docPluginConfigRef.current, mdx: enabled };
                    onRestart();
                  }}
                />
              </label>
            </div>

            <div className="mt-4 space-y-2 text-xs text-muted">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Scheduling preset</div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="scheduling-preset"
                    value="latency"
                    checked={schedulingPreset === "latency"}
                    onChange={() => setSchedulingPreset("latency")}
                  />
                  <span>Latency</span>
                </label>
                <label className="inline-flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="scheduling-preset"
                    value="throughput"
                    checked={schedulingPreset === "throughput"}
                    onChange={() => setSchedulingPreset("throughput")}
                  />
                  <span>Throughput</span>
                </label>
              </div>
              <div className="text-[11px] text-muted/80">Latency prioritizes first flush and immediate feedback.</div>
            </div>

            <div className="mt-4 space-y-2 text-xs text-muted">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Debug</div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={exportDebug}>
                  Export
                </Button>
                {LIST_DEBUG_ENABLED && (
                  <Button size="sm" variant="outline" onClick={exportListDebug}>
                    List debug
                  </Button>
                )}
                <Button size="sm" variant={showInspector ? "default" : "outline"} onClick={() => setShowInspector((value) => !value)}>
                  Inspector
                </Button>
              </div>
            </div>
          </div>

          <details className="studio-live-panel rounded-xl border border-border bg-background/60 p-4">
            <summary className="cursor-pointer text-sm font-semibold">Advanced controls</summary>
            <div className="mt-3 flex flex-col gap-3 text-xs text-muted">
              <div className="flex items-center justify-between">
                <span>Dark theme</span>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={theme === "dark"} onChange={(e) => setTheme(e.target.checked ? "dark" : "light")} />
                </div>
              </div>


              <div className="flex items-center justify-between">
                <span>Pre-warm languages</span>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={prewarm} onChange={(e) => setPrewarm(e.target.checked)} />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span>Show code header meta</span>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={showCodeMeta} onChange={(e) => setShowCodeMeta(e.target.checked)} />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span>Format anticipation</span>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formatAnticipationEnabled}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setFormatAnticipationEnabled(enabled);
                      docPluginConfigRef.current = {
                        ...docPluginConfigRef.current,
                        formatAnticipation: enabled ? formatAnticipationConfig : false,
                      };
                      onRestart();
                    }}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2 pl-4">
                <label className="flex items-center justify-between gap-2">
                  <span>Inline (em/strong/code/strike)</span>
                  <input
                    type="checkbox"
                    disabled={!formatAnticipationEnabled}
                    checked={formatAnticipationConfig.inline}
                    onChange={(e) => {
                      const updated = { ...formatAnticipationConfig, inline: e.target.checked };
                      setFormatAnticipationConfig(updated);
                      docPluginConfigRef.current = {
                        ...docPluginConfigRef.current,
                        formatAnticipation: formatAnticipationEnabled ? updated : false,
                      };
                      onRestart();
                    }}
                  />
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span>Math inline ($...$)</span>
                  <input
                    type="checkbox"
                    disabled={!formatAnticipationEnabled}
                    checked={formatAnticipationConfig.mathInline}
                    onChange={(e) => {
                      const updated = { ...formatAnticipationConfig, mathInline: e.target.checked };
                      setFormatAnticipationConfig(updated);
                      docPluginConfigRef.current = {
                        ...docPluginConfigRef.current,
                        formatAnticipation: formatAnticipationEnabled ? updated : false,
                      };
                      onRestart();
                    }}
                  />
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span>Math block ($$...$$)</span>
                  <input
                    type="checkbox"
                    disabled={!formatAnticipationEnabled}
                    checked={formatAnticipationConfig.mathBlock}
                    onChange={(e) => {
                      const updated = { ...formatAnticipationConfig, mathBlock: e.target.checked };
                      setFormatAnticipationConfig(updated);
                      docPluginConfigRef.current = {
                        ...docPluginConfigRef.current,
                        formatAnticipation: formatAnticipationEnabled ? updated : false,
                      };
                      onRestart();
                    }}
                  />
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span>HTML segments</span>
                  <input
                    type="checkbox"
                    disabled={!formatAnticipationEnabled}
                    checked={formatAnticipationConfig.html}
                    onChange={(e) => {
                      const updated = { ...formatAnticipationConfig, html: e.target.checked };
                      setFormatAnticipationConfig(updated);
                      docPluginConfigRef.current = {
                        ...docPluginConfigRef.current,
                        formatAnticipation: formatAnticipationEnabled ? updated : false,
                      };
                      onRestart();
                    }}
                  />
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span>MDX segments</span>
                  <input
                    type="checkbox"
                    disabled={!formatAnticipationEnabled}
                    checked={formatAnticipationConfig.mdx}
                    onChange={(e) => {
                      const updated = { ...formatAnticipationConfig, mdx: e.target.checked };
                      setFormatAnticipationConfig(updated);
                      docPluginConfigRef.current = {
                        ...docPluginConfigRef.current,
                        formatAnticipation: formatAnticipationEnabled ? updated : false,
                      };
                      onRestart();
                    }}
                  />
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span>Regex plugins</span>
                  <input
                    type="checkbox"
                    disabled={!formatAnticipationEnabled}
                    checked={formatAnticipationConfig.regex}
                    onChange={(e) => {
                      const updated = { ...formatAnticipationConfig, regex: e.target.checked };
                      setFormatAnticipationConfig(updated);
                      docPluginConfigRef.current = {
                        ...docPluginConfigRef.current,
                        formatAnticipation: formatAnticipationEnabled ? updated : false,
                      };
                      onRestart();
                    }}
                  />
                </label>
              </div>

              <div className="flex items-center justify-between">
                <span>Live code highlighting (slow)</span>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={liveCodeHighlightingEnabled}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      const nextMode: CodeHighlightingMode = enabled ? "live" : "incremental";
                      setCodeHighlightingMode(nextMode);
                      docPluginConfigRef.current = {
                        ...docPluginConfigRef.current,
                        codeHighlighting: nextMode,
                        liveCodeHighlighting: enabled,
                      };
                      onRestart();
                    }}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span>Log window size</span>
                  <span>
                    {noCap ? "∞" : logWindow}
                    <label className="ml-3 inline-flex items-center gap-2">
                      <input type="checkbox" checked={noCap} onChange={(e) => setNoCap(e.target.checked)} />
                      <span>No cap</span>
                    </label>
                  </span>
                </div>
                <Slider className="mt-4" min={10} max={500} step={10} value={[logWindow]} onValueChange={(v) => setLogWindow(v[0] ?? 50)} />
              </div>
            </div>
          </details>

          {showInspector && (
            <div className="studio-live-panel studio-live-inspector rounded-xl border border-border bg-background/60 p-3 font-mono text-xs">
              <div className="mb-1 flex items-center justify-between text-muted text-xs">
                <span>V2 Block inspector (last 10 blocks)</span>
                <span>total blocks {blocks.length}</span>
              </div>
              <div className="grid grid-cols-1 gap-1">
                {(() => {
                  const sliceStart = Math.max(0, blocks.length - 10);
                  return blocks.slice(sliceStart).map((b, i) => {
                    const idx = sliceStart + i + 1;
                    const features = [];
                    if (b.payload.highlightedHtml) features.push("highlighted");
                    if (b.payload.inline) features.push("inline");
                    if (b.payload.meta) features.push("meta");

                    return (
                      <div key={`insp-v2-${sliceStart}-${i}-${b.id}`} className="flex justify-between">
                        <span>
                          #{idx} {b.type}
                          {b.isFinalized ? " (final)" : " (dirty)"}
                        </span>
                        <span>
                          {features.join("+")} · {b.payload.raw.length} chars
                        </span>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
