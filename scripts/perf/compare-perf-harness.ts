import path from "node:path";
import fs from "node:fs/promises";
import { comparisonInvalidity, type ComparisonEvidence } from "./comparison-guards";

type Summary = ComparisonEvidence & {
  metadata?: {
    rendererVersion?: string;
    profile?: string;
    policy?: Record<string, unknown>;
  };
  config: {
    renderer?: string;
    profile?: string;
    fixture: string;
    scenario: string;
    scheduling: string;
    runs: number;
    warmup: number;
    timeoutMs: number;
  };
  aggregate: {
    durationMs: Stats | null;
    cdpTaskMs: Stats | null;
    timeToFirstFlushMs: Stats | null;
    longTaskP95: Stats | null;
    rafP95: Stats | null;
    memoryPeakMB: Stats | null;
    liveElements?: Stats | null;
    livePre?: Stats | null;
    liveCode?: Stats | null;
    liveTable?: Stats | null;
    liveTr?: Stats | null;
    liveLi?: Stats | null;
    liveMath?: Stats | null;
    semanticTextLength?: Stats | null;
    semanticTextHash?: string | null;
    cdpHeapTotalNodesEnd?: Stats | null;
    cdpHeapTotalNodesDelta?: Stats | null;
    domNodesEnd?: Stats | null;
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

type MetricKey = "cdpTaskMs" | "durationMs" | "timeToFirstFlushMs" | "longTaskP95" | "rafP95" | "memoryPeakMB";

const METRICS: Array<{ key: MetricKey; label: string; unit: string }> = [
  { key: "cdpTaskMs", label: "CDP TaskDuration median (primary)", unit: "ms" },
  { key: "durationMs", label: "duration p95", unit: "ms" },
  { key: "timeToFirstFlushMs", label: "first flush p95", unit: "ms" },
  { key: "longTaskP95", label: "longtask p95 (run p95s)", unit: "ms" },
  { key: "rafP95", label: "raf delta p95 (run p95s)", unit: "ms" },
  { key: "memoryPeakMB", label: "memory peak p95", unit: "MB" },
];

const DEFAULT_THRESHOLDS: Record<MetricKey, number> = {
  cdpTaskMs: 0.1,
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
    cdpTaskMs: getNumArg("--taskMedianMaxPct", "STREAM_MDX_PERF_TASK_MEDIAN_MAX_PCT") ?? DEFAULT_THRESHOLDS.cdpTaskMs,
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

  const invalidity = comparisonInvalidity(base, cand);
  let failures = invalidity.length;
  if (invalidity.length > 0) {
    lines.push("INVALID COMPARISON");
    for (const reason of invalidity) lines.push(`  - ${reason}`);
    lines.push("");
  }
  for (const metric of METRICS) {
    const baseValue = metric.key === "cdpTaskMs" ? base.aggregate.cdpTaskMs?.p50 ?? null : metricValue(base.aggregate[metric.key]);
    const candValue = metric.key === "cdpTaskMs" ? cand.aggregate.cdpTaskMs?.p50 ?? null : metricValue(cand.aggregate[metric.key]);
    const delta = baseValue === null || candValue === null ? null : candValue - baseValue;
    const pct = baseValue && candValue !== null ? delta / baseValue : null;
    const threshold = thresholds[metric.key];
    const regress = gate && pct !== null && pct > threshold;
    if (regress) failures += 1;
    const status = invalidity.length > 0 ? "INVALID COMPARISON" : regress ? "REGRESSION" : "ok";
    lines.push(
      `${metric.label}: ${formatValue(baseValue, metric.unit)} -> ${formatValue(candValue, metric.unit)} (${formatValue(delta, metric.unit)}, ${formatPct(pct)}) [${status}]`,
    );
  }

  lines.push("");
  lines.push("--- Semantic Equivalence Check ---");
  const baseHash = base.aggregate.semanticTextHash;
  const candHash = cand.aggregate.semanticTextHash;
  const baseLen = base.aggregate.semanticTextLength?.p50 ?? null;
  const candLen = cand.aggregate.semanticTextLength?.p50 ?? null;
  const baseMath = base.aggregate.liveMath?.p50 ?? null;
  const candMath = cand.aggregate.liveMath?.p50 ?? null;
  const baseCode = base.aggregate.liveCode?.p50 ?? null;
  const candCode = cand.aggregate.liveCode?.p50 ?? null;
  const baseTable = base.aggregate.liveTable?.p50 ?? null;
  const candTable = cand.aggregate.liveTable?.p50 ?? null;

  let semanticPass = invalidity.length === 0;
  const semanticNotes: string[] = [];
  if (baseHash && candHash) {
    if (baseHash === candHash) {
      semanticNotes.push(`text hash: MATCH (${baseHash.slice(0, 16)}...)`);
    } else {
      semanticPass = false;
      semanticNotes.push(`text hash: DIVERGENCE (base ${baseHash.slice(0, 12)} vs cand ${candHash.slice(0, 12)})`);
    }
  }
  if (baseLen !== null && candLen !== null) {
    const diff = Math.abs(candLen - baseLen);
    semanticNotes.push(`text length: base ${baseLen.toFixed(0)} vs cand ${candLen.toFixed(0)} (diff ${diff.toFixed(0)})`);
    if (diff > 50 && (!baseHash || baseHash !== candHash)) {
      semanticPass = false;
    }
  }
  if (baseCode !== null && candCode !== null) {
    const codeMatch = baseCode === candCode;
    semanticNotes.push(`code blocks: ${candCode} vs ${baseCode} [${codeMatch ? "MATCH" : "DIFF"}]`);
    if (!codeMatch) semanticPass = false;
  }
  if (baseMath !== null && candMath !== null) {
    const mathMatch = baseMath === candMath;
    semanticNotes.push(`math expressions: ${candMath} vs ${baseMath} [${mathMatch ? "MATCH" : "DIFF"}]`);
    if (!mathMatch) semanticPass = false;
  }
  if (baseTable !== null && candTable !== null) {
    const tableMatch = baseTable === candTable;
    semanticNotes.push(`tables: ${candTable} vs ${baseTable} [${tableMatch ? "MATCH" : "DIFF"}]`);
    if (!tableMatch) semanticPass = false;
  }
  lines.push(`semantic verdict: ${semanticPass ? "EQUIVALENT" : "DIVERGENT"}`);
  for (const note of semanticNotes) {
    lines.push(`  - ${note}`);
  }

  lines.push("");
  lines.push("--- Attached Live DOM vs CDP Heap Total (Detached Included) ---");
  const baseLive = base.aggregate.liveElements?.p50 ?? null;
  const candLive = cand.aggregate.liveElements?.p50 ?? null;
  if (baseLive !== null || candLive !== null) {
    lines.push(`live attached DOM elements (p50): ${baseLive ?? "n/a"} -> ${candLive ?? "n/a"}`);
  }
  const baseCdp = (base.aggregate.cdpHeapTotalNodesEnd ?? base.aggregate.domNodesEnd)?.p50 ?? null;
  const candCdp = (cand.aggregate.cdpHeapTotalNodesEnd ?? cand.aggregate.domNodesEnd)?.p50 ?? null;
  if (baseCdp !== null || candCdp !== null) {
    lines.push(`CDP heap total nodes (includes detached/retained) (p50): ${baseCdp ?? "n/a"} -> ${candCdp ?? "n/a"}`);
  }
  const output = `${lines.join("\n")}\n`;
  const outPath = getArg("--out");
  if (outPath) {
    await fs.writeFile(outPath, output);
  }
  process.stdout.write(output);

  if (gate && (failures > 0 || !semanticPass)) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
