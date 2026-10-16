"use client";

import type { InlineNode } from "@stream-mdx/core";
import type { RendererStateSnapshot, StreamingSchedulerOptions, StreamingMarkdownProps } from "@stream-mdx/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ComponentRegistry, StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";

import { components as mdxComponents } from "@/mdx-components";
import { configureDemoRegistry, createDemoHtmlElements, createDemoTableElements } from "@/lib/streaming-demo-registry";

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
  mdxCompileMode: NonNullable<StreamingMarkdownProps["mdxCompileMode"]>;
  showCodeMeta: boolean;
};

type RegressionSummary = {
  rootChildCount: number;
  selectors: {
    hasTable: boolean;
    hasPre: boolean;
    hasFootnotes: boolean;
    hasMdxPending: boolean;
    hasMdxCompiled: boolean;
    hasBlockquote: boolean;
    hasMath: boolean;
  };
  counts: {
    table: number;
    pre: number;
    blockquote: number;
    katex: number;
    mdxPending: number;
    mdxCompiled: number;
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

    if (block.type === "mdx") {
      const meta = block.payload.meta as { mdxStatus?: unknown } | undefined;
      const status = typeof meta?.mdxStatus === "string" ? meta.mdxStatus : undefined;
      if (status === "compiled") {
        const hasCompiled = Boolean(block.payload.compiledMdxModule || block.payload.compiledMdxRef);
        if (!hasCompiled) {
          violations.push({ message: `mdx block marked compiled without output: ${block.id}` });
        }
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
  while (Date.now() - start <= timeoutMs) {
    const blocks = handle.getState().blocks;
    const pendingLazyCode = blocks.some((block) => {
      if (block.type !== "code" || !block.isFinalized) return false;
      const meta = (block.payload.meta as Record<string, unknown> | undefined) ?? undefined;
      if (!meta?.lazyTokenization) return false;
      const expected = expectedLazyCodeLineCount({
        raw: typeof block.payload.raw === "string" ? block.payload.raw : "",
        meta,
      });
      if (expected <= 0) return false;
      const tokenizedUntil = typeof meta.lazyTokenizedUntil === "number" ? (meta.lazyTokenizedUntil as number) : 0;
      return tokenizedUntil < expected;
    });
    if (!pendingLazyCode) {
      return;
    }
    await nextFrame();
  }
  throw new Error(`[waitForLazyCodeCompletion] Timed out waiting for lazy code tokenization after ${timeoutMs}ms.`);
}
export function HtmlRegressionHarness(): JSX.Element {
  const FLUSH_TIMEOUT_MS = 8000;
  const [config, setConfig] = useState<RegressionConfig>({
    features: DEFAULT_FEATURES,
    scheduling: DEFAULT_SCHEDULING,
    mdxCompileMode: "worker",
    showCodeMeta: false,
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
    parseEventCount: number;
    patchEventCount: number;
  };

  const workerLifecycleRef = useRef<WorkerLifecycle>({
    initialized: false,
    finalized: false,
    errors: [],
    events: [],
    parseEventCount: 0,
    patchEventCount: 0,
  });
  const harnessErrorsRef = useRef<string[]>([]);

  const handleStreamingError = useCallback((error: Error) => {
    const message = error?.message || String(error);
    harnessErrorsRef.current.push(message);
    if (harnessErrorsRef.current.length > 50) harnessErrorsRef.current.shift();
  }, []);

  const createHarnessWorker = useCallback((): Worker => {
    workerLifecycleRef.current = {
      initialized: false,
      finalized: false,
      errors: [],
      events: [],
      parseEventCount: 0,
      patchEventCount: 0,
    };
    const worker = new Worker("/workers/markdown-worker.js");
    const pushEvent = (type: string, details?: string) => {
      const events = workerLifecycleRef.current.events;
      events.push({ type, details, timestamp: Date.now() });
      if (events.length > 50) events.shift();
    };

    worker.addEventListener("message", (event: MessageEvent<any>) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "INITIALIZED") {
        workerLifecycleRef.current.initialized = true;
        pushEvent("INITIALIZED", `blocks=${Array.isArray(data.blocks) ? data.blocks.length : 0}`);
      } else if (data.type === "FINALIZED") {
        workerLifecycleRef.current.finalized = true;
        pushEvent("FINALIZED");
      } else if (data.type === "PATCH") {
        workerLifecycleRef.current.parseEventCount += 1;
        workerLifecycleRef.current.patchEventCount += 1;
        pushEvent("PATCH", `tx=${data.tx} patches=${Array.isArray(data.patches) ? data.patches.length : 0}`);
      } else if (data.type === "METRICS") {
        workerLifecycleRef.current.parseEventCount += 1;
        pushEvent("METRICS", `parseMs=${data.metrics?.parseMs ?? 0}`);
      } else if (data.type === "RESET") {
        pushEvent("RESET", typeof data.reason === "string" ? data.reason : "");
      } else if (data.type === "ERROR") {
        const msg = data.error?.message ?? "Worker reported ERROR";
        workerLifecycleRef.current.errors.push(msg);
        pushEvent("ERROR", msg);
      }
    });

    worker.addEventListener("error", (event: ErrorEvent) => {
      const msg = event.message || "Worker runtime error";
      workerLifecycleRef.current.errors.push(msg);
      pushEvent("WORKER_ERROR", msg);
    });

    worker.addEventListener("messageerror", () => {
      const msg = "Worker message deserialization error";
      workerLifecycleRef.current.errors.push(msg);
      pushEvent("MESSAGE_ERROR", msg);
    });

    return worker;
  }, []);
  const tableElements = useMemo(() => createDemoTableElements(), []);
  const htmlElements = useMemo(() => createDemoHtmlElements(), []);

  const registry = useMemo(() => {
    const next = new ComponentRegistry();
    configureDemoRegistry({
      registry: next,
      tableElements,
      htmlElements,
      showCodeMeta: config.showCodeMeta,
    });
    return next;
  }, [tableElements, htmlElements, config.showCodeMeta]);

  useEffect(() => {
    instanceKeyRef.current = instanceKey;
  }, [instanceKey]);

  const handleInstanceRef = useCallback(
    (handle: StreamingMarkdownHandle | null) => {
      handleRef.current = handle;
      if (handle) {
        activeInstanceKeyRef.current = instanceKey;
      } else if (activeInstanceKeyRef.current === instanceKey) {
        activeInstanceKeyRef.current = null;
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

    const api: RegressionApi = {
      async setConfig(next) {
        const targetKey = instanceKeyRef.current + 1;
        workerLifecycleRef.current = {
          initialized: false,
          finalized: false,
          errors: [],
          events: [],
          parseEventCount: 0,
          patchEventCount: 0,
        };
        harnessErrorsRef.current.length = 0;
        setConfig((prev) => ({ ...prev, ...next }));
        setInstanceKey(targetKey);
        instanceKeyRef.current = targetKey;
        handleRef.current = null;
        activeInstanceKeyRef.current = null;
        const timeoutMs = 15000;
        const start = Date.now();
        while (true) {
          if (handleRef.current && activeInstanceKeyRef.current === targetKey) {
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

        const prevParseCount = workerLifecycleRef.current.parseEventCount;
        const prevPatchCount = workerLifecycleRef.current.patchEventCount;
        const prevVersion = handle.getState().rendererVersion;

        handle.append(chunk);

        // Await worker parse response (either PATCH or METRICS) within genuine timeout
        const start = Date.now();
        while (workerLifecycleRef.current.parseEventCount === prevParseCount) {
          if (workerLifecycleRef.current.errors.length > 0) {
            throw new Error(
              `[appendAndFlush] Worker error while processing chunk: ${workerLifecycleRef.current.errors.join("; ")}`,
            );
          }
          if (harnessErrorsRef.current.length > 0) {
            throw new Error(
              `[appendAndFlush] Harness error while processing chunk: ${harnessErrorsRef.current.join("; ")}`,
            );
          }
          if (Date.now() - start > FLUSH_TIMEOUT_MS) {
            throw new Error(
              `[appendAndFlush] Worker did not acknowledge APPEND parse within ${FLUSH_TIMEOUT_MS}ms (` +
                `chunkLength=${chunk.length}, prevParseEvents=${prevParseCount}, ` +
                `fixture=${meta.fixtureId ?? "unknown"}, scenario=${meta.scenarioId ?? "unknown"}, seed=${meta.seed ?? "baseline"}` +
                `).`,
            );
          }
          await nextFrame();
        }

        const hadNewPatches = workerLifecycleRef.current.patchEventCount > prevPatchCount;
        if (hadNewPatches) {
          // Worker produced patches: flush and wait for React commit
          handle.flushPending();
          await waitForFlushAfter(prevVersion);
          await waitForIdleWithTimeout(handle, FLUSH_TIMEOUT_MS);
        } else {
          // Chunk was no-op/whitespace/partial delimiter without AST patch.
          // Still flush any previously pending queue and wait if queue was active.
          handle.flushPending();
          if (handle.getState().queueDepth > 0 || handle.getState().pendingBatches > 0) {
            await waitForIdleWithTimeout(handle, FLUSH_TIMEOUT_MS);
          }
        }

        await nextFrame();
        await nextFrame();
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
        handle.finalize();
        handle.flushPending();

        // Require real FINALIZED from the worker for final drain
        const finalizeStart = Date.now();
        const finalizeTimeoutMs = 15000;
        while (!workerLifecycleRef.current.finalized) {
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

        // Assert store readiness
        const state = handle.getState();
        if (state.queueDepth > 0 || state.pendingBatches > 0) {
          throw new Error(
            `[finalizeAndFlush] Store queue not drained after finalize (queueDepth=${state.queueDepth}, pendingBatches=${state.pendingBatches}).`,
          );
        }

        await nextFrame();
        await nextFrame();
      },
      restart() {
        workerLifecycleRef.current.finalized = false;
        handleRef.current?.restart();
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
          hasMdxPending: Boolean(root?.querySelector('.markdown-mdx[data-mdx-status="pending"]')),
          hasMdxCompiled: Boolean(root?.querySelector('.markdown-mdx[data-mdx-status="compiled"]')),
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
            mdxPending: root?.querySelectorAll('.markdown-mdx[data-mdx-status="pending"]').length ?? 0,
            mdxCompiled: root?.querySelectorAll('.markdown-mdx[data-mdx-status="compiled"]').length ?? 0,
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
          mdxCompileMode={config.mdxCompileMode}
          mdxComponents={mdxComponents as Record<string, React.ComponentType<unknown>>}
          components={registry.getBlockComponentMap()}
          inlineComponents={registry.getInlineComponentMap()}
          tableElements={tableElements}
          htmlElements={htmlElements}
          onError={handleStreamingError}
        />
      </div>
    </div>
  );
}
