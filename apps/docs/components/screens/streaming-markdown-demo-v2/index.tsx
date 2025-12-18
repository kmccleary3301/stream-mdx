"use client";

import type { Block, InlineNode, Patch, PerformanceMetrics } from "@stream-mdx/core";
import type { HtmlElements, TableElements } from "@stream-mdx/react";
import type { CoalescingMetrics } from "@stream-mdx/react/renderer/patch-coalescing";
import type { PatchFlushResult } from "@stream-mdx/react/renderer/patch-commit-scheduler";
import type { RendererStore } from "@stream-mdx/react/renderer/store";
import type { CSSProperties, ComponentType, HTMLAttributes, ReactNode } from "react";

import { BlockMath, InlineMath } from "@/components/markdown/Math";
import { Button } from "@/components/ui/button";
import { ScrollAreaHorizontal } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { components as sharedMdxComponents } from "@/mdx-components";
import { DEFAULT_BACKPRESSURE_CONFIG, calculateSmoothedCredit, clampCredit } from "@stream-mdx/core";
import { StreamingMarkdown, type StreamingMarkdownHandle, ComponentRegistry, renderInlineNodes } from "@stream-mdx/react";
import { registerMDXComponents } from "@stream-mdx/react/mdx-client";
import { MarkdownWorkerClient, type MarkdownWorkerClientOptions } from "@stream-mdx/worker/worker-client";
import type { DefaultWorkerMode } from "@stream-mdx/worker";

import { Fragment, createElement, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

const METRIC_SAMPLE_LIMIT = 1000;
const COALESCING_RECENT_BATCH_COUNT = 8;
const COALESCING_SPARKLINE_POINTS = 24;
const COALESCING_WARN_REDUCTION_PCT = 5;
const COALESCING_WARN_DURATION_MS = 5;
const SHOULD_EXPOSE_AUTOMATION_API = process.env.NEXT_PUBLIC_STREAMING_DEMO_API === "true";
const AUTOMATION_DOC_LINK = "docs/STREAMING_MARKDOWN_V2_STATUS.md#54-automation-api-availability";
const ENABLE_WORKER_HELPER = process.env.NEXT_PUBLIC_STREAMING_WORKER_HELPER === "true";
const WORKER_HELPER_MODE: DefaultWorkerMode = process.env.NEXT_PUBLIC_STREAMING_WORKER_HELPER_MODE === "blob" ? "blob" : "auto";

type PatchSummary = { tx: number; count: number; byOp: Record<string, number> };
type AutomationState = {
  idx: number;
  total: number;
  isRunning: boolean;
  mode: "classic" | "worker";
  rate: number;
  tickMs: number;
  renderer?: { version: number; patchMode: boolean };
  patchStats?: {
    last: PatchSummary | null;
    totals: {
      totalMessages: number;
      totalOps: number;
      byOp: Record<string, number>;
      lastTx: number;
    };
  };
  paintEvents?: DebugEvent[];
  paintStats?: {
    count: number;
    avgMs: number;
    p95Ms: number;
    maxMs: number;
    lastDurationMs: number;
  } | null;
  renderTimes?: { ms: number; idx: number; total: number }[];
  timings?: TimingSummary;
};

type AutomationCodeBlockSnapshot = {
  blockId: string;
  html: string | null;
  lang?: string;
  lineCount: number;
};

type AppendDebugEvent = {
  at: number;
  type: "APPEND";
  start: number;
  end: number;
  appendedLen: number;
  totalBlocks: number;
};

type PatchEnqueueDebugEvent = {
  at: number;
  type: "PATCH_ENQUEUE";
  tx: number;
  patchCount: number;
  chunkIndex: number;
  chunkCount: number;
  queueSize: number;
  priority: "high" | "low";
};

type PatchBufferDebugEvent = {
  at: number;
  type: "PATCH_BUFFER";
  tx: number;
  patchCount: number;
  queueSize: number;
  priority: "high" | "low";
};

type PatchFlushDebugEvent = {
  at: number;
  type: "PATCH_FLUSH";
  totalPatches: number;
  queueDepthBefore: number;
  remainingQueue: number;
  batches: Array<{
    tx: number | null;
    patchCount: number;
    appliedPatchCount: number;
    durationMs: number;
    queueDelayMs: number;
    priority: "high" | "low";
    coalescing?: CoalescingMetrics;
  }>;
};

type FlushBatchSample = {
  tx: number | null;
  patchCount: number;
  appliedPatchCount: number;
  queueDelayMs: number;
  durationMs: number;
  priority: "high" | "low";
  receivedAt?: number | null;
  appliedAt?: number | null;
  queueDepthBefore?: number;
  remainingQueue?: number;
  effectiveQueueDepth?: number;
  flushStartedAt?: number;
  flushCompletedAt?: number;
  coalescing?: CoalescingMetrics | null;
};

type DebugEvent = AppendDebugEvent | PatchEnqueueDebugEvent | PatchBufferDebugEvent | PatchFlushDebugEvent;

export type StreamingDemoAutomationApiV2 = {
  setRate?: (value: number) => void;
  setTick?: (value: number) => void;
  setMode?: (mode: "classic" | "worker") => void;
  setMdxEnabled?: (enabled: boolean) => void;
  setMdxStrategy?: (mode: "server" | "worker") => void;
  setStreamLimit?: (limit: number | null) => void;
  fastForward?: () => Promise<void>;
  restart?: () => void;
  pause?: () => void;
  resume?: () => void;
  finalize?: () => void;
  getState?: () => AutomationState;
  getRendererNode?: (id: string) => Block | undefined;
  getRendererChildren?: (id: string) => ReadonlyArray<string>;
  getPatchHistory?: () => Array<{
    tx: number;
    patches: Patch[];
    timestamp: number;
  }>;
  getCodeBlockHtml?: (options?: {
    blockId?: string;
    blockIndex?: number;
  }) => string | null;
  getCodeBlockSnapshot?: (options?: {
    blockId?: string;
    blockIndex?: number;
  }) => AutomationCodeBlockSnapshot | null;
  onPatch?: (listener: () => void) => () => void;
  flushPending?: () => Promise<void>;
  waitForIdle?: () => Promise<void>;
  waitForWorker?: () => Promise<void>;
  getHandle?: () => StreamingMarkdownHandle | null;
  getPerf?: () => {
    summary: TimingSummary;
    samples: {
      recvToFlushMs: number[];
      flushApplyMs: number[];
      reactCommitMs: number[];
      paintMs: number[];
      queueDepth: number[];
      patchApplyMs: number[];
      longTasksMs: number[];
    };
    worker?: PerformanceMetrics | null;
    workerTotals?: {
      appendLineBatches: number;
      appendLineTotalLines: number;
      appendLineMaxLines: number;
    } | null;
    coalescingTotals?: {
      input: number;
      output: number;
      coalesced: number;
      appendLines: number;
      setProps: number;
      insertChild: number;
      durationMs: number;
    } | null;
    stream?: {
      startedAt?: number | null;
      firstMeaningfulMs?: number | null;
      completionMs?: number | null;
    } | null;
    patchTotals?: {
      totalMessages: number;
      totalOps: number;
      lastTx: number;
    } | null;
    scheduler?: {
      adaptiveBudgetActive: boolean;
      coalescingDurationP95: number | null;
      coalescingSampleCount: number;
    } | null;
    flushBatches?: FlushBatchSample[];
  };
  getCoalescingTotals?: () => {
    input: number;
    output: number;
    coalesced: number;
    appendLines: number;
    setProps: number;
    insertChild: number;
    durationMs: number;
  };
};

type StatSummary = {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  latestMs: number;
};

type TimingSummary = {
  patchApply: StatSummary | null;
  longTasks: StatSummary | null;
  recvToFlush: StatSummary | null;
  flushApply: StatSummary | null;
  reactCommit: StatSummary | null;
  paint: StatSummary | null;
  queueDepth: StatSummary | null;
};

declare global {
  interface Window {
    __STREAMING_DEMO__?: StreamingDemoAutomationApiV2;
    __STREAMING_RENDERER_STORE__?: RendererStore | null;
  }
}

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

function attrsToProps(attrs?: Record<string, string>): HTMLAttributes<HTMLElement> & Record<string, unknown> {
  if (!attrs) return {} as HTMLAttributes<HTMLElement> & Record<string, unknown>;
  const out: HTMLAttributes<HTMLElement> & Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") {
      out.className = value;
    } else if (key === "style") {
      out.style = parseStyleAttribute(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function parseStyleAttribute(value: string): CSSProperties & Record<string, string> {
  const style: Record<string, string> = {};
  if (!value) return style;
  const parts = value.split(";");
  for (const part of parts) {
    if (!part.trim()) continue;
    const [prop, val] = part.split(":");
    if (!prop || !val) continue;
    const property = prop.trim();
    const trimmedValue = val.trim();
    if (property.startsWith("--")) {
      style[property] = trimmedValue;
    } else {
      const camelProp = property.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
      style[camelProp] = trimmedValue;
    }
  }
  return style as CSSProperties & Record<string, string>;
}

export function StreamingMarkdownDemoV2({
  fullText,
  className = "",
}: {
  fullText: string;
  className?: string;
}) {
  const tableElements = useMemo<TableElements>(
    () => ({
      Table,
      Thead: TableHeader,
      Tbody: TableBody,
      Tr: TableRow,
      Th: TableHead,
      Td: TableCell,
    }),
    [],
  );
  const htmlElements = useMemo<Partial<HtmlElements>>(
    () => ({
      table: ({ className, children, ...props }: HTMLAttributes<HTMLTableElement>) => (
        <div className="my-6 w-full overflow-hidden overflow-y-auto">
          <Table className={className} {...props}>
            {children}
          </Table>
        </div>
      ),
      thead: ({ className, children, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
        <TableHeader className={className} {...props}>
          {children}
        </TableHeader>
      ),
      tbody: ({ className, children, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
        <TableBody className={cn("border border-border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right", className)} {...props}>
          {children}
        </TableBody>
      ),
      tr: ({ className, children, ...props }: HTMLAttributes<HTMLTableRowElement>) => (
        <TableRow className={cn("border border-border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right", className)} {...props}>
          {children}
        </TableRow>
      ),
      th: ({ className, children, ...props }: HTMLAttributes<HTMLTableCellElement>) => (
        <TableHead
          className={cn("border border-border px-4 py-2 text-left font-bold [&[align=center]]:text-center [&[align=right]]:text-right", className)}
          {...props}
        >
          {children}
        </TableHead>
      ),
      td: ({ className, children, ...props }: HTMLAttributes<HTMLTableCellElement>) => (
        <TableCell className={cn("border border-border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right", className)} {...props}>
          {children}
        </TableCell>
      ),
    }),
    [],
  );
  const PREWARM_LANGS = useMemo(() => ["typescript", "tsx", "javascript", "json", "python", "bash", "html", "css", "sql", "yaml", "markdown"], []);
  const rendererScheduling = useMemo(
    () => ({
      frameBudgetMs: 9,
      maxBatchesPerFlush: 5,
      lowPriorityFrameBudgetMs: 4,
      maxLowPriorityBatchesPerFlush: 1,
      urgentQueueThreshold: 2,
    }),
    [],
  );
  const [idx, setIdx] = useState<number>(0);
  const [rate, setRate] = useState<number>(500); // characters per second
  const [tickMs, setTickMs] = useState<number>(50); // update cadence in ms
  const [isRunning, setIsRunning] = useState<boolean>(true);
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
  const [showInspector, setShowInspector] = useState<boolean>(false);
  const [showCodeMeta, setShowCodeMeta] = useState<boolean>(false);
  const [formatAnticipationEnabled, setFormatAnticipationEnabled] = useState<boolean>(true);
  const [liveCodeHighlightingEnabled, setLiveCodeHighlightingEnabled] = useState<boolean>(false);
  const debugTimingRef = useRef(debugTiming);
  const showInspectorRef = useRef(showInspector);
  const modeRef = useRef<"classic" | "worker">("worker");
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  // Default to worker-side MDX compilation so the demo renders MDX blocks without server help.
  const [mdxStrategy, setMdxStrategy] = useState<"server" | "worker">("worker");
  const mdxStrategyRef = useRef<"server" | "worker">("worker");

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

  const [streamLimit, setStreamLimit] = useState<number | null>(null);
  const streamLimitRef = useRef<number | null>(null);
  const updateStreamLimit = useCallback((value: number | null) => {
    const normalized = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(value, fullTextRef.current.length)) : null;
    streamLimitRef.current = normalized;
    setStreamLimit(normalized);
    if (normalized !== null && latestIdxRef.current > normalized) {
      setIdx(normalized);
      workerSentIdxRef.current = Math.min(workerSentIdxRef.current, normalized);
    }
  }, []);

  useEffect(() => {
    if (streamLimitRef.current !== null && streamLimitRef.current > fullText.length) {
      updateStreamLimit(streamLimitRef.current);
    }
  }, [fullText.length, updateStreamLimit]);

  const maxLen = fullText.length;
  const effectiveTotal = streamLimit ?? maxLen;
  const finished = idx >= effectiveTotal;
  const current = useMemo(() => fullText.slice(0, Math.min(idx, effectiveTotal)), [fullText, idx, effectiveTotal]);
  const handleRendererError = useCallback((error: Error) => {
    console.error("StreamingMarkdown render error", error);
  }, []);

  useEffect(() => {
    mdxStrategyRef.current = mdxStrategy;
  }, [mdxStrategy]);

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
  type WorkerReadyDeferred = { promise: Promise<void>; resolve: () => void };
  const workerReadyDeferredRef = useRef<WorkerReadyDeferred | null>(null);
  const workerReadyStateRef = useRef(false);
  const resetWorkerReadyPromise = useCallback(() => {
    workerReadyStateRef.current = false;
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    workerReadyDeferredRef.current = { promise, resolve };
  }, []);
  const resolveWorkerReadyPromise = useCallback(() => {
    workerReadyStateRef.current = true;
    if (workerReadyDeferredRef.current) {
      workerReadyDeferredRef.current.resolve();
      workerReadyDeferredRef.current = null;
    }
  }, []);
  const workerCleanupRef = useRef<(() => void) | null>(null);
  const workerInitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingWorkerInitRef = useRef<MarkdownWorkerClient | null>(null);
  const componentRegistry = useRef(new ComponentRegistry());
  const hasPatchPipelineRef = useRef(false);
  const docPluginConfigRef = useRef({
    footnotes: true,
    html: true,
    mdx: true,
    tables: true,
    callouts: true,
    formatAnticipation: true,
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
  const workerTotalsRef = useRef({
    appendLineBatches: 0,
    appendLineTotalLines: 0,
    appendLineMaxLines: 0,
  });
  const streamTickAtRef = useRef<number | null>(null);
  const coalescingTotalsRef = useRef<{
    input: number;
    output: number;
    coalesced: number;
    appendLines: number;
    setProps: number;
    insertChild: number;
    durationMs: number;
  }>({
    input: 0,
    output: 0,
    coalesced: 0,
    appendLines: 0,
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
      appendLines: 0,
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

  useEffect(() => {
    registerMDXComponents(sharedMdxComponents as unknown as Record<string, ComponentType<unknown>>);
  }, []);

  const notifyPatchListeners = useCallback(() => {
    for (const listener of patchListenersRef.current) {
      try {
        listener();
      } catch (error) {
        console.error("patch listener failure", error);
      }
    }
  }, []);

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
          totals.appendLines += batch.coalescing.appendLinesCoalesced;
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

      notifyPatchListeners();
      scheduleUiSync();
    },
    [notifyPatchListeners, recordSample, updateWorkerCredits, computeSoftDrainDelayMs, scheduleUiSync],
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
    workerTotalsRef.current = {
      appendLineBatches: 0,
      appendLineTotalLines: 0,
      appendLineMaxLines: 0,
    };
    resetWorkerReadyPromise();
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
      if (msg.type === "INITIALIZED") {
        resolveWorkerReadyPromise();
        bumpWorkerInitEpoch((epoch) => epoch + 1);
        patchDurationsRef.current.length = 0;
        flushApplyRef.current.length = 0;
        longTaskDurationsRef.current.length = 0;
        recvToFlushRef.current.length = 0;
        reactCommitRef.current.length = 0;
        paintRef.current.length = 0;
        queueDepthRef.current.length = 0;
        flushBatchLogRef.current.length = 0;
        workerTotalsRef.current = {
          appendLineBatches: 0,
          appendLineTotalLines: 0,
          appendLineMaxLines: 0,
        };
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
        const catchUpIdx = latestIdxRef.current;
        if (catchUpIdx > 0) {
          const pending = fullTextRef.current.slice(0, catchUpIdx);
          if (pending) {
            client.append(pending);
            workerSentIdxRef.current = catchUpIdx;
          }
        }
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
        workerTotalsRef.current = {
          appendLineBatches: 0,
          appendLineTotalLines: 0,
          appendLineMaxLines: 0,
        };
        resetCoalescingStats();
        if (softDrainTimeoutRef.current) {
          clearTimeout(softDrainTimeoutRef.current);
          softDrainTimeoutRef.current = null;
        }
        return;
      }

      if (msg.type === "METRICS") {
        if (msg.metrics) {
          const totals = workerTotalsRef.current;
          const batchCount = msg.metrics.appendLineBatches ?? 0;
          const batchLines = msg.metrics.appendLineTotalLines ?? 0;
          const batchMax = msg.metrics.appendLineMaxLines ?? 0;
          if (batchCount > 0 || batchLines > 0 || batchMax > 0) {
            totals.appendLineBatches += batchCount;
            totals.appendLineTotalLines += batchLines;
            if (batchMax > totals.appendLineMaxLines) {
              totals.appendLineMaxLines = batchMax;
            }
          }
          const nextMetrics = {
            ...msg.metrics,
            appendLineBatchesTotal: totals.appendLineBatches,
            appendLineTotalLinesTotal: totals.appendLineTotalLines,
            appendLineMaxLinesTotal: totals.appendLineMaxLines,
          };
          lastMetricsRef.current = nextMetrics;
          if (debugTimingRef.current) {
            setLastMetrics(nextMetrics);
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
      workerReadyDeferredRef.current = null;
    };
  }, [
    PREWARM_LANGS,
    prewarm,
    mdxStrategy,
    resetCoalescingStats,
    resetWorkerReadyPromise,
    resolveWorkerReadyPromise,
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
      client.init("", prewarm ? PREWARM_LANGS : [], docPluginConfigRef.current, {
        compileMode: mdxStrategy,
      });
      pendingWorkerInitRef.current = null;
      workerInitTimerRef.current = null;
    }, 0);

    return () => {
      if (workerInitTimerRef.current) {
        clearTimeout(workerInitTimerRef.current);
        workerInitTimerRef.current = null;
      }
    };
  }, [rendererWorker, prewarm, PREWARM_LANGS, mdxStrategy]);

  useEffect(() => {
    setupWorker();
    return () => {
      workerCleanupRef.current?.();
      workerCleanupRef.current = null;
      workerRef.current = null;
    };
  }, [setupWorker]);

  // Send content to V2 worker
  useEffect(() => {
    if (!workerReadyStateRef.current) {
      return;
    }
    const ceiling = streamLimitRef.current ?? fullText.length;
    const target = Math.min(idx, ceiling);

    if (workerRef.current && target > workerSentIdxRef.current) {
      const start = workerSentIdxRef.current;
      const appended = fullText.slice(start, target);
      if (appended) {
        workerRef.current.append(appended);
        workerSentIdxRef.current = target;

        debugEventsRef.current.push({
          at: Date.now(),
          type: "APPEND",
          start,
          end: target,
          appendedLen: appended.length,
          totalBlocks: blocks.length,
        });
        const MAX_DEBUG_EVENTS = 500;
        if (debugEventsRef.current.length > MAX_DEBUG_EVENTS) {
          debugEventsRef.current.splice(0, debugEventsRef.current.length - MAX_DEBUG_EVENTS);
        }
      }
    }
  }, [idx, fullText, blocks.length]);

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
    if (!workerRef.current) {
      return;
    }
    if (!workerReadyStateRef.current) {
      return;
    }
    if (workerSentIdxRef.current < effectiveTotal) {
      return;
    }
    if (finished && !finalizedOnceRef.current) {
      workerRef.current.finalize();
      streamingRef.current?.finalize();
      finalizedOnceRef.current = true;
    } else if (!finished && finalizedOnceRef.current) {
      finalizedOnceRef.current = false;
    }
  }, [finished, effectiveTotal, workerInitEpoch]);

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
    restartPendingRef.current = wasRunning;
    setIsRunning(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
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
    workerTotalsRef.current = {
      appendLineBatches: 0,
      appendLineTotalLines: 0,
      appendLineMaxLines: 0,
    };
    streamStartRef.current = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
    firstMeaningfulMsRef.current = null;
    completionMsRef.current = null;
    setTimingSummary(createEmptyTimingSummary());
    finalizedOnceRef.current = false;
    bumpRunToken((token) => token + 1);
    setupWorker();
  }, [isRunning, setupWorker, bumpRunToken]);

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

  // Custom components for V2 renderer
  useEffect(() => {
    componentRegistry.current.setInlineComponents({
      mention: ({ handle }: { handle: string }) => (
        <a href={`https://x.com/${handle}`} className="text-[#A68AEB] underline-offset-4 hover:underline">
          @{handle}
        </a>
      ),
      "math-inline": ({ tex }: { tex: string }) => <InlineMath math={tex} />,
      "math-display": ({ tex }: { tex: string }) => <BlockMath math={tex} />,
    });

    const renderWithInline = (nodes: InlineNode[]) => renderInlineNodes(nodes, componentRegistry.current.getInlineComponents());

    componentRegistry.current.setBlockComponents({
      paragraph: ({
        inlines,
        raw,
      }: {
        inlines: InlineNode[];
        raw?: string;
      }) => {
        const filteredInlines = inlines.length > 0 && raw ? inlines.filter((node) => !(node.kind === "text" && node.text === raw)) : inlines;
        const baseInlines: InlineNode[] = filteredInlines.length > 0 ? filteredInlines : raw ? ([{ kind: "text", text: raw }] as InlineNode[]) : [];
        let hasDisplayMath = false;
        let key = 0;
        const segments: ReactNode[] = [];
        let buffer: InlineNode[] = [];

        const flushBuffer = () => {
          if (buffer.length === 0) return;
          segments.push(
            <p key={`segment-${key++}`} className="markdown-paragraph">
              {renderWithInline(buffer)}
            </p>,
          );
          buffer = [];
        };

        for (const node of baseInlines) {
          if (node.kind === "math-display") {
            hasDisplayMath = true;
            flushBuffer();
            segments.push(<BlockMath key={`math-${key++}`} math={node.tex} />);
          } else {
            buffer.push(node);
          }
        }
        flushBuffer();

        if (!hasDisplayMath) {
          return <p className="markdown-paragraph">{renderWithInline(baseInlines)}</p>;
        }

        return <div className="markdown-paragraph">{segments}</div>;
      },
      heading: ({
        level,
        inlines,
        text,
      }: {
        level: 1 | 2 | 3 | 4 | 5 | 6;
        inlines: InlineNode[];
        text?: string;
      }) => {
        const Tag = `h${level}` as const;
        const headingProps: Record<string, unknown> = {
          className: `markdown-heading markdown-h${level}`,
        };
        if (text && text.length > 0) {
          headingProps["data-heading-text"] = text;
        }
        return <Tag {...headingProps}>{renderWithInline(inlines)}</Tag>;
      },
      blockquote: ({
        inlines,
        renderedContent,
      }: {
        inlines: InlineNode[];
        renderedContent?: ReactNode;
      }) => <blockquote className="markdown-blockquote">{renderedContent ?? renderWithInline(inlines)}</blockquote>,
      list: ({
        ordered,
        items,
      }: {
        ordered: boolean;
        items: InlineNode[][];
      }) => {
        const Tag = ordered ? "ol" : "ul";
        return (
          <Tag className={`markdown-list ${ordered ? "ordered" : "unordered"}`}>
            {items.map((item, index) => {
              const synthesizedKey = item
                .map((node) => {
                  switch (node.kind) {
                    case "text":
                    case "code":
                      return `${node.kind}:${node.text}`;
                    case "link":
                      return `${node.kind}:${node.href ?? ""}:${node.title ?? ""}`;
                    case "image":
                      return `${node.kind}:${node.src}`;
                    case "mention":
                      return `${node.kind}:${node.handle}`;
                    default:
                      return node.kind;
                  }
                })
                .join("|");
              const key = synthesizedKey.length > 0 ? synthesizedKey : `list-item-${index}`;
              return (
                <li key={key} className="markdown-list-item">
                  {renderWithInline(item)}
                </li>
              );
            })}
          </Tag>
        );
      },
      code: ({
        html,
        raw,
        meta,
        lang,
        lines,
        preAttrs,
        codeAttrs,
      }: {
        html: string;
        raw?: string;
        meta?: Record<string, unknown>;
        lang?: string;
        lines?: ReadonlyArray<{
          id: string;
          index: number;
          text: string;
          html?: string | null;
        }>;
        preAttrs?: Record<string, string>;
        codeAttrs?: Record<string, string>;
      }) => {
        // Prefer explicit lines; otherwise derive from meta.code, else strip fences from raw.
        const fenced = typeof meta?.code === "string" && meta.code.length > 0 ? meta.code : raw ?? "";
        const stripFence = (value: string): string => {
          if (!value) return "";
          const trimmed = value.trimStart();
          if (!trimmed.startsWith("```")) return value;
          const parts = trimmed.split("\n");
          if (parts.length <= 1) return value;
          // Drop first fence line; drop last fence if present
          if (parts[parts.length - 1].trim().startsWith("```")) {
            return parts.slice(1, -1).join("\n");
          }
          return parts.slice(1).join("\n");
        };
        const rawCode = stripFence(fenced);
        const rawCodeLines = rawCode ? rawCode.split("\n") : [];
        const incomingLines = Array.isArray(lines) ? lines.map((l) => l.text ?? "") : [];
        const effectiveLines = rawCodeLines.length > 0 ? rawCodeLines : incomingLines;
        const languageLabel = typeof (lang ?? meta?.lang) === "string" && String(lang ?? meta?.lang).length > 0 ? String(lang ?? meta?.lang) : null;
        const showLabel = Boolean(showCodeMeta && languageLabel);

        return (
          <div className="flex flex-col">
            {showLabel ? (
              <div className="border-border/60 border-b bg-muted/40 px-3 py-1 font-mono text-muted-foreground text-xs">{languageLabel}</div>
            ) : null}
            <ScrollAreaHorizontal className="min-w-auto">
              <div className="min-w-max p-4">
                {html ? (
                  <div
                    className="[&_pre]:m-0 [&_pre]:overflow-x-visible [&_pre]:bg-transparent [&_pre]:p-0"
                    /* biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized upstream */
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                ) : effectiveLines.length > 0 ? (
                  <pre className="m-0" {...attrsToProps(preAttrs)}>
                    <code {...attrsToProps(codeAttrs)}>
                      {effectiveLines.map((text, idx) => (
                        <span
                          key={`line-${idx}`}
                          className="line"
                          dangerouslySetInnerHTML={{
                            __html: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
                          }}
                        />
                      ))}
                    </code>
                  </pre>
                ) : null}
              </div>
            </ScrollAreaHorizontal>
          </div>
        );
      },
      table: ({
        header,
        rows,
        align,
        elements,
      }: {
        header?: InlineNode[][];
        rows: InlineNode[][][];
        align?: Array<"left" | "center" | "right" | null>;
        elements?: Partial<TableElements>;
      }) => {
        const El: TableElements = { ...tableElements, ...(elements || {}) };
        const renderCells = (cells: InlineNode[][], tag: "th" | "td", rowIdx: number) =>
          cells.map((cell, i) => {
            const columnAlign = align?.[i] ?? undefined;
            const cellStyle = columnAlign ? ({ textAlign: columnAlign } satisfies CSSProperties) : undefined;
            const Comp = tag === "th" ? El.Th : El.Td;
            return (
              <Comp key={`${rowIdx}-${i}`} style={cellStyle} align={columnAlign ?? undefined}>
                {renderWithInline(cell)}
              </Comp>
            );
          });

        return (
          <ScrollAreaHorizontal className="my-6 w-full rounded border border-border">
            <div className="min-w-max">
              <El.Table className="w-full caption-bottom text-base">
                {header && header.length > 0 ? <El.Thead>{<El.Tr>{renderCells(header, "th", -1)}</El.Tr>}</El.Thead> : null}
                <El.Tbody>{rows.map((row, r) => createElement(El.Tr, { key: r }, renderCells(row, "td", r)))}</El.Tbody>
              </El.Table>
            </div>
          </ScrollAreaHorizontal>
        );
      },
    });

    // Use ShadCN table components for both structured tables and HTML tables
    componentRegistry.current.setTableElements(tableElements);
    componentRegistry.current.setHtmlElements(htmlElements);
  }, [showCodeMeta, tableElements, htmlElements]);

  useEffect(() => {
    if (!SHOULD_EXPOSE_AUTOMATION_API) return;
    if (typeof window === "undefined") return;
    if (typeof console !== "undefined" && !automationWarningLoggedRef.current) {
      console.warn(
        `[StreamingMarkdown demo] window.__STREAMING_DEMO__ is a demo-only automation shim. Prefer the StreamingMarkdownHandle ref.\nSee ${AUTOMATION_DOC_LINK}`,
      );
      automationWarningLoggedRef.current = true;
    }
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
    api.fastForward = async () => {
      // Ensure worker is ready before forcing a full append
      if (!workerReadyStateRef.current && workerReadyDeferredRef.current) {
        try {
          await workerReadyDeferredRef.current.promise;
        } catch {
          // ignore readiness errors
        }
      }
      if (!workerRef.current) {
        console.warn("[StreamingMarkdown demo] fastForward requested but worker not ready");
        return;
      }
      const target = streamLimitRef.current ?? fullTextRef.current.length;
      const start = workerSentIdxRef.current;
      const remaining = target - start;
      if (remaining > 0) {
        const chunk = fullTextRef.current.slice(start, target);
        if (chunk) {
          try {
            workerRef.current.append(chunk);
          } catch (error) {
            console.error("[StreamingMarkdown demo] fastForward append failed", error);
          }
        }
      }
      workerSentIdxRef.current = target;
      setIdx(target);
      setIsRunning(false);
    };
    api.setMdxEnabled = (enabled: boolean) => {
      docPluginConfigRef.current = {
        ...docPluginConfigRef.current,
        mdx: Boolean(enabled),
      };
      onRestart();
    };
    api.setMdxStrategy = (mode: "server" | "worker") => {
      mdxStrategyRef.current = mode;
      setMdxStrategy(mode);
      onRestart();
    };
    api.restart = () => onRestart();
    api.pause = () => setIsRunning(false);
    api.resume = () => setIsRunning(true);
    api.finalize = () => {
      workerRef.current?.finalize?.();
      streamingRef.current?.finalize();
    };
    api.getHandle = () => streamingRef.current;
    api.flushPending = async () => {
      streamingRef.current?.flushPending();
      await streamingRef.current?.waitForIdle?.();
    };
    api.waitForIdle = async () => {
      if (streamingRef.current) {
        await streamingRef.current.waitForIdle();
      }
    };
    api.waitForWorker = async () => {
      if (workerReadyStateRef.current) {
        return;
      }
      const deferred = workerReadyDeferredRef.current;
      if (deferred) {
        await deferred.promise;
        return;
      }
      const start = Date.now();
      const timeoutMs = 15_000;
      while (!workerReadyStateRef.current) {
        if (Date.now() - start > timeoutMs) {
          throw new Error("Worker did not initialize within the expected window.");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
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
      workerTotals: { ...workerTotalsRef.current },
      coalescingTotals: { ...coalescingTotalsRef.current },
      scheduler: {
        adaptiveBudgetActive: schedulerBudgetRef.current.active,
        coalescingDurationP95: schedulerBudgetRef.current.p95,
        coalescingSampleCount: schedulerBudgetRef.current.sampleCount,
      },
      flushBatches: flushBatchLogRef.current.map((entry) => ({ ...entry })),
    });
    api.getState = () => ({
      idx,
      total: effectiveTotal,
      isRunning,
      isPending,
      fullTextLength: fullTextRef.current.length,
      finished,
      streamLimit: streamLimitRef.current,
      workerSentIdx: workerSentIdxRef.current,
      workerCredits: workerCreditsRef.current,
      timerActive: Boolean(timerRef.current),
      mode: modeRef.current,
      rate,
      tickMs,
      renderer: {
        version: rendererVersion,
        patchMode: hasPatchPipelineRef.current,
      },
      patchStats: { last: lastPatchSummaryRef.current, totals: patchTotalsRef.current },
      renderTimes,
      timings: timingSummary,
    });
    window.__STREAMING_DEMO__ = api;
  }, [
    idx,
    effectiveTotal,
    isRunning,
    rate,
    tickMs,
    rendererVersion,
    renderTimes,
    timingSummary,
    onRestart,
    getCodeBlockSnapshot,
    updateStreamLimit,
  ]);

  const coalescingTotalsSnapshot = coalescingPanel.totals;
  const coalescingRecent = coalescingPanel.recent;
  const coalescingSparkline = coalescingPanel.sparkline;
  const coalescingAdaptiveState = coalescingPanel.adaptiveState;

  return (
    <div className={cn("flex w-full flex-col gap-4", className)}>
      {SHOULD_EXPOSE_AUTOMATION_API && (
        <div className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">Automation API is demo-only.</p>
          <p className="mt-1">
            The <code>window.__STREAMING_DEMO__</code> shim only exists for internal tooling. Use the <code>StreamingMarkdownHandle</code> ref instead. See{" "}
            {AUTOMATION_DOC_LINK}.
          </p>
        </div>
      )}
      <div className={cn("flex flex-col gap-3 rounded-lg border border-border p-4")}>
        <div className="flex items-center justify-between">
          <div className="text-muted text-sm">V2 Streaming Controls</div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="default" onClick={() => setIsRunning((r) => !r)}>
              {isRunning ? "Pause" : "Resume"}
            </Button>
            <Button size="sm" variant="secondary" onClick={onRestart}>
              Restart
            </Button>
            <Button size="sm" variant="outline" onClick={exportDebug}>
              Export debug
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between text-muted text-xs">
          <span>Theme</span>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-2 text-xs">
              <input type="checkbox" checked={theme === "dark"} onChange={(e) => setTheme(e.target.checked ? "dark" : "light")} />
              <span>Dark theme</span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between text-muted text-xs">
          <span>HTML/MDX compilation</span>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="radio"
                name="mdx-strategy"
                value="server"
                checked={mdxStrategy === "server"}
                onChange={() => {
                  if (mdxStrategyRef.current !== "server") {
                    mdxStrategyRef.current = "server";
                    setMdxStrategy("server");
                    onRestart();
                  }
                }}
              />
              <span>Server (API)</span>
            </label>
            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="radio"
                name="mdx-strategy"
                value="worker"
                checked={mdxStrategy === "worker"}
                onChange={() => {
                  if (mdxStrategyRef.current !== "worker") {
                    mdxStrategyRef.current = "worker";
                    setMdxStrategy("worker");
                    onRestart();
                  }
                }}
              />
              <span>Client (Worker)</span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between text-muted text-xs">
          <span>Pre-warm languages</span>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={prewarm} onChange={(e) => setPrewarm(e.target.checked)} />
          </div>
        </div>

        <div className="flex items-center justify-between text-muted text-xs">
          <span>Debug timing</span>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={debugTiming} onChange={(e) => setDebugTiming(e.target.checked)} />
          </div>
        </div>

        <div className="flex items-center justify-between text-muted text-xs">
          <span>Block inspector</span>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={showInspector} onChange={(e) => setShowInspector(e.target.checked)} />
          </div>
        </div>

        <div className="flex items-center justify-between text-muted text-xs">
          <span>Show code header meta</span>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={showCodeMeta} onChange={(e) => setShowCodeMeta(e.target.checked)} />
          </div>
        </div>

        <div className="flex items-center justify-between text-muted text-xs">
          <span>Format anticipation</span>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={formatAnticipationEnabled}
              onChange={(e) => {
                const enabled = e.target.checked;
                setFormatAnticipationEnabled(enabled);
                docPluginConfigRef.current = { ...docPluginConfigRef.current, formatAnticipation: enabled };
                onRestart();
              }}
            />
          </div>
        </div>

        <div className="flex items-center justify-between text-muted text-xs">
          <span>Live code highlighting (slow)</span>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={liveCodeHighlightingEnabled}
              onChange={(e) => {
                const enabled = e.target.checked;
                setLiveCodeHighlightingEnabled(enabled);
                docPluginConfigRef.current = { ...docPluginConfigRef.current, liveCodeHighlighting: enabled };
                onRestart();
              }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-muted text-xs">
            <span>Rate</span>
            <span>{rate} chars/sec</span>
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

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-muted text-xs">
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

        <div className="flex items-center justify-between text-muted text-xs">
          <span>
            Progress: {idx.toLocaleString()} / {maxLen.toLocaleString()} chars
          </span>
          <span>{finished ? "Completed" : !isRunning ? "Paused" : showRendering ? "Rendering…" : "Streaming"}</span>
        </div>

        {debugTiming && (
          <div className="rounded-md border border-border bg-background/50 p-2">
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
        )}

        <div className="rounded-md border border-border bg-background/60 p-3">
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
              <div>append lines {formatCount(coalescingTotalsSnapshot.appendLines, 0)}</div>
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

        {debugTiming && (
          <div className="rounded-md border border-border bg-background/50 p-2 font-mono text-[11px]">
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
                      <span>appendLines merged</span>
                      <span className="text-right text-foreground/80">{formatCount(totals.appendLines, 0)}</span>
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
        )}

        {showInspector && (
          <div className="rounded-md border border-border bg-background/50 p-2 font-mono text-xs">
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
      </div>

      {/* V2 Renderer Output */}
      <div data-testid="markdown-output" className={cn("prose max-w-none", theme === "dark" ? "prose-invert" : "")}>
        <StreamingMarkdown
          ref={streamingHandleRef}
          worker={rendererWorker ?? undefined}
          managedWorker={Boolean(rendererWorker)}
          className="markdown-v2-output"
          features={docPluginConfigRef.current}
          scheduling={rendererScheduling}
          mdxCompileMode={mdxStrategy}
          mdxComponents={sharedMdxComponents as unknown as Record<string, ComponentType<unknown>>}
          prewarmLangs={prewarm ? PREWARM_LANGS : []}
          components={componentRegistry.current.getBlockComponentMap()}
          inlineComponents={componentRegistry.current.getInlineComponentMap()}
          tableElements={tableElements}
          htmlElements={htmlElements}
          style={{ contain: "content" }}
          onError={handleRendererError}
        />
      </div>
    </div>
  );
}
