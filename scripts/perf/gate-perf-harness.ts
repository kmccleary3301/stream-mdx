import path from "node:path";
import fs from "node:fs/promises";

type Stats = {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
};

type Summary = {
  aggregate: {
    durationMs: Stats | null;
    timeToFirstFlushMs: Stats | null;
    longTaskP95: Stats | null;
    rafP95: Stats | null;
    memoryPeakMB: Stats | null;
  };
};

type MetricKey = keyof Summary["aggregate"];

const METRICS: Array<{ key: MetricKey; label: string; unit: string }> = [
  { key: "durationMs", label: "duration p95", unit: "ms" },
  { key: "timeToFirstFlushMs", label: "first flush p95", unit: "ms" },
  { key: "longTaskP95", label: "longtask p95 (run p95s)", unit: "ms" },
  { key: "rafP95", label: "raf delta p95 (run p95s)", unit: "ms" },
  { key: "memoryPeakMB", label: "memory peak p95", unit: "MB" },
];

const DEFAULT_THRESHOLDS: Record<MetricKey, number> = {
  durationMs: 0.1,
  timeToFirstFlushMs: 0.1,
  longTaskP95: 0.25,
  rafP95: 0.2,
  memoryPeakMB: 0.15,
};

const DEFAULT_BASE_S2 = "tmp/perf-baselines/S2_typical";
const DEFAULT_BASE_S3 = "tmp/perf-baselines/S3_fast_reasonable";

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

function resolveSummaryPath(input: string): string {
  if (input.endsWith(".json")) return input;
  return path.join(input, "summary.json");
}

function formatPct(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return "n/a";
  return `${value.toFixed(2)} ${unit}`;
}

function metricValue(stats: Stats | null): number | null {
  return stats ? stats.p95 : null;
}

async function loadSummary(input: string): Promise<Summary> {
  const summaryPath = resolveSummaryPath(input);
  const content = await fs.readFile(summaryPath, "utf8");
  return JSON.parse(content) as Summary;
}

async function comparePair(
  label: string,
  baseInput: string,
  candInput: string,
  thresholds: Record<MetricKey, number>,
  gate: boolean,
): Promise<number> {
  const base = await loadSummary(baseInput);
  const cand = await loadSummary(candInput);

  const lines: string[] = [];
  lines.push(`\n== ${label} ==`);
  lines.push(`base: ${resolveSummaryPath(baseInput)}`);
  lines.push(`candidate: ${resolveSummaryPath(candInput)}`);

  let failures = 0;
  for (const metric of METRICS) {
    const baseValue = metricValue(base.aggregate[metric.key]);
    const candValue = metricValue(cand.aggregate[metric.key]);
    const delta = baseValue === null || candValue === null ? null : candValue - baseValue;
    const pct = baseValue && candValue !== null ? delta / baseValue : null;
    const threshold = thresholds[metric.key];
    const regress = gate && pct !== null && pct > threshold;
    if (regress) failures += 1;
    const status = regress ? "REGRESSION" : "ok";
    lines.push(
      `${metric.label}: ${formatValue(baseValue, metric.unit)} -> ${formatValue(candValue, metric.unit)} (${formatValue(delta, metric.unit)}, ${formatPct(pct)}) [${status}]`,
    );
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return failures;
}

async function run(): Promise<void> {
  const candidateS2 = getArg("--candidateS2") ?? process.env.STREAM_MDX_PERF_CANDIDATE_S2 ?? getArg("--candidate");
  const candidateS3 = getArg("--candidateS3") ?? process.env.STREAM_MDX_PERF_CANDIDATE_S3 ?? getArg("--candidate");
  if (!candidateS2 || !candidateS3) {
    throw new Error("Provide --candidateS2 and --candidateS3 (or STREAM_MDX_PERF_CANDIDATE_S2 / _S3).");
  }

  const baseS2 = getArg("--baseS2") ?? process.env.STREAM_MDX_PERF_BASE_S2 ?? DEFAULT_BASE_S2;
  const baseS3 = getArg("--baseS3") ?? process.env.STREAM_MDX_PERF_BASE_S3 ?? DEFAULT_BASE_S3;

  const gate = !hasFlag("--no-gate") && process.env.STREAM_MDX_PERF_GATE !== "0";
  const thresholds: Record<MetricKey, number> = {
    durationMs: getNumArg("--durationP95MaxPct", "STREAM_MDX_PERF_DURATION_P95_MAX_PCT") ?? DEFAULT_THRESHOLDS.durationMs,
    timeToFirstFlushMs:
      getNumArg("--firstFlushP95MaxPct", "STREAM_MDX_PERF_FIRST_FLUSH_P95_MAX_PCT") ?? DEFAULT_THRESHOLDS.timeToFirstFlushMs,
    longTaskP95:
      getNumArg("--longTaskP95MaxPct", "STREAM_MDX_PERF_LONGTASK_P95_MAX_PCT") ?? DEFAULT_THRESHOLDS.longTaskP95,
    rafP95: getNumArg("--rafP95MaxPct", "STREAM_MDX_PERF_RAF_P95_MAX_PCT") ?? DEFAULT_THRESHOLDS.rafP95,
    memoryPeakMB:
      getNumArg("--memoryPeakP95MaxPct", "STREAM_MDX_PERF_MEMORY_PEAK_P95_MAX_PCT") ?? DEFAULT_THRESHOLDS.memoryPeakMB,
  };

  process.stdout.write("stream-mdx perf gate\n");
  let failures = 0;
  failures += await comparePair("S2_typical", baseS2, candidateS2, thresholds, gate);
  failures += await comparePair("S3_fast_reasonable", baseS3, candidateS3, thresholds, gate);

  if (gate && failures > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
