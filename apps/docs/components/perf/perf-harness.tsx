"use client";

import type { RendererMetrics, StreamingMarkdownProps, StreamingSchedulerOptions } from "@stream-mdx/react";
import React, { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Streamdown, type PluginConfig } from "streamdown";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";

import { ComponentRegistry, StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";

import { components as mdxComponents } from "@/mdx-components";
import { configureDemoRegistry, createDemoHtmlElements, createDemoTableElements } from "@/lib/streaming-demo-registry";
const streamdownPlugins = {
  code,
  math: createMathPlugin({ singleDollarTextMath: true }),
};


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

const PARITY_FEATURES: NonNullable<StreamingMarkdownProps["features"]> = {
  html: true,
  tables: true,
  math: true,
  mdx: false,
  callouts: false,
  footnotes: true,
  formatAnticipation: false,
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
  const renderer = (searchParams.get("renderer") ?? "streammdx") as "streammdx" | "streamdown";
  const profile = (searchParams.get("profile") ?? "parity") as BenchmarkProfile;
  const policy = profile === "rich" ? RICH_POLICY : PARITY_POLICY;
  const fixtureId = searchParams.get("fixture") ?? "naive-bayes";
  const scenarioId = searchParams.get("scenario") ?? "S2_typical";
  const schedulingPreset = searchParams.get("scheduling") ?? "aggressive";
  const profilerEnabled = parseBoolean(searchParams.get("profiler")) ?? false;
  const queryKey = searchParams.toString();
  const scheduling = useMemo(() => buildScheduling(schedulingPreset, new URLSearchParams(queryKey)), [schedulingPreset, queryKey]);
  const [streamdownText, setStreamdownText] = useState("");
  const [streamdownIsAnimating, setStreamdownIsAnimating] = useState(false);
  const streamdownCommittedRef = useRef(0);
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

  const onStreamdownCommit = useCallback((textLength: number) => {
    const now = performance.now();
    streamdownCommittedRef.current = textLength;
    if (firstFlushAtRef.current === null && textLength > 0) {
      firstFlushAtRef.current = now;
    }
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

        if (renderer === "streammdx") {
          const handle = await waitForHandle(handleRef);
          await waitForWorker(handle);
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
        let accumulated = "";
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
          const handle = handleRef.current;
          if (handle) {
            handle.finalize();
            handle.flushPending();
            await handle.waitForIdle();
          }
        } else {
          while (streamdownCommittedRef.current < fixture.length && !cancelled) {
            await nextFrame();
          }
          setStreamdownIsAnimating(false);
        }
        await nextFrame();
        await nextFrame();
        await sleep(100);
        await nextFrame();
        const runEnd = performance.now();
        stopLongTasks();
        stopRaf();
        stopMemory();

        const liveDom = await collectLiveDomMetrics(rootRef.current);

        const report: PerfReport = {
          meta: {
            renderer,
            rendererVersion: renderer === "streamdown" ? "2.7.0" : "engine-v2",
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
  }, [renderer, fixtureId, scenarioId, schedulingPreset, scheduling, profile, policy]);

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
                worker="/workers/markdown-worker.js"
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
              worker="/workers/markdown-worker.js"
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
              worker="/workers/markdown-worker.js"
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
            worker="/workers/markdown-worker.js"
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
