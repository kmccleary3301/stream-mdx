"use client";

import type { InlineNode } from "@stream-mdx/core";
import type { RendererStateSnapshot, StreamingSchedulerOptions, StreamingMarkdownProps } from "@stream-mdx/react";
import { createTrustedMdxEngine } from "@stream-mdx/react/trusted-mdx";
import { useCallback, useEffect, useMemo, useRef, useState, type ElementType } from "react";

import { SourceCapacityError, StreamingMarkdown, type AppendResult, type FinalizeResult, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { components as trustedMdxElements } from "@/mdx-components";
import { createDemoComponents } from "@/lib/streaming-demo-registry";

const regressionMdxEngine = createTrustedMdxEngine({
  components: trustedMdxElements as Readonly<Record<string, ElementType>>,
});
const regressionMdxEngines = { mdx: regressionMdxEngine };

const DEFAULT_FORMAT_ANTICIPATION = {
  inline: true,
  mathInline: true,
  mathBlock: true,
  html: true,
  mdx: true,
  regex: false,
};

const DEFAULT_FEATURES: NonNullable<StreamingMarkdownProps["features"]> = {
  html: true,
  tables: true,
  math: true,
  mdx: true,
  footnotes: true,
  callouts: true,
  formatAnticipation: DEFAULT_FORMAT_ANTICIPATION,
  codeHighlighting: "incremental",
  liveCodeHighlighting: false,
};

const DEFAULT_SCHEDULING: StreamingSchedulerOptions = {
  batch: "microtask",
  frameBudgetMs: 10,
  maxBatchesPerFlush: 12,
  lowPriorityFrameBudgetMs: 6,
  maxLowPriorityBatchesPerFlush: 2,
  urgentQueueThreshold: 4,
};

type RegressionConfig = {
  features: NonNullable<StreamingMarkdownProps["features"]>;
  scheduling: StreamingSchedulerOptions;
  showCodeMeta: boolean;
  contentPolicy: NonNullable<StreamingMarkdownProps["contentPolicy"]>;
};

type RegressionSummary = {
  rootChildCount: number;
  selectors: {
    hasTable: boolean;
    hasPre: boolean;
    hasFootnotes: boolean;
    hasBlockquote: boolean;
    hasMath: boolean;
  };
  counts: {
    table: number;
    pre: number;
    blockquote: number;
    katex: number;
    footnotes: number;
    hr: number;
  };
};

type InvariantViolation = {
  message: string;
};

type StyleTarget = {
  id: string;
  selector: string;
  properties: string[];
  pseudo?: {
    before?: string[];
    after?: string[];
  };
};

type RegressionApi = {
  setConfig: (next: Partial<RegressionConfig>) => Promise<void>;
  setMeta: (meta: { fixtureId?: string; scenarioId?: string; seed?: string; schedulerMode?: string }) => void;
  appendAndFlush: (chunk: string) => Promise<void>;
  finalizeAndFlush: () => Promise<void>;
  restart: () => void;
  waitForReady: (timeoutMs?: number) => Promise<void>;
  getHtml: () => string;
  getSummary: () => RegressionSummary;
  getRuntimeState: () => {
    rendererVersion: number;
    queueDepth: number;
    pendingBatches: number;
    workerReady: boolean;
    workerInitialized: boolean;
    workerFinalized: boolean;
    workerErrors: string[];
    harnessErrors: string[];
    lastTx: number | null;
    lastPatchToDomMs: number | null;
    lastDurationMs: number | null;
    meta: {
      fixtureId?: string;
      scenarioId?: string;
      seed?: string;
      schedulerMode?: string;
    };
    storeCounters: Record<string, number>;
  };
  getDebugBlocks: () => Array<{
    id: string;
    type: string;
    isFinalized: boolean;
    raw: string;
    meta?: Record<string, unknown>;
    inline?: InlineNode[];
  }>;
  getDebugNode: (
    id: string,
  ) =>
    | {
        id: string;
        type: string;
        version: number;
        props: Record<string, unknown>;
        block?: {
          id: string;
          type: string;
          isFinalized: boolean;
          raw: string;
          meta?: Record<string, unknown>;
          inline?: InlineNode[];
        };
      }
    | null;
  getInvariantViolations: () => InvariantViolation[];
  getComputedStyles: (targets: StyleTarget[]) => Record<string, unknown>;
};

declare global {
  interface Window {
    __streammdxRegression?: RegressionApi;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

type WorkerBarrierRejector = (error: Error) => void;

function rejectWorkerBarriers(barriers: Set<WorkerBarrierRejector>, error: Error): void {
  for (const reject of barriers) reject(error);
}


function collectInvariantViolations(state: RendererStateSnapshot): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const seenIds = new Set<string>();
  let lastRangeStart = Number.NEGATIVE_INFINITY;

  for (const block of state.blocks) {
    if (seenIds.has(block.id)) {
      violations.push({ message: `duplicate block id: ${block.id}` });
    } else {
      seenIds.add(block.id);
    }

    const range = block.payload.range;
    if (range) {
      if (range.from > range.to) {
        violations.push({ message: `invalid range for ${block.id}: ${range.from} > ${range.to}` });
      }
      if (range.from < lastRangeStart) {
        violations.push({ message: `non-monotonic range for ${block.id}: ${range.from} < ${lastRangeStart}` });
      } else {
        lastRangeStart = range.from;
      }
    }

  }

  if (state.queueDepth > 0) {
    violations.push({ message: `queue not drained: ${state.queueDepth}` });
  }
  if (state.pendingBatches > 0) {
    violations.push({ message: `pending batches remaining: ${state.pendingBatches}` });
  }

  return violations;
}

async function waitForStableVersion(
  handle: StreamingMarkdownHandle | null,
  options: { stableFrames?: number; timeoutMs?: number } = {},
): Promise<void> {
  if (!handle) {
    throw new Error("[waitForStableVersion] Handle is absent");
  }
  const stableFrames = options.stableFrames ?? 3;
  const timeoutMs = options.timeoutMs ?? 3000;
  const start = Date.now();
  let lastVersion = handle.getState().rendererVersion;
  let stableCount = 0;
  while (stableCount < stableFrames) {
    await nextFrame();
    const nextVersion = handle.getState().rendererVersion;
    if (nextVersion === lastVersion) {
      stableCount += 1;
    } else {
      stableCount = 0;
      lastVersion = nextVersion;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `[waitForStableVersion] Timed out waiting for stable renderer version after ${timeoutMs}ms (version=${lastVersion}, stableFrames=${stableCount}/${stableFrames}, queueDepth=${handle.getState().queueDepth}, pendingBatches=${handle.getState().pendingBatches}).`,
      );
    }
  }
}

function expectedLazyCodeLineCount(block: { raw: string; meta?: Record<string, unknown> }): number {
  const meta = block.meta ?? {};
  const highlightedLines = Array.isArray(meta.highlightedLines) ? meta.highlightedLines.length : 0;
  const tokenLines = Array.isArray(meta.tokenLines) ? meta.tokenLines.length : 0;
  const code = typeof meta.code === "string" ? meta.code : "";
  const sourceLineCount = code.length > 0 ? code.split("\n").length : 0;
  return Math.max(highlightedLines, tokenLines, sourceLineCount);
}

async function waitForLazyCodeCompletion(
  handle: StreamingMarkdownHandle | null,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (!handle) {
    throw new Error("[waitForLazyCodeCompletion] Handle is absent");
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  const start = Date.now();
  let pending: string[] = [];
  while (Date.now() - start <= timeoutMs) {
    pending = handle.getState().blocks.flatMap((block) => {
      if (block.type !== "code" || !block.isFinalized) return [];
      const meta = (block.payload.meta as Record<string, unknown> | undefined) ?? undefined;
      if (!meta?.lazyTokenization) return [];
      const expected = expectedLazyCodeLineCount({
        raw: typeof block.payload.raw === "string" ? block.payload.raw : "",
        meta,
      });
      const tokenizedUntil = typeof meta.lazyTokenizedUntil === "number" ? (meta.lazyTokenizedUntil as number) : 0;
      return expected > 0 && tokenizedUntil < expected ? [`${block.id}:${tokenizedUntil}/${expected}`] : [];
    });
    if (pending.length === 0) {
      return;
    }
    await nextFrame();
  }
  throw new Error(
    `[waitForLazyCodeCompletion] Timed out waiting for lazy code tokenization after ${timeoutMs}ms ` +
      `(pending tokenizedUntil/expected: ${pending.join(", ")}).`,
  );
}
export function HtmlRegressionHarness(): JSX.Element {
  const FLUSH_TIMEOUT_MS = 8000;
  const [config, setConfig] = useState<RegressionConfig>({
    features: DEFAULT_FEATURES,
    scheduling: DEFAULT_SCHEDULING,
    showCodeMeta: false,
    contentPolicy: "markdown",
  });
  const [instanceKey, setInstanceKey] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<StreamingMarkdownHandle | null>(null);
  const instanceKeyRef = useRef(0);
  const activeInstanceKeyRef = useRef<number | null>(null);
  const metaRef = useRef<{ fixtureId?: string; scenarioId?: string; seed?: string; schedulerMode?: string }>({});

  type WorkerLifecycle = {
    initialized: boolean;
    finalized: boolean;
    errors: string[];
    events: Array<{ type: string; details?: string; timestamp: number }>;
    /** PATCH events that change store content. Input-source-only PATCHes never bump the renderer version. */
    patchEventCount: number;
  };

  const workerLifecycleRef = useRef<WorkerLifecycle>({
    initialized: false,
    finalized: false,
    errors: [],
    events: [],
    patchEventCount: 0,
  });
  const workerRef = useRef<Worker | null>(null);
  const expectedContentLengthRef = useRef(0);
  const pendingWorkerBarriersRef = useRef(new Set<WorkerBarrierRejector>());
  const harnessErrorsRef = useRef<string[]>([]);

  const handleStreamingError = useCallback((error: Error) => {
    const message = error?.message || String(error);
    harnessErrorsRef.current.push(message);
    if (harnessErrorsRef.current.length > 50) harnessErrorsRef.current.shift();
    rejectWorkerBarriers(
      pendingWorkerBarriersRef.current,
      new Error(`[appendAndFlush] Harness error while processing chunk: ${message}`),
    );
  }, []);

  const createHarnessWorker = useCallback((): Worker => {
    if (workerRef.current) {
      rejectWorkerBarriers(
        pendingWorkerBarriersRef.current,
        new Error("[appendAndFlush] Worker replaced before the complete APPEND checkpoint."),
      );
      workerRef.current = null;
    }

    const lifecycle: WorkerLifecycle = {
      initialized: false,
      finalized: false,
      errors: [],
      events: [],
      patchEventCount: 0,
    };
    workerLifecycleRef.current = lifecycle;
    const worker = new Worker("/workers/markdown-worker.js", { type: "module" });
    workerRef.current = worker;
    expectedContentLengthRef.current = 0;

    const pushEvent = (type: string, details?: string) => {
      lifecycle.events.push({ type, details, timestamp: Date.now() });
      if (lifecycle.events.length > 50) lifecycle.events.shift();
    };

    worker.addEventListener("message", (event: MessageEvent<any>) => {
      if (workerRef.current !== worker) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "INITIALIZED") {
        lifecycle.initialized = true;
        lifecycle.finalized = false;
        pushEvent("INITIALIZED", `rootChildren=${Array.isArray(data.snapshot?.children) ? data.snapshot.children.length : 0}`);
      } else if (data.type === "FINALIZED") {
        lifecycle.finalized = true;
        pushEvent("FINALIZED");
      } else if (data.type === "PATCH") {
        if (Array.isArray(data.patches) && data.patches.some((patch: { op?: unknown }) => patch.op !== "appendInputSource")) {
          lifecycle.patchEventCount += 1;
        }
        pushEvent("PATCH", `tx=${data.tx} patches=${Array.isArray(data.patches) ? data.patches.length : 0}`);
      } else if (data.type === "METRICS") {
        pushEvent("METRICS", `parseMs=${data.metrics?.parseMs ?? 0}`);
      } else if (data.type === "RESET") {
        pushEvent("RESET", typeof data.reason === "string" ? data.reason : "");
      } else if (data.type === "ERROR") {
        const msg = data.error?.message ?? "Worker reported ERROR";
        lifecycle.errors.push(msg);
        pushEvent("ERROR", msg);
        rejectWorkerBarriers(
          pendingWorkerBarriersRef.current,
          new Error(`[appendAndFlush] Worker error while processing chunk: ${msg}`),
        );
      }
    });

    worker.addEventListener("error", (event: ErrorEvent) => {
      if (workerRef.current !== worker) return;
      const msg = event.message || "Worker runtime error";
      lifecycle.errors.push(msg);
      pushEvent("WORKER_ERROR", msg);
      rejectWorkerBarriers(
        pendingWorkerBarriersRef.current,
        new Error(`[appendAndFlush] Worker error while processing chunk: ${msg}`),
      );
    });

    worker.addEventListener("messageerror", () => {
      if (workerRef.current !== worker) return;
      const msg = "Worker message deserialization error";
      lifecycle.errors.push(msg);
      pushEvent("MESSAGE_ERROR", msg);
      rejectWorkerBarriers(
        pendingWorkerBarriersRef.current,
        new Error(`[appendAndFlush] Worker error while processing chunk: ${msg}`),
      );
    });

    return worker;
  }, []);
  const demoComponents = useMemo(() => createDemoComponents(config.showCodeMeta), [config.showCodeMeta]);

  useEffect(() => {
    instanceKeyRef.current = instanceKey;
  }, [instanceKey]);

  const handleInstanceRef = useCallback(
    (handle: StreamingMarkdownHandle | null) => {
      if (handle) {
        handleRef.current = handle;
        activeInstanceKeyRef.current = instanceKey;
      } else if (activeInstanceKeyRef.current === instanceKey) {
        handleRef.current = null;
        activeInstanceKeyRef.current = null;
        workerRef.current = null;
        expectedContentLengthRef.current = 0;
        rejectWorkerBarriers(
          pendingWorkerBarriersRef.current,
          new Error("[appendAndFlush] Renderer was unmounted before the complete APPEND checkpoint."),
        );
      }
    },
    [instanceKey],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const waitForFlushAfter = async (prevVersion: number, timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> => {
      const handle = handleRef.current;
      if (!handle) {
        throw new Error(
          `[waitForFlushAfter] Handle absent while waiting for flush (prevVersion=${prevVersion}, fixture=${metaRef.current.fixtureId ?? "unknown"}, seed=${metaRef.current.seed ?? "baseline"}).`,
        );
      }
      // flushPending may commit synchronously before this waiter subscribes.
      if (handle.getState().rendererVersion !== prevVersion) return;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe?.();
          const state = handle.getState();
          reject(
            new Error(
              `[waitForFlushAfter] Timed out waiting for flush after ${timeoutMs}ms (prevVersion=${prevVersion}, currentVersion=${state.rendererVersion}, queueDepth=${state.queueDepth}, pendingBatches=${state.pendingBatches}, workerReady=${state.workerReady}, workerInitialized=${workerLifecycleRef.current.initialized}, fixture=${metaRef.current.fixtureId ?? "unknown"}, scenario=${metaRef.current.scenarioId ?? "unknown"}, seed=${metaRef.current.seed ?? "baseline"}).`,
            ),
          );
        }, timeoutMs);
        const unsubscribe = handle.onFlush(() => {
          const nextVersion = handle.getState().rendererVersion;
          if (nextVersion !== prevVersion && !settled) {
            settled = true;
            window.clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        });
      });
    };

    const waitForIdleWithTimeout = async (handle: StreamingMarkdownHandle, timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> => {
      let timer: number | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => {
          const state = handle.getState();
          reject(
            new Error(
              `[waitForIdle] Queue failed to drain within ${timeoutMs}ms (queueDepth=${state.queueDepth}, pendingBatches=${state.pendingBatches}, workerReady=${state.workerReady}, workerInitialized=${workerLifecycleRef.current.initialized}, fixture=${metaRef.current.fixtureId ?? "unknown"}, scenario=${metaRef.current.scenarioId ?? "unknown"}, seed=${metaRef.current.seed ?? "baseline"}).`,
            ),
          );
        }, timeoutMs);
      });
      try {
        await Promise.race([handle.waitForIdle(), timeoutPromise]);
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
      }
    };
    const waitForCapacityWithTimeout = async (
      handle: StreamingMarkdownHandle,
      units: number,
      timeoutMs = FLUSH_TIMEOUT_MS,
    ): Promise<void> => {
      const controller = new AbortController();
      let timer: number | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => {
          const error = new Error(`[waitForCapacity] Source admission capacity did not open within ${timeoutMs}ms.`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });
      try {
        await Promise.race([handle.waitForCapacity({ units, signal: controller.signal }), timeoutPromise]);
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
        if (!controller.signal.aborted) controller.abort(new Error("Source admission capacity wait completed."));
      }
    };
    const waitForWorkerContentLength = (
      worker: Worker,
      handle: StreamingMarkdownHandle,
      rendererKey: number,
      expectedContentLength: number,
      timeoutMs = FLUSH_TIMEOUT_MS,
    ): Promise<void> => {
      // Keep the executor form compatible with the docs app's Node 20 promise declarations.
      let resolvePromise!: (value: void | PromiseLike<void>) => void;
      let rejectPromise!: (reason?: unknown) => void;
      const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      let settled = false;
      let timer: number | undefined;
      let onMessage: (event: MessageEvent<any>) => void;
      let onError: (event: ErrorEvent) => void;
      let onMessageError: () => void;
      let invalidate: WorkerBarrierRejector;

      const cleanup = () => {
        if (timer !== undefined) window.clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("messageerror", onMessageError);
        pendingWorkerBarriersRef.current.delete(invalidate);
      };
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) rejectPromise(error);
        else resolvePromise(undefined);
      };
      const isCurrentRenderer = () => {
        if (
          workerRef.current !== worker ||
          handleRef.current !== handle ||
          activeInstanceKeyRef.current !== rendererKey
        ) {
          settle(new Error("[appendAndFlush] Worker or renderer was replaced before the complete APPEND checkpoint."));
          return false;
        }
        return true;
      };
      onMessage = (event) => {
        if (!isCurrentRenderer()) return;
        const data = event.data;
        if (!data || typeof data !== "object") return;
        if (data.type === "ERROR") {
          settle(
            new Error(
              `[appendAndFlush] Worker error while processing chunk: ${data.error?.message ?? "Worker reported ERROR"}`,
            ),
          );
          return;
        }
        if (data.type !== "DEBUG_STATE") return;
        const actualContentLength = data.state?.contentLength;
        if (actualContentLength === expectedContentLength) settle();
      };
      onError = (event) => {
        settle(new Error(`[appendAndFlush] Worker error while processing chunk: ${event.message || "Worker runtime error"}`));
      };
      onMessageError = () => {
        settle(new Error("[appendAndFlush] Worker message deserialization error while processing chunk."));
      };
      invalidate = (error) => settle(error);

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onMessageError);
      pendingWorkerBarriersRef.current.add(invalidate);
      timer = window.setTimeout(() => {
        settle(
          new Error(
            `[appendAndFlush] Worker did not reach complete APPEND source length within ${timeoutMs}ms (` +
              `expectedContentLength=${expectedContentLength}, fixture=${metaRef.current.fixtureId ?? "unknown"}, ` +
              `scenario=${metaRef.current.scenarioId ?? "unknown"}, seed=${metaRef.current.seed ?? "baseline"}).`,
          ),
        );
      }, timeoutMs);

      try {
        worker.postMessage({ type: "DEBUG_STATE" });
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }

      return promise;
    };
    const remountRenderer = (nextConfig?: Partial<RegressionConfig>): number => {
      const targetKey = instanceKeyRef.current + 1;
      rejectWorkerBarriers(
        pendingWorkerBarriersRef.current,
        new Error("[appendAndFlush] Renderer replaced before the complete APPEND checkpoint."),
      );
      workerRef.current = null;
      expectedContentLengthRef.current = 0;
      workerLifecycleRef.current = {
        initialized: false,
        finalized: false,
        errors: [],
        events: [],
        patchEventCount: 0,
      };
      harnessErrorsRef.current.length = 0;
      handleRef.current = null;
      activeInstanceKeyRef.current = null;
      instanceKeyRef.current = targetKey;
      if (nextConfig !== undefined) setConfig((prev) => ({ ...prev, ...nextConfig }));
      setInstanceKey(targetKey);
      return targetKey;
    };


    const api: RegressionApi = {
      async setConfig(next) {
        const targetKey = remountRenderer(next);
        const timeoutMs = 15000;
        const start = Date.now();
        while (true) {
          if (handleRef.current && instanceKeyRef.current >= targetKey && activeInstanceKeyRef.current === instanceKeyRef.current) {
            return;
          }
          if (Date.now() - start > timeoutMs) {
            throw new Error(`[setConfig] Regression harness renderer did not remount in time after ${timeoutMs}ms.`);
          }
          await nextFrame();
        }
      },
      setMeta(meta) {
        const root = rootRef.current;
        metaRef.current = { ...metaRef.current, ...meta };
        if (!root) return;
        if (meta.fixtureId) root.dataset.fixture = meta.fixtureId;
        if (meta.scenarioId) root.dataset.scenario = meta.scenarioId;
        if (meta.seed) root.dataset.seed = meta.seed;
        if (meta.schedulerMode) root.dataset.schedulerMode = meta.schedulerMode;
      },
      async appendAndFlush(chunk) {
        if (!chunk) return;
        const meta = metaRef.current;
        const handle = handleRef.current;
        if (!handle) {
          throw new Error(
            `[appendAndFlush] Handle absent while attempting to append source chunk (` +
              `length=${chunk.length}, instanceKey=${instanceKeyRef.current}, activeKey=${activeInstanceKeyRef.current}, ` +
              `workerInitialized=${workerLifecycleRef.current.initialized}, workerReady=false, ` +
              `fixture=${meta.fixtureId ?? "unknown"}, scenario=${meta.scenarioId ?? "unknown"}, seed=${meta.seed ?? "baseline"}, scheduler=${meta.schedulerMode ?? "default"}` +
              `).`,
          );
        }
        if (!handle.getState().workerReady || !workerLifecycleRef.current.initialized) {
          throw new Error(
            `[appendAndFlush] Engine/worker not ready during append (` +
              `workerReady=${handle.getState().workerReady}, workerInitialized=${workerLifecycleRef.current.initialized}, ` +
              `fixture=${meta.fixtureId ?? "unknown"}, scenario=${meta.scenarioId ?? "unknown"}, seed=${meta.seed ?? "baseline"}` +
              `).`,
          );
        }
        if (workerLifecycleRef.current.errors.length > 0) {
          throw new Error(
            `[appendAndFlush] Worker error prior to append: ${workerLifecycleRef.current.errors.join("; ")}`,
          );
        }
        if (harnessErrorsRef.current.length > 0) {
          throw new Error(
            `[appendAndFlush] Harness error prior to append: ${harnessErrorsRef.current.join("; ")}`,
          );
        }

        const worker = workerRef.current;
        const rendererKey = activeInstanceKeyRef.current;
        if (!worker || rendererKey === null || rendererKey !== instanceKeyRef.current || handleRef.current !== handle) {
          throw new Error(
            `[appendAndFlush] Worker/renderer absent or replaced while appending source (` +
              `instanceKey=${instanceKeyRef.current}, activeKey=${rendererKey}).`,
          );
        }

        const prevPatchCount = workerLifecycleRef.current.patchEventCount;
        const prevVersion = handle.getState().rendererVersion;
        let expectedContentLength = expectedContentLengthRef.current;
        for (let offset = 0; offset < chunk.length;) {
          const part = chunk.slice(offset, offset + 65_536);
          let admission: AppendResult;
          while (true) {
            try {
              admission = handle.append(part);
              break;
            } catch (error) {
              if (!(error instanceof SourceCapacityError) || !error.retryable) throw error;
              await waitForCapacityWithTimeout(handle, part.length);
            }
          }
          const acceptedContentLength = expectedContentLength + part.length;
          if (admission.acceptedSourceUnits !== acceptedContentLength) {
            throw new Error(
              `[appendAndFlush] Host admitted ${admission.acceptedSourceUnits} source units; expected ${acceptedContentLength}.`,
            );
          }
          offset += part.length;
          expectedContentLength = acceptedContentLength;
          expectedContentLengthRef.current = expectedContentLength;
          if (admission.shouldPause && offset < chunk.length) {
            await waitForCapacityWithTimeout(handle, Math.min(65_536, chunk.length - offset));
          }
        }
        await waitForWorkerContentLength(worker, handle, rendererKey, expectedContentLength, FLUSH_TIMEOUT_MS);

        const hadNewPatches = workerLifecycleRef.current.patchEventCount > prevPatchCount;
        let waitForDomCommit = hadNewPatches;
        if (hadNewPatches) {
          // Worker produced patches: flush and wait for the real renderer commit.
          handle.flushPending();
          await waitForFlushAfter(prevVersion);
          await waitForIdleWithTimeout(handle, FLUSH_TIMEOUT_MS);
        } else {
          // Chunk was no-op/whitespace/partial delimiter without AST patch.
          // Still flush any previously pending queue and wait if it was active.
          const stateBeforeFlush = handle.getState();
          waitForDomCommit = stateBeforeFlush.queueDepth > 0 || stateBeforeFlush.pendingBatches > 0;
          handle.flushPending();
          if (handle.getState().queueDepth > 0 || handle.getState().pendingBatches > 0) {
            waitForDomCommit = true;
            await waitForIdleWithTimeout(handle, FLUSH_TIMEOUT_MS);
          }
        }

        if (waitForDomCommit) {
          // Store subscriptions are requestAnimationFrame-batched; allow the React DOM commit to land.
          await nextFrame();
        }
      },
      async finalizeAndFlush() {
        const meta = metaRef.current;
        const handle = handleRef.current;
        if (!handle) {
          throw new Error(
            `[finalizeAndFlush] Handle absent while attempting to finalize (` +
              `instanceKey=${instanceKeyRef.current}, activeKey=${activeInstanceKeyRef.current}, ` +
              `fixture=${meta.fixtureId ?? "unknown"}, scenario=${meta.scenarioId ?? "unknown"}, seed=${meta.seed ?? "baseline"}, scheduler=${meta.schedulerMode ?? "default"}` +
              `).`,
          );
        }
        const rendererKey = activeInstanceKeyRef.current;
        const worker = workerRef.current;
        const lifecycle = workerLifecycleRef.current;
        if (!worker || rendererKey === null || rendererKey !== instanceKeyRef.current) {
          throw new Error("[finalizeAndFlush] Worker/renderer absent or replaced before finalization.");
        }
        const assertCurrentRenderer = () => {
          if (
            workerRef.current !== worker ||
            handleRef.current !== handle ||
            activeInstanceKeyRef.current !== rendererKey ||
            instanceKeyRef.current !== rendererKey ||
            workerLifecycleRef.current !== lifecycle
          ) {
            throw new Error("[finalizeAndFlush] Renderer replaced before finalization completed.");
          }
        };
        assertCurrentRenderer();
        if (workerLifecycleRef.current.errors.length > 0) {
          throw new Error(
            `[finalizeAndFlush] Worker error prior to finalize: ${workerLifecycleRef.current.errors.join("; ")}`,
          );
        }
        if (harnessErrorsRef.current.length > 0) {
          throw new Error(
            `[finalizeAndFlush] Harness error prior to finalize: ${harnessErrorsRef.current.join("; ")}`,
          );
        }
        const prevVersion = handle.getState().rendererVersion;
        const finalizeStart = Date.now();
        const finalizeTimeoutMs = 15000;
        const finalizeTimeout = Promise.withResolvers<never>();
        const finalizeTimer = window.setTimeout(() => {
          finalizeTimeout.reject(new Error(
            `[finalizeAndFlush] Host finalize barrier did not resolve within ${finalizeTimeoutMs}ms (` +
              `fixture=${meta.fixtureId ?? "unknown"}, scenario=${meta.scenarioId ?? "unknown"}, seed=${meta.seed ?? "baseline"}` +
              `).`,
          ));
        }, finalizeTimeoutMs);
        let finalizationResult: FinalizeResult;
        try {
          finalizationResult = await Promise.race([handle.finalize(), finalizeTimeout.promise]);
          assertCurrentRenderer();
        } finally {
          window.clearTimeout(finalizeTimer);
        }
        if (
          finalizationResult.acceptedSourceUnits !== expectedContentLengthRef.current ||
          finalizationResult.committedSourceUnits !== finalizationResult.acceptedSourceUnits
        ) {
          throw new Error(
            `[finalizeAndFlush] Host barrier covered ${finalizationResult.committedSourceUnits}/${finalizationResult.acceptedSourceUnits} source units; expected ${expectedContentLengthRef.current}.`,
          );
        }
        handle.flushPending();

        // Require the independently observed worker FINALIZED before final drain.
        while (!lifecycle.finalized) {
          assertCurrentRenderer();
          if (workerLifecycleRef.current.errors.length > 0) {
            throw new Error(
              `[finalizeAndFlush] Worker error while waiting for FINALIZED: ${workerLifecycleRef.current.errors.join("; ")}`,
            );
          }
          if (Date.now() - finalizeStart > finalizeTimeoutMs) {
            throw new Error(
              `[finalizeAndFlush] Worker did not emit FINALIZED within ${finalizeTimeoutMs}ms (` +
                `fixture=${meta.fixtureId ?? "unknown"}, scenario=${meta.scenarioId ?? "unknown"}, seed=${meta.seed ?? "baseline"}` +
                `).`,
            );
          }
          await nextFrame();
        }

        if (handle.getState().rendererVersion !== prevVersion || handle.getState().queueDepth > 0 || handle.getState().pendingBatches > 0) {
          handle.flushPending();
          await waitForIdleWithTimeout(handle, FLUSH_TIMEOUT_MS);
        }
        await waitForStableVersion(handle, { stableFrames: 3, timeoutMs: 3000 });
        await waitForLazyCodeCompletion(handle, { timeoutMs: 5000 });
        await waitForStableVersion(handle, { stableFrames: 3, timeoutMs: 3000 });
        assertCurrentRenderer();

        // Assert store readiness
        const state = handle.getState();
        if (state.queueDepth > 0 || state.pendingBatches > 0) {
          throw new Error(
            `[finalizeAndFlush] Store queue not drained after finalize (queueDepth=${state.queueDepth}, pendingBatches=${state.pendingBatches}).`,
          );
        }

        await nextFrame();
        await nextFrame();
        assertCurrentRenderer();
      },
      restart() {
        // A new keyed renderer makes readiness wait for the replacement worker's INITIALIZED event.
        remountRenderer();
      },
      async waitForReady(timeoutMs = 15000) {
        const start = Date.now();
        while (true) {
          if (workerLifecycleRef.current.errors.length > 0) {
            throw new Error(
              `[waitForReady] Worker reported error during initialization: ${workerLifecycleRef.current.errors.join("; ")}`,
            );
          }
          if (harnessErrorsRef.current.length > 0) {
            throw new Error(
              `[waitForReady] Harness reported error during initialization: ${harnessErrorsRef.current.join("; ")}`,
            );
          }
          const handle = handleRef.current;
          const isMounted = activeInstanceKeyRef.current === instanceKeyRef.current && handle !== null;
          const isWorkerReady = Boolean(handle?.getState().workerReady);
          const isWorkerInitialized = workerLifecycleRef.current.initialized;
          const isStoreReady = Boolean(
            handle && handle.getState().store && typeof handle.getState().store.getVersion() === "number",
          );

          if (isMounted && isWorkerReady && isWorkerInitialized && isStoreReady) {
            return;
          }
          if (Date.now() - start > timeoutMs) {
            const meta = metaRef.current;
            throw new Error(
              `[waitForReady] Worker/store did not reach real INITIALIZED readiness within ${timeoutMs}ms (` +
                `mounted=${isMounted}, workerReady=${isWorkerReady}, workerInitialized=${isWorkerInitialized}, storeReady=${isStoreReady}, ` +
                `instanceKey=${instanceKeyRef.current}, activeKey=${activeInstanceKeyRef.current}, ` +
                `fixture=${meta.fixtureId ?? "unknown"}, scenario=${meta.scenarioId ?? "unknown"}, seed=${meta.seed ?? "baseline"}, scheduler=${meta.schedulerMode ?? "default"}` +
                `).`,
            );
          }
          await nextFrame();
        }
      },
      getHtml() {
        return rootRef.current?.innerHTML ?? "";
      },
      getSummary() {
        const root = rootRef.current;
        const selectors = {
          hasTable: Boolean(root?.querySelector("table")),
          hasPre: Boolean(root?.querySelector("pre")),
          hasFootnotes: Boolean(root?.querySelector(".footnotes")),
          hasBlockquote: Boolean(root?.querySelector("blockquote")),
          hasMath: Boolean(root?.querySelector(".katex")),
        };
        return {
          rootChildCount: root?.children.length ?? 0,
          selectors,
          counts: {
            table: root?.querySelectorAll("table").length ?? 0,
            pre: root?.querySelectorAll("pre").length ?? 0,
            blockquote: root?.querySelectorAll("blockquote").length ?? 0,
            katex: root?.querySelectorAll(".katex").length ?? 0,
            footnotes: root?.querySelectorAll(".footnotes").length ?? 0,
            hr: root?.querySelectorAll("hr").length ?? 0,
          },
        };
      },
      getRuntimeState() {
        const handle = handleRef.current;
        const lifecycle = workerLifecycleRef.current;
        if (!handle) {
          return {
            rendererVersion: 0,
            queueDepth: 0,
            pendingBatches: 0,
            workerReady: false,
            workerInitialized: lifecycle?.initialized ?? false,
            workerFinalized: lifecycle?.finalized ?? false,
            workerErrors: lifecycle ? [...lifecycle.errors] : [],
            harnessErrors: [...harnessErrorsRef.current],
            lastTx: null,
            lastPatchToDomMs: null,
            lastDurationMs: null,
            meta: { ...metaRef.current },
            storeCounters: {},
          };
        }
        const state = handle.getState();
        return {
          rendererVersion: state.rendererVersion,
          queueDepth: state.queueDepth,
          pendingBatches: state.pendingBatches,
          workerReady: state.workerReady,
          workerInitialized: lifecycle.initialized,
          workerFinalized: lifecycle.finalized,
          workerErrors: [...lifecycle.errors],
          harnessErrors: [...harnessErrorsRef.current],
          lastTx: state.lastMetrics?.tx ?? null,
          lastPatchToDomMs: state.lastMetrics?.patchToDomMs ?? null,
          lastDurationMs: state.lastMetrics?.durationMs ?? null,
          meta: { ...metaRef.current },
          storeCounters: state.store.getDebugCounters(),
        };
      },
      getDebugBlocks() {
        const handle = handleRef.current;
        if (!handle) return [];
        return handle.getState().blocks.map((block) => ({
          id: block.id,
          type: block.type,
          isFinalized: block.isFinalized,
          raw: typeof block.payload.raw === "string" ? block.payload.raw : "",
          meta: block.payload.meta,
          inline: Array.isArray(block.payload.inline) ? block.payload.inline : undefined,
        }));
      },
      getDebugNode(id) {
        const handle = handleRef.current;
        if (!handle) return null;
        const node = handle.getState().store.getNode(id);
        if (!node) return null;
        return {
          id: node.id,
          type: node.type,
          version: node.version,
          props: node.props ? { ...node.props } : {},
          block: node.block
            ? {
                id: node.block.id,
                type: node.block.type,
                isFinalized: node.block.isFinalized,
                raw: typeof node.block.payload.raw === "string" ? node.block.payload.raw : "",
                meta: node.block.payload.meta,
                inline: Array.isArray(node.block.payload.inline) ? node.block.payload.inline : undefined,
              }
            : undefined,
        };
      },
      getInvariantViolations() {
        const handle = handleRef.current;
        if (!handle) return [];
        return [
          ...collectInvariantViolations(handle.getState()),
          ...handle.getState().store.getInvariantViolations().map((message) => ({ message })),
        ];
      },
      getComputedStyles(targets) {
        const root = rootRef.current;
        const out: Record<string, unknown> = {};
        if (!root) return out;
        for (const target of targets) {
          const el = root.querySelector(target.selector) as HTMLElement | null;
          if (!el) {
            out[target.id] = { missing: true, selector: target.selector };
            continue;
          }
          const computed = getComputedStyle(el);
          const selected: Record<string, string> = {};
          for (const prop of target.properties) {
            selected[prop] = computed.getPropertyValue(prop);
          }
          const entry: Record<string, unknown> = {
            selector: target.selector,
            computed: selected,
          };
          if (target.pseudo?.before) {
            const before = getComputedStyle(el, "::before");
            const beforeSelected: Record<string, string> = {};
            for (const prop of target.pseudo.before) {
              beforeSelected[prop] = before.getPropertyValue(prop);
            }
            entry.pseudo = { ...(entry.pseudo as Record<string, unknown>), "::before": beforeSelected };
          }
          if (target.pseudo?.after) {
            const after = getComputedStyle(el, "::after");
            const afterSelected: Record<string, string> = {};
            for (const prop of target.pseudo.after) {
              afterSelected[prop] = after.getPropertyValue(prop);
            }
            entry.pseudo = { ...(entry.pseudo as Record<string, unknown>), "::after": afterSelected };
          }
          out[target.id] = entry;
        }
        return out;
      },
    };

    window.__streammdxRegression = api;
    return () => {
      if (window.__streammdxRegression === api) {
        delete window.__streammdxRegression;
      }
    };
  }, []);

  return (
    <div className="prose">
      <div id="regression-root" ref={rootRef} data-fixture="" data-scenario="">
        <StreamingMarkdown
          key={instanceKey}
          ref={handleInstanceRef}
          worker={createHarnessWorker}
          className="markdown-v2-output"
          features={config.features}
          scheduling={config.scheduling}
          contentPolicy={config.contentPolicy}
          engines={config.contentPolicy === "trusted-mdx" ? regressionMdxEngines : undefined}
          components={demoComponents}
          onError={handleStreamingError}
        />
      </div>
    </div>
  );
}
