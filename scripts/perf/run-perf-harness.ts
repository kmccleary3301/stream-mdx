import path from "node:path";
import fs from "node:fs/promises";

import { chromium } from "@playwright/test";

const BASE_URL = process.env.STREAM_MDX_PERF_BASE_URL ?? "http://localhost:3000";

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getNumArg(flag: string, envKey: string): number | null {
  const arg = getArg(flag);
  if (arg) {
    const parsed = Number(arg);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const envValue = process.env[envKey];
  if (!envValue) return null;
  const parsed = Number(envValue);
  return Number.isFinite(parsed) ? parsed : null;
}

const FIXTURE = getArg("--fixture") ?? process.env.STREAM_MDX_PERF_FIXTURE ?? "naive-bayes";
const SCENARIO = getArg("--scenario") ?? process.env.STREAM_MDX_PERF_SCENARIO ?? "S2_typical";
const SCHEDULING = getArg("--scheduling") ?? process.env.STREAM_MDX_PERF_SCHEDULING ?? "aggressive";
const RUNS = getNumArg("--runs", "STREAM_MDX_PERF_RUNS") ?? 3;
const WARMUP = getNumArg("--warmup", "STREAM_MDX_PERF_WARMUP") ?? 1;
const TIMEOUT_MS = getNumArg("--timeout", "STREAM_MDX_PERF_TIMEOUT") ?? 180000;
const OUT_DIR = getArg("--out") ?? process.env.STREAM_MDX_PERF_OUT ?? "tmp/perf-runs";
const HEADLESS = !(hasFlag("--headed") || process.env.STREAM_MDX_PERF_HEADED === "1");
const CPU_THROTTLE = getNumArg("--cpuThrottle", "STREAM_MDX_PERF_CPU_THROTTLE");
const PROFILER_ENABLED = hasFlag("--profiler") || process.env.STREAM_MDX_PERF_PROFILER === "1";

const SCHEDULING_OVERRIDES: Record<string, string> = {
  batch: getArg("--batch") ?? process.env.STREAM_MDX_PERF_BATCH ?? "",
  frameBudgetMs: getArg("--frameBudgetMs") ?? process.env.STREAM_MDX_PERF_FRAME_BUDGET_MS ?? "",
  maxBatchesPerFlush: getArg("--maxBatchesPerFlush") ?? process.env.STREAM_MDX_PERF_MAX_BATCHES ?? "",
  lowPriorityFrameBudgetMs:
    getArg("--lowPriorityFrameBudgetMs") ?? process.env.STREAM_MDX_PERF_LOW_PRIORITY_FRAME_BUDGET_MS ?? "",
  maxLowPriorityBatchesPerFlush:
    getArg("--maxLowPriorityBatchesPerFlush") ?? process.env.STREAM_MDX_PERF_MAX_LOW_PRIORITY_BATCHES ?? "",
  urgentQueueThreshold: getArg("--urgentQueueThreshold") ?? process.env.STREAM_MDX_PERF_URGENT_THRESHOLD ?? "",
  historyLimit: getArg("--historyLimit") ?? process.env.STREAM_MDX_PERF_HISTORY_LIMIT ?? "",
  adaptiveSwitch: getArg("--adaptiveSwitch") ?? process.env.STREAM_MDX_PERF_ADAPTIVE_SWITCH ?? "",
  adaptiveQueueThreshold: getArg("--adaptiveQueueThreshold") ?? process.env.STREAM_MDX_PERF_ADAPTIVE_QUEUE_THRESHOLD ?? "",
};

type PerfReport = {
  meta: {
    fixtureId: string;
    scenarioId: string;
    schedulingPreset: string;
    scheduling: Record<string, unknown>;
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
    flushes: Array<{
      durationMs: number;
      patchToDomMs: number;
      queueDepthBefore: number;
      queueDelay: { avg: number; max: number; p95: number };
      batchCount: number;
      appliedPatches: number;
      totalPatches: number;
    }>;
    longTasks: Array<{ startTime: number; duration: number }>;
    rafDeltas: number[];
    memory: Array<{ ts: number; usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }>;
    profiler: Array<{
      id: string;
      phase: "mount" | "update";
      actualDuration: number;
      baseDuration: number;
      startTime: number;
      commitTime: number;
    }>;
  };
};

type CdpMetricMap = Record<string, number>;

type CdpMetrics = {
  taskMs: number | null;
  scriptMs: number | null;
  layoutMs: number | null;
  recalcStyleMs: number | null;
  paintMs: number | null;
};

type DomCounters = {
  documents: number;
  nodes: number;
  jsEventListeners: number;
};

type PerfRun = {
  run: number;
  report: PerfReport;
  cdp: {
    metrics: CdpMetrics | null;
    domStart: DomCounters | null;
    domEnd: DomCounters | null;
    domDelta: DomCounters | null;
  };
};

type Stats = {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
};

type Summary = {
  config: {
    baseUrl: string;
    fixture: string;
    scenario: string;
    scheduling: string;
    overrides: Record<string, string>;
    runs: number;
    warmup: number;
    headless: boolean;
    timeoutMs: number;
    cpuThrottle: number | null;
    profiler: boolean;
  };
  runs: Array<{
    run: number;
    durationMs: number;
    timeToFirstFlushMs: number | null;
    flushDuration: Stats | null;
    patchToDom: Stats | null;
    queueDepth: Stats | null;
    queueDelayP95: Stats | null;
    longTasks: Stats | null;
    longTasksOver50: number;
    longTasksOver100: number;
    rafDeltas: Stats | null;
    rafOver33: number;
    rafOver50: number;
    memoryMB: { start: number | null; peak: number | null; end: number | null };
    cdp: CdpMetrics | null;
    domEnd: DomCounters | null;
    domDelta: DomCounters | null;
    profilerActual: Stats | null;
    profilerBase: Stats | null;
  }>;
  aggregate: {
    durationMs: Stats | null;
    timeToFirstFlushMs: Stats | null;
    longTaskP95: Stats | null;
    rafP95: Stats | null;
    memoryPeakMB: Stats | null;
    cdpTaskMs: Stats | null;
    cdpScriptMs: Stats | null;
    cdpLayoutMs: Stats | null;
    cdpRecalcStyleMs: Stats | null;
    cdpPaintMs: Stats | null;
    domNodesEnd: Stats | null;
    domListenersEnd: Stats | null;
    profilerActual: Stats | null;
    profilerBase: Stats | null;
  };
};

function percentIndex(count: number, pct: number): number {
  if (count <= 0) return 0;
  const idx = Math.floor(count * pct);
  return Math.min(Math.max(idx, 0), count - 1);
}

function stats(values: number[]): Stats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const avg = sum / sorted.length;
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg,
    p50: sorted[percentIndex(sorted.length, 0.5)],
    p95: sorted[percentIndex(sorted.length, 0.95)],
  };
}

function statsFromRuns(values: Array<number | null>): Stats | null {
  return stats(values.filter((value): value is number => typeof value === "number"));
}

function metricMap(metrics: Array<{ name: string; value: number }>): CdpMetricMap {
  return metrics.reduce<CdpMetricMap>((acc, metric) => {
    acc[metric.name] = metric.value;
    return acc;
  }, {});
}

function metricDeltaMs(start: CdpMetricMap | null, end: CdpMetricMap | null, name: string): number | null {
  if (!start || !end) return null;
  const startValue = start[name];
  const endValue = end[name];
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return null;
  return (endValue - startValue) * 1000;
}

function buildCdpMetrics(start: CdpMetricMap | null, end: CdpMetricMap | null): CdpMetrics | null {
  if (!start || !end) return null;
  return {
    taskMs: metricDeltaMs(start, end, "TaskDuration"),
    scriptMs: metricDeltaMs(start, end, "ScriptDuration"),
    layoutMs: metricDeltaMs(start, end, "LayoutDuration"),
    recalcStyleMs: metricDeltaMs(start, end, "RecalcStyleDuration"),
    paintMs: metricDeltaMs(start, end, "PaintDuration"),
  };
}

function diffDomCounters(start: DomCounters | null, end: DomCounters | null): DomCounters | null {
  if (!start || !end) return null;
  return {
    documents: end.documents - start.documents,
    nodes: end.nodes - start.nodes,
    jsEventListeners: end.jsEventListeners - start.jsEventListeners,
  };
}

function buildUrl(): string {
  const url = new URL("/perf/harness", BASE_URL);
  url.searchParams.set("fixture", FIXTURE);
  url.searchParams.set("scenario", SCENARIO);
  url.searchParams.set("scheduling", SCHEDULING);
  for (const [key, value] of Object.entries(SCHEDULING_OVERRIDES)) {
    if (value) url.searchParams.set(key, value);
  }
  if (PROFILER_ENABLED) {
    url.searchParams.set("profiler", "1");
  }
  return url.toString();
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function runOnce(pageId: number, page: Awaited<ReturnType<ReturnType<typeof chromium.launch>["newPage"]>>) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Performance.enable");
  } catch {
    // Ignore if unsupported.
  }
  if (CPU_THROTTLE && CPU_THROTTLE > 1) {
    try {
      await client.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
    } catch {
      // Ignore if unsupported.
    }
  }
  const target = buildUrl();
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  try {
    await page.waitForFunction(() => typeof window.__streammdxPerfRunStart === "number", { timeout: TIMEOUT_MS });
  } catch {
    // Ignore if the run start signal is missing.
  }
  const startMetrics = await client
    .send("Performance.getMetrics")
    .then((response) => metricMap(response.metrics))
    .catch(() => null);
  const startDom = await client.send("Memory.getDOMCounters").catch(() => null);
  await page.waitForFunction(() => Boolean(window.__streammdxPerfDone), { timeout: TIMEOUT_MS });
  await page.evaluate(() => window.__streammdxPerfDone);
  const report = await page.evaluate(() => window.__streammdxPerfReport ?? null);
  if (!report) {
    const errorMessage = await page.evaluate(() => window.__streammdxPerfError ?? null);
    throw new Error(errorMessage ? `Perf report missing: ${errorMessage}` : "Perf report missing.");
  }
  const endMetrics = await client
    .send("Performance.getMetrics")
    .then((response) => metricMap(response.metrics))
    .catch(() => null);
  const endDom = await client.send("Memory.getDOMCounters").catch(() => null);
  const cdpMetrics = buildCdpMetrics(startMetrics, endMetrics);
  const domStart = startDom ?? null;
  const domEnd = endDom ?? null;
  return {
    run: pageId,
    report: report as PerfReport,
    cdp: {
      metrics: cdpMetrics,
      domStart,
      domEnd,
      domDelta: diffDomCounters(domStart, domEnd),
    },
  };
}

function summarizeRun(entry: PerfRun) {
  const { report, run } = entry;
  const flushDurations = report.samples.flushes.map((m) => m.durationMs);
  const patchToDom = report.samples.flushes.map((m) => m.patchToDomMs);
  const queueDepth = report.samples.flushes.map((m) => m.queueDepthBefore);
  const queueDelayP95 = report.samples.flushes.map((m) => m.queueDelay.p95);
  const longTasks = report.samples.longTasks.map((entry) => entry.duration);
  const longTasksWithinRun = report.samples.longTasks
    .filter((entry) => entry.startTime >= report.meta.runStart && entry.startTime <= report.meta.runEnd)
    .map((entry) => entry.duration);
  const rafDeltas = report.samples.rafDeltas;
  const memory = report.samples.memory.map((sample) => sample.usedJSHeapSize / (1024 * 1024));
  const profilerActual = report.samples.profiler.map((entry) => entry.actualDuration);
  const profilerBase = report.samples.profiler.map((entry) => entry.baseDuration);
  const cdpMetrics = entry.cdp.metrics;
  const domEnd = entry.cdp.domEnd;
  const domDelta = entry.cdp.domDelta;

  const timeToFirstFlushMs =
    report.meta.firstFlushAt === null ? null : Math.max(0, report.meta.firstFlushAt - report.meta.runStart);

  return {
    run,
    durationMs: report.meta.runDurationMs,
    timeToFirstFlushMs,
    flushDuration: stats(flushDurations),
    patchToDom: stats(patchToDom),
    queueDepth: stats(queueDepth),
    queueDelayP95: stats(queueDelayP95),
    longTasks: stats(longTasksWithinRun),
    longTasksOver50: longTasksWithinRun.filter((value) => value > 50).length,
    longTasksOver100: longTasksWithinRun.filter((value) => value > 100).length,
    rafDeltas: stats(rafDeltas),
    rafOver33: rafDeltas.filter((value) => value > 33).length,
    rafOver50: rafDeltas.filter((value) => value > 50).length,
    memoryMB: {
      start: memory.length > 0 ? memory[0] : null,
      peak: memory.length > 0 ? Math.max(...memory) : null,
      end: memory.length > 0 ? memory[memory.length - 1] : null,
    },
    cdp: cdpMetrics,
    domEnd,
    domDelta,
    profilerActual: stats(profilerActual),
    profilerBase: stats(profilerBase),
  };
}

function formatSummaryText(summary: Summary): string {
  const lines: string[] = [];
  lines.push("stream-mdx perf harness summary");
  lines.push(`fixture: ${summary.config.fixture}`);
  lines.push(`scenario: ${summary.config.scenario}`);
  lines.push(`scheduling: ${summary.config.scheduling}`);
  lines.push(`runs: ${summary.config.runs} (warmup ${summary.config.warmup})`);
  if (summary.aggregate.durationMs) {
    lines.push(
      `duration p50/p95: ${summary.aggregate.durationMs.p50.toFixed(2)} / ${summary.aggregate.durationMs.p95.toFixed(2)} ms`,
    );
  }
  if (summary.aggregate.timeToFirstFlushMs) {
    lines.push(
      `first flush p50/p95: ${summary.aggregate.timeToFirstFlushMs.p50.toFixed(2)} / ${summary.aggregate.timeToFirstFlushMs.p95.toFixed(2)} ms`,
    );
  }
  if (summary.aggregate.longTaskP95) {
    lines.push(
      `longtask p95 (run p95s): ${summary.aggregate.longTaskP95.p50.toFixed(2)} / ${summary.aggregate.longTaskP95.p95.toFixed(2)} ms`,
    );
  }
  if (summary.aggregate.rafP95) {
    lines.push(
      `raf delta p95 (run p95s): ${summary.aggregate.rafP95.p50.toFixed(2)} / ${summary.aggregate.rafP95.p95.toFixed(2)} ms`,
    );
  }
  if (summary.aggregate.memoryPeakMB) {
    lines.push(
      `memory peak p50/p95: ${summary.aggregate.memoryPeakMB.p50.toFixed(2)} / ${summary.aggregate.memoryPeakMB.p95.toFixed(2)} MB`,
    );
  }
  if (summary.aggregate.profilerActual && summary.aggregate.profilerBase) {
    lines.push(
      `profiler actual p50/p95: ${summary.aggregate.profilerActual.p50.toFixed(2)} / ${summary.aggregate.profilerActual.p95.toFixed(2)} ms`,
    );
    lines.push(
      `profiler base p50/p95: ${summary.aggregate.profilerBase.p50.toFixed(2)} / ${summary.aggregate.profilerBase.p95.toFixed(2)} ms`,
    );
  }
  if (summary.aggregate.cdpTaskMs && summary.aggregate.cdpScriptMs) {
    lines.push(
      `cdp task p50/p95: ${summary.aggregate.cdpTaskMs.p50.toFixed(2)} / ${summary.aggregate.cdpTaskMs.p95.toFixed(2)} ms`,
    );
    lines.push(
      `cdp script p50/p95: ${summary.aggregate.cdpScriptMs.p50.toFixed(2)} / ${summary.aggregate.cdpScriptMs.p95.toFixed(2)} ms`,
    );
  }
  if (summary.aggregate.domNodesEnd && summary.aggregate.domListenersEnd) {
    lines.push(
      `dom nodes p50/p95: ${summary.aggregate.domNodesEnd.p50.toFixed(0)} / ${summary.aggregate.domNodesEnd.p95.toFixed(0)}`,
    );
    lines.push(
      `dom listeners p50/p95: ${summary.aggregate.domListenersEnd.p50.toFixed(0)} / ${summary.aggregate.domListenersEnd.p95.toFixed(0)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function run(): Promise<void> {
  if (!Number.isFinite(RUNS) || RUNS <= 0) throw new Error("Invalid run count.");
  if (!Number.isFinite(WARMUP) || WARMUP < 0) throw new Error("Invalid warmup count.");

  const outRoot = path.join(
    OUT_DIR,
    `${FIXTURE}-${SCENARIO}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await ensureDir(outRoot);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();

  for (let i = 0; i < WARMUP; i += 1) {
    const page = await context.newPage();
    await runOnce(i + 1, page);
    await page.close();
  }

  const outputs: PerfRun[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const page = await context.newPage();
    const result = await runOnce(i + 1, page);
    outputs.push(result);
    await page.close();
  }

  await context.close();
  await browser.close();

  const runSummaries = outputs.map(summarizeRun);
  const summary: Summary = {
    config: {
      baseUrl: BASE_URL,
      fixture: FIXTURE,
      scenario: SCENARIO,
      scheduling: SCHEDULING,
      overrides: SCHEDULING_OVERRIDES,
      runs: RUNS,
      warmup: WARMUP,
      headless: HEADLESS,
      timeoutMs: TIMEOUT_MS,
      cpuThrottle: CPU_THROTTLE ?? null,
      profiler: PROFILER_ENABLED,
    },
    runs: runSummaries,
    aggregate: {
      durationMs: stats(runSummaries.map((run) => run.durationMs)),
      timeToFirstFlushMs: statsFromRuns(runSummaries.map((run) => run.timeToFirstFlushMs)),
      longTaskP95: statsFromRuns(runSummaries.map((run) => run.longTasks?.p95 ?? null)),
      rafP95: statsFromRuns(runSummaries.map((run) => run.rafDeltas?.p95 ?? null)),
      memoryPeakMB: statsFromRuns(runSummaries.map((run) => run.memoryMB.peak)),
      cdpTaskMs: statsFromRuns(runSummaries.map((run) => run.cdp?.taskMs ?? null)),
      cdpScriptMs: statsFromRuns(runSummaries.map((run) => run.cdp?.scriptMs ?? null)),
      cdpLayoutMs: statsFromRuns(runSummaries.map((run) => run.cdp?.layoutMs ?? null)),
      cdpRecalcStyleMs: statsFromRuns(runSummaries.map((run) => run.cdp?.recalcStyleMs ?? null)),
      cdpPaintMs: statsFromRuns(runSummaries.map((run) => run.cdp?.paintMs ?? null)),
      domNodesEnd: statsFromRuns(runSummaries.map((run) => run.domEnd?.nodes ?? null)),
      domListenersEnd: statsFromRuns(runSummaries.map((run) => run.domEnd?.jsEventListeners ?? null)),
      profilerActual: statsFromRuns(runSummaries.map((run) => run.profilerActual?.p95 ?? null)),
      profilerBase: statsFromRuns(runSummaries.map((run) => run.profilerBase?.p95 ?? null)),
    },
  };

  await fs.writeFile(path.join(outRoot, "run.json"), JSON.stringify(outputs, null, 2));
  await fs.writeFile(path.join(outRoot, "summary.json"), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(outRoot, "summary.txt"), formatSummaryText(summary));

  console.log(`perf harness output: ${outRoot}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
