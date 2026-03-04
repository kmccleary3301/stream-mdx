"use client";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { useCallback, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Streamdown } from "streamdown";

type EngineKey = "streammdx" | "streamdown" | "react-markdown";
type RunState = "idle" | "running" | "done";

const ENGINE_META: Array<{ key: EngineKey; label: string; accent: string }> = [
  { key: "streammdx", label: "StreamMDX", accent: "text-blue-700 dark:text-blue-300" },
  { key: "streamdown", label: "Streamdown", accent: "text-emerald-700 dark:text-emerald-300" },
  { key: "react-markdown", label: "react-markdown", accent: "text-amber-700 dark:text-amber-300" },
];

const STATIC_FIXTURES = [
  {
    key: "prose",
    label: "Prose heavy",
    description: "Long narrative text with headings, lists, and inline formatting.",
    markdown: `# Incident review

The rollout was completed in two waves. The first wave targeted internal users, and the second wave targeted 10% of production traffic.

## Key observations

- Throughput stayed stable during the migration.
- Error rates remained below the alert threshold.
- Developer feedback improved after simplifying config defaults.

### Next actions

1. Publish the migration notes.
2. Add automated replay checks for regressions.
3. Expand production rollout during the next release window.
`,
  },
  {
    key: "tables",
    label: "Table heavy",
    description: "Large table blocks with short explanatory text.",
    markdown: `# Capacity dashboard

| Region | Requests/s | p95 latency | Error rate | Notes |
| --- | ---: | ---: | ---: | --- |
| us-east | 3840 | 62 ms | 0.21% | steady |
| us-west | 2910 | 71 ms | 0.18% | cache warmup |
| eu-west | 2480 | 77 ms | 0.24% | cross-zone traffic |
| ap-south | 1730 | 96 ms | 0.31% | higher RTT |
| sa-east | 1090 | 118 ms | 0.41% | congestion |

| Service | CPU | Memory | Saturation |
| --- | ---: | ---: | ---: |
| parser-worker | 41% | 318 MB | low |
| patch-scheduler | 37% | 146 MB | low |
| markdown-render | 49% | 411 MB | medium |
`,
  },
  {
    key: "code",
    label: "Code heavy",
    description: "Multiple fenced code blocks with surrounding markdown.",
    markdown: `# Patch scheduler excerpt

\`\`\`ts
type Patch = { op: "insert" | "replace" | "remove"; path: string; value?: unknown };

export function applyBatch(patches: Patch[]) {
  const queue = [...patches];
  const out: Patch[] = [];
  while (queue.length > 0) {
    const patch = queue.shift();
    if (!patch) continue;
    if (out.length > 0 && out[out.length - 1]?.path === patch.path) {
      out[out.length - 1] = patch;
      continue;
    }
    out.push(patch);
  }
  return out;
}
\`\`\`

\`\`\`bash
npm run docs:dev
npm run perf:harness -- --fixture naive-bayes --scenario S2_typical --runs 3
\`\`\`

\`\`\`json
{
  "first_p50_ms": 4.7,
  "final_p50_ms": 3556.7,
  "throughput_chars_per_sec": 1156
}
\`\`\`
`,
  },
  {
    key: "mixed",
    label: "Mixed rich markdown",
    description: "Lists, quotes, links, tasks, and tables in one document.",
    markdown: `# Mixed rendering sample

> This fixture mixes markdown features commonly seen in AI assistant outputs.

## Checklist

- [x] Parse heading structure
- [x] Render task list states
- [ ] Validate final HTML snapshots

## Notes

Use [comparison docs](/docs/guides/comparisons-and-benchmarks) for reproducible methodology.

| Metric | StreamMDX | Streamdown |
| --- | ---: | ---: |
| First paint p50 | 4.7 ms | 5.8 ms |
| Final stable p50 | 3556.7 ms | 3721.2 ms |

\`inline code\`, **bold**, and _italic_ should all render correctly.
`,
  },
] as const;

type FixtureKey = (typeof STATIC_FIXTURES)[number]["key"];
type FixtureSpec = (typeof STATIC_FIXTURES)[number];
type MeasureStats = { first: number[]; final: number[] };
type MeasureStore = Record<FixtureKey, Record<EngineKey, MeasureStats>>;
type CaseResult = { firstMs: number | null; finalMs: number | null; timedOut: boolean };

const SETTLE_WINDOW_MS = 90;
const CASE_TIMEOUT_MS = 8000;

function createMeasureStats(): MeasureStats {
  return { first: [], final: [] };
}

function createEngineStore(): Record<EngineKey, MeasureStats> {
  return {
    streammdx: createMeasureStats(),
    streamdown: createMeasureStats(),
    "react-markdown": createMeasureStats(),
  };
}

function createMeasureStore(): MeasureStore {
  return {
    prose: createEngineStore(),
    tables: createEngineStore(),
    code: createEngineStore(),
    mixed: createEngineStore(),
  };
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? null;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function formatMs(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  return `${value.toFixed(1)} ms`;
}

function isWorkerReady(handle: StreamingMarkdownHandle | null): handle is StreamingMarkdownHandle {
  if (!handle) return false;
  try {
    return handle.getState().workerReady;
  } catch {
    return false;
  }
}

export function StaticRenderComparison() {
  const [runState, setRunState] = useState<RunState>("idle");
  const [iterations, setIterations] = useState(3);
  const [activeFixture, setActiveFixture] = useState<FixtureKey | null>(null);
  const [activeEngine, setActiveEngine] = useState<EngineKey | null>(null);
  const [progress, setProgress] = useState(0);
  const [totalCases, setTotalCases] = useState(0);
  const [timeoutCount, setTimeoutCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [reactMarkdownText, setReactMarkdownText] = useState("");
  const [streamdownText, setStreamdownText] = useState("");

  const panelRefs = useRef<Record<EngineKey, HTMLDivElement | null>>({
    streammdx: null,
    streamdown: null,
    "react-markdown": null,
  });
  const runCancelledRef = useRef(false);
  const resultsRef = useRef<MeasureStore>(createMeasureStore());
  const streamHandleRef = useRef<StreamingMarkdownHandle | null>(null);

  const setStreamHandle = useCallback((handle: StreamingMarkdownHandle | null) => {
    streamHandleRef.current = handle;
  }, []);

  const waitForFrame = useCallback(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())), []);

  const waitFrames = useCallback(
    async (count: number) => {
      for (let index = 0; index < count; index += 1) {
        await waitForFrame();
      }
    },
    [waitForFrame],
  );

  const waitForReadyStreamHandle = useCallback(async (): Promise<StreamingMarkdownHandle> => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < 5000) {
      const handle = streamHandleRef.current;
      if (isWorkerReady(handle)) {
        return handle;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
    }
    throw new Error("Timed out waiting for StreamMDX worker readiness.");
  }, []);

  const restartStreamSession = useCallback(async (): Promise<StreamingMarkdownHandle> => {
    const handle = await waitForReadyStreamHandle();
    handle.restart();
    await waitFrames(2);
    return await waitForReadyStreamHandle();
  }, [waitForReadyStreamHandle, waitFrames]);

  const withRestartedStreamSession = useCallback(
    async (operation: (handle: StreamingMarkdownHandle) => Promise<void> | void) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const handle = await restartStreamSession();
        try {
          await operation(handle);
          return;
        } catch (error) {
          if (error instanceof Error && error.message === "Worker not attached" && attempt === 0) {
            continue;
          }
          throw error;
        }
      }
      throw new Error("Timed out waiting for StreamMDX worker readiness.");
    },
    [restartStreamSession],
  );

  const clearEngineContent = useCallback(
    async (engine: EngineKey) => {
      if (engine === "react-markdown") {
        setReactMarkdownText("");
        return;
      }
      if (engine === "streamdown") {
        setStreamdownText("");
        return;
      }
      await restartStreamSession();
    },
    [restartStreamSession],
  );

  const measureContainer = useCallback(
    async (container: HTMLDivElement, trigger: () => Promise<void> | void): Promise<CaseResult> =>
      await new Promise<CaseResult>(async (resolve, reject) => {
        const startAt = performance.now();
        let firstMutationAt: number | null = null;
        let lastMutationAt: number | null = null;
        let settleTimer: number | null = null;
        let timeoutTimer: number | null = null;
        let done = false;

        const cleanup = () => {
          observer.disconnect();
          if (settleTimer !== null) window.clearTimeout(settleTimer);
          if (timeoutTimer !== null) window.clearTimeout(timeoutTimer);
        };

        const finish = (timedOut: boolean) => {
          if (done) return;
          done = true;
          cleanup();
          const firstBase = firstMutationAt;
          const finalBase = lastMutationAt ?? firstMutationAt;
          resolve({
            firstMs: firstBase === null ? null : Math.max(0, firstBase - startAt),
            finalMs: finalBase === null ? null : Math.max(0, finalBase - startAt),
            timedOut,
          });
        };

        const scheduleSettle = () => {
          if (settleTimer !== null) window.clearTimeout(settleTimer);
          settleTimer = window.setTimeout(() => finish(false), SETTLE_WINDOW_MS);
        };

        const observer = new MutationObserver(() => {
          const now = performance.now();
          if (firstMutationAt === null) firstMutationAt = now;
          lastMutationAt = now;
          scheduleSettle();
        });

        observer.observe(container, {
          childList: true,
          subtree: true,
          characterData: true,
        });

        timeoutTimer = window.setTimeout(() => finish(true), CASE_TIMEOUT_MS);

        try {
          await trigger();
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }

        if ((container.textContent ?? "").trim().length > 0) {
          const now = performance.now();
          if (firstMutationAt === null) firstMutationAt = now;
          lastMutationAt = now;
          scheduleSettle();
        }
      }),
    [],
  );

  const runSingleCase = useCallback(
    async (fixture: FixtureSpec, engine: EngineKey): Promise<CaseResult> => {
      setActiveFixture(fixture.key);
      setActiveEngine(engine);
      await clearEngineContent(engine);
      await waitFrames(2);

      const container = panelRefs.current[engine];
      if (!container) {
        throw new Error(`Missing renderer panel for ${engine}.`);
      }

      return await measureContainer(container, async () => {
        if (engine === "react-markdown") {
          setReactMarkdownText(fixture.markdown);
          return;
        }
        if (engine === "streamdown") {
          setStreamdownText(fixture.markdown);
          return;
        }
        await withRestartedStreamSession(async (handle) => {
          handle.append(fixture.markdown);
          handle.finalize();
        });
      });
    },
    [clearEngineContent, measureContainer, waitFrames, withRestartedStreamSession],
  );

  const startRun = useCallback(async () => {
    if (runState === "running") return;

    runCancelledRef.current = false;
    setErrorMessage(null);
    setTimeoutCount(0);
    setProgress(0);
    setActiveFixture(null);
    setActiveEngine(null);
    resultsRef.current = createMeasureStore();
    setRevision((value) => value + 1);
    setRunState("running");

    const queue: Array<{ fixture: FixtureSpec; engine: EngineKey }> = [];
    for (let run = 0; run < iterations; run += 1) {
      for (const fixture of STATIC_FIXTURES) {
        for (const engine of ENGINE_META.map((meta) => meta.key)) {
          queue.push({ fixture, engine });
        }
      }
    }

    setTotalCases(queue.length);

    try {
      for (let index = 0; index < queue.length; index += 1) {
        if (runCancelledRef.current) break;
        const { fixture, engine } = queue[index]!;
        const result = await runSingleCase(fixture, engine);
        if (result.firstMs !== null) {
          resultsRef.current[fixture.key][engine].first.push(result.firstMs);
        }
        if (result.finalMs !== null) {
          resultsRef.current[fixture.key][engine].final.push(result.finalMs);
        }
        if (result.timedOut) {
          setTimeoutCount((value) => value + 1);
        }
        setProgress(index + 1);
        setRevision((value) => value + 1);
      }

      if (!runCancelledRef.current) {
        setRunState("done");
      } else {
        setRunState("idle");
      }
    } catch (error) {
      setRunState("idle");
      setErrorMessage(error instanceof Error ? error.message : "Static benchmark failed.");
    } finally {
      setActiveFixture(null);
      setActiveEngine(null);
    }
  }, [iterations, runSingleCase, runState]);

  const cancelRun = useCallback(() => {
    runCancelledRef.current = true;
  }, []);

  const summaries = useMemo(() => {
    void revision;
    return STATIC_FIXTURES.map((fixture) => {
      const perEngine = Object.fromEntries(
        ENGINE_META.map((engine) => {
          const sample = resultsRef.current[fixture.key][engine.key];
          return [
            engine.key,
            {
              firstP50: percentile(sample.first, 0.5),
              finalP50: percentile(sample.final, 0.5),
              sampleCount: sample.final.length,
            },
          ];
        }),
      ) as Record<EngineKey, { firstP50: number | null; finalP50: number | null; sampleCount: number }>;

      let winner: EngineKey | null = null;
      let winnerValue: number | null = null;
      for (const engine of ENGINE_META) {
        const value = perEngine[engine.key].finalP50;
        if (value === null) continue;
        if (winnerValue === null || value < winnerValue) {
          winner = engine.key;
          winnerValue = value;
        }
      }

      return { fixture, perEngine, winner, winnerValue };
    });
  }, [revision]);

  return (
    <section className="rounded-xl border border-border/60 bg-background p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Static render comparison (content types)</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Measures one-shot static rendering across prose, tables, code, and mixed markdown fixtures. Times are captured per engine as first
            mutation and final settled mutation.
          </p>
        </div>
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted">
          <div>State: {runState}</div>
          <div>Iterations: {iterations.toLocaleString()}</div>
          <div>
            Progress: {progress.toLocaleString()} / {totalCases.toLocaleString()}
          </div>
          <div>Active fixture: {activeFixture ?? "-"}</div>
          <div>Active engine: {activeEngine ?? "-"}</div>
          <div>Timeouts: {timeoutCount.toLocaleString()}</div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-semibold text-foreground">Iterations per fixture</span>
            <span className="font-mono text-muted">{iterations}</span>
          </div>
          <Slider
            className="mt-2"
            value={[iterations]}
            min={1}
            max={7}
            step={1}
            onValueChange={(next) => setIterations(next[0] ?? iterations)}
            disabled={runState === "running"}
          />
        </div>
        <Button size="sm" onClick={startRun} disabled={runState === "running"}>
          Start static run
        </Button>
        <Button size="sm" variant="outline" onClick={cancelRun} disabled={runState !== "running"}>
          Stop
        </Button>
      </div>

      {errorMessage ? (
        <div className="mt-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {errorMessage}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted">
        {STATIC_FIXTURES.map((fixture) => (
          <span key={fixture.key} className="rounded-full border border-border/50 bg-muted/20 px-2.5 py-1">
            {fixture.label}
          </span>
        ))}
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[1040px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-2 py-2">Content type</th>
              <th className="px-2 py-2">Description</th>
              <th className="px-2 py-2">StreamMDX first/final p50</th>
              <th className="px-2 py-2">Streamdown first/final p50</th>
              <th className="px-2 py-2">react-markdown first/final p50</th>
              <th className="px-2 py-2">Final p50 winner</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((row) => (
              <tr key={row.fixture.key} className="border-border/50 border-t align-top">
                <td className="px-2 py-2 font-medium text-foreground">{row.fixture.label}</td>
                <td className="px-2 py-2 text-muted">{row.fixture.description}</td>
                {ENGINE_META.map((engine) => (
                  <td key={`${row.fixture.key}-${engine.key}`} className="px-2 py-2 text-muted">
                    {formatMs(row.perEngine[engine.key].firstP50)} / {formatMs(row.perEngine[engine.key].finalP50)}
                    <span className="ml-2 text-[11px] opacity-70">n={row.perEngine[engine.key].sampleCount}</span>
                  </td>
                ))}
                <td className="px-2 py-2">
                  {row.winner ? (
                    <span className={cn("font-medium", ENGINE_META.find((engine) => engine.key === row.winner)?.accent)}>
                      {ENGINE_META.find((engine) => engine.key === row.winner)?.label} ({formatMs(row.winnerValue)})
                    </span>
                  ) : (
                    <span className="text-muted">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        <div className={cn("overflow-hidden rounded-xl border border-border/60", activeEngine === "streammdx" ? "ring-1 ring-blue-500/40" : "")}>
          <div className="border-border/60 border-b px-3 py-2 text-sm font-semibold text-foreground">StreamMDX</div>
          <div
            ref={(node) => {
              panelRefs.current.streammdx = node;
            }}
            className="h-[250px] overflow-auto p-3 text-sm"
          >
            <div className="prose max-w-none text-sm">
              <StreamingMarkdown
                ref={setStreamHandle}
                worker="/workers/markdown-worker.js"
                className="markdown-v2-output"
                features={{ html: false, tables: true, math: false, mdx: false, footnotes: false, callouts: false }}
                scheduling={{ batch: "rAF", startupMicrotaskFlushes: 4 }}
              />
            </div>
          </div>
        </div>

        <div className={cn("overflow-hidden rounded-xl border border-border/60", activeEngine === "streamdown" ? "ring-1 ring-emerald-500/40" : "")}>
          <div className="border-border/60 border-b px-3 py-2 text-sm font-semibold text-foreground">Streamdown</div>
          <div
            ref={(node) => {
              panelRefs.current.streamdown = node;
            }}
            className="h-[250px] overflow-auto p-3"
          >
            <div className="prose max-w-none text-sm">
              <Streamdown remarkPlugins={[remarkGfm]}>{streamdownText}</Streamdown>
            </div>
          </div>
        </div>

        <div
          className={cn(
            "overflow-hidden rounded-xl border border-border/60",
            activeEngine === "react-markdown" ? "ring-1 ring-amber-500/40" : "",
          )}
        >
          <div className="border-border/60 border-b px-3 py-2 text-sm font-semibold text-foreground">react-markdown</div>
          <div
            ref={(node) => {
              panelRefs.current["react-markdown"] = node;
            }}
            className="h-[250px] overflow-auto p-3"
          >
            <div className="prose max-w-none text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{reactMarkdownText}</ReactMarkdown>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
