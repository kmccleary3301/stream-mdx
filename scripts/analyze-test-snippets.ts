#!/usr/bin/env npx tsx
/**
 * Comprehensive analysis script for markdown test snippets
 * Runs each snippet through V2 renderer, captures HTML, and performs detailed analysis
 */
import type { Page } from "@playwright/test";
import type { LookaheadTraceStep } from "../packages/markdown-v2-core/src/streaming/lookahead-contract";

import { promises as fs } from "fs";
import path from "path";

import { JSDOM } from "jsdom";
import { chromium } from "@playwright/test";

const TEST_PAGE_URL = process.env.SNIPPET_TEST_URL ?? "http://localhost:3000/regression/snippet-test";
const SNIPPETS_DIR = process.env.SNIPPET_DIR ?? "tests/regression/fixtures";
const OUTPUT_DIR = "tmp/snippet_analysis";
const LOOKAHEAD_TRACE_DIR = path.join(OUTPUT_DIR, "lookahead-traces");
const COALESCING_CSV_PATH = path.join(OUTPUT_DIR, "coalescing.csv");
const ARTIFACT_MANIFEST_PATH = path.join(OUTPUT_DIR, "artifacts.json");
const GUARDRAIL_SUMMARY_PATH = path.join(OUTPUT_DIR, "guardrails.json");
const STREAM_RATE = Number(process.env.SNIPPET_STREAM_RATE ?? 600);
const STREAM_TICK_MS = Number(process.env.SNIPPET_STREAM_TICK_MS ?? 30);
const NAVIGATION_TIMEOUT_MS = Number(process.env.SNIPPET_NAVIGATION_TIMEOUT_MS ?? 90000);
const INITIAL_RENDER_TIMEOUT_MS = Number(process.env.SNIPPET_INITIAL_RENDER_TIMEOUT_MS ?? 30000);
const STREAM_COMPLETE_TIMEOUT_MS = Number(process.env.SNIPPET_STREAM_TIMEOUT_MS ?? 60000);
const FINALIZE_TIMEOUT_MS = Number(process.env.SNIPPET_FINALIZE_TIMEOUT_MS ?? 30000);
const OUTPUT_SELECTOR_TIMEOUT_MS = Number(process.env.SNIPPET_OUTPUT_TIMEOUT_MS ?? 30000);
const PATCH_P95_WARN_MS = 70;
const PATCH_MAX_WARN_MS = 200;
const LONG_TASK_WARN_MAX_MS = 50;
const TTFMC_WARN_MS = 750;
const QUEUE_DEPTH_P95_WARN = 2.5;
const QUEUE_DEPTH_MAX_WARN = 4;
const ANALYZER_MDX_MODE = (process.env.MDX_COMPILE_MODE ?? "").toLowerCase();
const CLI_ARGS = process.argv.slice(2);
const ANALYZER_SUPPRESSIONS_PATH = process.env.SNIPPET_ANALYZER_SUPPRESSIONS ?? path.join("config", "analyzer-suppressions.json");

function readNumericFlag(flag: string): number | null {
  const name = `--${flag}`;
  for (let i = 0; i < CLI_ARGS.length; i += 1) {
    const arg = CLI_ARGS[i];
    if (arg.startsWith(`${name}=`)) {
      const parsed = Number(arg.slice(name.length + 1));
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (arg === name) {
      const next = CLI_ARGS[i + 1];
      if (next === undefined) break;
      const parsed = Number(next);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function readStringFlag(flag: string): string | null {
  const name = `--${flag}`;
  for (let i = 0; i < CLI_ARGS.length; i += 1) {
    const arg = CLI_ARGS[i];
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
    if (arg === name) {
      return CLI_ARGS[i + 1] ?? null;
    }
  }
  return null;
}

function hasFlag(flag: string): boolean {
  const name = `--${flag}`;
  return CLI_ARGS.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function getNumericFlag(flag: string, fallback: number): number {
  const parsed = readNumericFlag(flag);
  return parsed === null ? fallback : parsed;
}

const MIN_COALESCING_REDUCTION_PCT = getNumericFlag("min-coalescing-reduction", 10);
const MAX_COALESCING_DURATION_P95_MS = getNumericFlag("max-coalescing-duration", 8);
const TRACE_LOOKAHEAD = hasFlag("trace-lookahead");
const TRACE_MODE = (readStringFlag("trace-mode") ?? "chunk").toLowerCase() === "char" ? "char" : "chunk";
const TRACE_SNIPPET = readStringFlag("trace-snippet");
const TRACE_MAX_STEPS = Math.max(1, getNumericFlag("trace-max-steps", TRACE_MODE === "char" ? 160 : 48));
type AnalyzerSuppressionEntry = {
  snippet: string;
  rule: string;
  reason: string;
  expiresOn?: string;
  addedBy?: string;
};

type LoadedAnalyzerSuppression = AnalyzerSuppressionEntry & {
  expiresAt?: number | null;
};

type GuardrailResult = {
  snippet: string;
  rule: string;
  severity: "warn" | "fail";
  message: string;
  suppressed: boolean;
  suppression?: LoadedAnalyzerSuppression | null;
};

type GuardrailSummary = {
  generatedAt: string;
  total: number;
  unsuppressedFailures: GuardrailResult[];
  unsuppressedWarnings: GuardrailResult[];
  suppressed: GuardrailResult[];
  results: GuardrailResult[];
};

let analyzerSuppressions: LoadedAnalyzerSuppression[] = [];
const guardrailResults: GuardrailResult[] = [];

async function loadAnalyzerSuppressions(): Promise<void> {
  try {
    const raw = await fs.readFile(ANALYZER_SUPPRESSIONS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { suppressions?: AnalyzerSuppressionEntry[] } | null;
    if (!parsed || !Array.isArray(parsed.suppressions)) {
      console.warn(`[analyze] Suppression file ${ANALYZER_SUPPRESSIONS_PATH} is missing a "suppressions" array; continuing without suppressions.`);
      analyzerSuppressions = [];
      return;
    }
    const now = Date.now();
    analyzerSuppressions = parsed.suppressions
      .filter((entry) => entry && typeof entry.snippet === "string" && typeof entry.rule === "string" && typeof entry.reason === "string")
      .map((entry) => {
        const expiresAt = entry.expiresOn ? Date.parse(entry.expiresOn) : null;
        if (entry.expiresOn && Number.isNaN(expiresAt)) {
          console.warn(`[analyze] Suppression for ${entry.snippet} (${entry.rule}) has invalid expiresOn "${entry.expiresOn}" and will be ignored.`);
          return null;
        }
        if (expiresAt !== null && expiresAt < now) {
          return null;
        }
        return {
          ...entry,
          expiresAt,
        };
      })
      .filter((entry): entry is LoadedAnalyzerSuppression => entry !== null);

    console.log(`[analyze] Loaded ${analyzerSuppressions.length} active suppression(s) from ${ANALYZER_SUPPRESSIONS_PATH}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      analyzerSuppressions = [];
      console.log(`[analyze] No analyzer suppression file found at ${ANALYZER_SUPPRESSIONS_PATH}; proceeding without suppressions.`);
      return;
    }
    throw error;
  }
}

function findActiveSuppression(snippet: string, rule: string): LoadedAnalyzerSuppression | null {
  for (const suppression of analyzerSuppressions) {
    const snippetMatches = suppression.snippet === "*" || suppression.snippet === snippet;
    const ruleMatches = suppression.rule === "*" || suppression.rule === rule;
    if (snippetMatches && ruleMatches) {
      return suppression;
    }
  }
  return null;
}

function serializeGuardrailResult(result: GuardrailResult) {
  return {
    snippet: result.snippet,
    rule: result.rule,
    severity: result.severity,
    message: result.message,
    suppressed: result.suppressed,
    suppression: result.suppression
      ? {
          reason: result.suppression.reason,
          expiresOn: result.suppression.expiresOn ?? null,
          addedBy: result.suppression.addedBy ?? null,
        }
      : null,
  };
}

function buildGuardrailSummary(): GuardrailSummary {
  const unsuppressedFailures = guardrailResults.filter((result) => result.severity === "fail" && !result.suppressed);
  const unsuppressedWarnings = guardrailResults.filter((result) => result.severity === "warn" && !result.suppressed);
  const suppressed = guardrailResults.filter((result) => result.suppressed);
  return {
    generatedAt: new Date().toISOString(),
    total: guardrailResults.length,
    unsuppressedFailures: unsuppressedFailures.map(serializeGuardrailResult),
    unsuppressedWarnings: unsuppressedWarnings.map(serializeGuardrailResult),
    suppressed: suppressed.map(serializeGuardrailResult),
    results: guardrailResults.map(serializeGuardrailResult),
  };
}

type SummaryStats = {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  latestMs: number;
};

function suppressionMatches(value: string, pattern: string): boolean {
  if (pattern === "*" || pattern === value) {
    return true;
  }
  return false;
}

function isSuppressionActive(suppression: LoadedAnalyzerSuppression): boolean {
  if (suppression.expiresAt === null || suppression.expiresAt === undefined) {
    return true;
  }
  return suppression.expiresAt >= Date.now();
}

function findSuppression(snippet: string, rule: string): LoadedAnalyzerSuppression | null {
  for (const suppression of analyzerSuppressions) {
    if (!suppressionMatches(snippet, suppression.snippet)) continue;
    if (!suppressionMatches(rule, suppression.rule)) continue;
    if (!isSuppressionActive(suppression)) continue;
    return suppression;
  }
  return null;
}

type PerfSummary = {
  patchApply: SummaryStats | null;
  longTasks: SummaryStats | null;
  recvToFlush: SummaryStats | null;
  flushApply: SummaryStats | null;
  reactCommit: SummaryStats | null;
  paint: SummaryStats | null;
  queueDepth: SummaryStats | null;
};

type PerfSamples = {
  recvToFlushMs: number[];
  flushApplyMs: number[];
  reactCommitMs: number[];
  paintMs: number[];
  queueDepth: number[];
  patchApplyMs: number[];
  longTasksMs: number[];
};

type FlushBatchSample = {
  tx: number | null;
  patchCount: number;
  appliedPatchCount?: number;
  queueDelayMs: number;
  durationMs: number;
  priority: "high" | "low";
  receivedAt?: number | null;
  appliedAt?: number | null;
  queueDepthBefore?: number;
  remainingQueue?: number;
  effectiveQueueDepth?: number;
  flushStartedAt?: number;
  flushCompletedAt?: number;
  coalescing?: {
    inputPatchCount?: number;
    outputPatchCount?: number;
    coalescedCount?: number;
    durationMs?: number;
    appendLinesCoalesced?: number;
    setPropsCoalesced?: number;
    insertChildCoalesced?: number;
  } | null;
};

type WorkerPerfMetrics = {
  tx?: number;
  timestamp?: number;
  parseMs?: number;
  parseTime?: number;
  enrichMs?: number;
  diffMs?: number;
  serializeMs?: number;
  highlightTime?: number;
  shikiMs?: number;
  mdxDetectMs?: number;
  patchBytes?: number;
  patchCount?: number;
  queueDepth?: number;
  blocksProduced?: number;
  grammarEngine?: "js" | "wasm";
  blockCountByType?: Record<string, number>;
  blockEnrichMsByType?: Record<string, number>;
  blockSizeByType?: Record<string, number>;
  highlightByLanguage?: Record<string, { count: number; totalMs: number; avgMs: number }>;
  appendLineBatches?: number;
  appendLineTotalLines?: number;
  appendLineMaxLines?: number;
  appendLineBatchesTotal?: number;
  appendLineTotalLinesTotal?: number;
  appendLineMaxLinesTotal?: number;
};

type StreamMetrics = {
  firstMeaningfulMs?: number | null;
  completionMs?: number | null;
  startedAt?: number | null;
};

type TelemetrySnapshot = {
  summary: PerfSummary;
  samples: PerfSamples;
  worker?: WorkerPerfMetrics | null;
  workerTotals?: {
    appendLineBatches: number;
    appendLineTotalLines: number;
    appendLineMaxLines: number;
  } | null;
  stream?: StreamMetrics | null;
  patchTotals?: {
    totalMessages: number;
    totalOps: number;
    lastTx: number;
  } | null;
  coalescingTotals?: {
    input: number;
    output: number;
    coalesced: number;
    appendLines: number;
    setProps: number;
    insertChild: number;
    durationMs: number;
  } | null;
  flushBatches?: FlushBatchSample[] | null;
};

type RuntimeStateSnapshot = {
  demoState: Record<string, unknown> | null;
  blocks: Array<{
    id: string;
    type: string;
    isFinalized: boolean;
    rawLength: number;
    inlineStatus?: unknown;
    inlineLookahead?: LookaheadTraceStep["blocks"][number]["inlineLookahead"];
    mixedLookahead?: LookaheadTraceStep["blocks"][number]["mixedLookahead"];
    mixedSegmentKinds?: string[];
  }>;
};

type CoalescingBreakdown = {
  batches: number;
  batchesWithMetrics: number;
  input: number;
  output: number;
  coalesced: number;
  appendLinesMerged: number;
  setPropsMerged: number;
  insertChildMerged: number;
  durationMsTotal: number;
  durationMsAvg: number;
  durationMsP95: number | null;
};

interface SnippetAnalysis {
  snippetName: string;
  snippetPath: string;
  snippetContent: string;
  renderedHtml: string;
  analysis: {
    structure: {
      blockCount: number;
      blockTypes: Record<string, number>;
      hasProseWrapper: boolean;
      hasMarkdownOutput: boolean;
    };
    content: {
      textLength: number;
      hasExpectedText: boolean;
      missingText: string[];
      unexpectedText: string[];
    };
    markdown: {
      headers: { level: number; count: number };
      lists: { unordered: number; ordered: number; nested: number };
      blockquotes: number;
      codeBlocks: { count: number; languages: string[] };
      tables: { count: number; rowCounts: number[] };
      paragraphs: number;
    };
    formatting: {
      bold: number;
      italic: number;
      strikethrough: number;
      links: number;
      inlineCode: number;
      kbd: number;
      sub: number;
      sup: number;
    };
    math: {
      inline: number;
      display: number;
      katexElements: number;
    };
    html: {
      rawHtmlBlocks: number;
      sanitizedHtml: boolean;
      mdxComponents: number;
      mdxPending: number;
      mdxErrors: number;
      mdxInlinePending: number;
      mdxInlineErrors: number;
    };
    performance: {
      patchApply: SummaryStats | null;
      longTasks: SummaryStats | null;
      recvToFlush: SummaryStats | null;
      flushApply: SummaryStats | null;
      reactCommit: SummaryStats | null;
      paint: SummaryStats | null;
      queueDepth: SummaryStats | null;
      stream?: StreamMetrics | null;
      worker?: WorkerPerfMetrics | null;
      workerTotals?: {
        appendLineBatches: number;
        appendLineTotalLines: number;
        appendLineMaxLines: number;
      } | null;
      coalescingTotals?: {
        input: number;
        output: number;
        coalesced: number;
        appendLines: number;
        setProps: number;
        insertChild: number;
        durationMs: number;
        reductionPct: number | null;
        appliedPct: number | null;
      } | null;
      coalescingBreakdown?: CoalescingBreakdown | null;
    };
    issues: {
      critical: string[];
      warnings: string[];
      suggestions: string[];
    };
  };
  telemetry?: TelemetrySnapshot | null;
}

function normalizeSummaryStats(input: any): SummaryStats | null {
  if (!input || typeof input !== "object") return null;
  const count = Number(input.count ?? 0);
  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }
  const num = (value: unknown, fallback = 0) => {
    const cast = Number(value);
    return Number.isFinite(cast) ? cast : fallback;
  };
  return {
    count,
    avgMs: num(input.avgMs ?? input.avg ?? 0),
    p50Ms: num(input.p50Ms ?? input.p50 ?? input.avgMs ?? 0),
    p95Ms: num(input.p95Ms ?? input.p95 ?? input.maxMs ?? 0),
    p99Ms: num(input.p99Ms ?? input.p99 ?? input.maxMs ?? 0),
    maxMs: num(input.maxMs ?? input.max ?? 0),
    latestMs: num(input.latestMs ?? input.latest ?? input.maxMs ?? 0),
  };
}

function cloneSummaryStats(stats: SummaryStats | null): SummaryStats | null {
  if (!stats) return null;
  return { ...stats };
}

function mapPerfSummary(summary?: Partial<PerfSummary> | null): PerfSummary {
  return {
    patchApply: normalizeSummaryStats(summary?.patchApply),
    longTasks: normalizeSummaryStats(summary?.longTasks),
    recvToFlush: normalizeSummaryStats(summary?.recvToFlush),
    flushApply: normalizeSummaryStats(summary?.flushApply),
    reactCommit: normalizeSummaryStats(summary?.reactCommit),
    paint: normalizeSummaryStats(summary?.paint),
    queueDepth: normalizeSummaryStats(summary?.queueDepth),
  };
}

function formatSummaryStats(stat: SummaryStats | null, unit: "ms" | "count" = "ms"): string {
  if (!stat) return "—";
  const digits = unit === "ms" ? 1 : 2;
  const suffix = unit === "ms" ? "ms" : "";

  const fmt = (value: number) => `${value.toFixed(digits)}${suffix}`;
  return `avg ${fmt(stat.avgMs)} · p50 ${fmt(stat.p50Ms)} · p95 ${fmt(stat.p95Ms)} · p99 ${fmt(stat.p99Ms)} · max ${fmt(stat.maxMs)} · last ${fmt(stat.latestMs)} · n=${stat.count}`;
}

function formatNumber(value: unknown, digits = 1): string {
  if (value === null || value === undefined) return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return num.toFixed(digits);
}

function formatPercentValue(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "—";
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

function computePercentile(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const clamped = Math.min(0.9999, Math.max(0, percentile));
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(clamped * (sorted.length - 1))));
  return sorted[index];
}

function collectCoalescingDurations(batches?: FlushBatchSample[] | null): number[] {
  if (!Array.isArray(batches)) return [];
  const durations: number[] = [];
  for (const batch of batches) {
    if (!batch || !batch.coalescing) continue;
    const duration = batch.coalescing.durationMs;
    if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
      durations.push(duration);
    }
  }
  return durations;
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function appendCoalescingCsvRows(snippetName: string, batches?: FlushBatchSample[] | null): Promise<void> {
  if (!Array.isArray(batches) || batches.length === 0) return;
  const lines: string[] = [];
  for (const batch of batches) {
    const metrics = batch.coalescing;
    if (!metrics) continue;
    const values = [
      snippetName,
      batch.tx ?? "",
      batch.priority ?? "",
      Number.isFinite(batch.queueDelayMs) ? batch.queueDelayMs : "",
      Number.isFinite(batch.durationMs) ? batch.durationMs : "",
      metrics.inputPatchCount ?? 0,
      metrics.outputPatchCount ?? 0,
      metrics.coalescedCount ?? 0,
      metrics.appendLinesCoalesced ?? 0,
      metrics.setPropsCoalesced ?? 0,
      metrics.insertChildCoalesced ?? 0,
    ];
    lines.push(values.map((value) => csvEscape(String(value ?? ""))).join(","));
  }
  if (lines.length > 0) {
    await fs.appendFile(COALESCING_CSV_PATH, `${lines.join("\n")}\n`, "utf-8");
  }
}

function computeCoalescingBreakdown(batches?: FlushBatchSample[] | null): CoalescingBreakdown | null {
  if (!Array.isArray(batches) || batches.length === 0) return null;
  let input = 0;
  let output = 0;
  let coalesced = 0;
  let appendLines = 0;
  let setProps = 0;
  let insertChild = 0;
  let durationTotal = 0;
  let batchesWithMetrics = 0;
  const durations: number[] = [];
  for (const batch of batches) {
    const metrics = batch.coalescing;
    if (!metrics) continue;
    input += metrics.inputPatchCount ?? 0;
    output += metrics.outputPatchCount ?? 0;
    coalesced += metrics.coalescedCount ?? 0;
    appendLines += metrics.appendLinesCoalesced ?? 0;
    setProps += metrics.setPropsCoalesced ?? 0;
    insertChild += metrics.insertChildCoalesced ?? 0;
    if (typeof metrics.durationMs === "number" && Number.isFinite(metrics.durationMs)) {
      durationTotal += metrics.durationMs;
      durations.push(metrics.durationMs);
    }
    batchesWithMetrics += 1;
  }
  if (batchesWithMetrics === 0) {
    return {
      batches: batches.length,
      batchesWithMetrics: 0,
      input: 0,
      output: 0,
      coalesced: 0,
      appendLinesMerged: 0,
      setPropsMerged: 0,
      insertChildMerged: 0,
      durationMsTotal: 0,
      durationMsAvg: 0,
      durationMsP95: null,
    };
  }
  return {
    batches: batches.length,
    batchesWithMetrics,
    input,
    output,
    coalesced,
    appendLinesMerged: appendLines,
    setPropsMerged: setProps,
    insertChildMerged: insertChild,
    durationMsTotal: durationTotal,
    durationMsAvg: batchesWithMetrics > 0 ? durationTotal / batchesWithMetrics : 0,
    durationMsP95: computePercentile(durations, 0.95),
  };
}

function recordCoalescingGuardrailResult(
  snippetName: string,
  ruleId: string,
  severity: "warn" | "fail",
  message: string,
  issues: SnippetAnalysis["analysis"]["issues"],
): void {
  const suppression = findActiveSuppression(snippetName, ruleId);
  const suppressed = Boolean(suppression);
  const entry: GuardrailResult = {
    snippet: snippetName,
    rule: ruleId,
    severity,
    message,
    suppressed,
    suppression: suppression ?? undefined,
  };
  guardrailResults.push(entry);

  const consolePrefix = suppressed ? "SUPPRESSED" : severity === "fail" ? "FAIL" : "WARN";
  const consoleMessage = `[coalescing][${consolePrefix}] ${snippetName} [${ruleId}] ${message}${
    suppressed && suppression
      ? ` (reason: ${suppression.reason}${suppression.expiresOn ? `, expires ${suppression.expiresOn}` : ""}${suppression.addedBy ? `, by ${suppression.addedBy}` : ""})`
      : ""
  }`;
  if (severity === "fail" && !suppressed) {
    console.error(consoleMessage);
  } else {
    console.warn(consoleMessage);
  }

  const decoratedMessage = `[Coalescing:${ruleId}] ${message}${suppressed ? " (suppressed)" : ""}`;
  if (suppressed) {
    issues.suggestions.push(`${decoratedMessage}${suppression ? ` — ${suppression.reason}` : ""}`);
    return;
  }

  if (severity === "fail") {
    issues.critical.push(decoratedMessage);
  } else {
    issues.warnings.push(decoratedMessage);
  }
}

function recordCoalescingGuardrailSkip(snippetName: string, ruleId: string, message: string, issues: SnippetAnalysis["analysis"]["issues"]): void {
  // Some snippets are intentionally too small (or don't produce coalescable patch streams). Treat these
  // guardrails as informational so CI stays focused on true regressions.
  console.warn(`[coalescing][SKIP] ${snippetName} [${ruleId}] ${message}`);
  issues.suggestions.push(`[Coalescing:${ruleId}] ${message} (skipped)`);
}

function evaluateCoalescingGuardrails(snippetName: string, analysis: SnippetAnalysis["analysis"], telemetry: TelemetrySnapshot | null): void {
  const issues = analysis.issues;
  if (MIN_COALESCING_REDUCTION_PCT > 0) {
    const totals = analysis.performance.coalescingTotals;
    if (!totals || typeof totals.input !== "number" || totals.input <= 0) {
      recordCoalescingGuardrailResult(
        snippetName,
        "coalescing/reduction/missing-totals",
        "warn",
        "Coalescing totals unavailable; reduction threshold skipped",
        issues,
      );
    } else {
      const reductionPct = typeof totals.reductionPct === "number" ? totals.reductionPct : totals.input > 0 ? (totals.coalesced / totals.input) * 100 : null;
      if (reductionPct === null || !Number.isFinite(reductionPct)) {
        recordCoalescingGuardrailResult(snippetName, "coalescing/reduction/invalid", "warn", "Invalid coalescing reduction metric", issues);
      } else if (totals.coalesced <= 0 && totals.setProps <= 0 && totals.appendLines <= 0 && totals.insertChild <= 0) {
        recordCoalescingGuardrailSkip(
          snippetName,
          "coalescing/reduction/no-coalescable",
          "No coalescable operations detected; reduction threshold skipped",
          issues,
        );
      } else if (totals.input < 50) {
        recordCoalescingGuardrailSkip(
          snippetName,
          "coalescing/reduction/sample-too-small",
          `Coalescing sample size ${totals.input} too small to enforce reduction threshold`,
          issues,
        );
      } else if (reductionPct + Number.EPSILON < MIN_COALESCING_REDUCTION_PCT) {
        recordCoalescingGuardrailResult(
          snippetName,
          "coalescing/reduction/threshold",
          "fail",
          `Coalescing reduction ${reductionPct.toFixed(2)}% below threshold ${MIN_COALESCING_REDUCTION_PCT}%`,
          issues,
        );
      }
    }
  }

  if (MAX_COALESCING_DURATION_P95_MS > 0) {
    const durations = collectCoalescingDurations(telemetry?.flushBatches ?? null);
    if (durations.length === 0) {
      recordCoalescingGuardrailResult(snippetName, "coalescing/duration/no-samples", "warn", "No coalescing duration samples available", issues);
    } else {
      const durationP95 = computePercentile(durations, 0.95);
      if (durationP95 !== null && durationP95 > MAX_COALESCING_DURATION_P95_MS) {
        recordCoalescingGuardrailResult(
          snippetName,
          "coalescing/duration/threshold",
          "fail",
          `Coalescing duration p95 ${durationP95.toFixed(2)}ms exceeds ${MAX_COALESCING_DURATION_P95_MS}ms`,
          issues,
        );
      }
    }
  }
}

async function readSnippet(fileName: string): Promise<string> {
  const filePath = path.join(SNIPPETS_DIR, fileName);
  return await fs.readFile(filePath, "utf-8");
}

function parseSnippetList(value: string | undefined): Set<string> | null {
  if (!value) return null;
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

const snippetFilter = parseSnippetList(process.env.SNIPPET_FILTER);
const snippetSkip = parseSnippetList(process.env.SNIPPET_SKIP);

function matchesFilter(fileName: string): boolean {
  if (!snippetFilter) return true;
  return snippetFilter.has(fileName) || snippetFilter.has(fileName.replace(/\.md$/, ""));
}

function isSkipped(fileName: string): boolean {
  if (!snippetSkip) return false;
  return snippetSkip.has(fileName) || snippetSkip.has(fileName.replace(/\.md$/, ""));
}

async function listSnippets(): Promise<string[]> {
  const files = await fs.readdir(SNIPPETS_DIR);
  return files
    .filter((f) => f.endsWith(".md") || f.endsWith(".mdx"))
    .filter((f) => matchesFilter(f) && !isSkipped(f))
    .sort();
}

async function captureRuntimeState(page: Page): Promise<RuntimeStateSnapshot> {
  return await page.evaluate<RuntimeStateSnapshot>(() => {
    const api = window.__STREAMING_DEMO__;
    const store = window.__STREAMING_RENDERER_STORE__;
    const demoState = api && typeof api.getState === "function" ? (api.getState() as Record<string, unknown>) : null;
    const blocks =
      store && typeof store.getBlocks === "function"
        ? store.getBlocks().map((block: any) => ({
            id: String(block.id),
            type: String(block.type),
            isFinalized: Boolean(block.isFinalized),
            rawLength: typeof block?.payload?.raw === "string" ? block.payload.raw.length : 0,
            inlineStatus: block?.payload?.meta?.inlineStatus,
            inlineContainerSignature:
              typeof block?.payload?.meta?.inlineContainerSignature === "string" ? block.payload.meta.inlineContainerSignature : undefined,
            inlineLookaheadInvalidated:
              typeof block?.payload?.meta?.inlineLookaheadInvalidated === "string"
                ? block.payload.meta.inlineLookaheadInvalidated
                : undefined,
            inlineLookahead: Array.isArray(block?.payload?.meta?.inlineLookahead) ? block.payload.meta.inlineLookahead : [],
            mixedLookahead: Array.isArray(block?.payload?.meta?.mixedLookahead) ? block.payload.meta.mixedLookahead : [],
            mixedSegmentKinds: Array.isArray(block?.payload?.meta?.mixedSegments)
              ? block.payload.meta.mixedSegments
                  .map((segment: any) => (segment && typeof segment.kind === "string" ? segment.kind : null))
                  .filter((kind: string | null): kind is string => kind !== null)
              : undefined,
          }))
        : [];
    return { demoState, blocks };
  });
}

async function renderSnippet(
  page: Page,
  snippetContent: string,
  options?: { traceFast?: boolean; streamLimit?: number },
): Promise<{ html: string; telemetry: TelemetrySnapshot | null; state: RuntimeStateSnapshot }> {
  const minVisibleLength = Math.min(10, Math.max(1, normalizeWhitespace(snippetContent).length));
  const compileMode = process.env.MDX_COMPILE_MODE && process.env.MDX_COMPILE_MODE.toLowerCase() === "worker" ? "worker" : "server";
  await page.addInitScript(
    ({ content, config }) => {
      const runtimeWindow = window as typeof window & {
        __name?: (target: unknown) => unknown;
        __TEST_SNIPPET_CONTENT__?: string;
        __TEST_SNIPPET_CONFIG__?: {
          initialStreamLimit?: number | null;
          initialIsRunning?: boolean;
          initialMdxStrategy?: "server" | "worker";
        };
      };
      // Some MDX fixtures expect this helper to exist in the browser.
      if (typeof runtimeWindow.__name !== "function") {
        runtimeWindow.__name = function (target) {
          return target;
        };
      }
      runtimeWindow.__TEST_SNIPPET_CONTENT__ = content;
      runtimeWindow.__TEST_SNIPPET_CONFIG__ = config;
    },
    {
      content: snippetContent,
      config: options?.traceFast
        ? {
            initialStreamLimit: options.streamLimit ?? null,
            initialIsRunning: false,
            initialMdxStrategy: compileMode,
          }
        : {
            initialStreamLimit: null,
            initialIsRunning: true,
            initialMdxStrategy: compileMode,
          },
    },
  );

  // Large regression fixtures exceed practical query-string limits, so inject
  // the snippet through the test-page global instead of the URL.
  const url = TEST_PAGE_URL;

  // Navigate to test page with content in URL
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });

  // Wait for React to hydrate and either expose the automation API or render visible content.
  await page.waitForTimeout(options?.traceFast ? 250 : 1500);

  // Wait for API
  await page.waitForFunction(() => typeof window.__STREAMING_DEMO__ !== "undefined" && window.__STREAMING_DEMO__?.getState !== undefined, { timeout: 30000 });

  if (!options?.traceFast) {
    // Wait for component to render with our content in the normal interactive path.
    await page.waitForFunction(
      ({ minVisible }) => {
        const output = document.querySelector('[data-testid="markdown-output"]');
        if (!output) return false;
        const text = output.textContent || "";
        return text !== "Waiting for snippet content... (set via window.__TEST_SNIPPET_CONTENT__ or ?snippet= param)" && text.length >= minVisible;
      },
      { minVisible: minVisibleLength },
      { timeout: INITIAL_RENDER_TIMEOUT_MS },
    );
  }

  if (options?.traceFast) {
    await page.evaluate(async () => {
      const api = window.__STREAMING_DEMO__;
      if (!api) return;
      await api.waitForWorker?.();
    });
  } else {
    await page.evaluate(
      ({ mode, streamLimit }) => {
        const api = window.__STREAMING_DEMO__;
        if (!api) return;
        if (typeof streamLimit === "number") {
          api.setStreamLimit?.(streamLimit);
        }
        api.setMdxStrategy?.(mode === "worker" ? "worker" : "server");
        api.restart?.();
      },
      { mode: compileMode, streamLimit: options?.streamLimit ?? null },
    );
  }

  if (options?.traceFast && typeof options.streamLimit === "number") {
    await page.waitForFunction(
      ({ expectedTotal }) => {
        const api = window.__STREAMING_DEMO__;
        const state = api?.getState?.();
        return Boolean(state && typeof state.total === "number" && state.total === expectedTotal && state.idx === 0);
      },
      { expectedTotal: options.streamLimit },
      { timeout: Math.max(2000, Math.min(10000, INITIAL_RENDER_TIMEOUT_MS)) },
    );
  }

  // Wait for streaming to complete
  const completed = options?.traceFast
    ? await page
        .evaluate(async () => {
          const api = window.__STREAMING_DEMO__;
          if (!api) return false;
          await api.fastForward?.();
          await api.flushPending?.();
          return false;
        })
    : await page
        .waitForFunction(
          () => {
            const api = window.__STREAMING_DEMO__;
            if (!api) return false;
            const state = api.getState?.();
            if (!state || typeof state.total !== "number" || state.total <= 0) {
              return false;
            }
            return state.idx === state.total;
          },
          { timeout: STREAM_COMPLETE_TIMEOUT_MS },
        )
        .then(() => true)
        .catch(async () => {
          console.warn("[analyze] Streaming did not complete within timeout");
          const state = await page
            .evaluate(() => {
              const api = window.__STREAMING_DEMO__;
              if (!api || typeof api.getState !== "function") return null;
              return api.getState();
            })
            .catch(() => null);
          if (state) {
            console.warn("[analyze] Stream state at timeout", state);
          }
          return false;
        });

  // Trigger finalization and give it a moment to settle
  if (!options?.traceFast) {
    await page.evaluate(async () => {
      const api = window.__STREAMING_DEMO__;
      if (!api) return;
      await api.finalize?.();
      await api.flushPending?.();
      await api.waitForIdle?.();
    });
  }
  let storeFinalized = completed;
  if (!options?.traceFast && !storeFinalized) {
    storeFinalized = await page
      .waitForFunction(
        () => {
          const api = window.__STREAMING_DEMO__;
          const state = api?.getState?.();
          const streamDone = Boolean(state && state.idx === state.total);
          const store = window.__STREAMING_RENDERER_STORE__;
          if (!store || typeof store.getBlocks !== "function") {
            return streamDone;
          }
          const blocks = store.getBlocks();
          if (!Array.isArray(blocks) || blocks.length === 0) {
            return streamDone;
          }
          const allFinal = blocks.every((block: any) => block && block.isFinalized === true);
          if (!allFinal) {
            return false;
          }
          if (document.querySelector(".streaming-partial")) {
            return false;
          }
          return true;
        },
        { timeout: FINALIZE_TIMEOUT_MS },
      )
      .then(() => true)
      .catch(() => false);
  }

  if (!options?.traceFast && !storeFinalized) {
    console.warn("[analyze] Store did not report all blocks finalized before timeout; falling back to DOM check");
    await page
      .waitForFunction(() => !document.querySelector(".streaming-partial"), {
        timeout: Math.max(1000, Math.floor(FINALIZE_TIMEOUT_MS / 2)),
      })
      .catch(() => {
        console.warn("[analyze] Finalization wait timed out; proceeding with current DOM state");
      });
  }
  await page.waitForTimeout(options?.traceFast ? Math.min(250, STREAM_TICK_MS * 2) : 50);

  if (process.env.DEBUG_SNIPPET_BLOCKS === "1") {
    const state = await page.evaluate(() => {
      const store = window.__STREAMING_RENDERER_STORE__;
      if (!store) return null;
      return store.getBlocks().map((block) => ({
        id: block.id,
        type: block.type,
        isFinalized: block.isFinalized,
        raw: block.payload.raw,
        meta: block.payload.meta,
        children: store.getChildren(block.id).map((childId) => {
          const child = store.getNode(childId);
          if (!child) return null;
          return {
            id: child.id,
            type: child.type,
            props: child.props,
            children: child.children,
          };
        }),
      }));
    });
    console.log("[analyze][debug] blocks", JSON.stringify(state, null, 2));
  }

  let outputHandle: Awaited<ReturnType<Page["waitForSelector"]>> | null = null;
  try {
    outputHandle = await page.waitForSelector('[data-testid="markdown-output"]', {
      timeout: OUTPUT_SELECTOR_TIMEOUT_MS,
    });
  } catch {
    console.warn("[analyze] markdown output selector timeout; attempting direct lookup");
    outputHandle = await page.$('[data-testid="markdown-output"]');
  }

  if (!outputHandle) {
    throw new Error("markdown output container not found");
  }

  // Capture HTML
  const html = await outputHandle.evaluate((node) => (node as HTMLElement).outerHTML);
  const telemetry = await page.evaluate<TelemetrySnapshot | null>(() => {
    const api = window.__STREAMING_DEMO__;
    if (!api || typeof api.getPerf !== "function") {
      return null;
    }
    const perf = api.getPerf();
    if (!perf) return null;
    const state = api.getState?.();

    const ensureArray = (value: unknown): number[] => {
      return Array.isArray(value) ? value.map((num) => Number(num)).filter((num) => Number.isFinite(num)) : [];
    };

    const normalizeBatch = (value: any) => {
      if (!value || typeof value !== "object") return null;
      const queueDelay = Number((value as any).queueDelayMs);
      const duration = Number((value as any).durationMs);
      if (!Number.isFinite(queueDelay) || !Number.isFinite(duration)) {
        return null;
      }
      const patchCount = Number((value as any).patchCount ?? 0);
      const appliedPatchCount = Number((value as any).appliedPatchCount ?? 0);
      const txValue = (value as any).tx;
      const priority = (value as any).priority;
      const coalescing = (value as any).coalescing;
      return {
        tx: typeof txValue === "number" ? txValue : txValue === null ? null : Number.isFinite(Number(txValue)) ? Number(txValue) : null,
        patchCount: Number.isFinite(patchCount) ? patchCount : 0,
        appliedPatchCount: Number.isFinite(appliedPatchCount) ? appliedPatchCount : undefined,
        queueDelayMs: queueDelay,
        durationMs: duration,
        priority: priority === "low" ? "low" : "high",
        receivedAt: Number.isFinite(Number((value as any).receivedAt)) ? Number((value as any).receivedAt) : null,
        appliedAt: Number.isFinite(Number((value as any).appliedAt)) ? Number((value as any).appliedAt) : null,
        queueDepthBefore: Number.isFinite(Number((value as any).queueDepthBefore)) ? Number((value as any).queueDepthBefore) : null,
        remainingQueue: Number.isFinite(Number((value as any).remainingQueue)) ? Number((value as any).remainingQueue) : null,
        effectiveQueueDepth: Number.isFinite(Number((value as any).effectiveQueueDepth)) ? Number((value as any).effectiveQueueDepth) : null,
        flushStartedAt: Number.isFinite(Number((value as any).flushStartedAt)) ? Number((value as any).flushStartedAt) : null,
        flushCompletedAt: Number.isFinite(Number((value as any).flushCompletedAt)) ? Number((value as any).flushCompletedAt) : null,
        coalescing:
          coalescing && typeof coalescing === "object"
            ? {
                inputPatchCount: Number((coalescing as any).inputPatchCount ?? undefined) || 0,
                outputPatchCount: Number((coalescing as any).outputPatchCount ?? undefined) || 0,
                coalescedCount: Number((coalescing as any).coalescedCount ?? undefined) || 0,
                durationMs: Number((coalescing as any).durationMs ?? undefined) || 0,
                appendLinesCoalesced: Number((coalescing as any).appendLinesCoalesced ?? undefined) || 0,
                setPropsCoalesced: Number((coalescing as any).setPropsCoalesced ?? undefined) || 0,
                insertChildCoalesced: Number((coalescing as any).insertChildCoalesced ?? undefined) || 0,
              }
            : null,
      };
    };

    const flushBatches = Array.isArray((perf as any).flushBatches) ? (perf as any).flushBatches.map(normalizeBatch).filter((entry: any) => entry !== null) : [];

    return {
      summary: perf.summary ?? {},
      samples: {
        recvToFlushMs: ensureArray(perf.samples?.recvToFlushMs),
        flushApplyMs: ensureArray(perf.samples?.flushApplyMs),
        reactCommitMs: ensureArray(perf.samples?.reactCommitMs),
        paintMs: ensureArray(perf.samples?.paintMs),
        queueDepth: ensureArray(perf.samples?.queueDepth),
        patchApplyMs: ensureArray(perf.samples?.patchApplyMs),
        longTasksMs: ensureArray(perf.samples?.longTasksMs),
      },
      worker: perf.worker ?? null,
      workerTotals: perf.workerTotals ?? null,
      stream: perf.stream ?? null,
      patchTotals: state?.patchStats?.totals ?? null,
      coalescingTotals: perf.coalescingTotals ?? null,
      flushBatches,
    };
  });
  const state = await captureRuntimeState(page);
  return { html, telemetry, state };
}

function buildTracePrefixLengths(content: string, mode: "chunk" | "char", maxSteps: number): number[] {
  if (content.length === 0) return [0];
  if (mode === "char") {
    const lengths: number[] = [];
    const limit = Math.min(content.length, maxSteps);
    for (let index = 1; index <= limit; index += 1) {
      lengths.push(index);
    }
    if (lengths[lengths.length - 1] !== content.length) {
      lengths.push(content.length);
    }
    return lengths;
  }

  const approxChunk = Math.max(1, Math.floor((STREAM_RATE * STREAM_TICK_MS) / 1000));
  const lengths: number[] = [];
  for (let index = approxChunk; index < content.length; index += approxChunk) {
    lengths.push(index);
    if (lengths.length >= maxSteps - 1) {
      break;
    }
  }
  if (lengths.length === 0 || lengths[lengths.length - 1] !== content.length) {
    lengths.push(content.length);
  }
  return lengths;
}

function summarizeLookaheadDecisions(steps: LookaheadTraceStep[]) {
  const providerCounts: Record<string, number> = {};
  const terminationCounts: Record<string, number> = {};
  const downgradeCounts: Record<string, number> = {};

  for (const step of steps) {
    for (const block of step.blocks ?? []) {
      for (const decision of [...(block.inlineLookahead ?? []), ...(block.mixedLookahead ?? [])]) {
        providerCounts[decision.providerId] = (providerCounts[decision.providerId] ?? 0) + 1;
        if (decision.termination?.reason) {
          terminationCounts[decision.termination.reason] = (terminationCounts[decision.termination.reason] ?? 0) + 1;
        }
        if (decision.downgrade?.mode) {
          downgradeCounts[decision.downgrade.mode] = (downgradeCounts[decision.downgrade.mode] ?? 0) + 1;
        }
      }
    }
  }

  return { providerCounts, terminationCounts, downgradeCounts };
}

function buildStepDecisionSummary(step: LookaheadTraceStep): NonNullable<LookaheadTraceStep["decisionSummary"]> {
  const providerCounts: Record<string, number> = {};
  const terminationCounts: Record<string, number> = {};
  const downgradeCounts: Record<string, number> = {};
  const blocksWithNoDecision: string[] = [];
  let totalDecisions = 0;

  for (const block of step.blocks ?? []) {
    const decisions = [...(block.inlineLookahead ?? []), ...(block.mixedLookahead ?? [])];
    if (decisions.length === 0) {
      blocksWithNoDecision.push(block.id);
      continue;
    }
    totalDecisions += decisions.length;
    for (const decision of decisions) {
      providerCounts[decision.providerId] = (providerCounts[decision.providerId] ?? 0) + 1;
      if (decision.termination?.reason) {
        terminationCounts[decision.termination.reason] = (terminationCounts[decision.termination.reason] ?? 0) + 1;
      }
      if (decision.downgrade?.mode) {
        downgradeCounts[decision.downgrade.mode] = (downgradeCounts[decision.downgrade.mode] ?? 0) + 1;
      }
    }
  }

  return {
    totalDecisions,
    providerCounts,
    terminationCounts,
    downgradeCounts,
    blocksWithNoDecision,
  };
}

function buildStepDiff(previous: LookaheadTraceStep | null, current: LookaheadTraceStep, currentHtml: string, previousHtml: string | null) {
  const previousBlocks = new Map((previous?.blocks ?? []).map((block) => [block.id, JSON.stringify(block)]));
  const changedBlockIds: string[] = [];
  let firstDecisionChangeBlockId: string | null = null;

  for (const block of current.blocks ?? []) {
    const serialized = JSON.stringify(block);
    const before = previousBlocks.get(block.id);
    if (before !== serialized) {
      changedBlockIds.push(block.id);
      if (firstDecisionChangeBlockId === null) {
        const previousBlock = (previous?.blocks ?? []).find((candidate) => candidate.id === block.id);
        const beforeDecisions = JSON.stringify([...(previousBlock?.inlineLookahead ?? []), ...(previousBlock?.mixedLookahead ?? [])]);
        const afterDecisions = JSON.stringify([...(block.inlineLookahead ?? []), ...(block.mixedLookahead ?? [])]);
        if (beforeDecisions !== afterDecisions) {
          firstDecisionChangeBlockId = block.id;
        }
      }
    }
  }

  return {
    rawDeltaChars: current.rawInput.length - (previous?.rawInput.length ?? 0),
    htmlChanged: previousHtml === null ? true : previousHtml !== currentHtml,
    blockIdsChanged: changedBlockIds,
    firstDecisionChangeBlockId,
  };
}

async function writeLookaheadTrace(browser: typeof chromium, snippetName: string): Promise<void> {
  const snippetContent = await readSnippet(snippetName);
  const prefixLengths = buildTracePrefixLengths(snippetContent, TRACE_MODE, TRACE_MAX_STEPS);
  const slug = snippetName.replace(/\.[^.]+$/, "");
  const traceRoot = path.join(LOOKAHEAD_TRACE_DIR, `${slug}-${TRACE_MODE}`);
  const htmlDir = path.join(traceRoot, "html");
  const stepsDir = path.join(traceRoot, "steps");
  await fs.rm(traceRoot, { recursive: true, force: true });
  await fs.mkdir(htmlDir, { recursive: true });
  await fs.mkdir(stepsDir, { recursive: true });

  const summary = {
    generatedAt: new Date().toISOString(),
    snippet: snippetName,
    mode: TRACE_MODE,
    totalSteps: prefixLengths.length,
    lengths: prefixLengths,
  };

  const traceSteps: LookaheadTraceStep[] = [];
  let previousStep: LookaheadTraceStep | null = null;
  let previousHtml: string | null = null;

  for (let stepIndex = 0; stepIndex < prefixLengths.length; stepIndex += 1) {
    const prefixLength = prefixLengths[stepIndex]!;
    const rawInput = snippetContent.slice(0, prefixLength);
    const page = await browser.newPage();
    try {
      const { html, telemetry, state } = await renderSnippet(page, snippetContent, { traceFast: true, streamLimit: prefixLength });
      const htmlRel = path.join("html", `step-${String(stepIndex).padStart(4, "0")}.html`);
      const stepRel = path.join("steps", `step-${String(stepIndex).padStart(4, "0")}.json`);
      const telemetryRel = path.join("steps", `telemetry-${String(stepIndex).padStart(4, "0")}.json`);
      await fs.writeFile(path.join(traceRoot, htmlRel), html, "utf-8");
      const traceStep: LookaheadTraceStep = {
        stepIndex,
        mode: TRACE_MODE,
        prefixLength,
        rawInput,
        htmlPath: htmlRel,
        telemetryPath: telemetryRel,
        state: state.demoState,
        blocks: state.blocks,
      };
      traceStep.decisionSummary = buildStepDecisionSummary(traceStep);
      traceStep.diffFromPrevious = buildStepDiff(previousStep, traceStep, html, previousHtml);
      traceSteps.push(traceStep);
      await fs.writeFile(path.join(traceRoot, telemetryRel), JSON.stringify(telemetry, null, 2), "utf-8");
      await fs.writeFile(path.join(traceRoot, stepRel), JSON.stringify(traceStep, null, 2), "utf-8");
      previousStep = traceStep;
      previousHtml = html;
    } finally {
      await page.close();
    }
  }

  const aggregateSummary = summarizeLookaheadDecisions(traceSteps);
  const firstRenderableStep = traceSteps.find((step) => Array.isArray(step.blocks) && step.blocks.length > 0)?.stepIndex ?? null;
  const firstFinalizedStep =
    traceSteps.find((step) => (step.blocks ?? []).some((block) => block.isFinalized))?.stepIndex ?? null;

  await fs.writeFile(
    path.join(traceRoot, "trace-summary.json"),
    JSON.stringify(
      {
        ...summary,
        firstRenderableStep,
        firstFinalizedStep,
        aggregate: aggregateSummary,
      },
      null,
      2,
    ),
    "utf-8",
  );
  await fs.writeFile(path.join(traceRoot, "trace.ndjson"), `${traceSteps.map((step) => JSON.stringify(step)).join("\n")}\n`, "utf-8");

  console.log(`[analyze] Wrote lookahead trace for ${snippetName} to ${traceRoot}`);
}

function analyzeHtml(html: string, snippetContent: string, snippetName: string): SnippetAnalysis["analysis"] {
  // Parse HTML using JSDOM to avoid Playwright serialization issues
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const root = document.querySelector('[data-testid="markdown-output"]');

  if (!root) {
    return {
      structure: {
        blockCount: 0,
        blockTypes: {},
        hasProseWrapper: false,
        hasMarkdownOutput: false,
      },
      content: {
        textLength: 0,
        hasExpectedText: false,
        missingText: [],
        unexpectedText: [],
      },
      markdown: {
        headers: { level: 0, count: 0 },
        lists: { unordered: 0, ordered: 0, nested: 0 },
        blockquotes: 0,
        codeBlocks: { count: 0, languages: [] },
        tables: { count: 0, rowCounts: [] },
        paragraphs: 0,
      },
      formatting: {
        bold: 0,
        italic: 0,
        strikethrough: 0,
        links: 0,
        inlineCode: 0,
        kbd: 0,
        sub: 0,
        sup: 0,
      },
      math: {
        inline: 0,
        display: 0,
        katexElements: 0,
      },
      html: {
        rawHtmlBlocks: 0,
        sanitizedHtml: false,
        mdxComponents: 0,
        mdxPending: 0,
        mdxErrors: 0,
        mdxInlinePending: 0,
        mdxInlineErrors: 0,
      },
      performance: {
        patchApply: null,
        longTasks: null,
      },
      issues: {
        critical: ["Root element '[data-testid=\"markdown-output\"]' not found"],
        warnings: [],
        suggestions: [],
      },
    };
  }

  const issues: {
    critical: string[];
    warnings: string[];
    suggestions: string[];
  } = {
    critical: [],
    warnings: [],
    suggestions: [],
  };

  // Structure analysis
  const proseWrapper = root.querySelector(".prose.markdown") ?? root.querySelector(".prose");
  const outputContainer = root.querySelector(".markdown-v2-output");
  const blocks = Array.from(outputContainer?.children ?? root.children);
  const blockTypes: Record<string, number> = {};
  blocks.forEach((block) => {
    const tag = block.tagName.toLowerCase();
    blockTypes[tag] = (blockTypes[tag] ?? 0) + 1;
  });

  // Content analysis
  const textContent = root.textContent ?? "";
  const normalizedText = normalizeWhitespace(textContent);
  const snippetLines = snippetContent.split("\n").filter((l) => l.trim().length > 0);
  const missingText: string[] = [];

  snippetLines.slice(0, 10).forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (trimmed.includes("|") || /^-+$/.test(trimmed)) {
      return;
    }
    const candidate = normalizeWhitespace(stripMarkdownLinePrefix(trimmed));
    if (candidate.length > 20 && !normalizedText.includes(candidate)) {
      missingText.push(trimmed.slice(0, 60));
    }
  });

  // Markdown element analysis
  const headers = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  const headerLevels = headers.map((h) => parseInt(h.tagName[1] ?? "0", 10));
  const headerCount = headers.length;
  const maxLevel = headerLevels.length > 0 ? Math.max(...headerLevels) : 0;

  const unorderedLists = root.querySelectorAll("ul");
  const orderedLists = root.querySelectorAll("ol");
  const nestedLists = Array.from(root.querySelectorAll("ul ul, ol ul, ul ol, ol ol")).length;

  const blockquotes = root.querySelectorAll("blockquote").length;

  const codeBlocks = root.querySelectorAll("pre code");
  const codeLanguages: string[] = [];
  codeBlocks.forEach((block) => {
    const lang = block.getAttribute("data-language") ?? block.getAttribute("class")?.match(/language-(\w+)/)?.[1];
    if (lang) codeLanguages.push(lang);
  });

  const tables = root.querySelectorAll("table");
  const tableRowCounts: number[] = [];
  tables.forEach((table) => {
    tableRowCounts.push(table.querySelectorAll("tr").length);
  });

  const paragraphs = root.querySelectorAll("p").length;

  // Formatting analysis
  const bold = root.querySelectorAll("strong, b").length;
  const italic = root.querySelectorAll("em, i").length;
  const strikethrough = root.querySelectorAll("del, s").length;
  const links = root.querySelectorAll("a[href]").length;
  const inlineCode = root.querySelectorAll("code:not(pre code)").length;
  const kbd = root.querySelectorAll("kbd").length;
  const sub = root.querySelectorAll("sub").length;
  const sup = root.querySelectorAll("sup").length;

  // Math analysis
  const katexInline = root.querySelectorAll(".katex-inline, .katex:not(.katex-display)").length;
  const katexDisplay = root.querySelectorAll(".katex-display, .katex-display .katex").length;
  const katexElements = root.querySelectorAll(".katex").length;

  // HTML/MDX analysis
  const rawHtmlDivs = Array.from(root.querySelectorAll("div")).filter((div) => {
    const divHtml = div.innerHTML.trim();
    return divHtml.startsWith("<") && !divHtml.match(/^<(p|div|span|a|strong|em|code|pre|ul|ol|li|h[1-6]|blockquote)/i);
  }).length;

  // Check sanitization by examining DOM, not HTML string
  const scripts = root.querySelectorAll("script");
  const sanitizedHtml = scripts.length === 0;
  const mdxComponents = root.querySelectorAll("[data-mdx-component]").length;
  const mdxPendingBlocks = root.querySelectorAll('.markdown-mdx[data-mdx-status="pending"]').length;
  const mdxErrorBlocks = root.querySelectorAll('.markdown-mdx[data-mdx-status="error"]').length;
  const mdxInlinePending = root.querySelectorAll('.markdown-mdx-inline[data-mdx-status="pending"]').length;
  const mdxInlineErrors = root.querySelectorAll('.markdown-mdx-inline[data-mdx-status="error"]').length;

  // Issue detection
  if (!outputContainer) {
    issues.warnings.push("Missing '.markdown-v2-output' container");
  }

  if (codeBlocks.length > 0) {
    codeBlocks.forEach((block, idx) => {
      const lang = codeLanguages[idx];
      const pre = block.closest("pre");
      const hasShikiClass =
        (pre?.className && /\bshiki\b/.test(pre.className)) || (block.getAttribute("class") && /\bshiki\b/.test(block.getAttribute("class") ?? ""));
      const hasShikiTheme = Boolean(block.getAttribute("data-theme") || pre?.getAttribute("data-theme"));
      const hasShikiVars = (block.getAttribute("style") ?? "").includes("--shiki-") || (pre?.getAttribute("style") ?? "").includes("--shiki-");
      const hasHighlight = hasShikiClass || hasShikiTheme || hasShikiVars;
      if (!hasHighlight && lang && lang !== "text") {
        issues.warnings.push(`Code block ${idx + 1} (${lang}) missing syntax highlighting`);
      }
    });
  }

  const mathDisplayPlaceholders = root.querySelectorAll(".math-display, .markdown-math-display").length;
  const hasStreamingPartial = root.querySelector(".streaming-partial") !== null;
  if (snippetContent.includes("$$") && katexDisplay === 0) {
    if (hasStreamingPartial) {
      issues.warnings.push("Display math ($$) captured while streaming block was still partial");
    } else if (mathDisplayPlaceholders > 0) {
      issues.warnings.push("Display math ($$) rendered without KaTeX finalization (placeholder detected)");
    } else {
      issues.critical.push("Display math ($$) detected in snippet but no KaTeX display elements found");
    }
  }

  if (snippetContent.includes("$") && !snippetContent.includes("$$") && katexInline === 0 && snippetContent.match(/\$[^$]+\$/)) {
    issues.suggestions.push("Inline math ($) detected but no KaTeX inline elements found");
  }

  if (missingText.length > 0) {
    const lineCount = snippetLines.length || 1;
    const missingRatio = missingText.length / lineCount;
    const message = `${missingText.length} expected text segments not found in rendered output`;
    if (missingRatio >= 0.25) {
      issues.warnings.push(message);
    } else {
      issues.suggestions.push(message);
    }
  }

  // Check for proper escaping - look for literal asterisks in text content
  const escapedAsterisks = snippetContent.match(/\\\*/g);
  if (escapedAsterisks && escapedAsterisks.length > 0) {
    // Count asterisks that appear as literal text (not in formatting contexts)
    const textNodes = Array.from(root.querySelectorAll("*"))
      .map((el) => el.textContent ?? "")
      .join(" ");
    const literalAsterisks = textNodes.match(/\*/g)?.length ?? 0;
    // If we have escaped asterisks in source but they're rendered as formatting, we'd see fewer literal asterisks
    // This is a heuristic check
    if (literalAsterisks < escapedAsterisks.length) {
      issues.suggestions.push("Some escaped asterisks may be rendered as formatting");
    }
  }

  if (mdxPendingBlocks > 0) {
    const message = `${mdxPendingBlocks} MDX block(s) remained pending after finalize`;
    if (ANALYZER_MDX_MODE === "worker") {
      issues.critical.push(message);
    } else {
      issues.warnings.push(message);
    }
  }

  if (mdxErrorBlocks > 0) {
    issues.critical.push(`${mdxErrorBlocks} MDX block(s) reported compilation errors`);
  }

  if (mdxInlinePending > 0) {
    issues.warnings.push(`${mdxInlinePending} inline MDX fragment(s) still pending after finalize`);
  }

  if (mdxInlineErrors > 0) {
    issues.critical.push(`${mdxInlineErrors} inline MDX fragment(s) reported compilation errors`);
  }

  return {
    structure: {
      blockCount: blocks.length,
      blockTypes,
      hasProseWrapper: !!proseWrapper,
      hasMarkdownOutput: !!outputContainer,
    },
    content: {
      textLength: textContent.length,
      hasExpectedText: missingText.length === 0,
      missingText,
      unexpectedText: [],
    },
    markdown: {
      headers: { level: maxLevel, count: headerCount },
      lists: {
        unordered: unorderedLists.length,
        ordered: orderedLists.length,
        nested: nestedLists,
      },
      blockquotes,
      codeBlocks: { count: codeBlocks.length, languages: codeLanguages },
      tables: { count: tables.length, rowCounts: tableRowCounts },
      paragraphs,
    },
    formatting: {
      bold,
      italic,
      strikethrough,
      links,
      inlineCode,
      kbd,
      sub,
      sup,
    },
    math: {
      inline: katexInline,
      display: katexDisplay,
      katexElements,
    },
    html: {
      rawHtmlBlocks: rawHtmlDivs,
      sanitizedHtml,
      mdxComponents,
      mdxPending: mdxPendingBlocks,
      mdxErrors: mdxErrorBlocks,
      mdxInlinePending,
      mdxInlineErrors,
    },
    performance: {
      patchApply: null,
      longTasks: null,
      recvToFlush: null,
      flushApply: null,
      reactCommit: null,
      paint: null,
      queueDepth: null,
      stream: null,
      worker: null,
      workerTotals: null,
      coalescingTotals: null,
      coalescingBreakdown: null,
    },
    issues,
  };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripMarkdownLinePrefix(line: string): string {
  let result = line.trim();
  if (result.length === 0) return result;

  result = result.replace(/^>+\s*/, "");
  result = result.replace(/^#{1,6}\s+/, "");
  result = result.replace(/^\[[xX ]\]\s+/, "");
  result = result.replace(/^(\d+\.)\s+/, "");
  result = result.replace(/^[-*+]\s+/, "");

  return result.trimStart();
}

async function analyzeSnippet(browser: typeof chromium, snippetName: string): Promise<SnippetAnalysis> {
  console.log(`[analyze] Processing ${snippetName}...`);
  const snippetContent = await readSnippet(snippetName);
  const page = await browser.newPage();

  try {
    const { html: renderedHtml, telemetry } = await renderSnippet(page, snippetContent);
    const analysis = analyzeHtml(renderedHtml, snippetContent, snippetName);

    if (telemetry) {
      analysis.telemetry = telemetry;
      const perfSummary = mapPerfSummary(telemetry.summary);
      analysis.performance.patchApply = cloneSummaryStats(perfSummary.patchApply);
      analysis.performance.longTasks = cloneSummaryStats(perfSummary.longTasks);
      analysis.performance.recvToFlush = cloneSummaryStats(perfSummary.recvToFlush);
      analysis.performance.flushApply = cloneSummaryStats(perfSummary.flushApply);
      analysis.performance.reactCommit = cloneSummaryStats(perfSummary.reactCommit);
      analysis.performance.paint = cloneSummaryStats(perfSummary.paint);
      analysis.performance.queueDepth = cloneSummaryStats(perfSummary.queueDepth);
      analysis.performance.stream = telemetry.stream ? { ...telemetry.stream } : null;
      analysis.performance.worker = telemetry.worker ? { ...telemetry.worker } : null;
      analysis.performance.workerTotals = telemetry.workerTotals ? { ...telemetry.workerTotals } : null;
      if (telemetry.coalescingTotals) {
        const totals = telemetry.coalescingTotals;
        const reductionPct = totals.input > 0 ? (totals.coalesced / totals.input) * 100 : null;
        const appliedPct = totals.input > 0 ? (totals.output / totals.input) * 100 : null;
        analysis.performance.coalescingTotals = {
          input: totals.input,
          output: totals.output,
          coalesced: totals.coalesced,
          appendLines: totals.appendLines,
          setProps: totals.setProps,
          insertChild: totals.insertChild,
          durationMs: totals.durationMs,
          reductionPct,
          appliedPct,
        };
      } else {
        analysis.performance.coalescingTotals = null;
      }
      analysis.performance.coalescingBreakdown = computeCoalescingBreakdown(telemetry.flushBatches ?? null);
      await appendCoalescingCsvRows(snippetName, telemetry.flushBatches ?? null);

      const patchStats = analysis.performance.patchApply;
      if (patchStats) {
        if (patchStats.p95Ms > PATCH_P95_WARN_MS) {
          analysis.issues.warnings.push(`Patch apply p95 ${patchStats.p95Ms.toFixed(1)}ms exceeds ${PATCH_P95_WARN_MS}ms guardrail`);
        }
        if (patchStats.maxMs > PATCH_MAX_WARN_MS) {
          analysis.issues.warnings.push(`Patch apply max ${patchStats.maxMs.toFixed(1)}ms exceeds ${PATCH_MAX_WARN_MS}ms guardrail`);
        }
      }

      const longTaskStats = analysis.performance.longTasks;
      if (longTaskStats && longTaskStats.count > 0) {
        const msg = `Long tasks detected (${longTaskStats.count} ≥50ms, max ${longTaskStats.maxMs.toFixed(1)}ms)`;
        if (longTaskStats.maxMs > LONG_TASK_WARN_MAX_MS) {
          analysis.issues.warnings.push(msg);
        } else {
          analysis.issues.suggestions.push(msg);
        }
      }

      const queueStats = analysis.performance.queueDepth;
      if (queueStats) {
        if (queueStats.p95Ms > QUEUE_DEPTH_P95_WARN) {
          analysis.issues.warnings.push(
            `Queue depth p95 ${queueStats.p95Ms.toFixed(2)} exceeds ${QUEUE_DEPTH_P95_WARN.toFixed(1)} (possible back-pressure issue)`,
          );
        }
        if (queueStats.maxMs > QUEUE_DEPTH_MAX_WARN) {
          analysis.issues.warnings.push(`Queue depth max ${queueStats.maxMs.toFixed(2)} exceeds ${QUEUE_DEPTH_MAX_WARN.toFixed(1)} (patch backlog observed)`);
        }
      }

      const streamMetrics = telemetry.stream;
      if (streamMetrics?.firstMeaningfulMs !== undefined && streamMetrics.firstMeaningfulMs !== null) {
        if (streamMetrics.firstMeaningfulMs > TTFMC_WARN_MS) {
          analysis.issues.warnings.push(`TTFMC ${streamMetrics.firstMeaningfulMs.toFixed(1)}ms exceeds ${TTFMC_WARN_MS}ms target`);
        }
      } else {
        analysis.issues.suggestions.push("First meaningful chunk timing unavailable");
      }

      if (streamMetrics?.completionMs === undefined || streamMetrics?.completionMs === null) {
        analysis.issues.suggestions.push("Stream completion timing unavailable");
      }
    }

    evaluateCoalescingGuardrails(snippetName, analysis, telemetry ?? null);
    return {
      snippetName,
      snippetPath: path.join(SNIPPETS_DIR, snippetName),
      snippetContent,
      renderedHtml,
      analysis,
      telemetry: telemetry ?? null,
    };
  } finally {
    await page.close();
  }
}

async function main() {
  await loadAnalyzerSuppressions();
  const snippets = await listSnippets();
  console.log(`[analyze] Found ${snippets.length} snippets to analyze`);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(LOOKAHEAD_TRACE_DIR, { recursive: true });

  if (TRACE_LOOKAHEAD) {
    const snippetName = TRACE_SNIPPET ?? snippets[0];
    if (!snippetName) {
      throw new Error("[analyze] No snippets available for lookahead tracing");
    }
    const resolvedSnippet = snippets.includes(snippetName)
      ? snippetName
      : snippets.find((candidate) => candidate === `${snippetName}.md`) ??
        snippets.find((candidate) => candidate === `${snippetName}.mdx`) ??
        snippetName;
    if (!snippets.includes(resolvedSnippet)) {
      throw new Error(`[analyze] Requested trace snippet not found: ${snippetName}`);
    }
    const browser = await chromium.launch({ headless: true });
    try {
      await writeLookaheadTrace(browser, resolvedSnippet);
    } finally {
      await browser.close();
    }
    return;
  }

  await fs.writeFile(
    COALESCING_CSV_PATH,
    "snippet,tx,priority,queueDelayMs,durationMs,inputPatches,outputPatches,coalesced,appendLinesMerged,setPropsMerged,insertChildMerged\n",
    "utf-8",
  );

  const browser = await chromium.launch({ headless: true });
  const results: SnippetAnalysis[] = [];
  const snippetArtifacts: Array<{ snippet: string; htmlPath: string }> = [];
  let guardrailSummary: GuardrailSummary | null = null;

  try {
    for (const snippet of snippets) {
      const result = await analyzeSnippet(browser, snippet);
      results.push(result);

      // Save individual HTML
      const htmlPath = path.join(OUTPUT_DIR, `${snippet.replace(".md", "")}.html`);
      await fs.writeFile(htmlPath, result.renderedHtml, "utf-8");
      snippetArtifacts.push({ snippet, htmlPath });

      // Log summary
      const { analysis } = result;
      console.log(`  ✓ ${snippet}`);
      console.log(`    Blocks: ${analysis.structure.blockCount}, Types: ${Object.keys(analysis.structure.blockTypes).join(", ")}`);
      console.log(
        `    Headers: ${analysis.markdown.headers.count}, Lists: ${analysis.markdown.lists.unordered + analysis.markdown.lists.ordered}, Code: ${analysis.markdown.codeBlocks.count}`,
      );
      if (analysis.issues.critical.length > 0) {
        console.log(`    ⚠ CRITICAL: ${analysis.issues.critical.join(", ")}`);
      }
      if (analysis.issues.warnings.length > 0) {
        console.log(`    ⚠ Warnings: ${analysis.issues.warnings.length}`);
      }
    }

    // Save comprehensive report
    const reportPath = path.join(OUTPUT_DIR, "analysis-report.json");
    await fs.writeFile(reportPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`\n[analyze] Saved detailed report to ${reportPath}`);

    const perfMetrics: Record<string, unknown> = {};
    for (const result of results) {
      const perf = result.analysis.performance;
      perfMetrics[result.snippetName] = {
        summary: {
          patchApply: cloneSummaryStats(perf.patchApply),
          flushApply: cloneSummaryStats(perf.flushApply),
          recvToFlush: cloneSummaryStats(perf.recvToFlush),
          reactCommit: cloneSummaryStats(perf.reactCommit),
          paint: cloneSummaryStats(perf.paint),
          queueDepth: cloneSummaryStats(perf.queueDepth),
          longTasks: cloneSummaryStats(perf.longTasks),
        },
        stream: perf.stream ?? null,
        worker: perf.worker ?? null,
        samples: result.telemetry?.samples ?? null,
        patchTotals: result.telemetry?.patchTotals ?? null,
        workerTotals: result.telemetry?.workerTotals ?? null,
        coalescingTotals: result.telemetry?.coalescingTotals ?? null,
        flushBatches: result.telemetry?.flushBatches ?? null,
        coalescingBreakdown: perf.coalescingBreakdown ?? null,
        warnings: result.analysis.issues.warnings,
        critical: result.analysis.issues.critical,
      };
    }
    const perfPath = path.join(OUTPUT_DIR, "performance-metrics.json");
    await fs.writeFile(perfPath, JSON.stringify(perfMetrics, null, 2), "utf-8");
    console.log(`[analyze] Saved performance metrics to ${perfPath}`);

    // Generate markdown summary
    const summaryPath = path.join(OUTPUT_DIR, "analysis-summary.md");
    await generateMarkdownSummary(results, summaryPath);
    console.log(`[analyze] Saved markdown summary to ${summaryPath}`);

    guardrailSummary = buildGuardrailSummary();
    await fs.writeFile(GUARDRAIL_SUMMARY_PATH, JSON.stringify(guardrailSummary, null, 2), "utf-8");
    console.log(`[analyze] Saved guardrail summary to ${GUARDRAIL_SUMMARY_PATH}`);

    const manifest = {
      generatedAt: new Date().toISOString(),
      outputDir: OUTPUT_DIR,
      files: {
        report: path.relative(process.cwd(), reportPath),
        performanceMetrics: path.relative(process.cwd(), perfPath),
        summary: path.relative(process.cwd(), summaryPath),
        coalescingCsv: path.relative(process.cwd(), COALESCING_CSV_PATH),
        guardrails: path.relative(process.cwd(), GUARDRAIL_SUMMARY_PATH),
      },
      snippets: snippetArtifacts.map((artifact) => ({
        snippet: artifact.snippet,
        html: path.relative(process.cwd(), artifact.htmlPath),
      })),
      guardrails: guardrailSummary
        ? {
            total: guardrailSummary.total,
            unsuppressedFailures: guardrailSummary.unsuppressedFailures.length,
            unsuppressedWarnings: guardrailSummary.unsuppressedWarnings.length,
            suppressed: guardrailSummary.suppressed.length,
          }
        : null,
    };
    await fs.writeFile(ARTIFACT_MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
    console.log(`[analyze] Saved artifact manifest to ${ARTIFACT_MANIFEST_PATH}`);
  } finally {
    await browser.close();
  }

  const summaryForExit = guardrailSummary ?? buildGuardrailSummary();
  if (summaryForExit.unsuppressedFailures.length > 0 || summaryForExit.unsuppressedWarnings.length > 0) {
    console.error("[analyze] Guardrail violations detected:");
    for (const entry of [...summaryForExit.unsuppressedFailures, ...summaryForExit.unsuppressedWarnings]) {
      console.error(`  - ${entry.snippet} [${entry.rule}] ${entry.message}`);
    }
    throw new Error(
      `[analyze] Guardrail violations: ${summaryForExit.unsuppressedFailures.length} failure(s), ${summaryForExit.unsuppressedWarnings.length} warning(s)`,
    );
  }

  if (summaryForExit.suppressed.length > 0) {
    console.log("[analyze] Suppressed guardrail entries:");
    for (const entry of summaryForExit.suppressed) {
      console.log(`  - ${entry.snippet} [${entry.rule}] ${entry.message}`);
    }
  }
}

async function generateMarkdownSummary(results: SnippetAnalysis[], outputPath: string): Promise<void> {
  const lines: string[] = [
    "# Test Snippet Analysis Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Total snippets analyzed: ${results.length}`,
    "",
    "## Summary",
    "",
  ];

  const criticalIssues = results.filter((r) => r.analysis.issues.critical.length > 0);
  const warnings = results.filter((r) => r.analysis.issues.warnings.length > 0);

  lines.push(`- **Critical Issues**: ${criticalIssues.length} snippets`);
  lines.push(`- **Warnings**: ${warnings.length} snippets`);
  lines.push(`- **Coalescing Detail**: per-batch data saved to \`coalescing.csv\``);
  lines.push("");

  for (const result of results) {
    lines.push(`## ${result.snippetName}`, "");
    lines.push(`**Path**: \`${result.snippetPath}\``);
    lines.push(`**Content Length**: ${result.snippetContent.length} chars`);
    lines.push(`**Rendered HTML Length**: ${result.renderedHtml.length} chars`);
    lines.push("");

    const { analysis } = result;

    lines.push("### Structure", "");
    lines.push(`- Block count: ${analysis.structure.blockCount}`);
    lines.push(
      `- Block types: ${Object.entries(analysis.structure.blockTypes)
        .map(([k, v]) => `${k}(${v})`)
        .join(", ")}`,
    );
    lines.push(`- Has prose wrapper: ${analysis.structure.hasProseWrapper}`);
    lines.push(`- Has markdown-output: ${analysis.structure.hasMarkdownOutput}`);
    lines.push("");

    lines.push("### Markdown Elements", "");
    lines.push(`- Headers: ${analysis.markdown.headers.count} (max level ${analysis.markdown.headers.level})`);
    lines.push(`- Lists: ${analysis.markdown.lists.unordered} unordered, ${analysis.markdown.lists.ordered} ordered, ${analysis.markdown.lists.nested} nested`);
    lines.push(`- Blockquotes: ${analysis.markdown.blockquotes}`);
    lines.push(`- Code blocks: ${analysis.markdown.codeBlocks.count} (${analysis.markdown.codeBlocks.languages.join(", ") || "none"})`);
    lines.push(`- Tables: ${analysis.markdown.tables.count} (${analysis.markdown.tables.rowCounts.join(", ") || "none"})`);
    lines.push(`- Paragraphs: ${analysis.markdown.paragraphs}`);
    lines.push("");

    lines.push("### Formatting", "");
    lines.push(`- Bold: ${analysis.formatting.bold}, Italic: ${analysis.formatting.italic}, Strikethrough: ${analysis.formatting.strikethrough}`);
    lines.push(`- Links: ${analysis.formatting.links}, Inline code: ${analysis.formatting.inlineCode}`);
    lines.push(`- KBD: ${analysis.formatting.kbd}, Sub: ${analysis.formatting.sub}, Sup: ${analysis.formatting.sup}`);
    lines.push("");

    if (analysis.math.katexElements > 0) {
      lines.push("### Math", "");
      lines.push(`- Inline: ${analysis.math.inline}, Display: ${analysis.math.display}, Total KaTeX: ${analysis.math.katexElements}`);
      lines.push("");
    }

    if (
      analysis.html.mdxComponents > 0 ||
      analysis.html.rawHtmlBlocks > 0 ||
      analysis.html.mdxPending > 0 ||
      analysis.html.mdxErrors > 0 ||
      analysis.html.mdxInlinePending > 0 ||
      analysis.html.mdxInlineErrors > 0
    ) {
      lines.push("### HTML/MDX", "");
      lines.push(`- MDX components: ${analysis.html.mdxComponents}`);
      lines.push(`- Raw HTML blocks: ${analysis.html.rawHtmlBlocks}`);
      lines.push(`- Sanitized: ${analysis.html.sanitizedHtml}`);
      if (analysis.html.mdxPending > 0) {
        lines.push(`- Pending MDX blocks: ${analysis.html.mdxPending}`);
      }
      if (analysis.html.mdxErrors > 0) {
        lines.push(`- MDX block errors: ${analysis.html.mdxErrors}`);
      }
      if (analysis.html.mdxInlinePending > 0) {
        lines.push(`- Pending inline MDX fragments: ${analysis.html.mdxInlinePending}`);
      }
      if (analysis.html.mdxInlineErrors > 0) {
        lines.push(`- Inline MDX errors: ${analysis.html.mdxInlineErrors}`);
      }
      lines.push("");
    }

    const perf = analysis.performance;
    lines.push("### Performance", "");
    lines.push(`- Patch apply: ${formatSummaryStats(perf.patchApply)}`);
    lines.push(`- Flush apply: ${formatSummaryStats(perf.flushApply)}`);
    lines.push(`- Recv → flush: ${formatSummaryStats(perf.recvToFlush)}`);
    lines.push(`- React commit: ${formatSummaryStats(perf.reactCommit)}`);
    lines.push(`- Paint spacing: ${formatSummaryStats(perf.paint)}`);
    lines.push(`- Queue depth: ${formatSummaryStats(perf.queueDepth, "count")}`);
    lines.push(`- Long tasks: ${formatSummaryStats(perf.longTasks)}`);
    if (perf.coalescingTotals) {
      const totals = perf.coalescingTotals;
      lines.push(
        `- Coalescing: input ${totals.input.toLocaleString()} → output ${totals.output.toLocaleString()} (reduction ${formatPercentValue(totals.reductionPct)}, applied ${formatPercentValue(totals.appliedPct)})`,
      );
      lines.push(
        `  - AppendLines merged ${totals.appendLines.toLocaleString()}, setProps merged ${totals.setProps.toLocaleString()}, insertChild merged ${totals.insertChild.toLocaleString()}`,
      );
    }
    if (perf.coalescingBreakdown) {
      const breakdown = perf.coalescingBreakdown;
      const reductionPct = breakdown.input > 0 ? ((breakdown.coalesced / breakdown.input) * 100).toFixed(2) : "0.00";
      lines.push(
        `- Coalescing breakdown: ${breakdown.batchesWithMetrics}/${breakdown.batches} batches reported metrics · total input ${breakdown.input.toLocaleString()} / coalesced ${breakdown.coalesced.toLocaleString()} (${reductionPct}%)`,
      );
      lines.push(
        `  - Duration avg ${breakdown.durationMsAvg.toFixed(2)}ms · p95 ${breakdown.durationMsP95 !== null ? breakdown.durationMsP95.toFixed(2) : "—"}ms · see coalescing.csv for per-batch details`,
      );
    }
    if (perf.stream) {
      const { firstMeaningfulMs, completionMs } = perf.stream;
      if (firstMeaningfulMs !== undefined) {
        lines.push(`- TTFMC: ${Number.isFinite(firstMeaningfulMs ?? NaN) ? `${(firstMeaningfulMs ?? 0).toFixed(1)} ms` : "—"}`);
      }
      if (completionMs !== undefined) {
        lines.push(`- Completion: ${Number.isFinite(completionMs ?? NaN) ? `${(completionMs ?? 0).toFixed(1)} ms` : "—"}`);
      }
    }
    if (perf.worker) {
      lines.push(
        `- Worker parse/enrich/diff/serialize: ${formatNumber(perf.worker.parseMs ?? perf.worker.parseTime)} / ${formatNumber(perf.worker.enrichMs)} / ${formatNumber(perf.worker.diffMs)} / ${formatNumber(perf.worker.serializeMs)} ms`,
      );
      lines.push(
        `- Worker highlight/mdx: ${formatNumber(perf.worker.shikiMs ?? perf.worker.highlightTime)} / ${formatNumber(perf.worker.mdxDetectMs)} ms · Queue depth ${formatNumber(perf.worker.queueDepth, 2)}`,
      );
    }
    lines.push("");

    if (analysis.issues.critical.length > 0 || analysis.issues.warnings.length > 0 || analysis.issues.suggestions.length > 0) {
      lines.push("### Issues", "");
      if (analysis.issues.critical.length > 0) {
        lines.push("**Critical:**");
        analysis.issues.critical.forEach((issue) => lines.push(`- ❌ ${issue}`));
        lines.push("");
      }
      if (analysis.issues.warnings.length > 0) {
        lines.push("**Warnings:**");
        analysis.issues.warnings.forEach((issue) => lines.push(`- ⚠️ ${issue}`));
        lines.push("");
      }
      if (analysis.issues.suggestions.length > 0) {
        lines.push("**Suggestions:**");
        analysis.issues.suggestions.forEach((issue) => lines.push(`- 💡 ${issue}`));
        lines.push("");
      }
    }

    lines.push("---");
    lines.push("");
  }

  await fs.writeFile(outputPath, lines.join("\n"), "utf-8");
}

main().catch((error) => {
  console.error("[analyze] Analysis failed:", error);
  process.exit(1);
});
