"use client";

import type { RendererMetrics, StreamingMarkdownProps, StreamingSchedulerOptions } from "@stream-mdx/react";
import React, { Profiler, useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";

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

const SCHEDULING_PRESETS: Record<string, StreamingSchedulerOptions> = {
  default: DEFAULT_SCHEDULING,
  smooth: {
    batch: "rAF",
    frameBudgetMs: 6,
    maxBatchesPerFlush: 4,
    lowPriorityFrameBudgetMs: 3,
    maxLowPriorityBatchesPerFlush: 1,
    urgentQueueThreshold: 2,
  },
  aggressive: DEFAULT_SCHEDULING,
};

type ScenarioConfig = {
  id: string;
  label?: string;
  updateIntervalMs: number;
  charRateCps: number;
  maxChunkChars: number;
};

type LongTaskEntry = {
  startTime: number;
  duration: number;
};

type MemorySample = {
  ts: number;
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

type ProfilerSample = {
  id: string;
  phase: "mount" | "update" | "nested-update";
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
};

type PerfReport = {
  meta: {
    fixtureId: string;
    scenarioId: string;
    schedulingPreset: string;
    scheduling: StreamingSchedulerOptions;
    updateIntervalMs: number;
    charRateCps: number;
    maxChunkChars: number;
    runStart: number;
    runEnd: number;
    runDurationMs: number;
    totalChars: number;
    firstFlushAt: number | null;
    userAgent: string;
  };
  samples: {
    flushes: RendererMetrics[];
    longTasks: LongTaskEntry[];
    rafDeltas: number[];
    memory: MemorySample[];
    profiler: ProfilerSample[];
  };
};

declare global {
  interface Window {
    __streammdxPerfReport?: PerfReport;
    __streammdxPerfDone?: Promise<void>;
    __streammdxPerfError?: string;
    __streammdxPerfRunStart?: number;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHandle(ref: React.RefObject<StreamingMarkdownHandle | null>): Promise<StreamingMarkdownHandle> {
  const timeoutMs = 10000;
  const start = Date.now();
  while (true) {
    if (ref.current) return ref.current;
    if (Date.now() - start > timeoutMs) {
      throw new Error("StreamingMarkdown handle did not initialize in time.");
    }
    await nextFrame();
  }
}

function parseNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBoolean(value: string | null): boolean | null {
  if (value === null) return null;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return null;
}

function buildScheduling(presetKey: string, params: URLSearchParams): StreamingSchedulerOptions {
  const base = SCHEDULING_PRESETS[presetKey] ?? DEFAULT_SCHEDULING;
  const batch = params.get("batch") ?? base.batch;
  return {
    ...base,
    batch: batch === "microtask" || batch === "timeout" || batch === "rAF" ? batch : base.batch,
    frameBudgetMs: parseNumber(params.get("frameBudgetMs")) ?? base.frameBudgetMs,
    maxBatchesPerFlush: parseNumber(params.get("maxBatchesPerFlush")) ?? base.maxBatchesPerFlush,
    lowPriorityFrameBudgetMs: parseNumber(params.get("lowPriorityFrameBudgetMs")) ?? base.lowPriorityFrameBudgetMs,
    maxLowPriorityBatchesPerFlush: parseNumber(params.get("maxLowPriorityBatchesPerFlush")) ?? base.maxLowPriorityBatchesPerFlush,
    urgentQueueThreshold: parseNumber(params.get("urgentQueueThreshold")) ?? base.urgentQueueThreshold,
    historyLimit: parseNumber(params.get("historyLimit")) ?? base.historyLimit,
  };
}

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

async function fetchFixture(id: string): Promise<string> {
  const response = await fetch(`${BASE_PATH}/perf/fixtures/${encodeURIComponent(id)}.md`);
  if (!response.ok) throw new Error(`Failed to load fixture ${id}`);
  return response.text();
}

async function fetchScenario(id: string): Promise<ScenarioConfig> {
  const response = await fetch(`${BASE_PATH}/perf/scenarios/${encodeURIComponent(id)}.json`);
  if (!response.ok) throw new Error(`Failed to load scenario ${id}`);
  return response.json() as Promise<ScenarioConfig>;
}

async function waitForWorker(handle: StreamingMarkdownHandle | null): Promise<void> {
  if (!handle) return;
  const timeoutMs = 15000;
  const start = Date.now();
  while (true) {
    if (handle.getState().workerReady) return;
    if (Date.now() - start > timeoutMs) throw new Error("Worker did not initialize in time.");
    await nextFrame();
  }
}

export function PerfHarness(): JSX.Element {
  const searchParams = useSearchParams();
  const fixtureId = searchParams.get("fixture") ?? "naive-bayes";
  const scenarioId = searchParams.get("scenario") ?? "S2_typical";
  const schedulingPreset = searchParams.get("scheduling") ?? "aggressive";
  const profilerEnabled = parseBoolean(searchParams.get("profiler")) ?? false;
  const queryKey = searchParams.toString();
  const scheduling = useMemo(() => buildScheduling(schedulingPreset, new URLSearchParams(queryKey)), [schedulingPreset, queryKey]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<StreamingMarkdownHandle | null>(null);
  const runTokenRef = useRef(0);
  const doneResolveRef = useRef<(() => void) | null>(null);

  const flushesRef = useRef<RendererMetrics[]>([]);
  const firstFlushAtRef = useRef<number | null>(null);
  const longTasksRef = useRef<LongTaskEntry[]>([]);
  const rafDeltasRef = useRef<number[]>([]);
  const memorySamplesRef = useRef<MemorySample[]>([]);
  const profilerSamplesRef = useRef<ProfilerSample[]>([]);
  const rafActiveRef = useRef(false);
  const memoryTimerRef = useRef<number | null>(null);
  const observerRef = useRef<PerformanceObserver | null>(null);

  const tableElements = useMemo(() => createDemoTableElements(), []);
  const htmlElements = useMemo(() => createDemoHtmlElements(), []);

  const registry = useMemo(() => {
    const next = new ComponentRegistry();
    configureDemoRegistry({
      registry: next,
      tableElements,
      htmlElements,
      showCodeMeta: false,
    });
    return next;
  }, [tableElements, htmlElements]);

  const onMetrics = useCallback((metrics: RendererMetrics) => {
    flushesRef.current.push(metrics);
    if (firstFlushAtRef.current === null) {
      firstFlushAtRef.current = metrics.committedAt;
    }
  }, []);

  const onProfile = useCallback<React.ProfilerOnRenderCallback>((id, phase, actualDuration, baseDuration, startTime, commitTime) => {
      if (!profilerEnabled) return;
      profilerSamplesRef.current.push({
        id,
        phase,
        actualDuration,
        baseDuration,
        startTime,
        commitTime,
      });
    },
    [profilerEnabled],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.__streammdxPerfReport = undefined;
    window.__streammdxPerfDone = new Promise((resolve) => {
      doneResolveRef.current = resolve;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const token = (runTokenRef.current += 1);

    if (typeof window !== "undefined") {
      window.__streammdxPerfReport = undefined;
      window.__streammdxPerfError = undefined;
      window.__streammdxPerfRunStart = undefined;
      window.__streammdxPerfDone = new Promise((resolve) => {
        doneResolveRef.current = resolve;
      });
    }

    const startLongTasks = () => {
      longTasksRef.current = [];
      if (!("PerformanceObserver" in window)) return;
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasksRef.current.push({ startTime: entry.startTime, duration: entry.duration });
          }
        });
        observer.observe({ type: "longtask", buffered: true });
        observerRef.current = observer;
      } catch {
        observerRef.current = null;
      }
    };

    const stopLongTasks = () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };

    const startRaf = () => {
      rafDeltasRef.current = [];
      rafActiveRef.current = true;
      let last = performance.now();
      const tick = (now: number) => {
        if (!rafActiveRef.current) return;
        rafDeltasRef.current.push(Math.max(0, now - last));
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    const stopRaf = () => {
      rafActiveRef.current = false;
    };

    const startMemory = () => {
      memorySamplesRef.current = [];
      if (!("memory" in performance)) return;
      if (memoryTimerRef.current !== null) {
        clearInterval(memoryTimerRef.current);
      }
      memoryTimerRef.current = window.setInterval(() => {
        const mem = (performance as Performance & { memory?: MemorySample }).memory;
        if (!mem) return;
        memorySamplesRef.current.push({
          ts: performance.now(),
          usedJSHeapSize: mem.usedJSHeapSize,
          totalJSHeapSize: mem.totalJSHeapSize,
          jsHeapSizeLimit: mem.jsHeapSizeLimit,
        });
      }, 250);
    };

    const stopMemory = () => {
      if (memoryTimerRef.current !== null) {
        clearInterval(memoryTimerRef.current);
        memoryTimerRef.current = null;
      }
    };

    const run = async () => {
      try {
        const fixture = await fetchFixture(fixtureId);
        const scenario = await fetchScenario(scenarioId);
        if (cancelled || token !== runTokenRef.current) return;

        flushesRef.current = [];
        firstFlushAtRef.current = null;
        profilerSamplesRef.current = [];

        const handle = await waitForHandle(handleRef);
        await waitForWorker(handle);
        handle.resume();
        await nextFrame();

        startLongTasks();
        startRaf();
        startMemory();

        const runStart = performance.now();
        window.__streammdxPerfRunStart = runStart;
        let idx = 0;
        let buffered = 0;
        let lastTick = performance.now();
        const intervalMs = Math.max(1, scenario.updateIntervalMs);
        const chunkCeiling = Math.max(1, scenario.maxChunkChars);

        while (idx < fixture.length) {
          if (cancelled || token !== runTokenRef.current) return;
          const now = performance.now();
          const elapsed = Math.max(0, now - lastTick);
          lastTick = now;
          const targetChars = (scenario.charRateCps * elapsed) / 1000 + buffered;
          const totalChars = Math.floor(targetChars);
          buffered = targetChars - totalChars;
          if (totalChars > 0) {
            const size = Math.min(chunkCeiling, totalChars, fixture.length - idx);
            if (size > 0) {
              const chunk = fixture.slice(idx, idx + size);
              handle.append(chunk);
              idx += size;
            }
          }
          await sleep(intervalMs);
        }

        handle.finalize();
        handle.flushPending();
        await handle.waitForIdle();
        await nextFrame();
        await nextFrame();

        const runEnd = performance.now();
        stopLongTasks();
        stopRaf();
        stopMemory();

        const report: PerfReport = {
          meta: {
            fixtureId,
            scenarioId,
            schedulingPreset,
            scheduling,
            updateIntervalMs: scenario.updateIntervalMs,
            charRateCps: scenario.charRateCps,
            maxChunkChars: scenario.maxChunkChars,
            runStart,
            runEnd,
            runDurationMs: Math.max(0, runEnd - runStart),
            totalChars: fixture.length,
            firstFlushAt: firstFlushAtRef.current,
            userAgent: navigator.userAgent,
          },
          samples: {
            flushes: flushesRef.current,
            longTasks: longTasksRef.current,
            rafDeltas: rafDeltasRef.current,
            memory: memorySamplesRef.current,
            profiler: profilerSamplesRef.current,
          },
        };

        window.__streammdxPerfReport = report;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("perf harness failed", error);
        window.__streammdxPerfError = message;
      } finally {
        doneResolveRef.current?.();
      }
    };

    run();

    return () => {
      cancelled = true;
      stopLongTasks();
      stopRaf();
      stopMemory();
    };
  }, [fixtureId, scenarioId, schedulingPreset, scheduling]);

  return (
    <div className="prose markdown">
      <div id="perf-root" ref={rootRef} data-fixture={fixtureId} data-scenario={scenarioId}>
        {profilerEnabled ? (
          <Profiler id="StreamingMarkdown" onRender={onProfile}>
            <StreamingMarkdown
              ref={handleRef}
              worker="/workers/markdown-worker.js"
              className="markdown-v2-output"
              features={DEFAULT_FEATURES}
              scheduling={scheduling}
              mdxCompileMode="worker"
              mdxComponents={mdxComponents as Record<string, React.ComponentType<unknown>>}
              components={registry.getBlockComponentMap()}
              inlineComponents={registry.getInlineComponentMap()}
              tableElements={tableElements}
              htmlElements={htmlElements}
              onMetrics={onMetrics}
            />
          </Profiler>
        ) : (
          <StreamingMarkdown
            ref={handleRef}
            worker="/workers/markdown-worker.js"
            className="markdown-v2-output"
            features={DEFAULT_FEATURES}
            scheduling={scheduling}
            mdxCompileMode="worker"
            mdxComponents={mdxComponents as Record<string, React.ComponentType<unknown>>}
            components={registry.getBlockComponentMap()}
            inlineComponents={registry.getInlineComponentMap()}
            tableElements={tableElements}
            htmlElements={htmlElements}
            onMetrics={onMetrics}
          />
        )}
      </div>
    </div>
  );
}
