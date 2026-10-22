import type { Block, Patch, PerformanceMetrics } from "@stream-mdx/core";
import type { StreamingMarkdownHandle } from "@stream-mdx/react";
import type { CoalescingMetrics } from "@stream-mdx/react/renderer/patch-coalescing";
import type { RendererStore } from "@stream-mdx/react/renderer/store";

export type PatchSummary = { tx: number; count: number; byOp: Record<string, number> };

type AutomationState = {
  idx: number;
  total: number;
  isRunning: boolean;
  mode: "classic" | "worker";
  schedulingPreset?: "latency" | "throughput";
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

export type AutomationCodeBlockSnapshot = {
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

export type FlushBatchSample = {
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

export type DebugEvent = AppendDebugEvent | PatchEnqueueDebugEvent | PatchBufferDebugEvent | PatchFlushDebugEvent;

export type StreamingDemoAutomationApiV2 = {
  setRate?: (value: number) => void;
  setTick?: (value: number) => void;
  setMode?: (mode: "classic" | "worker") => void;
  setSchedulingPreset?: (preset: "latency" | "throughput") => void;
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
  getWorker?: () => Worker | null;
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
    coalescingTotals?: {
      input: number;
      output: number;
      coalesced: number;
      setProps: number;
      insertChild: number;
      durationMs: number;
    } | null;
    mdxHydration?: {
      pending: number;
      compiled: number;
      hydrated: number;
      error: number;
      avgHydrationMs: number | null;
      p95HydrationMs: number | null;
      maxHydrationMs: number | null;
      lastHydrationMs: number | null;
      longTaskTotalMs?: number | null;
      longTaskCount?: number | null;
      p95LongTaskMs?: number | null;
      maxLongTaskMs?: number | null;
      prefetch?: {
        requested: number;
        completed: number;
        error: number;
        pending: number;
        avgPrefetchMs: number | null;
        p95PrefetchMs: number | null;
        maxPrefetchMs: number | null;
        lastPrefetchMs: number | null;
      } | null;
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
    setProps: number;
    insertChild: number;
    durationMs: number;
  };
};

export type StatSummary = {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  latestMs: number;
};

export type TimingSummary = {
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
