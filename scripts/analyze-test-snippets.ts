#!/usr/bin/env npx tsx
/**
 * Comprehensive analysis script for markdown test snippets
 * Runs each snippet through V2 renderer, captures HTML, and performs detailed analysis
 */
import type { Browser, Page } from "@playwright/test";
import type { PerformanceMetrics } from "@stream-mdx/core";
import type {
  FlushBatchSample as StreamingFlushBatchSample,
  StreamingDemoAutomationApiV2,
} from "../apps/docs/components/screens/streaming-markdown-demo-v2/automation-api";
import type {
  LookaheadDecisionTrace,
  LookaheadFeatureFamily,
  LookaheadSurface,
  LookaheadTraceFocus,
  LookaheadTraceStep,
} from "../packages/markdown-v2-core/src/streaming/lookahead-contract";
import type { PerfWindow } from "./perf/demo-worker-lifecycle-browser";

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const TEST_PAGE_URL = process.env.SNIPPET_TEST_URL ?? "http://localhost:3000/regression/snippet-test";
const SNIPPETS_DIR = process.env.SNIPPET_DIR ?? "tests/regression/fixtures";
const OUTPUT_DIR = "tmp/snippet_analysis";
const LOOKAHEAD_TRACE_DIR = path.join(OUTPUT_DIR, "lookahead-traces");
const COALESCING_CSV_PATH = path.join(OUTPUT_DIR, "coalescing.csv");
const ARTIFACT_MANIFEST_PATH = path.join(OUTPUT_DIR, "artifacts.json");
const GUARDRAIL_SUMMARY_PATH = path.join(OUTPUT_DIR, "guardrails.json");
const STREAM_RATE = Number(process.env.SNIPPET_STREAM_RATE ?? 600);
const STREAM_TICK_MS = Number(process.env.SNIPPET_STREAM_TICK_MS ?? 30);
const SCHEDULING_PRESET = "throughput" as const;
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

const MAX_COALESCING_DURATION_P95_MS = getNumericFlag("max-coalescing-duration", 8);
const TRACE_LOOKAHEAD = hasFlag("trace-lookahead");
const TRACE_MODE = (readStringFlag("trace-mode") ?? "chunk").toLowerCase() === "char" ? "char" : "chunk";
const TRACE_SNIPPET = readStringFlag("trace-snippet");
const TRACE_MAX_STEPS = Math.max(1, getNumericFlag("trace-max-steps", TRACE_MODE === "char" ? 160 : 48));
const TRACE_SURFACE = readStringFlag("trace-surface") as LookaheadSurface | null;
const TRACE_FEATURE_FAMILY = readStringFlag("trace-feature-family") as LookaheadFeatureFamily | null;
const TRACE_FROM_PATTERN = readStringFlag("trace-from-pattern");
const TRACE_START_OFFSET = readNumericFlag("trace-start-offset");
const TRACE_WINDOW_BEFORE = Math.max(0, getNumericFlag("trace-window-before", TRACE_MODE === "char" ? 24 : 160));
const TRACE_WINDOW_AFTER = Math.max(0, getNumericFlag("trace-window-after", TRACE_MODE === "char" ? 96 : 800));
type AnalyzerSuppressionEntry = {
  snippet: string;
  rule: string;
  reason: string;
  expiresOn?: string;
  addedBy?: string;
};

type LoadedAnalyzerSuppression = AnalyzerSuppressionEntry & {
  expiresAt: number | null;
};

type GuardrailResult = {
  snippet: string;
  rule: string;
  severity: "warn" | "fail";
  message: string;
  suppressed: boolean;
  suppression?: LoadedAnalyzerSuppression | null;
};

type SerializedGuardrailResult = Omit<GuardrailResult, "suppression"> & {
  suppression: {
    reason: string;
    expiresOn: string | null;
    addedBy: string | null;
  } | null;
};

type GuardrailSummary = {
  generatedAt: string;
  total: number;
  unsuppressedFailures: SerializedGuardrailResult[];
  unsuppressedWarnings: SerializedGuardrailResult[];
  suppressed: SerializedGuardrailResult[];
  results: SerializedGuardrailResult[];
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

function serializeGuardrailResult(result: GuardrailResult): SerializedGuardrailResult {
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

type CoalescingMetrics = NonNullable<StreamingFlushBatchSample["coalescing"]>;

type FlushBatchSample = {
  tx: number | null | undefined;
  patchCount: number;
  appliedPatchCount: number | undefined;
  queueDelayMs: number | undefined;
  durationMs: number | undefined;
  priority: "high" | "low" | undefined;
  receivedAt: number | null | undefined;
  appliedAt: number | null | undefined;
  queueDepthBefore: number | undefined;
  remainingQueue: number | undefined;
  effectiveQueueDepth: number | undefined;
  flushStartedAt: number | undefined;
  flushCompletedAt: number | undefined;
  coalescing: CoalescingMetrics | null | undefined;
};

type CoalescingBatchValidation =
  | { valid: true }
  | { valid: false; message: string };

type WorkerPerfMetrics = PerformanceMetrics;

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
  coalescingBatchValidation: CoalescingBatchValidation;
};

type RawTelemetrySnapshot = {
  summary: TelemetrySnapshot["summary"];
  samples: TelemetrySnapshot["samples"];
  worker: TelemetrySnapshot["worker"];
  workerTotals: TelemetrySnapshot["workerTotals"];
  stream: TelemetrySnapshot["stream"];
  patchTotals: TelemetrySnapshot["patchTotals"];
  coalescingTotals: TelemetrySnapshot["coalescingTotals"];
  flushBatches: unknown;
};

type LookaheadTraceBlock = NonNullable<LookaheadTraceStep["blocks"]>[number];

type RuntimeStateSnapshot = {
  demoState: Record<string, unknown> | null;
  blocks: Array<{
    id: string;
    type: string;
    isFinalized: boolean;
    rawLength: number;
    inlineStatus?: unknown;
    inlineLookahead?: LookaheadTraceBlock["inlineLookahead"];
    mixedLookahead?: LookaheadTraceBlock["mixedLookahead"];
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
    telemetry?: TelemetrySnapshot | null;
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

function isTelemetryRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finiteTelemetryNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}


type CoalescingMetricsNormalization =
  | { valid: true; metrics: CoalescingMetrics }
  | { valid: false; message: string };

function normalizeCoalescingMetrics(value: unknown): CoalescingMetricsNormalization {
  if (!isTelemetryRecord(value)) {
    return { valid: false, message: "metrics must be an object" };
  }
  const inputPatchCount = value.inputPatchCount;
  const outputPatchCount = value.outputPatchCount;
  const coalescedCount = value.coalescedCount;
  const appendLinesCoalesced = value.appendLinesCoalesced;
  const setPropsCoalesced = value.setPropsCoalesced;
  const insertChildCoalesced = value.insertChildCoalesced;
  const durationMs = value.durationMs;
  if (
    !isNonNegativeInteger(inputPatchCount) ||
    !isNonNegativeInteger(outputPatchCount) ||
    !isNonNegativeInteger(coalescedCount) ||
    !isNonNegativeInteger(appendLinesCoalesced) ||
    !isNonNegativeInteger(setPropsCoalesced) ||
    !isNonNegativeInteger(insertChildCoalesced) ||
    !isFiniteNonNegativeNumber(durationMs)
  ) {
    return {
      valid: false,
      message: "metrics require six finite non-negative integer counters and a finite non-negative duration",
    };
  }
  if (
    inputPatchCount !== outputPatchCount + coalescedCount ||
    appendLinesCoalesced + setPropsCoalesced + insertChildCoalesced > inputPatchCount
  ) {
    return { valid: false, message: "counter relationships do not reconcile or operation counts exceed input patches" };
  }
  return {
    valid: true,
    metrics: {
      inputPatchCount,
      outputPatchCount,
      coalescedCount,
      appendLinesCoalesced,
      setPropsCoalesced,
      insertChildCoalesced,
      durationMs,
    },
  };
}

type NormalizedFlushBatches = {
  batches: FlushBatchSample[] | null;
  validation: CoalescingBatchValidation;
};

function normalizeFlushBatches(
  rawBatches: unknown,
  totals: TelemetrySnapshot["coalescingTotals"],
): NormalizedFlushBatches {
  const totalsReportWork =
    totals !== null &&
    totals !== undefined &&
    (totals.input !== 0 ||
      totals.output !== 0 ||
      totals.coalesced !== 0 ||
      totals.appendLines !== 0 ||
      totals.setProps !== 0 ||
      totals.insertChild !== 0 ||
      totals.durationMs !== 0);
  if (rawBatches === null || rawBatches === undefined) {
    return {
      batches: null,
      validation: totalsReportWork
        ? { valid: false, message: "Reported coalescing work has no retained batch samples" }
        : { valid: true },
    };
  }
  if (!Array.isArray(rawBatches)) {
    return {
      batches: null,
      validation: { valid: false, message: "Retained flush batch telemetry is not an array" },
    };
  }
  const rawBatchCandidates: unknown[] = rawBatches;

  const batches: FlushBatchSample[] = [];
  const observedCounts = { input: 0, output: 0, coalesced: 0, appendLines: 0, setProps: 0, insertChild: 0 };
  const invalid = (message: string): NormalizedFlushBatches => ({
    batches: null,
    validation: { valid: false, message },
  });

  for (let index = 0; index < rawBatchCandidates.length; index += 1) {
    const candidate = rawBatchCandidates[index];
    if (!isTelemetryRecord(candidate)) {
      return invalid(`Retained flush batch ${index} is not an object`);
    }
    const patchCount = candidate.patchCount;
    if (!isNonNegativeInteger(patchCount) || patchCount < 1) {
      return invalid(`Retained flush batch ${index} has an invalid patch count`);
    }

    const rawMetrics = candidate.coalescing;
    let coalescing: CoalescingMetrics | null | undefined;
    if (rawMetrics === null || rawMetrics === undefined) {
      // The scheduler deliberately skips coalescing for singleton patch batches.
      if (patchCount !== 1) {
        return invalid(`Retained multi-patch batch ${index} is missing coalescing metrics`);
      }
      coalescing = rawMetrics;
    } else {
      const normalizedMetrics = normalizeCoalescingMetrics(rawMetrics);
      if (!normalizedMetrics.valid) {
        return invalid(`Retained coalescing batch ${index}: ${normalizedMetrics.message}`);
      }
      const metrics = normalizedMetrics.metrics;
      coalescing = metrics;
      observedCounts.input += metrics.inputPatchCount;
      observedCounts.output += metrics.outputPatchCount;
      observedCounts.coalesced += metrics.coalescedCount;
      observedCounts.appendLines += metrics.appendLinesCoalesced;
      observedCounts.setProps += metrics.setPropsCoalesced;
      observedCounts.insertChild += metrics.insertChildCoalesced;
    }

    const tx = candidate.tx === null ? null : finiteTelemetryNumber(candidate.tx);
    const appliedPatchCount = finiteTelemetryNumber(candidate.appliedPatchCount);
    const queueDelayMs = finiteTelemetryNumber(candidate.queueDelayMs);
    const durationMs = finiteTelemetryNumber(candidate.durationMs);
    const priority = candidate.priority === "high" || candidate.priority === "low" ? candidate.priority : undefined;
    const receivedAt = candidate.receivedAt === null ? null : finiteTelemetryNumber(candidate.receivedAt);
    const appliedAt = candidate.appliedAt === null ? null : finiteTelemetryNumber(candidate.appliedAt);
    const queueDepthBefore = finiteTelemetryNumber(candidate.queueDepthBefore);
    const remainingQueue = finiteTelemetryNumber(candidate.remainingQueue);
    const effectiveQueueDepth = finiteTelemetryNumber(candidate.effectiveQueueDepth);
    const flushStartedAt = finiteTelemetryNumber(candidate.flushStartedAt);
    const flushCompletedAt = finiteTelemetryNumber(candidate.flushCompletedAt);
    batches.push({
      tx,
      patchCount,
      appliedPatchCount,
      queueDelayMs,
      durationMs,
      priority,
      receivedAt,
      appliedAt,
      queueDepthBefore,
      remainingQueue,
      effectiveQueueDepth,
      flushStartedAt,
      flushCompletedAt,
      coalescing,
    });
  }
  if (batches.length === 0 && totalsReportWork) {
    return invalid("Reported coalescing work has no retained batch samples");
  }

  if (
    !isNonNegativeInteger(observedCounts.input) ||
    !isNonNegativeInteger(observedCounts.output) ||
    !isNonNegativeInteger(observedCounts.coalesced) ||
    !isNonNegativeInteger(observedCounts.appendLines) ||
    !isNonNegativeInteger(observedCounts.setProps) ||
    !isNonNegativeInteger(observedCounts.insertChild)
  ) {
    return invalid("Retained coalescing batch counters cannot be summed as finite non-negative integers");
  }
  if (
    totals &&
    isNonNegativeInteger(totals.input) &&
    isNonNegativeInteger(totals.output) &&
    isNonNegativeInteger(totals.coalesced) &&
    isNonNegativeInteger(totals.appendLines) &&
    isNonNegativeInteger(totals.setProps) &&
    isNonNegativeInteger(totals.insertChild) &&
    (observedCounts.input > totals.input ||
      observedCounts.output > totals.output ||
      observedCounts.coalesced > totals.coalesced ||
      observedCounts.appendLines > totals.appendLines ||
      observedCounts.setProps > totals.setProps ||
      observedCounts.insertChild > totals.insertChild)
  ) {
    return invalid("Retained coalescing batch counters exceed the reported aggregate totals");
  }

  return { batches, validation: { valid: true } };
}

function collectCoalescingDurations(batches?: FlushBatchSample[] | null): number[] {
  if (!Array.isArray(batches)) return [];
  const durations: number[] = [];
  for (const batch of batches) {
    if (batch.coalescing) durations.push(batch.coalescing.durationMs);
  }
  return durations;
}

function normalizeTelemetrySnapshot(raw: RawTelemetrySnapshot | null): TelemetrySnapshot | null {
  if (!raw) return null;

  const ensureArray = (value: number[] | null | undefined): number[] =>
    value?.map((num) => Number(num)).filter((num) => Number.isFinite(num)) ?? [];
  const normalizedBatches = normalizeFlushBatches(raw.flushBatches, raw.coalescingTotals);

  return {
    summary: raw.summary,
    samples: {
      recvToFlushMs: ensureArray(raw.samples.recvToFlushMs),
      flushApplyMs: ensureArray(raw.samples.flushApplyMs),
      reactCommitMs: ensureArray(raw.samples.reactCommitMs),
      paintMs: ensureArray(raw.samples.paintMs),
      queueDepth: ensureArray(raw.samples.queueDepth),
      patchApplyMs: ensureArray(raw.samples.patchApplyMs),
      longTasksMs: ensureArray(raw.samples.longTasksMs),
    },
    worker: raw.worker ?? null,
    workerTotals: raw.workerTotals ?? null,
    stream: raw.stream ?? null,
    patchTotals: raw.patchTotals ?? null,
    coalescingTotals: raw.coalescingTotals ?? null,
    flushBatches: normalizedBatches.batches,
    coalescingBatchValidation: normalizedBatches.validation,
  };
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
      typeof batch.queueDelayMs === "number" && Number.isFinite(batch.queueDelayMs) ? batch.queueDelayMs : "",
      typeof batch.durationMs === "number" && Number.isFinite(batch.durationMs) ? batch.durationMs : "",
      metrics.inputPatchCount,
      metrics.outputPatchCount,
      metrics.coalescedCount,
      metrics.appendLinesCoalesced,
      metrics.setPropsCoalesced,
      metrics.insertChildCoalesced,
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
    input += metrics.inputPatchCount;
    output += metrics.outputPatchCount;
    coalesced += metrics.coalescedCount;
    appendLines += metrics.appendLinesCoalesced;
    setProps += metrics.setPropsCoalesced;
    insertChild += metrics.insertChildCoalesced;
    durationTotal += metrics.durationMs;
    durations.push(metrics.durationMs);
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
    durationMsAvg: durationTotal / batchesWithMetrics,
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


function evaluateCoalescingGuardrails(snippetName: string, analysis: SnippetAnalysis["analysis"], telemetry: TelemetrySnapshot | null): void {
  const issues = analysis.issues;
  const totals = telemetry?.coalescingTotals;
  const batchValidation = telemetry?.coalescingBatchValidation;
  if (!totals) {
    recordCoalescingGuardrailResult(
      snippetName,
      "coalescing/totals/missing",
      "fail",
      "Coalescing totals unavailable",
      issues,
    );
  } else {
    const counts = [totals.input, totals.output, totals.coalesced, totals.appendLines, totals.setProps, totals.insertChild];
    const countsAreValid = counts.every(isNonNegativeInteger);
    const durationIsValid = isFiniteNonNegativeNumber(totals.durationMs);
    if (!countsAreValid || !durationIsValid) {
      recordCoalescingGuardrailResult(
        snippetName,
        "coalescing/totals/invalid",
        "fail",
        "Coalescing totals must contain non-negative integer counts and a finite non-negative duration",
        issues,
      );
    } else if (
      totals.input !== totals.output + totals.coalesced ||
      totals.appendLines + totals.setProps + totals.insertChild > totals.input
    ) {
      recordCoalescingGuardrailResult(
        snippetName,
        "coalescing/totals/inconsistent",
        "fail",
        "Coalescing totals do not reconcile input and output counts or operation counts exceed input patches",
        issues,
      );
    }
  }
  if (batchValidation && !batchValidation.valid) {
    recordCoalescingGuardrailResult(
      snippetName,
      "coalescing/batches/invalid",
      "fail",
      batchValidation.message,
      issues,
    );
  }


  if (MAX_COALESCING_DURATION_P95_MS > 0 && batchValidation?.valid !== false) {
    const durations = collectCoalescingDurations(telemetry?.flushBatches ?? null);
    if (durations.length === 0) {
      const noWork =
        totals?.input === 0 &&
        totals.output === 0 &&
        totals.coalesced === 0 &&
        totals.appendLines === 0 &&
        totals.setProps === 0 &&
        totals.insertChild === 0 &&
        totals.durationMs === 0;
      recordCoalescingGuardrailResult(
        snippetName,
        noWork ? "coalescing/duration/not-applicable" : "coalescing/duration/no-samples",
        noWork ? "warn" : "fail",
        noWork
          ? "No coalescing work was recorded; its duration guard is not applicable"
          : "No duration samples are available for reported or unverified coalescing work",
        issues,
      );
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
type SnippetRuntimeState = {
  idx: number;
  total: number;
  isRunning: boolean;
  mode: "classic" | "worker";
  schedulingPreset?: "latency" | "throughput";
  rate: number;
  tickMs: number;
  finished?: boolean;
  isFinalizing?: boolean;
  timerActive?: boolean;
  streamLimit?: number | null;
  fullTextLength?: number;
  workerSentIdx?: number;
};

type SnippetWorkerRun = {
  workerId: number;
  generation: number;
};

async function rejectIncompleteRun(
  page: Page,
  snippetName: string,
  phase: string,
  expected: { rate: number; tickMs: number; sourceMode: "worker" | "server"; workerRun: SnippetWorkerRun | null },
  cause: unknown,
): Promise<never> {
  const diagnostic = await page
    .evaluate((details) => {
      const root = window as typeof window &
        PerfWindow & {
          __TEST_SNIPPET_CONFIG__?: { initialMdxStrategy?: "server" | "worker" };
        };
      const api = root.__STREAMING_DEMO__ as StreamingDemoAutomationApiV2 | undefined;
      const state = api?.getState?.() as (Record<string, unknown> & {
        workerSentIdx?: number;
        total?: number;
      }) | undefined;
      const observer = root.__STREAM_MDX_WORKER_LIFECYCLE__;
      const rendererState = api?.getHandle?.()?.getState?.() as
        | { queueDepth?: number; pendingBatches?: number }
        | undefined;
      const store = root.__STREAMING_RENDERER_STORE__;
      const perf = api?.getPerf?.() ?? null;
      const flushBatches = perf?.flushBatches ?? [];
      const latestFlushBatch = flushBatches[flushBatches.length - 1];
      const output = document.querySelector('[data-testid="markdown-output"]');
      return {
        phase: details.phase,
        expected: details.expected,
        sourceMode: root.__TEST_SNIPPET_CONFIG__?.initialMdxStrategy ?? null,
        state: state ?? null,
        currentWorkerId: observer?.workerIdFor(api?.getWorker?.() ?? null) ?? null,
        workerLifecycle: observer?.events ?? [],
        renderer: {
          queueDepth: rendererState?.queueDepth ?? null,
          pendingBatches: rendererState?.pendingBatches ?? null,
          remainingQueue: latestFlushBatch?.remainingQueue ?? null,
          remainingSource: state && typeof state.total === "number" && typeof state.workerSentIdx === "number"
            ? Math.max(0, state.total - state.workerSentIdx)
            : null,
          blocks: store?.getBlocks?.().map((block) => ({
            id: block.id,
            type: block.type,
            isFinalized: block.isFinalized,
          })) ?? [],
        },
        perf,
        partialHtml: output?.outerHTML ?? null,
      };
    }, { phase, expected })
    .catch((captureError: unknown) => ({
      phase,
      expected,
      captureError: captureError instanceof Error ? captureError.message : String(captureError),
    }));
  const diagnosticPath = path.join(
    OUTPUT_DIR,
    `${path.basename(snippetName, path.extname(snippetName))}.incomplete.json`,
  );
  await fs.writeFile(diagnosticPath, JSON.stringify(diagnostic, null, 2), "utf-8");
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  throw new Error(`[analyze] ${snippetName} did not complete during ${phase}: ${causeMessage}. Diagnostics: ${diagnosticPath}`);
}

async function waitForSnippetWorker(
  page: Page,
  afterSequence: number,
  requireNewGeneration: boolean,
  timeoutMs: number,
): Promise<SnippetWorkerRun> {
  const options = { afterSequence, requireNewGeneration };
  await page.waitForFunction(
    ({ afterSequence: after, requireNewGeneration: requireNew }) => {
      const api = window.__STREAMING_DEMO__;
      const observer = (window as PerfWindow).__STREAM_MDX_WORKER_LIFECYCLE__;
      if (!api || !observer) return false;
      const workerId = observer.workerIdFor(api.getWorker?.() ?? null);
      if (workerId === null) return false;
      const init = [...observer.events].reverse().find(
        (event) =>
          event.workerId === workerId &&
          event.direction === "input" &&
          event.type === "INIT" &&
          event.generation !== null &&
          (!requireNew || event.sequence > after),
      );
      if (!init || init.generation === null) return false;
      return observer.events.some(
        (event) =>
          event.workerId === workerId &&
          event.generation === init.generation &&
          event.direction === "output" &&
          event.type === "INITIALIZED",
      );
    },
    options,
    { timeout: timeoutMs },
  );
  return await page.evaluate((waitOptions) => {
    const api = window.__STREAMING_DEMO__;
    const observer = (window as PerfWindow).__STREAM_MDX_WORKER_LIFECYCLE__;
    if (!api || !observer) throw new Error("Worker lifecycle observer disappeared after initialization.");
    const workerId = observer.workerIdFor(api.getWorker?.() ?? null);
    if (workerId === null) throw new Error("Current streaming worker has no observed identity.");
    const init = [...observer.events].reverse().find(
      (event) =>
        event.workerId === workerId &&
        event.direction === "input" &&
        event.type === "INIT" &&
        event.generation !== null &&
        (!waitOptions.requireNewGeneration || event.sequence > waitOptions.afterSequence),
    );
    if (!init || init.generation === null) throw new Error("Current streaming worker INIT generation was not observed.");
    return { workerId, generation: init.generation };
  }, options);
}

async function renderSnippet(
  page: Page,
  snippetContent: string,
  options?: { traceFast?: boolean; streamLimit?: number; workerLifecycleScript?: string; snippetName?: string },
): Promise<{ html: string; telemetry: TelemetrySnapshot | null; state: RuntimeStateSnapshot }> {
  const minVisibleLength = Math.min(10, Math.max(1, normalizeWhitespace(snippetContent).length));
  const diagnosticSnippetName = options?.snippetName ?? "snippet";
  const compileMode: "worker" | "server" =
    process.env.MDX_COMPILE_MODE && process.env.MDX_COMPILE_MODE.toLowerCase() === "worker" ? "worker" : "server";
  if (!options?.traceFast) {
    if (!options?.workerLifecycleScript) {
      throw new Error("Snippet worker lifecycle observer bundle was not provided.");
    }
    await page.addInitScript({ content: options.workerLifecycleScript });
  }
  await page.addInitScript(
    ({ content, config }) => {
      const runtimeWindow = window as typeof window & {
        __TEST_SNIPPET_CONTENT__?: string;
        __TEST_SNIPPET_CONFIG__?: {
          initialStreamLimit?: number | null;
          initialIsRunning?: boolean;
          initialMdxStrategy?: "server" | "worker";
        };
      };
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
            initialIsRunning: false,
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
  await page.waitForFunction(
    () => typeof window.__STREAMING_DEMO__ !== "undefined" && window.__STREAMING_DEMO__?.getState !== undefined,
    undefined,
    { timeout: 30000 },
  );


  let workerRun: SnippetWorkerRun | null = null;
  const resolvedRate = Math.min(20_000, Math.max(50, Math.round(STREAM_RATE)));
  const resolvedTickMs = Math.min(200, Math.max(1, Math.round(STREAM_TICK_MS)));
  if (options?.traceFast) {
    await page.evaluate(async () => {
      const api = window.__STREAMING_DEMO__;
      if (!api) return;
      await api.waitForWorker?.();
    });
  } else {
    try {
      workerRun = await waitForSnippetWorker(page, 0, false, INITIAL_RENDER_TIMEOUT_MS);
      const presetChange = await page.evaluate((preset) => {
        const root = window as typeof window &
          PerfWindow & {
            __TEST_SNIPPET_CONFIG__?: { initialMdxStrategy?: "server" | "worker" };
          };
        const api = root.__STREAMING_DEMO__;
        const state = api?.getState?.() as Record<string, unknown> | undefined;
        const observer = root.__STREAM_MDX_WORKER_LIFECYCLE__;
        if (!api || !state || !observer) {
          throw new Error("Streaming API or worker lifecycle observer is unavailable during configuration.");
        }
        if (root.__TEST_SNIPPET_CONFIG__?.initialMdxStrategy === undefined) {
          throw new Error("Snippet source mode was not configured before hydration.");
        }
        if (typeof api.setMode !== "function" || typeof api.setSchedulingPreset !== "function") {
          throw new Error("Streaming API does not expose mode and scheduling-preset configuration.");
        }
        api.setMode("worker");
        const changed = state.schedulingPreset !== preset;
        const boundary = observer.sequence;
        if (changed) api.setSchedulingPreset(preset);
        return { changed, boundary };
      }, SCHEDULING_PRESET);
      await page.waitForFunction(
        ({ sourceMode, preset }) => {
          const root = window as typeof window & {
            __TEST_SNIPPET_CONFIG__?: { initialMdxStrategy?: "server" | "worker" };
          };
          const state = window.__STREAMING_DEMO__?.getState?.() as Record<string, unknown> | undefined;
          return Boolean(
            state &&
              state.mode === "worker" &&
              state.schedulingPreset === preset &&
              root.__TEST_SNIPPET_CONFIG__?.initialMdxStrategy === sourceMode,
          );
        },
        { sourceMode: compileMode, preset: SCHEDULING_PRESET },
        { timeout: INITIAL_RENDER_TIMEOUT_MS },
      );
      if (presetChange.changed) {
        workerRun = await waitForSnippetWorker(page, presetChange.boundary, true, INITIAL_RENDER_TIMEOUT_MS);
      }

      await page.evaluate(({ rate, tickMs }) => {
        const api = window.__STREAMING_DEMO__;
        if (!api || typeof api.setRate !== "function" || typeof api.setTick !== "function") {
          throw new Error("Streaming API does not expose rate and tick configuration.");
        }
        api.setRate(rate);
        api.setTick(tickMs);
      }, { rate: resolvedRate, tickMs: resolvedTickMs });
      await page.waitForFunction(
        ({ sourceMode, preset, rate, tickMs, total, workerId, generation }) => {
          const root = window as typeof window &
            PerfWindow & {
              __TEST_SNIPPET_CONFIG__?: { initialMdxStrategy?: "server" | "worker" };
            };
          const api = root.__STREAMING_DEMO__;
          const state = api?.getState?.() as SnippetRuntimeState | undefined;
          const observer = root.__STREAM_MDX_WORKER_LIFECYCLE__;
          if (
            !api ||
            !state ||
            !observer ||
            state.mode !== "worker" ||
            state.schedulingPreset !== preset ||
            state.rate !== rate ||
            state.tickMs !== tickMs ||
            state.idx !== 0 ||
            state.total !== total ||
            state.fullTextLength !== total ||
            state.streamLimit !== null ||
            state.workerSentIdx !== 0 ||
            state.isRunning !== false ||
            root.__TEST_SNIPPET_CONFIG__?.initialMdxStrategy !== sourceMode ||
            observer.workerIdFor(api.getWorker?.() ?? null) !== workerId
          ) {
            return false;
          }
          return observer.events.some(
            (event) =>
              event.workerId === workerId &&
              event.generation === generation &&
              event.direction === "output" &&
              event.type === "INITIALIZED",
          );
        },
        {
          sourceMode: compileMode,
          preset: SCHEDULING_PRESET,
          rate: resolvedRate,
          tickMs: resolvedTickMs,
          total: snippetContent.length,
          workerId: workerRun.workerId,
          generation: workerRun.generation,
        },
        { timeout: INITIAL_RENDER_TIMEOUT_MS },
      );
      await page.evaluate(() => {
        const api = window.__STREAMING_DEMO__;
        if (!api || typeof api.resume !== "function") {
          throw new Error("Streaming API does not expose resume after configuration.");
        }
        api.resume();
      });
      // The source starts paused so configuration is observable at idx=0.
      // First content can only be required after resume.
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
    } catch (error) {
      await rejectIncompleteRun(
        page,
        diagnosticSnippetName,
        "stream setup",
        { rate: resolvedRate, tickMs: resolvedTickMs, sourceMode: compileMode, workerRun },
        error,
      );
    }
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

  if (options?.traceFast) {
    await page.evaluate(async () => {
      const api = window.__STREAMING_DEMO__;
      if (!api) return;
      await api.fastForward?.();
      await api.flushPending?.();
    });
  } else {
        const run = workerRun;
        if (!run) {
          await rejectIncompleteRun(
            page,
            diagnosticSnippetName,
            "worker identity resolution",
            { rate: resolvedRate, tickMs: resolvedTickMs, sourceMode: compileMode, workerRun },
            new Error("Current worker identity was not resolved before streaming."),
          );
        }
        try {
          await page.waitForFunction(
            ({ workerId, generation, total }) => {
              const api = window.__STREAMING_DEMO__;
              const state = api?.getState?.() as SnippetRuntimeState | undefined;
              const observer = (window as PerfWindow).__STREAM_MDX_WORKER_LIFECYCLE__;
              return Boolean(
                api &&
                  state &&
                  observer &&
                  observer.workerIdFor(api.getWorker?.() ?? null) === workerId &&
                  state.finished === true &&
                  state.timerActive === false &&
                  state.idx === total &&
                  state.total === total &&
                  state.fullTextLength === total &&
                  state.streamLimit === null &&
                  typeof state.workerSentIdx === "number" &&
                  state.workerSentIdx >= total &&
                  observer.events.some(
                    (event) =>
                      event.workerId === workerId &&
                      event.generation === generation &&
                      event.direction === "output" &&
                      event.type === "INITIALIZED",
                  ),
              );
            },
            { ...run, total: snippetContent.length },
            { timeout: STREAM_COMPLETE_TIMEOUT_MS },
          );
        } catch (error) {
          await rejectIncompleteRun(
            page,
            diagnosticSnippetName,
            "source EOF",
            { rate: resolvedRate, tickMs: resolvedTickMs, sourceMode: compileMode, workerRun: run },
            error,
          );
        }

        try {
          await page.waitForFunction(
            ({ workerId, generation, total }) => {
              const api = window.__STREAMING_DEMO__;
              const state = api?.getState?.() as SnippetRuntimeState | undefined;
              const observer = (window as PerfWindow).__STREAM_MDX_WORKER_LIFECYCLE__;
              if (
                !api ||
                !state ||
                !observer ||
                observer.workerIdFor(api.getWorker?.() ?? null) !== workerId ||
                state.finished !== true ||
                state.timerActive !== false ||
                state.isFinalizing !== false ||
                state.idx !== total ||
                state.total !== total ||
                state.fullTextLength !== total ||
                state.streamLimit !== null ||
                typeof state.workerSentIdx !== "number" ||
                state.workerSentIdx < total
              ) {
                return false;
              }
              const events = observer.events;
              const initialized = events.find(
                (event) =>
                  event.workerId === workerId &&
                  event.generation === generation &&
                  event.direction === "output" &&
                  event.type === "INITIALIZED",
              );
              if (!initialized) return false;
              const finalizeSent = events.find(
                (event) =>
                  event.sequence > initialized.sequence &&
                  event.workerId === workerId &&
                  event.generation === generation &&
                  event.direction === "input" &&
                  event.type === "FINALIZE",
              );
              if (!finalizeSent) return false;
              const finalized = events.some(
                (event) =>
                  event.sequence > finalizeSent.sequence &&
                  event.workerId === workerId &&
                  event.generation === generation &&
                  event.direction === "output" &&
                  event.type === "FINALIZED",
              );
              if (!finalized) return false;
              const rendererState = api.getHandle?.()?.getState?.() as
                | { queueDepth?: number; pendingBatches?: number }
                | undefined;
              if (!rendererState || rendererState.queueDepth !== 0 || rendererState.pendingBatches !== 0) {
                return false;
              }
              const store = window.__STREAMING_RENDERER_STORE__;
              if (store && typeof store.getBlocks === "function") {
                const blocks = store.getBlocks();
                if (blocks.length > 0 && !blocks.every((block) => block.isFinalized === true)) return false;
              }
              return !document.querySelector(".streaming-partial");
            },
            { ...run, total: snippetContent.length },
            { timeout: FINALIZE_TIMEOUT_MS },
          );
        } catch (error) {
          await rejectIncompleteRun(
            page,
            diagnosticSnippetName,
            "worker finalization and renderer queue drain",
            { rate: resolvedRate, tickMs: resolvedTickMs, sourceMode: compileMode, workerRun: run },
            error,
          );
        }
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
  const rawTelemetry = await page.evaluate<RawTelemetrySnapshot | null>(() => {
    const api = window.__STREAMING_DEMO__;
    if (!api || typeof api.getPerf !== "function") {
      return null;
    }
    const perf = api.getPerf();
    if (!perf) return null;
    const state = api.getState?.();

    return {
      summary: perf.summary,
      samples: perf.samples,
      worker: perf.worker ?? null,
      workerTotals: perf.workerTotals ?? null,
      stream: perf.stream ?? null,
      patchTotals: state?.patchStats?.totals ?? null,
      coalescingTotals: perf.coalescingTotals ?? null,
      flushBatches: perf.flushBatches ?? null,
    };
  });
  const telemetry = normalizeTelemetrySnapshot(rawTelemetry);
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

function buildTraceFocus(content: string): LookaheadTraceFocus | null {
  if (!TRACE_SURFACE && !TRACE_FEATURE_FAMILY && TRACE_START_OFFSET === null && !TRACE_FROM_PATTERN) {
    return null;
  }
  const normalizedPattern = TRACE_FROM_PATTERN?.replace(/\\\\/g, "\\") ?? null;
  let startOffset = TRACE_START_OFFSET;
  if (startOffset === null && normalizedPattern) {
    const idx = content.indexOf(normalizedPattern);
    startOffset = idx >= 0 ? idx : null;
  }
  return {
    surface: TRACE_SURFACE ?? undefined,
    featureFamily: TRACE_FEATURE_FAMILY ?? undefined,
    pattern: normalizedPattern ?? undefined,
    startOffset: startOffset ?? undefined,
    windowBefore: TRACE_WINDOW_BEFORE,
    windowAfter: TRACE_WINDOW_AFTER,
  };
}

function applyTraceFocus(prefixLengths: number[], contentLength: number, focus: LookaheadTraceFocus | null): number[] {
  if (!focus || typeof focus.startOffset !== "number") {
    return prefixLengths;
  }
  const min = Math.max(1, focus.startOffset - (focus.windowBefore ?? 0));
  const max = Math.min(contentLength, focus.startOffset + (focus.windowAfter ?? 0));
  const selected = prefixLengths.filter((length) => length >= min && length <= max);
  if (!selected.includes(max)) selected.push(max);
  if (!selected.includes(contentLength)) selected.push(contentLength);
  return [...new Set(selected)].sort((a, b) => a - b);
}

function describeTraceFocus(focus: LookaheadTraceFocus | null): string | null {
  if (!focus) return null;
  const parts: string[] = [];
  if (focus.surface) parts.push(`surface-${focus.surface}`);
  if (focus.featureFamily) parts.push(`family-${focus.featureFamily}`);
  if (typeof focus.startOffset === "number") parts.push(`offset-${focus.startOffset}`);
  else if (focus.pattern) parts.push("pattern");
  return parts.length > 0 ? parts.join("__").replace(/[^a-zA-Z0-9._-]+/g, "-") : "focused";
}

function summarizeLookaheadDecisions(steps: LookaheadTraceStep[]) {
  const providerCounts: Record<string, number> = {};
  const surfaceCounts: Record<string, number> = {};
  const featureFamilyCounts: Record<string, number> = {};
  const terminationCounts: Record<string, number> = {};
  const downgradeCounts: Record<string, number> = {};

  for (const step of steps) {
    for (const block of step.blocks ?? []) {
      for (const decision of [...(block.inlineLookahead ?? []), ...(block.mixedLookahead ?? [])]) {
        providerCounts[decision.providerId] = (providerCounts[decision.providerId] ?? 0) + 1;
        surfaceCounts[decision.surface] = (surfaceCounts[decision.surface] ?? 0) + 1;
        if (decision.featureFamily) {
          featureFamilyCounts[decision.featureFamily] = (featureFamilyCounts[decision.featureFamily] ?? 0) + 1;
        }
        if (decision.termination?.reason) {
          terminationCounts[decision.termination.reason] = (terminationCounts[decision.termination.reason] ?? 0) + 1;
        }
        if (decision.downgrade?.mode) {
          downgradeCounts[decision.downgrade.mode] = (downgradeCounts[decision.downgrade.mode] ?? 0) + 1;
        }
      }
    }
  }

  return { providerCounts, surfaceCounts, featureFamilyCounts, terminationCounts, downgradeCounts };
}

function collectMathTraceEntries(steps: LookaheadTraceStep[]) {
  const entries: Array<{
    stepIndex: number;
    prefixLength: number;
    blockId: string;
    providerId: string;
    surface: string;
    featureFamily?: string;
    decision: string;
    validation?: unknown;
    termination?: unknown;
    downgrade?: unknown;
    analysis: NonNullable<NonNullable<LookaheadDecisionTrace["analysis"]>["math"]>;
  }> = [];

  for (const step of steps) {
    for (const block of step.blocks ?? []) {
      const decisions = [...(block.inlineLookahead ?? []), ...(block.mixedLookahead ?? [])];
      for (const decision of decisions) {
        if (!decision.analysis?.math) continue;
        entries.push({
          stepIndex: step.stepIndex,
          prefixLength: step.prefixLength,
          blockId: block.id,
          providerId: decision.providerId,
          surface: decision.surface,
          featureFamily: decision.featureFamily,
          decision: decision.decision,
          validation: decision.validation,
          termination: decision.termination,
          downgrade: decision.downgrade,
          analysis: decision.analysis.math,
        });
      }
    }
  }

  return entries;
}

function buildStepDecisionSummary(step: LookaheadTraceStep): NonNullable<LookaheadTraceStep["decisionSummary"]> {
  const providerCounts: Record<string, number> = {};
  const surfaceCounts: Record<string, number> = {};
  const featureFamilyCounts: Record<string, number> = {};
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
      surfaceCounts[decision.surface] = (surfaceCounts[decision.surface] ?? 0) + 1;
      if (decision.featureFamily) {
        featureFamilyCounts[decision.featureFamily] = (featureFamilyCounts[decision.featureFamily] ?? 0) + 1;
      }
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
    surfaceCounts,
    featureFamilyCounts,
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

async function writeLookaheadTrace(browser: Browser, snippetName: string): Promise<void> {
  const snippetContent = await readSnippet(snippetName);
  const traceFocus = buildTraceFocus(snippetContent);
  const prefixLengths = applyTraceFocus(buildTracePrefixLengths(snippetContent, TRACE_MODE, TRACE_MAX_STEPS), snippetContent.length, traceFocus);
  const slug = snippetName.replace(/\.[^.]+$/, "");
  const focusSlug = describeTraceFocus(traceFocus);
  const traceRoot = path.join(LOOKAHEAD_TRACE_DIR, `${slug}-${TRACE_MODE}${focusSlug ? `-${focusSlug}` : ""}`);
  const htmlDir = path.join(traceRoot, "html");
  const stepsDir = path.join(traceRoot, "steps");
  const failuresDir = path.join(traceRoot, "failures");
  await fs.rm(traceRoot, { recursive: true, force: true });
  await fs.mkdir(htmlDir, { recursive: true });
  await fs.mkdir(stepsDir, { recursive: true });
  await fs.mkdir(failuresDir, { recursive: true });

  const summary = {
    generatedAt: new Date().toISOString(),
    snippet: snippetName,
    mode: TRACE_MODE,
    totalSteps: prefixLengths.length,
    lengths: prefixLengths,
    focus: traceFocus,
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
        focus: traceFocus ?? undefined,
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
  const firstProviderActivation =
    traceSteps.find((step) => (step.decisionSummary?.totalDecisions ?? 0) > 0)?.stepIndex ?? null;
  const firstTermination =
    traceSteps.find((step) => Object.keys(step.decisionSummary?.terminationCounts ?? {}).length > 0)?.stepIndex ?? null;
  const firstDowngrade =
    traceSteps.find((step) => Object.keys(step.decisionSummary?.downgradeCounts ?? {}).length > 0)?.stepIndex ?? null;
  const firstFinalizedStep =
    traceSteps.find((step) => (step.blocks ?? []).some((block) => block.isFinalized))?.stepIndex ?? null;

  await fs.writeFile(
    path.join(traceRoot, "trace-summary.json"),
    JSON.stringify(
      {
        ...summary,
        firstRenderableStep,
        firstProviderActivation,
        firstTermination,
        firstDowngrade,
        firstFinalizedStep,
        aggregate: aggregateSummary,
      },
      null,
      2,
    ),
    "utf-8",
  );
  await fs.writeFile(path.join(traceRoot, "trace.ndjson"), `${traceSteps.map((step) => JSON.stringify(step)).join("\n")}\n`, "utf-8");
  await fs.writeFile(
    path.join(traceRoot, "focus-summary.json"),
    JSON.stringify(
      {
        snippet: snippetName,
        mode: TRACE_MODE,
        focus: traceFocus,
        capturedWindow: {
          firstPrefixLength: prefixLengths[0] ?? 0,
          lastPrefixLength: prefixLengths[prefixLengths.length - 1] ?? 0,
          totalSteps: prefixLengths.length,
        },
        firstProviderActivation,
        firstTermination,
        firstDowngrade,
        aggregate: aggregateSummary,
      },
      null,
      2,
    ),
    "utf-8",
  );
  const mathEntries = collectMathTraceEntries(traceSteps);
  await fs.writeFile(
    path.join(traceRoot, "math-tail-analysis.json"),
    JSON.stringify(
      mathEntries.map((entry) => ({
        stepIndex: entry.stepIndex,
        prefixLength: entry.prefixLength,
        blockId: entry.blockId,
        providerId: entry.providerId,
        surface: entry.surface,
        featureFamily: entry.featureFamily,
        mode: entry.analysis.mode,
        family: entry.analysis.family,
        unsupportedReason: entry.analysis.unsupportedReason ?? null,
        tokens: entry.analysis.tokens ?? [],
        obligations: entry.analysis.obligations ?? [],
        checkpoints: entry.analysis.checkpoints ?? [],
      })),
      null,
      2,
    ),
    "utf-8",
  );
  await fs.writeFile(
    path.join(traceRoot, "math-candidates.json"),
    JSON.stringify(
      mathEntries.map((entry) => ({
        stepIndex: entry.stepIndex,
        prefixLength: entry.prefixLength,
        blockId: entry.blockId,
        decision: entry.decision,
        featureFamily: entry.featureFamily,
        selectedCandidate: entry.analysis.selectedCandidate ?? null,
        candidates: entry.analysis.candidates ?? [],
        comparison: entry.analysis.comparison ?? null,
        checkpoints: entry.analysis.checkpoints ?? [],
      })),
      null,
      2,
    ),
    "utf-8",
  );
  await fs.writeFile(
    path.join(traceRoot, "math-validation.json"),
    JSON.stringify(
      mathEntries.map((entry) => ({
        stepIndex: entry.stepIndex,
        prefixLength: entry.prefixLength,
        blockId: entry.blockId,
        featureFamily: entry.featureFamily,
        validation: entry.validation ?? null,
        downgrade: entry.downgrade ?? null,
      })),
      null,
      2,
    ),
    "utf-8",
  );
  await fs.writeFile(
    path.join(traceRoot, "latch-rearm.json"),
    JSON.stringify(
      mathEntries.map((entry) => ({
        stepIndex: entry.stepIndex,
        prefixLength: entry.prefixLength,
        blockId: entry.blockId,
        featureFamily: entry.featureFamily,
        termination: entry.termination ?? null,
      })),
      null,
      2,
    ),
    "utf-8",
  );
  const firstDivergence =
    traceSteps.find((step) => {
      const diff = step.diffFromPrevious;
      return Boolean(diff && (diff.firstDecisionChangeBlockId !== null || diff.htmlChanged));
    }) ?? null;
  await fs.writeFile(
    path.join(failuresDir, "first-divergence.json"),
    JSON.stringify(
      firstDivergence
        ? {
            snippet: snippetName,
            mode: TRACE_MODE,
            stepIndex: firstDivergence.stepIndex,
            prefixLength: firstDivergence.prefixLength,
            diffFromPrevious: firstDivergence.diffFromPrevious,
            decisionSummary: firstDivergence.decisionSummary,
            blocks: firstDivergence.blocks,
            htmlPath: firstDivergence.htmlPath,
            telemetryPath: firstDivergence.telemetryPath,
          }
        : {
            snippet: snippetName,
            mode: TRACE_MODE,
            stepIndex: null,
            note: "no divergence within captured steps",
          },
      null,
      2,
    ),
    "utf-8",
  );

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
        recvToFlush: null,
        flushApply: null,
        reactCommit: null,
        paint: null,
        queueDepth: null,
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

async function analyzeSnippet(browser: Browser, snippetName: string, workerLifecycleScript: string): Promise<SnippetAnalysis> {
  console.log(`[analyze] Processing ${snippetName}...`);
  const snippetContent = await readSnippet(snippetName);
  const page = await browser.newPage();

  try {
    const { html: renderedHtml, telemetry } = await renderSnippet(page, snippetContent, {
      workerLifecycleScript,
      snippetName,
    });
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

  const workerLifecycleScript = (
    await build({
      entryPoints: [fileURLToPath(new URL("./perf/demo-worker-lifecycle-browser.ts", import.meta.url))],
      platform: "browser",
      bundle: true,
      write: false,
      format: "iife",
      keepNames: false,
      target: "es2020",
    })
  ).outputFiles[0].text;
  const browser = await chromium.launch({ headless: true });
  const results: SnippetAnalysis[] = [];
  const snippetArtifacts: Array<{ snippet: string; htmlPath: string }> = [];
  let guardrailSummary: GuardrailSummary | null = null;

  try {
    for (const snippet of snippets) {
      const result = await analyzeSnippet(browser, snippet, workerLifecycleScript);
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
    try {
      await browser.close();
    } finally {
      if (guardrailSummary === null) {
        guardrailSummary = buildGuardrailSummary();
        await fs.writeFile(GUARDRAIL_SUMMARY_PATH, JSON.stringify(guardrailSummary, null, 2), "utf-8");
        if (results.length > 0) {
          await fs.writeFile(path.join(OUTPUT_DIR, "analysis-partial-report.json"), JSON.stringify(results, null, 2), "utf-8");
        }
      }
    }
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
