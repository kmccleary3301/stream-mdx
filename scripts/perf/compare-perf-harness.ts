import path from "node:path";
import fs from "node:fs/promises";

type Summary = {
  config: {
    fixture: string;
    scenario: string;
    scheduling: string;
    runs: number;
    warmup: number;
    timeoutMs: number;
  };
  aggregate: {
    durationMs: Stats | null;
    timeToFirstFlushMs: Stats | null;
    longTaskP95: Stats | null;
    rafP95: Stats | null;
    memoryPeakMB: Stats | null;
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

async function run(): Promise<void> {
  const baseInput = getArg("--base") ?? process.env.STREAM_MDX_PERF_BASE;
  const candInput = getArg("--candidate") ?? process.env.STREAM_MDX_PERF_CANDIDATE;
  if (!baseInput || !candInput) {
    throw new Error("Provide --base and --candidate (or STREAM_MDX_PERF_BASE / STREAM_MDX_PERF_CANDIDATE).");
  }

  const base = await loadSummary(baseInput);
  const cand = await loadSummary(candInput);

  const gate = hasFlag("--gate") || process.env.STREAM_MDX_PERF_GATE === "1";
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

  const lines: string[] = [];
  lines.push("stream-mdx perf harness comparison");
  lines.push(`base: ${resolveSummaryPath(baseInput)}`);
  lines.push(`candidate: ${resolveSummaryPath(candInput)}`);
  lines.push("");

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

  const output = `${lines.join("\n")}\n`;
  const outPath = getArg("--out");
  if (outPath) {
    await fs.writeFile(outPath, output);
  }
  process.stdout.write(output);

  if (gate && failures > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
