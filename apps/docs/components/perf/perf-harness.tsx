/// <reference lib="es2024.promise" />
"use client";

import type { RendererMetrics, StreamingMarkdownProps, StreamingSchedulerOptions } from "@stream-mdx/react";
import type { WorkerOut } from "@stream-mdx/core";
import React, { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Streamdown, type PluginConfig } from "streamdown";
import { code, type CodeHighlighterPlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";

import { ComponentRegistry, StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";

import { components as mdxComponents } from "@/mdx-components";
import { configureDemoRegistry, createDemoHtmlElements, createDemoTableElements } from "@/lib/streaming-demo-registry";
const streamdownMath = createMathPlugin({ singleDollarTextMath: true });

class BenchmarkHighlighting {
  pending = 0;
  readonly completed = new Set<string>();
  readonly plugin: CodeHighlighterPlugin = {
    ...code,
    highlight: (options, callback) => {
      const key = JSON.stringify([options.language, options.code]);
      this.pending += 1;
      const result = code.highlight(options, (highlighted) => {
        this.pending -= 1;
        this.completed.add(key);
        callback?.(highlighted);
      });
      if (result) {
        this.pending -= 1;
        this.completed.add(key);
      }
      return result;
    },
  };

  isComplete(root: HTMLElement): boolean {
    if (this.pending > 0) return false;
    return Array.from(root.querySelectorAll<HTMLElement>('[data-streamdown="code-block"]')).every((block) => {
      const body = block.querySelector("code");
      if (!body) return false;
      // Streamdown renders each source line as a block span, using "\n" for an empty line.
      const source = Array.from(body.children, (line) => {
        const text = line.textContent ?? "";
        return text === "\n" ? "" : text;
      }).join("\n").replace(/\n+$/, "");
      return this.completed.has(JSON.stringify([block.dataset.language, source]));
    });
  }
}


export type BenchmarkProfile = "parity" | "rich";

export interface ParityPolicyConfig {
  profile: BenchmarkProfile;
  mdx: boolean;
  callouts: boolean;
  math: {
    singleDollar: boolean;
    output: "htmlAndMathml";
  };
  syntaxHighlighting: {
    code: boolean;
    diff: string;
    mode: string;
  };
  streamdownControls: boolean;
  streamdownAnimation: boolean;
  html: boolean;
  gfm: boolean;
  footnotes: boolean;
  customMarkupOverrides: boolean;
}

export const PARITY_POLICY: ParityPolicyConfig = {
  profile: "parity",
  mdx: false,
  callouts: false,
  math: {
    singleDollar: true,
    output: "htmlAndMathml",
  },
  syntaxHighlighting: {
    code: true,
    diff: "grammar_only",
    mode: "incremental",
  },
  streamdownControls: false,
  streamdownAnimation: false,
  html: true,
  gfm: true,
  footnotes: true,
  customMarkupOverrides: false,
};

export const RICH_POLICY: ParityPolicyConfig = {
  profile: "rich",
  mdx: true,
  callouts: true,
  math: {
    singleDollar: true,
    output: "htmlAndMathml",
  },
  syntaxHighlighting: {
    code: true,
    diff: "grammar_only",
    mode: "live",
  },
  streamdownControls: true,
  streamdownAnimation: true,
  html: true,
  gfm: true,
  footnotes: true,
  customMarkupOverrides: true,
};

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
  liveCodeHighlighting: true,
};

const PARITY_FORMAT_ANTICIPATION = {
  inline: true,
  mathInline: true,
  mathBlock: true,
  html: true,
  mdx: false,
  regex: false,
};

const PARITY_FEATURES: NonNullable<StreamingMarkdownProps["features"]> = {
  html: true,
  tables: true,
  math: true,
  mdx: false,
  callouts: false,
  footnotes: true,
  formatAnticipation: PARITY_FORMAT_ANTICIPATION,
  liveCodeHighlighting: true,
};
export type LiveSubtreeCounts = {
  elements: number;
  pre: number;
  code: number;
  codeBlocks: number;
  inlineCode: number;
  table: number;
  tr: number;
  li: number;
  math: number;
  katex: number;
};
export type SemanticContent = {
  rawLength: number;
  normalizedLength: number;
  normalizedTextHash: string;
  preview: string;
};

async function collectLiveDomMetrics(root: HTMLElement | null): Promise<{
  subtreeCounts: LiveSubtreeCounts;
  semanticContent: SemanticContent;
}> {
  if (!root) {
    return {
      subtreeCounts: { elements: 0, pre: 0, code: 0, codeBlocks: 0, inlineCode: 0, table: 0, tr: 0, li: 0, math: 0, katex: 0 },
      semanticContent: { rawLength: 0, normalizedLength: 0, normalizedTextHash: "", preview: "" },
    };
  }

  const elements = root.querySelectorAll("*").length;
  const pre = root.querySelectorAll("pre").length;
  const code = root.querySelectorAll("code").length;
  const inlineCode = root.querySelectorAll("code:not(pre code):not(pre *)").length;
  const codeBlocks = root.querySelectorAll("pre, .markdown-code-block").length;
  const table = root.querySelectorAll("table").length;
  const tr = root.querySelectorAll("tr").length;
  const li = root.querySelectorAll("li").length;
  const math = root.querySelectorAll("math").length;
  const katex = root.querySelectorAll(".katex").length;

  // Normalize semantic text: clone root, remove duplicate MathML, remove control buttons
  const clone = root.cloneNode(true) as HTMLElement;
  // Remove duplicate MathML in KaTeX htmlAndMathml output so math text is not duplicated
  clone.querySelectorAll(".katex-mathml").forEach((el) => el.remove());
  // Exclude copied control strings (button labels, copy/download controls)
  clone.querySelectorAll("button, [data-control], [aria-label*='Copy'], [aria-label*='Download']").forEach((el) => el.remove());

  const rawText = clone.innerText ?? clone.textContent ?? "";
  const normalizedText = rawText
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();

  let hash = "";
  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const msgBuffer = new TextEncoder().encode(normalizedText);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      hash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    hash = "hash-failed";
  }

  return {
    subtreeCounts: {
      elements,
      pre,
      code,
      codeBlocks,
      inlineCode,
      table,
      tr,
      li,
      math: math > 0 ? math : katex,
      katex,
    },
    semanticContent: {
      rawLength: rawText.length,
      normalizedLength: normalizedText.length,
      normalizedTextHash: hash,
      preview: normalizedText.slice(0, 200),
    },
  };
}

function expectedLazyCodeLineCount(block: { raw: string; meta?: Record<string, unknown> }): number {
  const meta = block.meta ?? {};
  const highlightedLines = Array.isArray(meta.highlightedLines) ? meta.highlightedLines.length : 0;
  const tokenLines = Array.isArray(meta.tokenLines) ? meta.tokenLines.length : 0;
  const code = typeof meta.code === "string" ? meta.code : "";
  const sourceLineCount = code.length > 0 ? code.split("\n").length : 0;
  return Math.max(highlightedLines, tokenLines, sourceLineCount);
}

// The public worker factory leaves ownership with the caller on both runtimes.
class BenchmarkWorker {
  private worker: Worker | null = null;
  finalized = false;
  error: Error | null = null;

  readonly onError = (error: Error): void => {
    this.error = error;
  };

  private readonly onMessage = (event: MessageEvent<WorkerOut>): void => {
    if (event.data.type === "FINALIZED") this.finalized = true;
    if (event.data.type === "ERROR") this.onError(new Error(event.data.error.message));
  };

  private readonly onWorkerError = (event: ErrorEvent): void => {
    this.onError(new Error(event.message || "Benchmark worker failed."));
  };

  private readonly onMessageError = (): void => {
    this.onError(new Error("Benchmark worker message could not be decoded."));
  };

  readonly create = (): Worker => {
    this.dispose();
    this.finalized = false;
    this.error = null;
    const worker = new Worker(`${BASE_PATH}/workers/markdown-worker.js`, { type: "module", name: "markdown-v2" });
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onWorkerError);
    worker.addEventListener("messageerror", this.onMessageError);
    this.worker = worker;
    return worker;
  };

  assertHealthy(): void {
    if (this.error) throw this.error;
    if (!this.worker) throw new Error("Benchmark worker is unavailable.");
  }

  dispose(): void {
    if (!this.worker) return;
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onWorkerError);
    this.worker.removeEventListener("messageerror", this.onMessageError);
    this.worker.terminate();
    this.worker = null;
  }
}

function waitForCompletionStep<T>(step: Promise<T>, deadline: number, signal: AbortSignal, phase: string): Promise<T> {
  if (performance.now() >= deadline) throw new Error(`Incomplete measurement: timed out waiting for ${phase}.`);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(new Error("Benchmark navigation cancelled."));
  const timer = window.setTimeout(() => reject(new Error(`Incomplete measurement: timed out waiting for ${phase}.`)), Math.max(0, deadline - performance.now()));
  signal.addEventListener("abort", abort, { once: true });
  step.then(resolve, reject);
  if (signal.aborted) abort();
  return promise.finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  });
}

async function waitForStreamMdxCompletion(
  handle: StreamingMarkdownHandle | null,
  worker: BenchmarkWorker,
  root: HTMLElement | null,
  signal: AbortSignal,
  timeoutMs = 10000,
): Promise<void> {
  if (!handle || !root) throw new Error("Incomplete measurement: StreamMDX did not mount.");
  const deadline = performance.now() + timeoutMs;
  worker.assertHealthy();
  worker.finalized = false;
  handle.finalize();
  while (!worker.finalized) {
    worker.assertHealthy();
    await waitForCompletionStep(nextFrame(), deadline, signal, "worker FINALIZED");
  }
  // FINALIZED follows the canonical snapshot, but its patches still need to commit.
  handle.flushPending();
  await waitForCompletionStep(handle.waitForIdle(), deadline, signal, "StreamMDX scheduler idle");

  let stableCount = 0;
  let lastVersion = handle.getState().rendererVersion;
  let hasMutations = false;
  const observer = new MutationObserver(() => { hasMutations = true; });
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
  try {
    while (stableCount < 3) {
      hasMutations = false;
      await waitForCompletionStep(nextFrame(), deadline, signal, "StreamMDX final DOM and highlighting");
      worker.assertHealthy();
      const state = handle.getState();
      const allFinalized = state.blocks.length > 0 && state.blocks.every((block) => block.isFinalized);
      const pendingLazyCode = state.blocks.some((block) => {
        if (block.type !== "code" || !block.isFinalized) return false;
        const meta = block.payload.meta;
        if (!meta?.lazyTokenization) return false;
        const expected = expectedLazyCodeLineCount({ raw: block.payload.raw, meta });
        const tokenizedUntil = typeof meta.lazyTokenizedUntil === "number" ? meta.lazyTokenizedUntil : 0;
        return tokenizedUntil < expected;
      });
      const pendingMath = Array.from(root.querySelectorAll(".math-inline[data-tex],.math-display[data-tex]")).some((element) => !element.querySelector(".katex"));
      if (allFinalized && !pendingLazyCode && !pendingMath && !hasMutations && state.rendererVersion === lastVersion) {
        stableCount += 1;
      } else {
        stableCount = 0;
      }
      lastVersion = state.rendererVersion;
    }
  } finally {
    observer.disconnect();
  }
}

async function waitForStreamdownCompletion(
  root: HTMLElement | null,
  committedRef: React.MutableRefObject<number>,
  expectedLength: number,
  highlighting: BenchmarkHighlighting,
  signal: AbortSignal,
  timeoutMs = 10000,
): Promise<void> {
  if (!root) throw new Error("Incomplete measurement: Streamdown did not mount.");
  const deadline = performance.now() + timeoutMs;
  while (committedRef.current < expectedLength) {
    await waitForCompletionStep(nextFrame(), deadline, signal, "Streamdown final React commit");
  }

  let stableFrames = 0;
  let hasMutations = false;
  let observer: MutationObserver | null = null;
  if (root && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => {
      hasMutations = true;
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  try {
    while (stableFrames < 3) {
      hasMutations = false;
      await waitForCompletionStep(nextFrame(), deadline, signal, "Streamdown highlighting and skeleton-free DOM");
      const hasSkeleton = root.querySelector(".streamdown-code-skeleton") !== null;
      if (!hasMutations && !hasSkeleton && highlighting.isComplete(root)) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }
    }
  } finally {
    observer?.disconnect();
  }
}

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
    renderer: "streammdx" | "streamdown";
    rendererVersion: string;
    fixtureId: string;
    scenarioId: string;
    schedulingPreset: string;
    scheduling: StreamingSchedulerOptions;
    profile: BenchmarkProfile;
    policy: ParityPolicyConfig;
    updateIntervalMs: number;
    charRateCps: number;
    maxChunkChars: number;
    runStart: number;
    runEnd: number;
    runDurationMs: number;
    totalChars: number;
    firstFlushAt: number | null;
    userAgent: string;
    liveDom: {
      subtreeCounts: LiveSubtreeCounts;
      semanticContent: SemanticContent;
    };
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

async function waitForHandle(ref: React.RefObject<StreamingMarkdownHandle | null>, signal: AbortSignal): Promise<StreamingMarkdownHandle> {
  const timeoutMs = 10000;
  const start = Date.now();
  while (true) {
    if (signal.aborted) throw new Error("Benchmark navigation cancelled.");
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
  const adaptiveSwitch = parseBoolean(params.get("adaptiveSwitch"));
  const adaptiveBudgeting = parseBoolean(params.get("adaptiveBudgeting"));
  return {
    ...base,
    batch: batch === "microtask" || batch === "timeout" || batch === "rAF" ? batch : base.batch,
    frameBudgetMs: parseNumber(params.get("frameBudgetMs")) ?? base.frameBudgetMs,
    maxBatchesPerFlush: parseNumber(params.get("maxBatchesPerFlush")) ?? base.maxBatchesPerFlush,
    lowPriorityFrameBudgetMs: parseNumber(params.get("lowPriorityFrameBudgetMs")) ?? base.lowPriorityFrameBudgetMs,
    maxLowPriorityBatchesPerFlush: parseNumber(params.get("maxLowPriorityBatchesPerFlush")) ?? base.maxLowPriorityBatchesPerFlush,
    urgentQueueThreshold: parseNumber(params.get("urgentQueueThreshold")) ?? base.urgentQueueThreshold,
    historyLimit: parseNumber(params.get("historyLimit")) ?? base.historyLimit,
    startupMicrotaskFlushes: parseNumber(params.get("startupMicrotaskFlushes")) ?? base.startupMicrotaskFlushes,
    adaptiveBudgeting: adaptiveBudgeting ?? base.adaptiveBudgeting,
    adaptiveSwitch: adaptiveSwitch ?? base.adaptiveSwitch,
    adaptiveQueueThreshold: parseNumber(params.get("adaptiveQueueThreshold")) ?? base.adaptiveQueueThreshold,
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

async function waitForWorker(handle: StreamingMarkdownHandle, worker: BenchmarkWorker, signal: AbortSignal): Promise<void> {
  const timeoutMs = 15000;
  const start = Date.now();
  while (true) {
    if (signal.aborted) throw new Error("Benchmark navigation cancelled.");
    worker.assertHealthy();
    if (handle.getState().workerReady) return;
    if (Date.now() - start > timeoutMs) throw new Error("Worker did not initialize in time.");
    await nextFrame();
  }
}

export function PerfHarness(): JSX.Element {
  const searchParams = useSearchParams();
  const renderer = (searchParams.get("renderer") ?? "streammdx") as "streammdx" | "streamdown";
  const profile = (searchParams.get("profile") ?? "parity") as BenchmarkProfile;
  const policy = profile === "rich" ? RICH_POLICY : PARITY_POLICY;
  const fixtureId = searchParams.get("fixture") ?? "naive-bayes";
  const scenarioId = searchParams.get("scenario") ?? "S2_typical";
  const schedulingPreset = searchParams.get("scheduling") ?? "aggressive";
  const profilerEnabled = parseBoolean(searchParams.get("profiler")) ?? false;
  const queryKey = searchParams.toString();
  const scheduling = useMemo(() => buildScheduling(schedulingPreset, new URLSearchParams(queryKey)), [schedulingPreset, queryKey]);
  const benchmarkWorker = useMemo(() => new BenchmarkWorker(), [queryKey]);
  const highlighting = useMemo(() => new BenchmarkHighlighting(), [queryKey]);
  const streamdownPlugins = useMemo(() => ({ code: highlighting.plugin, math: streamdownMath }), [highlighting]);
  const rendererVersion = searchParams.get("rendererVersion") ?? (renderer === "streamdown" ? "2.7.0" : "streammdx (version not supplied)");
  const [streamdownText, setStreamdownText] = useState("");
  const [streamdownIsAnimating, setStreamdownIsAnimating] = useState(false);
  const streamdownCommittedRef = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<StreamingMarkdownHandle | null>(null);
  const runTokenRef = useRef(0);

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
  }, []);

  const onStreamdownCommit = useCallback((textLength: number) => {
    streamdownCommittedRef.current = textLength;
  }, []);

  const onProfile = useCallback(
    (
      id: string,
      phase: "mount" | "update" | "nested-update",
      actualDuration: number,
      baseDuration: number,
      startTime: number,
      commitTime: number,
    ) => {
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
    let cancelled = false;
    const token = (runTokenRef.current += 1);
    const controller = new AbortController();
    let firstContentObserver: MutationObserver | null = null;
    const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();

    if (typeof window !== "undefined") {
      window.__streammdxPerfReport = undefined;
      window.__streammdxPerfError = undefined;
      window.__streammdxPerfRunStart = undefined;
      window.__streammdxPerfDone = done;
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

        if (renderer === "streammdx") {
          const handle = await waitForCompletionStep(waitForHandle(handleRef, controller.signal), performance.now() + 10000, controller.signal, "StreamMDX handle");
          await waitForCompletionStep(waitForWorker(handle, benchmarkWorker, controller.signal), performance.now() + 15000, controller.signal, "worker initialization");
          benchmarkWorker.assertHealthy();
          handle.resume();
          await nextFrame();
        } else {
          setStreamdownText("");
          if (profile === "rich") {
            setStreamdownIsAnimating(true);
          } else {
            setStreamdownIsAnimating(false);
          }
          streamdownCommittedRef.current = 0;
          await nextFrame();
        }
        if (cancelled || token !== runTokenRef.current) return;
        startLongTasks();
        startRaf();
        startMemory();

        const runStart = performance.now();
        window.__streammdxPerfRunStart = runStart;
        // Same post-start committed-content policy for both renderers. INIT flushes do not count.
        const observeFirstContent = () => {
          const root = rootRef.current;
          if (!root || firstFlushAtRef.current !== null) return;
          const textNodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let hasContent = false;
          while (textNodes.nextNode()) {
            const node = textNodes.currentNode;
            if ((node.textContent ?? "").trim() && !node.parentElement?.closest("button,[data-control],script,style,[data-streamdown='code-block-header']")) {
              hasContent = true;
              break;
            }
          }
          if (hasContent) {
            firstFlushAtRef.current = performance.now();
            firstContentObserver?.disconnect();
          }
        };
        firstContentObserver = new MutationObserver(observeFirstContent);
        if (!rootRef.current) throw new Error("Incomplete measurement: content root did not mount.");
        firstContentObserver.observe(rootRef.current, { childList: true, subtree: true, characterData: true });
        let idx = 0;
        let buffered = 0;
        let lastTick = performance.now();
        const intervalMs = Math.max(1, scenario.updateIntervalMs);
        const chunkCeiling = Math.max(1, scenario.maxChunkChars);
        let accumulated = "";
        while (idx < fixture.length) {
          if (cancelled || token !== runTokenRef.current) return;
          if (renderer === "streammdx") benchmarkWorker.assertHealthy();
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
              idx += size;
              if (renderer === "streammdx") {
                handleRef.current?.append(chunk);
              } else {
                accumulated += chunk;
                setStreamdownText(accumulated);
              }
            }
          }
          await sleep(intervalMs);
        }

        if (renderer === "streammdx") {
          await waitForStreamMdxCompletion(handleRef.current, benchmarkWorker, rootRef.current, controller.signal);
        } else {
          await waitForStreamdownCompletion(
            rootRef.current,
            streamdownCommittedRef,
            fixture.length,
            highlighting,
            controller.signal,
          );
          setStreamdownIsAnimating(false);
        }
        if (cancelled || token !== runTokenRef.current) return;
        if (firstFlushAtRef.current === null) throw new Error("Incomplete measurement: no post-start committed content observed.");

        // Final completion timestamp reflects all rendering, finalization, and highlighting work
        const runEnd = performance.now();
        stopLongTasks();
        stopRaf();
        stopMemory();
        const liveDom = await collectLiveDomMetrics(rootRef.current);
        if (cancelled || token !== runTokenRef.current) return;

        const report: PerfReport = {
          meta: {
            renderer,
            rendererVersion,
            fixtureId,
            scenarioId,
            schedulingPreset,
            scheduling,
            profile,
            policy,
            updateIntervalMs: scenario.updateIntervalMs,
            charRateCps: scenario.charRateCps,
            maxChunkChars: scenario.maxChunkChars,
            runStart,
            runEnd,
            runDurationMs: Math.max(0, runEnd - runStart),
            totalChars: fixture.length,
            firstFlushAt: firstFlushAtRef.current,
            userAgent: navigator.userAgent,
            liveDom,
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
        if (cancelled || token !== runTokenRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error("perf harness failed", error);
        window.__streammdxPerfError = message;
      } finally {
        firstContentObserver?.disconnect();
        if (token === runTokenRef.current) {
          stopLongTasks();
          stopRaf();
          stopMemory();
        }
        benchmarkWorker.dispose();
        resolveDone();
      }
    };

    run();

    return () => {
      cancelled = true;
      firstContentObserver?.disconnect();
      controller.abort();
      benchmarkWorker.dispose();
      resolveDone();
      stopLongTasks();
      stopRaf();
      stopMemory();
    };
  }, [renderer, fixtureId, scenarioId, schedulingPreset, scheduling, profile, policy, benchmarkWorker, rendererVersion, highlighting]);

  return (
    <div className="prose">
      <div id="perf-root" ref={rootRef} data-fixture={fixtureId} data-scenario={scenarioId} data-renderer={renderer} data-profile={profile}>
        {renderer === "streamdown" ? (
          profilerEnabled ? (
            <Profiler id="Streamdown" onRender={onProfile}>
              <StreamdownHost
                text={streamdownText}
                plugins={streamdownPlugins}
                isAnimating={profile === "rich" ? streamdownIsAnimating : false}
                controls={profile === "rich"}
                onCommit={onStreamdownCommit}
              />
            </Profiler>
          ) : (
            <StreamdownHost
              text={streamdownText}
              plugins={streamdownPlugins}
              isAnimating={profile === "rich" ? streamdownIsAnimating : false}
              controls={profile === "rich"}
              onCommit={onStreamdownCommit}
            />
          )
        ) : profile === "parity" ? (
          profilerEnabled ? (
            <Profiler id="StreamingMarkdown" onRender={onProfile}>
              <StreamingMarkdown
                ref={handleRef}
                key={queryKey}
                worker={benchmarkWorker.create}
                onError={benchmarkWorker.onError}
                className="markdown-v2-output"
                features={PARITY_FEATURES}
                scheduling={scheduling}
                caret={false}
                onMetrics={onMetrics}
              />
            </Profiler>
          ) : (
            <StreamingMarkdown
              ref={handleRef}
              key={queryKey}
              worker={benchmarkWorker.create}
              onError={benchmarkWorker.onError}
              className="markdown-v2-output"
              features={PARITY_FEATURES}
              scheduling={scheduling}
              caret={false}
              onMetrics={onMetrics}
            />
          )
        ) : profilerEnabled ? (
          <Profiler id="StreamingMarkdown" onRender={onProfile}>
            <StreamingMarkdown
              ref={handleRef}
              key={queryKey}
              worker={benchmarkWorker.create}
              onError={benchmarkWorker.onError}
              className="markdown-v2-output"
              features={DEFAULT_FEATURES}
              scheduling={scheduling}
              caret={false}
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
            key={queryKey}
            worker={benchmarkWorker.create}
            onError={benchmarkWorker.onError}
            className="markdown-v2-output"
            features={DEFAULT_FEATURES}
            scheduling={scheduling}
            caret={false}
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

function StreamdownHost({
  text,
  plugins,
  isAnimating,
  controls,
  onCommit,
}: {
  text: string;
  plugins: PluginConfig;
  isAnimating: boolean;
  controls: boolean;
  onCommit: (textLength: number) => void;
}) {
  useLayoutEffect(() => {
    onCommit(text.length);
  }, [text, onCommit]);

  return (
    <Streamdown
      mode="streaming"
      plugins={plugins}
      parseIncompleteMarkdown={true}
      isAnimating={isAnimating}
      animated={false}
      controls={controls}
    >
      {text}
    </Streamdown>
  );
}
