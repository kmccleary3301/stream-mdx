import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

type SummaryStats = {
  p50: number;
  p95: number;
};

type PerfSummary = {
  aggregate: {
    durationMs: SummaryStats | null;
    timeToFirstFlushMs: SummaryStats | null;
    longTaskP95: SummaryStats | null;
    rafP95: SummaryStats | null;
    memoryPeakMB: SummaryStats | null;
    cdpTaskMs: SummaryStats | null;
    cdpScriptMs: SummaryStats | null;
  };
};

type ModeRun = {
  id: string;
  label: string;
  args: string[];
};

const BASE_URL = process.env.STREAM_MDX_PERF_BASE_URL ?? "http://127.0.0.1:3012";
const FIXTURE = process.env.STREAM_MDX_PERF_FIXTURE ?? "naive-bayes";
const SCENARIO = process.env.STREAM_MDX_PERF_SCENARIO ?? "S2_typical";
const RUNS = process.env.STREAM_MDX_PERF_RUNS ?? "2";
const WARMUP = process.env.STREAM_MDX_PERF_WARMUP ?? "0";
const OUT_ROOT = path.join(process.cwd(), "tmp/perf-runs/scheduler-characterization");

const MODES: ModeRun[] = [
  {
    id: "ci-locked",
    label: "CI locked",
    args: [
      "--scheduling",
      "smooth",
      "--batch",
      "rAF",
      "--startupMicrotaskFlushes",
      "8",
      "--adaptiveBudgeting",
      "false",
    ],
  },
  {
    id: "explore",
    label: "Explore",
    args: [
      "--scheduling",
      "smooth",
      "--batch",
      "rAF",
      "--startupMicrotaskFlushes",
      "4",
      "--adaptiveBudgeting",
      "true",
    ],
  },
];

function formatStat(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return value.toFixed(1);
}

async function newestDirectory(root: string): Promise<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const dirs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const full = path.join(root, entry.name);
        const stat = await fs.stat(full);
        return { full, mtimeMs: stat.mtimeMs };
      }),
  );
  const latest = dirs.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!latest) throw new Error(`No perf output directories found in ${root}`);
  return latest.full;
}

async function runMode(mode: ModeRun): Promise<{ mode: ModeRun; summary: PerfSummary }> {
  const modeRoot = path.join(OUT_ROOT, mode.id);
  await fs.mkdir(modeRoot, { recursive: true });

  const result = spawnSync(
    "npm",
    [
      "run",
      "perf:harness",
      "--",
      "--fixture",
      FIXTURE,
      "--scenario",
      SCENARIO,
      "--runs",
      RUNS,
      "--warmup",
      WARMUP,
      "--out",
      modeRoot,
      ...mode.args,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        STREAM_MDX_PERF_BASE_URL: BASE_URL,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`Perf characterization failed for mode ${mode.id}`);
  }

  const latestRunDir = await newestDirectory(modeRoot);
  const summaryPath = path.join(latestRunDir, "summary.json");
  const summary = JSON.parse(await fs.readFile(summaryPath, "utf8")) as PerfSummary;
  return { mode, summary };
}

function buildMarkdown(results: Array<{ mode: ModeRun; summary: PerfSummary }>): string {
  const lines: string[] = [];
  lines.push("# Scheduler characterization");
  lines.push("");
  lines.push(`Fixture: \`${FIXTURE}\``);
  lines.push(`Scenario: \`${SCENARIO}\``);
  lines.push(`Base URL: \`${BASE_URL}\``);
  lines.push(`Runs per mode: \`${RUNS}\``);
  lines.push("");
  lines.push("| Mode | First flush p50 | Run duration p50 | Long-task p95 | rAF p95 | Peak memory p50 | CDP task p50 | CDP script p50 |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const { mode, summary } of results) {
    lines.push(
      `| ${mode.label} | ${formatStat(summary.aggregate.timeToFirstFlushMs?.p50)} ms | ${formatStat(summary.aggregate.durationMs?.p50)} ms | ${formatStat(summary.aggregate.longTaskP95?.p50)} ms | ${formatStat(summary.aggregate.rafP95?.p50)} ms | ${formatStat(summary.aggregate.memoryPeakMB?.p50)} MB | ${formatStat(summary.aggregate.cdpTaskMs?.p50)} ms | ${formatStat(summary.aggregate.cdpScriptMs?.p50)} ms |`,
    );
  }
  lines.push("");
  lines.push("Interpretation:");
  lines.push("- `CI locked` is the claim-grade preset. It disables adaptive budgeting and increases startup microtask flushes to keep local comparison runs reproducible.");
  lines.push("- `Explore` keeps the same base transport but allows adaptive budgeting, so it is better for finding cliffs than for publishing claims.");
  lines.push("- Treat differences here as local characterization, not cross-machine benchmark claims.");
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const results: Array<{ mode: ModeRun; summary: PerfSummary }> = [];
  for (const mode of MODES) {
    console.log(`[scheduler-characterization] mode=${mode.id}`);
    results.push(await runMode(mode));
  }
  await fs.mkdir(OUT_ROOT, { recursive: true });
  const jsonPath = path.join(OUT_ROOT, "latest-summary.json");
  const mdPath = path.join(OUT_ROOT, "latest-summary.md");
  await fs.writeFile(jsonPath, JSON.stringify(results, null, 2));
  await fs.writeFile(mdPath, buildMarkdown(results));
  console.log(`[scheduler-characterization] wrote ${jsonPath}`);
  console.log(`[scheduler-characterization] wrote ${mdPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
