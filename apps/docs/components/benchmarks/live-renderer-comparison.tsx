"use client";

import { BottomStickScrollArea } from "@/components/layout/bottom-stick-scroll-area";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";
import ReactMarkdown from "react-markdown";
import { Streamdown } from "streamdown";
import remarkGfm from "remark-gfm";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

type EngineKey = "streammdx" | "streamdown" | "react-markdown";
type RunState = "idle" | "running" | "paused" | "done";
type EnginePhase = "warmup" | "measured";
type OrderMode = "rotate" | "random" | "fixed";
type ChartMetric = "first" | "final";
type ChartLayout = "single" | "split";
type BenchmarkProfile = "parity-gfm" | "streaming-heavy";
type MethodologyMode = "explore" | "ci-locked";

type DeltaPoint = {
  seq: number;
  totalChars: number;
  firstLatencies: Partial<Record<EngineKey, number>>;
  finalLatencies: Partial<Record<EngineKey, number>>;
};

type EngineStats = {
  count: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
};

type EngineTiming = {
  startAt: number | null;
  endAt: number | null;
};

type MetricWinner = {
  key: EngineKey;
  label: string;
  value: number;
} | null;

type AggregateStore = Record<
  EngineKey,
  {
    first: number[];
    final: number[];
    runMs: number[];
    throughput: number[];
  }
>;

type StageBreakdownStore = Record<
  EngineKey,
  {
    emitToIngest: number[];
    ingestToCommit: number[];
    emitToCommit: number[];
    appendOverhead: number[];
    timerDrift: number[];
  }
>;

type GateStatus = "pass" | "fail" | "pending";

const FIXTURE_SECTION = `## Stream stress section

This paragraph mixes **formatting**, _italics_, \`inline code\`, and [links](https://example.com).

| key | value | status |
| --- | --- | --- |
| parser | worker | stable |
| patch queue | coalesced | stable |
| renderer | incremental | stable |

\`\`\`ts
type PatchBatch = { tx: number; ops: number; mode: "latency" | "throughput" };
export function apply(batch: PatchBatch) {
  return \`tx=\${batch.tx} ops=\${batch.ops} mode=\${batch.mode}\`;
}
\`\`\`

- item a
- item b
- item c
`;

const DEFAULT_CHUNK_CHARS = 42;
const DEFAULT_INTERVAL_MS = 32;
const DEFAULT_REPEAT = 16;
const DEFAULT_SCORED_RUNS = 3;
const ENGINE_SETTLE_FRAMES = 2;
const CHART_WIDTH = 920;
const CHART_HEIGHT = 240;
const CHART_MARGIN = { top: 12, right: 16, bottom: 34, left: 56 };
const CHART_PLOT_WIDTH = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
const CHART_PLOT_HEIGHT = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
const AXIS_TICK_COUNT = 5;
const CI_PROFILE = {
  chunkChars: 42,
  intervalMs: 32,
  repeatCount: 16,
  scoredRuns: 5,
  orderMode: "rotate" as const,
  profile: "parity-gfm" as const,
  chartLayout: "split" as const,
};

const ENGINE_META: Array<{ key: EngineKey; label: string; color: string; dash?: string; strokeWidth?: number }> = [
  { key: "streammdx", label: "StreamMDX", color: "#2563eb", strokeWidth: 2 },
  { key: "streamdown", label: "Streamdown", color: "#22c55e", dash: "7 5", strokeWidth: 2.6 },
  { key: "react-markdown", label: "react-markdown", color: "#d97706", dash: "2 4", strokeWidth: 2.2 },
];

function buildFixture(repeat: number) {
  return Array.from({ length: repeat }, (_, index) => `# Delta ${index + 1}\n\n${FIXTURE_SECTION}`).join("\n\n");
}

function createEmptyAggregate(): AggregateStore {
  return {
    streammdx: { first: [], final: [], runMs: [], throughput: [] },
    streamdown: { first: [], final: [], runMs: [], throughput: [] },
    "react-markdown": { first: [], final: [], runMs: [], throughput: [] },
  };
}

function createEmptyStageBreakdown(): StageBreakdownStore {
  return {
    streammdx: { emitToIngest: [], ingestToCommit: [], emitToCommit: [], appendOverhead: [], timerDrift: [] },
    streamdown: { emitToIngest: [], ingestToCommit: [], emitToCommit: [], appendOverhead: [], timerDrift: [] },
    "react-markdown": { emitToIngest: [], ingestToCommit: [], emitToCommit: [], appendOverhead: [], timerDrift: [] },
  };
}

function rotateOrder(order: EngineKey[], offset: number): EngineKey[] {
  if (!order.length) return [];
  const start = ((offset % order.length) + order.length) % order.length;
  return [...order.slice(start), ...order.slice(0, start)];
}

function shuffleOrder(order: EngineKey[], seed: number): EngineKey[] {
  const next = [...order];
  // Deterministic shuffle per run id for reproducibility.
  let state = (seed + 1) * 2654435761;
  const random = () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex]!, next[index]!];
  }
  return next;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower] ?? null;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  const weight = pos - lower;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function summarize(values: number[]): EngineStats {
  if (!values.length) {
    return { count: 0, avg: null, p50: null, p95: null, max: null };
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    avg: sum / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function formatMs(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  return `${value.toFixed(1)} ms`;
}

function formatThroughput(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  return `${value.toFixed(0)} chars/s`;
}

function getEngineAccentClass(engine: EngineKey): string {
  if (engine === "streammdx") return "border-blue-500/45 bg-blue-500/12 text-blue-700 dark:text-blue-300";
  if (engine === "streamdown") return "border-emerald-500/45 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
  return "border-amber-500/45 bg-amber-500/12 text-amber-700 dark:text-amber-300";
}

function buildLinePath(
  points: DeltaPoint[],
  engine: EngineKey,
  metric: ChartMetric,
  maxSeq: number,
  maxY: number,
): string {
  let path = "";
  let hasMove = false;

  for (const point of points) {
    const latency = metric === "first" ? point.firstLatencies[engine] : point.finalLatencies[engine];
    if (latency === undefined) continue;
    const x = CHART_MARGIN.left + (point.seq / Math.max(1, maxSeq)) * CHART_PLOT_WIDTH;
    const y = CHART_MARGIN.top + CHART_PLOT_HEIGHT - (latency / Math.max(1, maxY)) * CHART_PLOT_HEIGHT;
    path += `${hasMove ? " L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    hasMove = true;
  }

  return path;
}

function ReactMarkdownPanel({
  text,
  seq,
  onCommit,
  remarkPlugins,
}: {
  text: string;
  seq: number;
  onCommit: (seq: number) => void;
  remarkPlugins?: any[];
}) {
  useLayoutEffect(() => {
    if (seq > 0) onCommit(seq);
  }, [seq, onCommit]);

  return (
    <div className="prose max-w-none text-sm">
      <ReactMarkdown remarkPlugins={remarkPlugins}>{text}</ReactMarkdown>
    </div>
  );
}

function StreamdownPanel({
  text,
  seq,
  onCommit,
  remarkPlugins,
  rehypePlugins,
}: {
  text: string;
  seq: number;
  onCommit: (seq: number) => void;
  remarkPlugins?: any[];
  rehypePlugins?: any[];
}) {
  useLayoutEffect(() => {
    if (seq > 0) onCommit(seq);
  }, [seq, onCommit]);

  return (
    <div className="prose max-w-none text-sm">
      <Streamdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {text}
      </Streamdown>
    </div>
  );
}

function StreamMdxPanel({
  seq,
  onCommit,
  streamHandleRef,
  setStreamHandleReady,
  features,
  scheduling,
}: {
  seq: number;
  onCommit: (seq: number) => void;
  streamHandleRef: React.MutableRefObject<StreamingMarkdownHandle | null>;
  setStreamHandleReady: (ready: boolean) => void;
  features: {
    html: boolean;
    tables: boolean;
    math: boolean;
    mdx: boolean;
    footnotes: boolean;
    callouts: boolean;
  };
  scheduling: {
    batch: "rAF" | "microtask" | "timeout";
    startupMicrotaskFlushes: number;
    adaptiveBudgeting?: boolean;
  };
}) {
  const localHandleRef = useRef<StreamingMarkdownHandle | null>(null);
  const setHandleRef = useCallback(
    (handle: StreamingMarkdownHandle | null) => {
      localHandleRef.current = handle;
      streamHandleRef.current = handle;
      setStreamHandleReady(Boolean(handle));
      if (process.env.NODE_ENV !== "production") {
        (window as Window & { __streamMdxBenchHandle?: StreamingMarkdownHandle | null }).__streamMdxBenchHandle = handle;
      }
    },
    [setStreamHandleReady, streamHandleRef],
  );

  useEffect(() => {
    const sync = () => {
      if (streamHandleRef.current !== localHandleRef.current) {
        streamHandleRef.current = localHandleRef.current;
      }
      setStreamHandleReady(Boolean(localHandleRef.current));
    };
    sync();
    const interval = window.setInterval(sync, 120);
    return () => {
      window.clearInterval(interval);
      if (streamHandleRef.current === localHandleRef.current) {
        streamHandleRef.current = null;
        setStreamHandleReady(false);
      }
    };
  }, [setStreamHandleReady, streamHandleRef]);

  useLayoutEffect(() => {
    if (seq > 0) onCommit(seq);
  }, [seq, onCommit]);

  return (
    <div className="prose max-w-none text-sm">
      <StreamingMarkdown
        ref={setHandleRef}
        worker="/workers/markdown-worker.js"
        className="markdown-v2-output"
        features={features}
        scheduling={scheduling}
      />
    </div>
  );
}

export function LiveRendererComparison() {
  const [chunkChars, setChunkChars] = useState(DEFAULT_CHUNK_CHARS);
  const [intervalMs, setIntervalMs] = useState(DEFAULT_INTERVAL_MS);
  const [repeatCount, setRepeatCount] = useState(DEFAULT_REPEAT);
  const [scoredRuns, setScoredRuns] = useState(DEFAULT_SCORED_RUNS);
  const [orderMode, setOrderMode] = useState<OrderMode>("rotate");
  const [chartMetric, setChartMetric] = useState<ChartMetric>("final");
  const [chartLayout, setChartLayout] = useState<ChartLayout>("split");
  const [profile, setProfile] = useState<BenchmarkProfile>("parity-gfm");
  const [methodologyMode, setMethodologyMode] = useState<MethodologyMode>("explore");

  const [runState, setRunState] = useState<RunState>("idle");
  const [activePhase, setActivePhase] = useState<EnginePhase>("warmup");
  const [activeEngine, setActiveEngine] = useState<EngineKey | null>(null);
  const [activeSeq, setActiveSeq] = useState(0);
  const [activeRun, setActiveRun] = useState(0);
  const [displayOrder, setDisplayOrder] = useState<EngineKey[]>([]);
  const [engineText, setEngineText] = useState<Record<EngineKey, string>>({
    streammdx: "",
    streamdown: "",
    "react-markdown": "",
  });
  const [points, setPoints] = useState<DeltaPoint[]>([]);
  const [statsRevision, setStatsRevision] = useState(0);

  const streamHandleRef = useRef<StreamingMarkdownHandle | null>(null);
  const [streamHandleReady, setStreamHandleReady] = useState(false);

  const engineOrder = useMemo(() => ENGINE_META.map((engine) => engine.key), []);
  const activeEngineRef = useRef<EngineKey | null>(null);
  const activePhaseRef = useRef<EnginePhase>("warmup");
  const runStateRef = useRef<RunState>("idle");
  const seqRef = useRef(0);
  const cursorRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerDeadlineRef = useRef<number | null>(null);
  const engineTransitioningRef = useRef(false);
  const runCountRef = useRef(1);
  const runIndexRef = useRef(0);
  const engineQueueRef = useRef<EngineKey[]>([]);
  const engineQueueIndexRef = useRef(0);
  const aggregateRef = useRef<AggregateStore>(createEmptyAggregate());

  const runStartAtRef = useRef<number | null>(null);
  const runEndAtRef = useRef<number | null>(null);
  const ingestedAtRef = useRef<Record<EngineKey, Map<number, number>>>({
    streammdx: new Map(),
    streamdown: new Map(),
    "react-markdown": new Map(),
  });
  const stageBreakdownRef = useRef<StageBreakdownStore>(createEmptyStageBreakdown());
  const engineTimingRef = useRef<Record<EngineKey, EngineTiming>>({
    streammdx: { startAt: null, endAt: null },
    streamdown: { startAt: null, endAt: null },
    "react-markdown": { startAt: null, endAt: null },
  });

  const emittedAtRef = useRef<Record<EngineKey, Map<number, number>>>({
    streammdx: new Map(),
    streamdown: new Map(),
    "react-markdown": new Map(),
  });
  const pointsBySeqRef = useRef<Map<number, DeltaPoint>>(new Map());

  const fixture = useMemo(() => buildFixture(repeatCount), [repeatCount]);
  const totalChars = fixture.length;
  const totalDeltas = Math.max(1, Math.ceil(totalChars / chunkChars));
  const streamMdxFeatures = useMemo(
    () =>
      profile === "parity-gfm"
        ? { html: false, tables: true, math: false, mdx: false, footnotes: false, callouts: false }
        : { html: true, tables: true, math: true, mdx: true, footnotes: true, callouts: true },
    [profile],
  );
  const streamMdxScheduling = useMemo(
    () => ({
      batch: "rAF" as const,
      startupMicrotaskFlushes: methodologyMode === "ci-locked" ? 8 : 4,
      adaptiveBudgeting: methodologyMode === "ci-locked" ? false : undefined,
    }),
    [methodologyMode],
  );
  const reactMarkdownPlugins = useMemo(() => [remarkGfm], []);
  const streamdownPlugins = useMemo(
    () => (profile === "parity-gfm" ? { remarkPlugins: [remarkGfm], rehypePlugins: [] as any[] } : undefined),
    [profile],
  );

  const syncPointsState = useCallback(() => {
    const ordered = [...pointsBySeqRef.current.values()].sort((a, b) => a.seq - b.seq);
    setPoints(ordered);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    timerDeadlineRef.current = null;
  }, []);

  const setRunStateBoth = useCallback((next: RunState) => {
    runStateRef.current = next;
    setRunState(next);
  }, []);

  const getOrderForRun = useCallback(
    (runIndex: number): EngineKey[] => {
      if (orderMode === "fixed") return [...engineOrder];
      if (orderMode === "random") return shuffleOrder(engineOrder, runIndex);
      return rotateOrder(engineOrder, runIndex);
    },
    [engineOrder, orderMode],
  );

  const appendMeasuredEngineStats = useCallback(
    (engine: EngineKey) => {
      const pointValues = [...pointsBySeqRef.current.values()];
      const first = pointValues
        .map((point) => point.firstLatencies[engine])
        .filter((value): value is number => value !== undefined && Number.isFinite(value));
      const final = pointValues
        .map((point) => point.finalLatencies[engine])
        .filter((value): value is number => value !== undefined && Number.isFinite(value));
      aggregateRef.current[engine].first.push(...first);
      aggregateRef.current[engine].final.push(...final);

      const timing = engineTimingRef.current[engine];
      if (timing.startAt !== null && timing.endAt !== null) {
        const durationMs = Math.max(0, timing.endAt - timing.startAt);
        aggregateRef.current[engine].runMs.push(durationMs);
        if (durationMs > 0) {
          aggregateRef.current[engine].throughput.push((totalChars / durationMs) * 1000);
        }
      }
      setStatsRevision((value) => value + 1);
    },
    [totalChars],
  );

  const startEngine = useCallback((engine: EngineKey, phase: EnginePhase) => {
    activeEngineRef.current = engine;
    setActiveEngine(engine);
    activePhaseRef.current = phase;
    setActivePhase(phase);
    seqRef.current = 0;
    cursorRef.current = 0;
    setActiveSeq(0);

    emittedAtRef.current[engine] = new Map();
    ingestedAtRef.current[engine] = new Map();
    setEngineText((previous) => ({ ...previous, [engine]: "" }));

    if (phase === "measured") {
      engineTimingRef.current[engine] = { startAt: performance.now(), endAt: null };
    } else {
      engineTimingRef.current[engine] = { startAt: null, endAt: null };
    }

    if (engine === "streammdx") {
      streamHandleRef.current?.restart();
    }
  }, []);

  const completeRun = useCallback(() => {
    stopTimer();
    setRunStateBoth("done");
    runEndAtRef.current = performance.now();
    engineTransitioningRef.current = false;
    activeEngineRef.current = null;
    activePhaseRef.current = "warmup";
    setActiveEngine(null);
    setActivePhase("warmup");
  }, [setRunStateBoth, stopTimer]);

  const startRunCycle = useCallback(
    (runIndex: number) => {
      runIndexRef.current = runIndex;
      setActiveRun(runIndex + 1);
      const order = getOrderForRun(runIndex);
      engineQueueRef.current = order;
      engineQueueIndexRef.current = 0;
      setDisplayOrder(order);
      pointsBySeqRef.current = new Map();
      setPoints([]);
      setActiveSeq(0);
      startEngine(order[0]!, "warmup");
    },
    [getOrderForRun, startEngine],
  );

  const moveToNextEnginePhase = useCallback(() => {
    if (engineTransitioningRef.current) return;
    engineTransitioningRef.current = true;
    const current = activeEngineRef.current;
    const currentPhase = activePhaseRef.current;
    if (!current) {
      completeRun();
      return;
    }

    if (currentPhase === "measured") {
      engineTimingRef.current[current] = {
        ...engineTimingRef.current[current],
        endAt: performance.now(),
      };
      appendMeasuredEngineStats(current);
    }

    if (current === "streammdx") {
      streamHandleRef.current?.finalize();
    }

    if (currentPhase === "warmup") {
      startEngine(current, "measured");
      engineTransitioningRef.current = false;
      return;
    }

    const nextQueueIndex = engineQueueIndexRef.current + 1;
    const nextEngine = engineQueueRef.current[nextQueueIndex];
    if (nextEngine) {
      engineQueueIndexRef.current = nextQueueIndex;
      startEngine(nextEngine, "warmup");
      engineTransitioningRef.current = false;
      return;
    }

    const nextRunIndex = runIndexRef.current + 1;
    if (nextRunIndex < runCountRef.current) {
      startRunCycle(nextRunIndex);
      engineTransitioningRef.current = false;
      return;
    }

    engineTransitioningRef.current = false;
    completeRun();
  }, [appendMeasuredEngineStats, completeRun, startEngine, startRunCycle]);

  const markCommitted = useCallback(
    (engine: EngineKey, seqCommitted: number) => {
      if (seqCommitted <= 0 || activeEngineRef.current !== engine) return;
      if (activePhaseRef.current !== "measured") return;
      const emitted = emittedAtRef.current[engine];
      if (!emitted.size) return;

      const now = performance.now();
      let changed = false;

      for (const [emittedSeq, emittedAt] of emitted) {
        if (emittedSeq > seqCommitted) continue;

        const point = pointsBySeqRef.current.get(emittedSeq);
        if (!point) continue;

        if (point.firstLatencies[engine] === undefined) {
          const emitToCommit = now - emittedAt;
          point.firstLatencies[engine] = emitToCommit;
          const ingestedAt = ingestedAtRef.current[engine].get(emittedSeq);
          const emitToIngest = ingestedAt !== undefined ? Math.max(0, ingestedAt - emittedAt) : 0;
          const ingestToCommit = ingestedAt !== undefined ? Math.max(0, now - ingestedAt) : emitToCommit;
          stageBreakdownRef.current[engine].emitToIngest.push(emitToIngest);
          stageBreakdownRef.current[engine].ingestToCommit.push(ingestToCommit);
          stageBreakdownRef.current[engine].emitToCommit.push(emitToCommit);
          changed = true;
        }
        point.finalLatencies[engine] = now - emittedAt;
        changed = true;
      }

      if (changed) syncPointsState();
    },
    [syncPointsState],
  );

  const handleStreamMdxCommit = useCallback(
    (nextSeq: number) => {
      markCommitted("streammdx", nextSeq);
    },
    [markCommitted],
  );

  const handleStreamdownCommit = useCallback(
    (nextSeq: number) => {
      markCommitted("streamdown", nextSeq);
    },
    [markCommitted],
  );

  const handleReactMarkdownCommit = useCallback(
    (nextSeq: number) => {
      markCommitted("react-markdown", nextSeq);
    },
    [markCommitted],
  );

  const settleThenMoveToNextEngine = useCallback(() => {
    if (engineTransitioningRef.current) return;
    engineTransitioningRef.current = true;

    let framesRemaining = ENGINE_SETTLE_FRAMES;
    const waitForCommitFrame = () => {
      if (runStateRef.current === "idle" || runStateRef.current === "done") {
        engineTransitioningRef.current = false;
        return;
      }
      if (framesRemaining <= 0) {
        const currentEngine = activeEngineRef.current;
        if (currentEngine) {
          // If a renderer batches commit callbacks, flush any still-pending deltas before leaving this engine.
          markCommitted(currentEngine, seqRef.current);
        }
        engineTransitioningRef.current = false;
        moveToNextEnginePhase();
        return;
      }
      framesRemaining -= 1;
      requestAnimationFrame(waitForCommitFrame);
    };

    requestAnimationFrame(waitForCommitFrame);
  }, [markCommitted, moveToNextEnginePhase]);

  const emitDelta = useCallback(() => {
    if (engineTransitioningRef.current) return;
    const engine = activeEngineRef.current;
    if (!engine || runStateRef.current !== "running") return;
    const phase = activePhaseRef.current;

    if (engine === "streammdx") {
      const handle = streamHandleRef.current;
      if (!handle) return;
      const state = handle.getState();
      if (!state.workerReady) {
        return;
      }
    }

    if (cursorRef.current >= fixture.length) {
      settleThenMoveToNextEngine();
      return;
    }

    const nextChunk = fixture.slice(cursorRef.current, cursorRef.current + chunkChars);
    if (!nextChunk) {
      settleThenMoveToNextEngine();
      return;
    }

    const emittedAt = performance.now();
    const nextSeq = seqRef.current + 1;
    const nextCursor = cursorRef.current + nextChunk.length;
    let ingestedAt = performance.now();

    if (engine === "streammdx") {
      const appendStartedAt = ingestedAt;
      try {
        streamHandleRef.current?.append(nextChunk);
      } catch {
        // Worker can briefly detach during restart; retry next timer tick.
        return;
      }
      const appendEndedAt = performance.now();
      stageBreakdownRef.current.streammdx.appendOverhead.push(Math.max(0, appendEndedAt - appendStartedAt));
      ingestedAt = appendEndedAt;
    }

    seqRef.current = nextSeq;
    cursorRef.current = nextCursor;
    setActiveSeq(nextSeq);

    if (engine !== "streammdx") {
      setEngineText((previous) => ({
        ...previous,
        [engine]: previous[engine] + nextChunk,
      }));
    }

    if (phase === "measured") {
      const existing = pointsBySeqRef.current.get(nextSeq);
      if (existing) {
        existing.totalChars = nextCursor;
      } else {
        pointsBySeqRef.current.set(nextSeq, {
          seq: nextSeq,
          totalChars: nextCursor,
          firstLatencies: {},
          finalLatencies: {},
        });
      }

      emittedAtRef.current[engine].set(nextSeq, emittedAt);
      ingestedAtRef.current[engine].set(nextSeq, ingestedAt);
      syncPointsState();
    }

    if (nextCursor >= fixture.length) {
      settleThenMoveToNextEngine();
    }
  }, [chunkChars, fixture, settleThenMoveToNextEngine, syncPointsState]);

  const startTimer = useCallback(() => {
    stopTimer();
    timerDeadlineRef.current = performance.now() + intervalMs;
    const scheduleNextTick = () => {
      const deadline = timerDeadlineRef.current;
      if (deadline === null) return;
      const delay = Math.max(0, deadline - performance.now());
      timerRef.current = setTimeout(() => {
        const now = performance.now();
        const scheduledAt = timerDeadlineRef.current;
        const engine = activeEngineRef.current;
        if (scheduledAt !== null) {
          const overdueMs = Math.max(0, now - scheduledAt);
          const skippedIntervals = intervalMs > 0 ? Math.floor(overdueMs / intervalMs) : 0;
          const driftMs = intervalMs > 0 ? overdueMs - skippedIntervals * intervalMs : overdueMs;
          if (engine && activePhaseRef.current === "measured") {
            stageBreakdownRef.current[engine].timerDrift.push(driftMs);
          }
          timerDeadlineRef.current = scheduledAt + (skippedIntervals + 1) * intervalMs;
        } else {
          timerDeadlineRef.current = now + intervalMs;
        }
        emitDelta();
        if (runStateRef.current === "running" && timerDeadlineRef.current !== null) {
          scheduleNextTick();
          return;
        }
        timerRef.current = null;
      }, delay);
    };
    scheduleNextTick();
  }, [emitDelta, intervalMs, stopTimer]);

  const resetState = useCallback(() => {
    stopTimer();
    setPoints([]);
    setActiveSeq(0);
    setActiveRun(0);
    setDisplayOrder([]);
    setActiveEngine(null);
    setActivePhase("warmup");
    activeEngineRef.current = null;
    activePhaseRef.current = "warmup";
    seqRef.current = 0;
    cursorRef.current = 0;
    runIndexRef.current = 0;
    runCountRef.current = 1;
    engineQueueRef.current = [];
    engineQueueIndexRef.current = 0;
    pointsBySeqRef.current = new Map();
    emittedAtRef.current = {
      streammdx: new Map(),
      streamdown: new Map(),
      "react-markdown": new Map(),
    };
    ingestedAtRef.current = {
      streammdx: new Map(),
      streamdown: new Map(),
      "react-markdown": new Map(),
    };
    stageBreakdownRef.current = createEmptyStageBreakdown();
    aggregateRef.current = createEmptyAggregate();
    setStatsRevision((value) => value + 1);
    engineTransitioningRef.current = false;
    setEngineText({
      streammdx: "",
      streamdown: "",
      "react-markdown": "",
    });
    runStartAtRef.current = null;
    runEndAtRef.current = null;
    engineTimingRef.current = {
      streammdx: { startAt: null, endAt: null },
      streamdown: { startAt: null, endAt: null },
      "react-markdown": { startAt: null, endAt: null },
    };
  }, [stopTimer]);

  const startRun = useCallback(() => {
    resetState();
    runStartAtRef.current = performance.now();
    runEndAtRef.current = null;
    runCountRef.current = scoredRuns;
    setRunStateBoth("running");
    startRunCycle(0);
    startTimer();
  }, [resetState, scoredRuns, setRunStateBoth, startRunCycle, startTimer]);

  const pauseRun = useCallback(() => {
    setRunStateBoth("paused");
    stopTimer();
  }, [setRunStateBoth, stopTimer]);

  const resumeRun = useCallback(() => {
    if (runStateRef.current === "done") return;
    setRunStateBoth("running");
    startTimer();
  }, [setRunStateBoth, startTimer]);

  const resetRun = useCallback(() => {
    resetState();
    setRunStateBoth("idle");
  }, [resetState, setRunStateBoth]);

  const applyCiProfile = useCallback(() => {
    setChunkChars(CI_PROFILE.chunkChars);
    setIntervalMs(CI_PROFILE.intervalMs);
    setRepeatCount(CI_PROFILE.repeatCount);
    setScoredRuns(CI_PROFILE.scoredRuns);
    setOrderMode(CI_PROFILE.orderMode);
    setProfile(CI_PROFILE.profile);
    setChartLayout(CI_PROFILE.chartLayout);
    setChartMetric("final");
  }, []);

  useEffect(() => {
    if (methodologyMode !== "ci-locked") return;
    applyCiProfile();
  }, [applyCiProfile, methodologyMode]);

  useEffect(() => {
    return () => {
      stopTimer();
    };
  }, [stopTimer]);

  const controlsLocked = runState === "running" || runState === "paused" || methodologyMode === "ci-locked";
  const isCiProfile =
    chunkChars === CI_PROFILE.chunkChars &&
    intervalMs === CI_PROFILE.intervalMs &&
    repeatCount === CI_PROFILE.repeatCount &&
    scoredRuns === CI_PROFILE.scoredRuns &&
    orderMode === CI_PROFILE.orderMode &&
    profile === CI_PROFILE.profile;

  const maxSeq = points.length ? points[points.length - 1]?.seq ?? 1 : 1;
  const maxLatencyFirst = Math.max(
    10,
    ...points.flatMap((point) =>
      ENGINE_META.map((engine) => point.firstLatencies[engine.key]).filter((value): value is number => value !== undefined),
    ),
  );
  const maxLatencyFinal = Math.max(
    10,
    ...points.flatMap((point) =>
      ENGINE_META.map((engine) => point.finalLatencies[engine.key]).filter((value): value is number => value !== undefined),
    ),
  );
  const yAxisMaxFirst = Math.ceil(maxLatencyFirst / 5) * 5;
  const yAxisMaxFinal = Math.ceil(maxLatencyFinal / 5) * 5;
  const yAxisMax = chartMetric === "first" ? yAxisMaxFirst : yAxisMaxFinal;

  const aggregateStats = useMemo(() => {
    void statsRevision;
    return Object.fromEntries(
      ENGINE_META.map(({ key }) => {
        const aggregate = aggregateRef.current[key];
        return [
          key,
          {
            first: summarize(aggregate.first),
            final: summarize(aggregate.final),
            runMs: summarize(aggregate.runMs),
            throughput: summarize(aggregate.throughput),
          },
        ];
      }),
    ) as Record<
      EngineKey,
      {
        first: EngineStats;
        final: EngineStats;
        runMs: EngineStats;
        throughput: EngineStats;
      }
    >;
  }, [statsRevision]);

  const stageStats = useMemo(() => {
    void statsRevision;
    return Object.fromEntries(
      ENGINE_META.map(({ key }) => {
        const stage = stageBreakdownRef.current[key];
        return [
          key,
          {
            emitToIngest: summarize(stage.emitToIngest),
            ingestToCommit: summarize(stage.ingestToCommit),
            emitToCommit: summarize(stage.emitToCommit),
            appendOverhead: summarize(stage.appendOverhead),
            timerDrift: summarize(stage.timerDrift),
          },
        ];
      }),
    ) as Record<
      EngineKey,
      {
        emitToIngest: EngineStats;
        ingestToCommit: EngineStats;
        emitToCommit: EngineStats;
        appendOverhead: EngineStats;
        timerDrift: EngineStats;
      }
    >;
  }, [statsRevision]);

  const gateChecks = useMemo(() => {
    const streamMdx = aggregateStats.streammdx;
    const streamdown = aggregateStats.streamdown;
    const evaluate = (passed: boolean | null): GateStatus => {
      if (passed === null) return "pending";
      return passed ? "pass" : "fail";
    };

    const firstP50Pass =
      streamMdx.first.p50 !== null && streamdown.first.p50 !== null ? streamMdx.first.p50 <= streamdown.first.p50 : null;
    const finalP50Pass =
      streamMdx.final.p50 !== null && streamdown.final.p50 !== null ? streamMdx.final.p50 <= streamdown.final.p50 : null;
    const runP50Pass = streamMdx.runMs.p50 !== null && streamdown.runMs.p50 !== null ? streamMdx.runMs.p50 <= streamdown.runMs.p50 : null;
    const throughputP50Pass =
      streamMdx.throughput.p50 !== null && streamdown.throughput.p50 !== null
        ? streamMdx.throughput.p50 >= streamdown.throughput.p50
        : null;

    return [
      { id: "first-p50", label: "First paint p50 <= Streamdown", status: evaluate(firstP50Pass), raw: firstP50Pass },
      { id: "final-p50", label: "Final stable p50 <= Streamdown", status: evaluate(finalP50Pass), raw: finalP50Pass },
      { id: "run-p50", label: "Run p50 <= Streamdown", status: evaluate(runP50Pass), raw: runP50Pass },
      { id: "throughput-p50", label: "Throughput p50 >= Streamdown", status: evaluate(throughputP50Pass), raw: throughputP50Pass },
    ];
  }, [aggregateStats]);

  const gateSummary = useMemo(() => {
    const pending = gateChecks.filter((gate) => gate.status === "pending").length;
    const passed = gateChecks.filter((gate) => gate.status === "pass").length;
    const failed = gateChecks.filter((gate) => gate.status === "fail").length;
    const status: GateStatus = pending > 0 ? "pending" : failed > 0 ? "fail" : "pass";
    return { pending, passed, failed, status };
  }, [gateChecks]);
  const streamMdxHasData = activeSeq > 0 || aggregateRef.current.streammdx.runMs.length > 0;

  const metricWinners = useMemo(() => {
    const byKey = Object.fromEntries(ENGINE_META.map((engine) => [engine.key, engine.label])) as Record<EngineKey, string>;
    const pickWinner = (
      selector: (stats: {
        first: EngineStats;
        final: EngineStats;
        runMs: EngineStats;
        throughput: EngineStats;
      }) => number | null,
      direction: "min" | "max",
    ): MetricWinner => {
      const candidates = ENGINE_META.map((engine) => {
        const value = selector(aggregateStats[engine.key]);
        if (value === null || Number.isNaN(value)) return null;
        return { key: engine.key, label: byKey[engine.key], value };
      }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

      if (!candidates.length) return null;
      candidates.sort((a, b) => (direction === "min" ? a.value - b.value : b.value - a.value));
      return candidates[0] ?? null;
    };

    return {
      firstP50: pickWinner((stats) => stats.first.p50, "min"),
      finalP50: pickWinner((stats) => stats.final.p50, "min"),
      runP50: pickWinner((stats) => stats.runMs.p50, "min"),
      throughputP50: pickWinner((stats) => stats.throughput.p50, "max"),
    };
  }, [aggregateStats]);

  const winnerTally = useMemo(() => {
    const tally: Record<EngineKey, number> = {
      streammdx: 0,
      streamdown: 0,
      "react-markdown": 0,
    };
    for (const winner of Object.values(metricWinners)) {
      if (!winner) continue;
      tally[winner.key] += 1;
    }
    return tally;
  }, [metricWinners]);

  const activeEngineLabel = ENGINE_META.find((engine) => engine.key === activeEngine)?.label ?? "-";
  const emittedChars = cursorRef.current;

  const activeEngineDurationMs = useMemo(() => {
    if (!activeEngine) return 0;
    const timing = engineTimingRef.current[activeEngine];
    if (!timing.startAt) return 0;
    const end = timing.endAt ?? performance.now();
    return Math.max(0, end - timing.startAt);
  }, [activeEngine, points, runState]);

  const throughput = activeEngineDurationMs > 0 ? (emittedChars / activeEngineDurationMs) * 1000 : 0;
  const xTicks = Array.from({ length: AXIS_TICK_COUNT }, (_, index) => {
    const ratio = AXIS_TICK_COUNT <= 1 ? 0 : index / (AXIS_TICK_COUNT - 1);
    const seq = Math.round(ratio * maxSeq);
    const x = CHART_MARGIN.left + ratio * CHART_PLOT_WIDTH;
    return { ratio, seq, x };
  });

  const renderLatencyChart = (metric: ChartMetric, title: string, maxY: number) => {
    const yTicks = Array.from({ length: AXIS_TICK_COUNT }, (_, index) => {
      const ratio = AXIS_TICK_COUNT <= 1 ? 0 : index / (AXIS_TICK_COUNT - 1);
      const value = Math.round((1 - ratio) * maxY);
      const y = CHART_MARGIN.top + ratio * CHART_PLOT_HEIGHT;
      return { value, y };
    });

    return (
      <div className="rounded-xl border border-border/60 p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="text-xs text-muted">Y max: {maxY} ms</div>
        </div>
        <svg width="100%" height={CHART_HEIGHT} viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={`${title} chart`}>
          {yTicks.map((tick, index) => (
            <g key={`y-${index}`}>
              <line
                x1={CHART_MARGIN.left}
                y1={tick.y}
                x2={CHART_MARGIN.left + CHART_PLOT_WIDTH}
                y2={tick.y}
                stroke="rgba(100,116,139,0.22)"
                strokeDasharray="4 6"
              />
              <text x={CHART_MARGIN.left - 8} y={tick.y + 4} textAnchor="end" fontSize={11} fill="currentColor" opacity={0.72}>
                {tick.value}
              </text>
            </g>
          ))}
          {xTicks.map((tick, index) => (
            <g key={`x-${index}`}>
              <line x1={tick.x} y1={CHART_MARGIN.top} x2={tick.x} y2={CHART_MARGIN.top + CHART_PLOT_HEIGHT} stroke="rgba(100,116,139,0.16)" />
              <text
                x={tick.x}
                y={CHART_MARGIN.top + CHART_PLOT_HEIGHT + 18}
                textAnchor="middle"
                fontSize={11}
                fill="currentColor"
                opacity={0.72}
              >
                {tick.seq.toLocaleString()}
              </text>
            </g>
          ))}
          <line
            x1={CHART_MARGIN.left}
            y1={CHART_MARGIN.top}
            x2={CHART_MARGIN.left}
            y2={CHART_MARGIN.top + CHART_PLOT_HEIGHT}
            stroke="rgba(100,116,139,0.46)"
          />
          <line
            x1={CHART_MARGIN.left}
            y1={CHART_MARGIN.top + CHART_PLOT_HEIGHT}
            x2={CHART_MARGIN.left + CHART_PLOT_WIDTH}
            y2={CHART_MARGIN.top + CHART_PLOT_HEIGHT}
            stroke="rgba(100,116,139,0.46)"
          />

          {ENGINE_META.map((engine) => {
            const path = buildLinePath(points, engine.key, metric, maxSeq, maxY);
            return (
              <path
                key={engine.key}
                d={path}
                fill="none"
                stroke={engine.color}
                strokeWidth={engine.strokeWidth ?? 2}
                strokeDasharray={engine.dash}
                strokeLinecap="round"
              />
            );
          })}

          <text
            x={CHART_MARGIN.left + CHART_PLOT_WIDTH / 2}
            y={CHART_MARGIN.top + CHART_PLOT_HEIGHT + 32}
            textAnchor="middle"
            fontSize={12}
            fill="currentColor"
            opacity={0.78}
          >
            Delta index
          </text>
          <text
            x={14}
            y={CHART_MARGIN.top + CHART_PLOT_HEIGHT / 2}
            textAnchor="middle"
            fontSize={12}
            fill="currentColor"
            opacity={0.78}
            transform={`rotate(-90 14 ${CHART_MARGIN.top + CHART_PLOT_HEIGHT / 2})`}
          >
            Latency (ms)
          </text>
        </svg>
      </div>
    );
  };

  return (
    <section className="rounded-xl border border-border/60 bg-background p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Live renderer comparison lab (sequential)</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Renderers run one-by-one to minimize CPU contention. Each engine gets an unscored warmup pass before the scored pass. Metrics split
            into first-visible commit vs final-stable commit.
          </p>
        </div>
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted">
          <div>State: {runState}</div>
          <div>Active engine: {activeEngineLabel}</div>
          <div>Phase: {activePhase}</div>
          <div>
            Run: {activeRun.toLocaleString()} / {(runState === "idle" ? scoredRuns : runCountRef.current).toLocaleString()}
          </div>
          <div>
            Delta: {activeSeq.toLocaleString()} / {totalDeltas.toLocaleString()}
          </div>
          <div>
            Chars: {emittedChars.toLocaleString()} / {totalChars.toLocaleString()}
          </div>
          <div>Throughput: {throughput.toFixed(0)} chars/s</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted">
        {ENGINE_META.map((engine, index) => {
          const done = aggregateRef.current[engine.key].runMs.length > 0;
          const isActive = activeEngine === engine.key;
          return (
            <span
              key={engine.key}
              className={cn(
                "rounded-full border px-2.5 py-1",
                isActive
                  ? "border-foreground/30 bg-foreground/10 text-foreground"
                  : done
                    ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-700"
                    : "border-border/50 bg-muted/20 text-muted",
              )}
            >
              {index + 1}. {engine.label}
            </span>
          );
        })}
      </div>
      <div className="mt-2 text-xs text-muted">
        Current order:{" "}
        {displayOrder.length ? displayOrder.map((engine) => ENGINE_META.find((item) => item.key === engine)?.label ?? engine).join(" → ") : "-"}
      </div>
      <div className="mt-3 rounded-md border border-border/60 bg-muted/15 p-3 text-xs">
        <div className="font-semibold text-foreground">Methodology mode</div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={methodologyMode === "ci-locked" ? "default" : "outline"}
            onClick={() => {
              setMethodologyMode("ci-locked");
              applyCiProfile();
            }}
            disabled={runState === "running" || runState === "paused"}
          >
            CI locked profile
          </Button>
          <Button
            size="sm"
            variant={methodologyMode === "explore" ? "default" : "outline"}
            onClick={() => setMethodologyMode("explore")}
            disabled={runState === "running" || runState === "paused"}
          >
            Explore
          </Button>
          <span className="text-muted">
            {methodologyMode === "ci-locked"
              ? "Inputs are locked to reproducible CI settings."
              : "Freeform tuning enabled for diagnosis."}
          </span>
        </div>
        <div className="mt-2 text-muted">
          Active profile snapshot: chunk={chunkChars}, interval={intervalMs}ms, repeats={repeatCount}, runs={scoredRuns}, order={orderMode},
          workload={profile}. {isCiProfile ? "Matches CI profile." : "Differs from CI profile."}
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <ControlSlider
          label="Chunk size (chars)"
          value={chunkChars}
          min={8}
          max={220}
          step={2}
          onChange={setChunkChars}
          disabled={controlsLocked}
        />
        <ControlSlider
          label="Emit interval (ms)"
          value={intervalMs}
          min={8}
          max={300}
          step={2}
          onChange={setIntervalMs}
          disabled={controlsLocked}
        />
        <ControlSlider
          label="Fixture repeats"
          value={repeatCount}
          min={4}
          max={32}
          step={1}
          onChange={setRepeatCount}
          disabled={controlsLocked}
        />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <ControlSlider
          label="Scored runs"
          value={scoredRuns}
          min={1}
          max={7}
          step={1}
          onChange={setScoredRuns}
          disabled={controlsLocked}
        />
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
          <div className="text-xs font-semibold text-foreground">Order mode</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["rotate", "random", "fixed"] satisfies OrderMode[]).map((mode) => (
              <Button
                key={mode}
                size="sm"
                variant={orderMode === mode ? "default" : "outline"}
                onClick={() => setOrderMode(mode)}
                disabled={controlsLocked}
              >
                {mode}
              </Button>
            ))}
          </div>
        </div>
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
          <div className="text-xs font-semibold text-foreground">Benchmark profile</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={profile === "parity-gfm" ? "default" : "outline"}
              onClick={() => setProfile("parity-gfm")}
              disabled={controlsLocked}
            >
              parity-gfm
            </Button>
            <Button
              size="sm"
              variant={profile === "streaming-heavy" ? "default" : "outline"}
              onClick={() => setProfile("streaming-heavy")}
              disabled={controlsLocked}
            >
              streaming-heavy
            </Button>
          </div>
        </div>
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
          <div className="text-xs font-semibold text-foreground">Chart metric</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={chartMetric === "first" ? "default" : "outline"}
              onClick={() => setChartMetric("first")}
              disabled={chartLayout === "split" || controlsLocked}
            >
              First commit
            </Button>
            <Button
              size="sm"
              variant={chartMetric === "final" ? "default" : "outline"}
              onClick={() => setChartMetric("final")}
              disabled={chartLayout === "split" || controlsLocked}
            >
              Final stable
            </Button>
          </div>
          {chartLayout === "split" ? <div className="mt-1 text-[11px] text-muted">Split mode shows both metrics.</div> : null}
        </div>
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
          <div className="text-xs font-semibold text-foreground">Chart layout</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={chartLayout === "single" ? "default" : "outline"}
              onClick={() => setChartLayout("single")}
              disabled={controlsLocked}
            >
              Single
            </Button>
            <Button
              size="sm"
              variant={chartLayout === "split" ? "default" : "outline"}
              onClick={() => setChartLayout("split")}
              disabled={controlsLocked}
            >
              Split
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={startRun} disabled={!streamHandleReady || runState === "running" || runState === "paused"}>
          {methodologyMode === "ci-locked" ? "Start CI run" : "Start run"}
        </Button>
        <Button size="sm" variant="outline" onClick={pauseRun} disabled={runState !== "running"}>
          Pause
        </Button>
        <Button size="sm" variant="outline" onClick={resumeRun} disabled={runState !== "paused"}>
          Resume
        </Button>
        <Button size="sm" variant="ghost" onClick={resetRun}>
          Reset
        </Button>
      </div>

      <div className={cn("mt-5 grid gap-3", chartLayout === "split" ? "xl:grid-cols-2" : "grid-cols-1")}>
        {chartLayout === "split" ? (
          <>
            {renderLatencyChart("first", "Per-delta latency (first visible commit - emit time)", yAxisMaxFirst)}
            {renderLatencyChart("final", "Per-delta latency (final stable commit - emit time)", yAxisMaxFinal)}
          </>
        ) : (
          renderLatencyChart(
            chartMetric,
            `Per-delta latency (${chartMetric === "first" ? "first visible commit" : "final stable commit"} - emit time)`,
            yAxisMax,
          )
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
        {ENGINE_META.map((engine) => (
          <span key={engine.key} className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/15 px-2.5 py-1">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: engine.color }} />
            {engine.label}
          </span>
        ))}
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-2 py-2">Renderer</th>
              <th className="px-2 py-2">Samples</th>
              <th className="px-2 py-2">First paint p50</th>
              <th className="px-2 py-2">First paint p95</th>
              <th className="px-2 py-2">Final stable p50</th>
              <th className="px-2 py-2">Final stable p95</th>
              <th className="px-2 py-2">Run p50</th>
              <th className="px-2 py-2">Throughput p50</th>
            </tr>
          </thead>
          <tbody>
            {ENGINE_META.map((engine) => {
              const row = aggregateStats[engine.key];
              return (
                <tr key={engine.key} className="border-border/50 border-t">
                  <td className="px-2 py-2 font-medium text-foreground">{engine.label}</td>
                  <td className="px-2 py-2 text-muted">{row.final.count.toLocaleString()}</td>
                  <td className="px-2 py-2 text-muted">{formatMs(row.first.p50)}</td>
                  <td className="px-2 py-2 text-muted">{formatMs(row.first.p95)}</td>
                  <td className="px-2 py-2 text-muted">{formatMs(row.final.p50)}</td>
                  <td className="px-2 py-2 text-muted">{formatMs(row.final.p95)}</td>
                  <td className="px-2 py-2 text-muted">{formatMs(row.runMs.p50)}</td>
                  <td className="px-2 py-2 text-muted">{formatThroughput(row.throughput.p50)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 rounded-md border border-border/60 bg-muted/15 p-3 text-xs">
        <div className="font-semibold text-foreground">Metric leaders</div>
        {(() => {
          const leaderChips: Array<{
            id: string;
            label: string;
            winner: MetricWinner;
            mode: "latency" | "throughput";
          }> = [
            { id: "first-p50", label: "First paint p50", winner: metricWinners.firstP50, mode: "latency" },
            { id: "final-p50", label: "Final stable p50", winner: metricWinners.finalP50, mode: "latency" },
            { id: "run-p50", label: "Run p50", winner: metricWinners.runP50, mode: "latency" },
            { id: "throughput-p50", label: "Throughput p50", winner: metricWinners.throughputP50, mode: "throughput" },
          ];

          return (
            <div className="mt-2 flex flex-wrap gap-2 text-muted">
              {leaderChips.map((chip) => (
                <span
                  key={chip.id}
                  className={cn(
                    "rounded-full border px-2.5 py-1 font-medium",
                    chip.winner ? getEngineAccentClass(chip.winner.key) : "border-border/60 bg-muted/20 text-muted",
                  )}
                >
                  {chip.label}:{" "}
                  {chip.winner
                    ? `${chip.winner.label} (${chip.mode === "throughput" ? formatThroughput(chip.winner.value) : formatMs(chip.winner.value)})`
                    : "-"}
                </span>
              ))}
            </div>
          );
        })()}
        <div className="mt-2 flex flex-wrap gap-2">
          {ENGINE_META.map((engine) => (
            <span key={engine.key} className={cn("rounded-full border px-2.5 py-1 font-medium", getEngineAccentClass(engine.key))}>
              {engine.label}: {winnerTally[engine.key]} / 4 metric wins
            </span>
          ))}
        </div>
      </div>

      <div className="mt-3 rounded-md border border-border/60 bg-muted/15 p-3 text-xs">
        <div className="font-semibold text-foreground">CI gate (StreamMDX vs Streamdown)</div>
        <div className="mt-2 flex flex-wrap gap-2">
          <span
            className={cn(
              "rounded-full border px-2.5 py-1 font-medium",
              gateSummary.status === "pass"
                ? "border-emerald-500/45 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                : gateSummary.status === "fail"
                  ? "border-rose-500/45 bg-rose-500/12 text-rose-700 dark:text-rose-300"
                  : "border-border/60 bg-muted/20 text-muted",
            )}
          >
            {gateSummary.status.toUpperCase()} • pass={gateSummary.passed} fail={gateSummary.failed} pending={gateSummary.pending}
          </span>
          {methodologyMode !== "ci-locked" ? (
            <span className="rounded-full border border-amber-500/45 bg-amber-500/12 px-2.5 py-1 font-medium text-amber-700 dark:text-amber-300">
              Run in CI locked mode before claiming results
            </span>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-muted">
          {gateChecks.map((gate) => (
            <span
              key={gate.id}
              className={cn(
                "rounded-full border px-2.5 py-1 font-medium",
                gate.status === "pass"
                  ? "border-emerald-500/45 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                  : gate.status === "fail"
                    ? "border-rose-500/45 bg-rose-500/12 text-rose-700 dark:text-rose-300"
                    : "border-border/60 bg-muted/20 text-muted",
              )}
            >
              {gate.label}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-2 py-2">Renderer</th>
              <th className="px-2 py-2">Emit→ingest p50</th>
              <th className="px-2 py-2">Ingest→commit p50</th>
              <th className="px-2 py-2">Emit→commit p50</th>
              <th className="px-2 py-2">Append overhead p50</th>
              <th className="px-2 py-2">Timer drift p50 / p95</th>
            </tr>
          </thead>
          <tbody>
            {ENGINE_META.map((engine) => {
              const row = stageStats[engine.key];
              return (
                <tr key={`${engine.key}-stages`} className="border-border/50 border-t">
                  <td className="px-2 py-2 font-medium text-foreground">{engine.label}</td>
                  <td className="px-2 py-2 text-muted">{formatMs(row.emitToIngest.p50)}</td>
                  <td className="px-2 py-2 text-muted">{formatMs(row.ingestToCommit.p50)}</td>
                  <td className="px-2 py-2 text-muted">{formatMs(row.emitToCommit.p50)}</td>
                  <td className="px-2 py-2 text-muted">{formatMs(row.appendOverhead.p50)}</td>
                  <td className="px-2 py-2 text-muted">
                    {formatMs(row.timerDrift.p50)} / {formatMs(row.timerDrift.p95)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        <RendererPane
          title="StreamMDX"
          subtitle="Incremental worker parser + patch renderer"
          active={activeEngine === "streammdx"}
          runState={runState}
          hasData={streamMdxHasData}
        >
          <BottomStickScrollArea className="h-full w-full" contentClassName="p-3" showJumpToBottom showScrollBar>
            <StreamMdxPanel
              seq={activeEngine === "streammdx" ? activeSeq : 0}
              onCommit={handleStreamMdxCommit}
              streamHandleRef={streamHandleRef}
              setStreamHandleReady={setStreamHandleReady}
              features={streamMdxFeatures}
              scheduling={streamMdxScheduling}
            />
          </BottomStickScrollArea>
        </RendererPane>

        <RendererPane
          title="Streamdown"
          subtitle="Drop-in streaming replacement for react-markdown"
          active={activeEngine === "streamdown"}
          runState={runState}
          hasData={engineText.streamdown.length > 0}
        >
          {activeEngine === "streamdown" || runState === "done" ? (
            <BottomStickScrollArea className="h-full w-full" contentClassName="p-3" showJumpToBottom showScrollBar>
              <StreamdownPanel
                text={engineText.streamdown}
                seq={activeEngine === "streamdown" ? activeSeq : 0}
                onCommit={handleStreamdownCommit}
                remarkPlugins={streamdownPlugins?.remarkPlugins}
                rehypePlugins={streamdownPlugins?.rehypePlugins}
              />
            </BottomStickScrollArea>
          ) : null}
        </RendererPane>

        <RendererPane
          title="react-markdown"
          subtitle="Baseline markdown renderer (full re-render on updates)"
          active={activeEngine === "react-markdown"}
          runState={runState}
          hasData={engineText["react-markdown"].length > 0}
        >
          {activeEngine === "react-markdown" || runState === "done" ? (
            <BottomStickScrollArea className="h-full w-full" contentClassName="p-3" showJumpToBottom showScrollBar>
              <ReactMarkdownPanel
                text={engineText["react-markdown"]}
                seq={activeEngine === "react-markdown" ? activeSeq : 0}
                onCommit={handleReactMarkdownCommit}
                remarkPlugins={reactMarkdownPlugins}
              />
            </BottomStickScrollArea>
          ) : null}
        </RendererPane>
      </div>

      <p className="mt-4 text-xs text-muted">
        Method note: each engine runs warmup then scored pass in isolation. Commit timing capture is unified across engines via layout-effect
        commit hooks to avoid instrumentation bias. Use CI locked mode for claim-grade runs; use explore mode to diagnose bottlenecks. \"First
        paint\" measures earliest visible commit; \"final stable\" reflects how quickly each delta settles after downstream formatting/render
        passes.
      </p>
    </section>
  );
}

function RendererPane({
  title,
  subtitle,
  active,
  runState,
  hasData,
  children,
}: {
  title: string;
  subtitle: string;
  active: boolean;
  runState: RunState;
  hasData: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm">
      <div className="border-border/60 border-b px-3 py-2">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="text-xs text-muted">{subtitle}</div>
      </div>
      <div className={cn("h-[420px] w-full")}>{children}</div>
      {runState === "running" && !active ? (
        <div className="border-border/60 border-t px-3 py-2 text-xs text-muted">Waiting for isolated run phase…</div>
      ) : null}
      {runState !== "running" && !active && !hasData ? (
        <div className="border-border/60 border-t px-3 py-2 text-xs text-muted">No stream data yet.</div>
      ) : null}
    </div>
  );
}

function ControlSlider({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold text-foreground">{label}</span>
        <span className="font-mono text-muted">{value}</span>
      </div>
      <Slider
        className="mt-2"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => onChange(next[0] ?? value)}
        disabled={disabled}
      />
    </div>
  );
}
