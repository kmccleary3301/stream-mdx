import type { Patch, PatchMetrics } from "@stream-mdx/core";
import { type CoalescingMetrics, DEFAULT_COALESCE_CONFIG, coalescePatchesWithMetrics } from "./patch-coalescing";
import type { RendererStore } from "./store";

type NowFn = () => number;

export interface AdaptiveBudgetState {
  /** Whether adaptive throttling is currently engaged */
  active: boolean;
  /** Current high-priority batch cap when adaptive mode is active */
  highBatchCap?: number;
  /** Current low-priority batch cap when adaptive mode is active */
  lowBatchCap?: number;
  /** Coalescing-duration threshold (ms) that activates adaptive mode */
  activateThresholdMs: number;
  /** Coalescing-duration threshold (ms) that deactivates adaptive mode */
  deactivateThresholdMs: number;
  /** Latest observed coalescing p95 in milliseconds */
  lastObservedP95?: number | null;
}

export interface PatchBatchMeta {
  tx?: number;
  metrics?: PatchMetrics;
  receivedAt?: number;
  priority?: "high" | "low";
}

export interface PatchBatchInput {
  patches: Patch[];
  meta?: PatchBatchMeta;
}

export interface PatchFlushBatchResult {
  tx?: number;
  metrics?: PatchMetrics;
  patchCount: number;
  appliedPatchCount: number;
  durationMs: number;
  touched: Set<string>;
  queueDelayMs: number;
  receivedAt: number;
  appliedAt: number;
  priority: "high" | "low";
  coalescing?: CoalescingMetrics;
}

export interface PatchFlushResult {
  batches: PatchFlushBatchResult[];
  totalPatches: number;
  totalAppliedPatches: number;
  totalDurationMs: number;
  remainingQueueSize: number;
  queueDepthBefore: number;
  flushStartedAt: number;
  flushCompletedAt: number;
  coalescingDurationP95?: number | null;
  coalescingDurationSampleCount?: number;
  adaptiveBudgetActive?: boolean;
  adaptiveBudgetState?: AdaptiveBudgetState;
}

export interface PatchCommitSchedulerOptions {
  frameBudgetMs?: number;
  maxBatchesPerFlush?: number;
  raf?: typeof requestAnimationFrame;
  cancelRaf?: typeof cancelAnimationFrame;
  timeoutMs?: number;
  now?: NowFn;
  lowPriorityFrameBudgetMs?: number;
  maxLowPriorityBatchesPerFlush?: number;
  urgentQueueThreshold?: number;
  batch?: "rAF" | "microtask" | "timeout";
  historyLimit?: number;
}

interface PatchBatchInternal {
  seq: number;
  patches: Patch[];
  meta: PatchBatchMeta;
  receivedAt: number;
  priority: "high" | "low";
}

const DEFAULT_TIMEOUT_MS = 16;
const COALESCING_DURATION_SAMPLE_LIMIT = 60;
const COALESCING_DURATION_ACTIVATE_MS = 6;
const COALESCING_DURATION_DEACTIVATE_MS = 4;
const RETAIN_TOUCHED_IN_HISTORY =
  typeof process !== "undefined" && process.env ? process.env.NODE_ENV !== "production" : true;
const EMPTY_TOUCHED_SET = new Set<string>();

function getDefaultNow(): NowFn {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return () => performance.now();
  }
  return () => Date.now();
}

function getDefaultRaf(): typeof requestAnimationFrame | null {
  if (typeof globalThis !== "undefined") {
    const candidate = (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame;
    if (typeof candidate === "function") {
      return candidate.bind(globalThis);
    }
  }
  return null;
}

function getDefaultCancelRaf(): typeof cancelAnimationFrame | null {
  if (typeof globalThis !== "undefined") {
    const candidate = (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame;
    if (typeof candidate === "function") {
      return candidate.bind(globalThis);
    }
  }
  return null;
}

export class PatchCommitScheduler {
  private readonly store: RendererStore;
  private readonly onFlush: (result: PatchFlushResult) => void;
  private frameBudgetMs: number;
  private maxBatchesPerFlush?: number;
  private readonly now: NowFn;
  private readonly raf: typeof requestAnimationFrame | null;
  private readonly cancelRaf: typeof cancelAnimationFrame | null;
  private readonly timeoutMs: number;

  private lowPriorityFrameBudgetMs: number;
  private maxLowPriorityBatchesPerFlush?: number;
  private urgentQueueThreshold: number;

  private highQueue: PatchBatchInternal[] = [];
  private lowQueue: PatchBatchInternal[] = [];
  private scheduled = false;
  private flushing = false;
  private scheduledHandle: number | ReturnType<typeof setTimeout> | null = null;
  private scheduledViaRaf = false;
  private sequence = 0;
  private idleResolvers: Array<() => void> = [];
  private paused = false;
  private history: PatchFlushResult[] = [];
  private historyLimit: number;
  private batchStrategy: "rAF" | "timeout" | "microtask";
  private scheduleToken = 0;
  private coalescingDurationSamples: number[] = [];
  private adaptiveBudgetActive = false;
  private adaptiveHighBatchCap: number | undefined;
  private adaptiveLowBatchCap: number | undefined;

  constructor(params: {
    store: RendererStore;
    onFlush: (result: PatchFlushResult) => void;
    options?: PatchCommitSchedulerOptions;
  }) {
    this.store = params.store;
    this.onFlush = params.onFlush;
    this.frameBudgetMs = Math.max(1, params.options?.frameBudgetMs ?? 10);
    this.maxBatchesPerFlush = params.options?.maxBatchesPerFlush ?? 12;
    this.now = params.options?.now ?? getDefaultNow();
    this.raf = params.options?.raf ?? getDefaultRaf();
    this.cancelRaf = params.options?.cancelRaf ?? getDefaultCancelRaf();
    this.timeoutMs = Math.max(1, params.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.lowPriorityFrameBudgetMs = Math.max(
      1,
      params.options?.lowPriorityFrameBudgetMs ?? Math.max(2, Math.floor(this.frameBudgetMs * 0.6)),
    );
    this.maxLowPriorityBatchesPerFlush = params.options?.maxLowPriorityBatchesPerFlush ?? 2;
    this.urgentQueueThreshold = Math.max(1, params.options?.urgentQueueThreshold ?? 4);
    this.historyLimit = Math.max(1, params.options?.historyLimit ?? 200);
    const requestedBatch = params.options?.batch;
    if (requestedBatch === "microtask") {
      this.batchStrategy = "microtask";
    } else if (requestedBatch === "timeout") {
      this.batchStrategy = "timeout";
    } else if (requestedBatch === "rAF") {
      this.batchStrategy = this.raf ? "rAF" : "timeout";
    } else {
      this.batchStrategy = "microtask";
    }
    if (this.batchStrategy === "microtask" && typeof queueMicrotask !== "function") {
      this.batchStrategy = this.raf ? "rAF" : "timeout";
    }
  }

  enqueue(input: PatchBatchInput): void {
    if (!input || !input.patches || input.patches.length === 0) {
      return;
    }
    if (!this.paused && !this.flushing && this.getPendingCount() >= this.urgentQueueThreshold) {
      this.runFlush(this.frameBudgetMs, false);
    }
    const batch: PatchBatchInternal = {
      seq: ++this.sequence,
      patches: input.patches,
      meta: input.meta ?? {},
      receivedAt: input.meta?.receivedAt ?? this.now(),
      priority: input.meta?.priority === "low" ? "low" : "high",
    };
    if (batch.priority === "low") {
      this.lowQueue.push(batch);
    } else {
      this.highQueue.push(batch);
    }
    if (!this.paused) {
      this.schedule();
    }
  }

  flushAll(): PatchFlushResult | null {
    if (this.highQueue.length === 0 && this.lowQueue.length === 0 && !this.flushing) {
      return null;
    }
    this.cancelScheduled();
    const result = this.runFlush(Number.POSITIVE_INFINITY, true);
    this.maybeResolveIdle();
    return result;
  }

  clear(): void {
    this.cancelScheduled();
    this.highQueue = [];
    this.lowQueue = [];
    this.flushing = false;
    this.coalescingDurationSamples = [];
    this.adaptiveBudgetActive = false;
    this.adaptiveHighBatchCap = undefined;
    this.adaptiveLowBatchCap = undefined;
    this.maybeResolveIdle();
  }

  getPendingCount(): number {
    return this.highQueue.length + this.lowQueue.length;
  }

  isIdle(): boolean {
    return !this.flushing && !this.scheduled && this.highQueue.length === 0 && this.lowQueue.length === 0;
  }

  awaitIdle(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private schedule() {
    if (this.paused) {
      return;
    }
    if (this.scheduled || this.flushing) {
      return;
    }
    const token = ++this.scheduleToken;
    this.scheduled = true;
    const execute = () => {
      if (token !== this.scheduleToken) {
        this.scheduled = false;
        this.scheduledHandle = null;
        this.scheduledViaRaf = false;
        this.maybeResolveIdle();
        return;
      }
      if (this.paused) {
        this.scheduled = false;
        this.scheduledHandle = null;
        this.scheduledViaRaf = false;
        this.maybeResolveIdle();
        return;
      }
      this.scheduled = false;
      this.scheduledHandle = null;
      this.scheduledViaRaf = false;
      this.runFlush(this.frameBudgetMs, false);
      this.maybeResolveIdle();
    };

    if (this.batchStrategy === "microtask" && typeof queueMicrotask === "function") {
      this.scheduledViaRaf = false;
      this.scheduledHandle = token;
      queueMicrotask(execute);
    } else if (this.batchStrategy === "rAF" && this.raf) {
      this.scheduledViaRaf = true;
      this.scheduledHandle = this.raf(() => execute());
    } else {
      this.scheduledViaRaf = false;
      this.scheduledHandle = setTimeout(() => execute(), this.timeoutMs);
    }
  }

  private cancelScheduled() {
    if (!this.scheduled) return;
    this.scheduleToken++;
    if (this.scheduledHandle !== null) {
      if (this.scheduledViaRaf && this.cancelRaf) {
        this.cancelRaf(this.scheduledHandle as number);
      } else {
        clearTimeout(this.scheduledHandle as ReturnType<typeof setTimeout>);
      }
    }
    this.scheduled = false;
    this.scheduledHandle = null;
    this.scheduledViaRaf = false;
  }

  private runFlush(budgetMs: number, manual: boolean): PatchFlushResult | null {
    if (this.paused && !manual) {
      return null;
    }
    if (this.highQueue.length === 0 && this.lowQueue.length === 0) {
      return null;
    }

    this.flushing = true;
    const startedAt = this.now();
    const initialQueueSize = this.highQueue.length + this.lowQueue.length;
    const batches: PatchFlushBatchResult[] = [];
    let totalInputPatches = 0;
    let totalAppliedPatches = 0;
    let elapsed = 0;

    const processQueue = (queue: PatchBatchInternal[], maxBatches?: number, budgetLimit?: number) => {
      const effectiveBudget = manual ? Number.POSITIVE_INFINITY : Math.max(0, budgetLimit ?? budgetMs);
      const startingBatchCount = batches.length;
      let consumed = 0;
      while (consumed < queue.length) {
        const next = queue[consumed];
        if (!next) break;
        consumed += 1;
        const applyStart = this.now();
        const queueDelayMs = Math.max(0, applyStart - next.receivedAt);
        const { patches: coalesced, metrics: coalescingMetrics } = coalescePatchesWithMetrics(next.patches, DEFAULT_COALESCE_CONFIG);
        const touched = this.store.applyPatches(coalesced, {
          coalesced: true,
          metrics: coalescingMetrics,
        });
        const durationMs = this.now() - applyStart;
        this.recordCoalescingDuration(coalescingMetrics?.durationMs);
        totalInputPatches += next.patches.length;
        totalAppliedPatches += coalesced.length;
        batches.push({
          tx: next.meta.tx,
          metrics: next.meta.metrics,
          patchCount: next.patches.length,
          appliedPatchCount: coalesced.length,
          durationMs,
          touched,
          queueDelayMs,
          receivedAt: next.receivedAt,
          appliedAt: applyStart,
          priority: next.priority,
          coalescing: coalescingMetrics,
        });

        if (maxBatches && batches.length - startingBatchCount >= maxBatches) {
          break;
        }

        if (!manual) {
          elapsed = this.now() - startedAt;
          if (elapsed >= effectiveBudget) {
            break;
          }
        }
      }
      if (consumed > 0) {
        queue.splice(0, consumed);
      }
    };

    const initialHighQueueSize = this.highQueue.length;
    const configuredHighLimit =
      manual || !this.maxBatchesPerFlush ? undefined : initialHighQueueSize > this.maxBatchesPerFlush ? undefined : this.maxBatchesPerFlush;
    const highBatchLimit = this.adaptiveHighBatchCap ?? configuredHighLimit;

    processQueue(this.highQueue, highBatchLimit, budgetMs);

    if (manual) {
      processQueue(this.lowQueue, undefined, Number.POSITIVE_INFINITY);
    } else if (this.lowQueue.length > 0) {
      elapsed = this.now() - startedAt;
      const budgetForLow = Math.max(0, this.lowPriorityFrameBudgetMs - elapsed);
      if (budgetForLow > 0) {
        const initialLowQueueSize = this.lowQueue.length;
        const configuredLowLimit =
          manual || !this.maxLowPriorityBatchesPerFlush
            ? undefined
            : initialLowQueueSize > this.maxLowPriorityBatchesPerFlush
              ? undefined
              : this.maxLowPriorityBatchesPerFlush;
        const lowBatchLimit = this.adaptiveLowBatchCap ?? configuredLowLimit;

        processQueue(this.lowQueue, lowBatchLimit, budgetForLow);
      }
    }

    this.flushing = false;
    const completedAt = this.now();
    const totalDurationMs = completedAt - startedAt;
    const remaining = this.highQueue.length + this.lowQueue.length;

    if (batches.length > 0) {
      try {
        this.onFlush({
          batches,
          totalPatches: totalInputPatches,
          totalAppliedPatches,
          totalDurationMs,
          remainingQueueSize: remaining,
          queueDepthBefore: initialQueueSize,
          flushStartedAt: startedAt,
          flushCompletedAt: completedAt,
        });
      } catch (error) {
        console.error("[patch-scheduler] onFlush callback failed", error);
      }
    }

    if (remaining > 0 && !this.paused) {
      this.schedule();
    }

    const coalescingStats = this.computeCoalescingDurationStats();
    this.updateAdaptiveBudget(coalescingStats.p95);
    const adaptiveState = this.snapshotAdaptiveBudget(coalescingStats.p95 ?? null);

    const flushResult =
      batches.length > 0
        ? {
            batches,
            totalPatches: totalInputPatches,
            totalAppliedPatches,
            totalDurationMs,
            remainingQueueSize: remaining,
            queueDepthBefore: initialQueueSize,
            flushStartedAt: startedAt,
            flushCompletedAt: completedAt,
            coalescingDurationP95: coalescingStats.p95 ?? undefined,
            coalescingDurationSampleCount: coalescingStats.sampleCount,
            adaptiveBudgetActive: adaptiveState.active,
            adaptiveBudgetState: adaptiveState,
          }
        : null;

    if (flushResult) {
      this.recordHistory(flushResult);
    }

    return flushResult;
  }

  private recordCoalescingDuration(value: number | null | undefined): void {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return;
    }
    this.coalescingDurationSamples.push(value);
    if (this.coalescingDurationSamples.length > COALESCING_DURATION_SAMPLE_LIMIT) {
      this.coalescingDurationSamples.splice(0, this.coalescingDurationSamples.length - COALESCING_DURATION_SAMPLE_LIMIT);
    }
  }

  private computeCoalescingDurationStats(): { sampleCount: number; p95: number | null } {
    if (this.coalescingDurationSamples.length === 0) {
      return { sampleCount: 0, p95: null };
    }
    const sorted = [...this.coalescingDurationSamples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(0.95 * (sorted.length - 1))));
    return { sampleCount: this.coalescingDurationSamples.length, p95: sorted[index] ?? null };
  }

  private snapshotAdaptiveBudget(latestP95: number | null): AdaptiveBudgetState {
    return {
      active: this.adaptiveBudgetActive,
      highBatchCap: this.adaptiveHighBatchCap,
      lowBatchCap: this.adaptiveLowBatchCap,
      activateThresholdMs: COALESCING_DURATION_ACTIVATE_MS,
      deactivateThresholdMs: COALESCING_DURATION_DEACTIVATE_MS,
      lastObservedP95: typeof latestP95 === "number" ? latestP95 : null,
    };
  }

  private updateAdaptiveBudget(p95: number | null): void {
    if (p95 !== null && p95 > COALESCING_DURATION_ACTIVATE_MS) {
      if (!this.adaptiveBudgetActive) {
        this.adaptiveBudgetActive = true;
        this.adaptiveHighBatchCap = this.computeAdaptiveCap(this.maxBatchesPerFlush, 2);
        this.adaptiveLowBatchCap = this.computeAdaptiveCap(this.maxLowPriorityBatchesPerFlush, 1);
      }
    } else if (this.adaptiveBudgetActive && (p95 === null || p95 < COALESCING_DURATION_DEACTIVATE_MS)) {
      this.adaptiveBudgetActive = false;
      this.adaptiveHighBatchCap = undefined;
      this.adaptiveLowBatchCap = undefined;
    }
  }

  private computeAdaptiveCap(configured?: number, fallback = 1): number {
    if (configured === undefined || configured <= 0) {
      return Math.max(1, fallback);
    }
    return Math.max(1, Math.floor(configured / 2));
  }

  private maybeResolveIdle() {
    if (!this.isIdle()) {
      return;
    }
    if (this.idleResolvers.length === 0) {
      return;
    }
    const pending = this.idleResolvers.slice();
    this.idleResolvers = [];
    for (const resolve of pending) {
      try {
        resolve();
      } catch (error) {
        console.error("[patch-scheduler] idle resolver failed", error);
      }
    }
  }

  private recordHistory(result: PatchFlushResult) {
    if (RETAIN_TOUCHED_IN_HISTORY) {
      this.history.push(result);
    } else {
      const trimmed: PatchFlushResult = {
        ...result,
        batches: result.batches.map((batch) => ({
          ...batch,
          touched: EMPTY_TOUCHED_SET,
        })),
      };
      this.history.push(trimmed);
    }
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
  }

  pause(): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    this.cancelScheduled();
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    if (this.getPendingCount() > 0) {
      this.schedule();
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  restart(): void {
    this.cancelScheduled();
    this.highQueue = [];
    this.lowQueue = [];
    this.flushing = false;
    this.sequence = 0;
    this.history = [];
    this.scheduleToken++;
    this.paused = false;
    this.coalescingDurationSamples = [];
    this.adaptiveBudgetActive = false;
    this.adaptiveHighBatchCap = undefined;
    this.adaptiveLowBatchCap = undefined;
    this.maybeResolveIdle();
  }

  getHistory(limit?: number): ReadonlyArray<PatchFlushResult> {
    if (limit === undefined || limit >= this.history.length) {
      return [...this.history];
    }
    return this.history.slice(this.history.length - limit);
  }

  setHistoryLimit(limit: number): void {
    this.historyLimit = Math.max(1, limit);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
  }

  updateOptions(options: PatchCommitSchedulerOptions): void {
    if (!options) return;
    let shouldReschedule = false;

    if (typeof options.frameBudgetMs !== "undefined") {
      this.frameBudgetMs = Math.max(1, options.frameBudgetMs);
      shouldReschedule = true;
    }
    if (typeof options.maxBatchesPerFlush !== "undefined") {
      this.maxBatchesPerFlush = options.maxBatchesPerFlush;
      shouldReschedule = true;
    }
    if (typeof options.lowPriorityFrameBudgetMs !== "undefined") {
      this.lowPriorityFrameBudgetMs = Math.max(1, options.lowPriorityFrameBudgetMs);
      shouldReschedule = true;
    }
    if (typeof options.maxLowPriorityBatchesPerFlush !== "undefined") {
      this.maxLowPriorityBatchesPerFlush = options.maxLowPriorityBatchesPerFlush;
      shouldReschedule = true;
    }
    if (typeof options.urgentQueueThreshold !== "undefined") {
      this.urgentQueueThreshold = Math.max(1, options.urgentQueueThreshold);
      shouldReschedule = true;
    }
    if (typeof options.historyLimit !== "undefined") {
      this.setHistoryLimit(options.historyLimit);
    }
    if (typeof options.batch !== "undefined") {
      const requestedBatch = options.batch;
      if (requestedBatch === "microtask") {
        this.batchStrategy = "microtask";
      } else if (requestedBatch === "timeout") {
        this.batchStrategy = "timeout";
      } else if (requestedBatch === "rAF") {
        this.batchStrategy = this.raf ? "rAF" : "timeout";
      }
      if (this.batchStrategy === "microtask" && typeof queueMicrotask !== "function") {
        this.batchStrategy = this.raf ? "rAF" : "timeout";
      }
      shouldReschedule = true;
    }

    if (shouldReschedule && !this.paused && !this.flushing && this.getPendingCount() > 0) {
      this.cancelScheduled();
      this.schedule();
    }
  }

  clearHistory(): void {
    this.history = [];
  }
}
