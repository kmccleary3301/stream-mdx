// Web Worker for V2 Markdown parsing and enrichment
// Handles Lezer parsing, inline processing, and syntax highlighting

import "./worker-dom-stub";

import type {
  Block,
  CompiledMdxModule,
  InlineNode,
  NodeSnapshot,
  Patch,
  PatchMetrics,
  PerformanceMetrics,
  ProtectedRange,
  WorkerErrorPayload,
  WorkerIn,
  WorkerOut,
  WorkerPhase,
} from "@stream-mdx/core";

import type { Tree } from "@lezer/common";
import { parser as mdParser } from "@lezer/markdown";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { createHighlighter } from "shiki";

import {
  PATCH_ROOT_ID,
  PerformanceTimer,
  blocksStructurallyEqual,
  cloneBlock,
  createBlockSnapshot,
  detectMDX,
  extractMixedContentSegments,
  generateBlockId,
  normalizeBlockquoteText,
  parseCodeFenceInfo,
  removeHeadingMarkers,
} from "@stream-mdx/core";
import { InlineParser, dedentIndentedCode, sanitizeHtmlInWorker, stripCodeFence } from "@stream-mdx/core";
import { computeHeavyPatchBudget } from "@stream-mdx/core";
import { isHeavyPatch } from "@stream-mdx/core/perf/patch-batching";
import { CalloutsPlugin, HTMLBlockPlugin, MDXDetectionPlugin, TablesPlugin, globalDocumentPluginRegistry, registerFootnotesPlugin } from "@stream-mdx/plugins";
import type { DocumentState } from "@stream-mdx/plugins/document";
import { isBlockLevelNode, mapLezerNodeToBlockType } from "./parser/block-types";
import { computeParagraphPatchLimit } from "./perf/patch-heuristics";

// Worker state
let highlighter: Awaited<ReturnType<typeof createHighlighter>> | null = null;
let blocks: Block[] = [];
let lastTree: Tree | null = null;
let currentContent = "";
let inlineParser: InlineParser;
let performanceTimer: PerformanceTimer;
const documentPluginState: DocumentState = {};
let txCounter = 0;
const workerGrammarEngine: "js" | "wasm" = "js";
let workerCredits = 1;
const MAX_DEFERRED_PATCHES = 400;
let deferredPatchQueue: Patch[] = [];
const MAX_DEFERRED_FLUSH_PATCHES = 120;
const CODE_HIGHLIGHT_CACHE = new Map<string, { html: string; lang: string }>();
const MAX_CODE_HIGHLIGHT_CACHE_ENTRIES = 200;
type WorkerMdxMode = "server" | "worker";
let mdxCompileMode: WorkerMdxMode = "server";
const WORKER_MDX_CACHE = new Map<string, CompiledMdxModule>();
const WORKER_MDX_INFLIGHT = new Map<string, Promise<CompiledMdxModule>>();
const MAX_WORKER_MDX_CACHE_ENTRIES = 128;
let loggedMdxSkipCount = 0;
const MAX_MDX_SKIP_LOGS = 20;

// Debug toggles (controlled via env or global flag to avoid noisy consoles in dev)
function isDebugEnabled(flag: "mdx" | "worker"): boolean {
  try {
    if (typeof process !== "undefined" && process.env) {
      if (flag === "mdx" && process.env.NEXT_PUBLIC_STREAMING_DEBUG_MDX === "1") return true;
      if (flag === "worker" && process.env.NEXT_PUBLIC_STREAMING_DEBUG_WORKER === "1") return true;
    }
  } catch {
    // ignore env read errors
  }
  try {
    const g = globalThis as { __STREAMING_DEBUG__?: { mdx?: boolean; worker?: boolean } };
    if (flag === "mdx" && g.__STREAMING_DEBUG__?.mdx) return true;
    if (flag === "worker" && g.__STREAMING_DEBUG__?.worker) return true;
  } catch {
    // ignore global read errors
  }
  return false;
}
const DEBUG_MDX = isDebugEnabled("mdx");

const sharedTextEncoder: TextEncoder | null = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

class WorkerMetricsCollector {
  private readonly grammarEngine: "js" | "wasm";
  private readonly startedAt: number;
  private parseStart: number | null = null;
  private diffStart: number | null = null;
  private serializeStart: number | null = null;
  private tx?: number;

  parseMs = 0;
  enrichMs = 0;
  diffMs = 0;
  serializeMs = 0;
  shikiMs = 0;
  mdxDetectMs = 0;
  patchBytes = 0;
  patchCount = 0;
  queueDepth = 0;
  blocksProduced = 0;
  private readonly blockTypeCounts = new Map<string, number>();
  private readonly blockTypeDurations = new Map<string, number>();
  private readonly blockTypeSizes = new Map<string, number>();
  private readonly highlightByLanguage = new Map<string, { time: number; count: number }>();
  appendLineBatchCount = 0;
  appendLineTotalLines = 0;
  appendLineMaxLines = 0;

  constructor(grammarEngine: "js" | "wasm") {
    this.grammarEngine = grammarEngine;
    this.startedAt = now();
  }

  markParseStart(): void {
    this.parseStart = now();
  }

  markParseEnd(): void {
    if (this.parseStart === null) return;
    this.parseMs += Math.max(0, now() - this.parseStart);
    this.parseStart = null;
  }

  recordEnrich(duration: number | null | undefined): void {
    if (!Number.isFinite(duration ?? Number.NaN)) return;
    this.enrichMs += Math.max(0, Number(duration));
  }

  recordShiki(duration: number | null | undefined): void {
    if (!Number.isFinite(duration ?? Number.NaN)) return;
    this.shikiMs += Math.max(0, Number(duration));
  }

  recordMdxDetect(duration: number | null | undefined): void {
    if (!Number.isFinite(duration ?? Number.NaN)) return;
    this.mdxDetectMs += Math.max(0, Number(duration));
  }

  countBlockType(type: string): void {
    if (!type) return;
    this.blockTypeCounts.set(type, (this.blockTypeCounts.get(type) ?? 0) + 1);
  }

  recordBlockSize(type: string, size: number | null | undefined): void {
    if (!type || !Number.isFinite(size ?? Number.NaN)) return;
    const current = this.blockTypeSizes.get(type) ?? 0;
    this.blockTypeSizes.set(type, current + Math.max(0, Number(size)));
  }

  recordBlockEnrich(type: string, duration: number | null | undefined): void {
    if (!type || !Number.isFinite(duration ?? Number.NaN)) return;
    const previous = this.blockTypeDurations.get(type) ?? 0;
    this.blockTypeDurations.set(type, previous + Math.max(0, Number(duration)));
  }

  recordHighlightForLanguage(lang: string, duration: number | null | undefined): void {
    if (!lang || !Number.isFinite(duration ?? Number.NaN)) return;
    const entry = this.highlightByLanguage.get(lang) ?? { time: 0, count: 0 };
    entry.time += Math.max(0, Number(duration));
    entry.count += 1;
    this.highlightByLanguage.set(lang, entry);
  }

  recordAppendLines(lineCount: number | null | undefined): void {
    if (!Number.isFinite(lineCount ?? Number.NaN)) return;
    const normalized = Math.max(0, Math.floor(Number(lineCount)));
    if (normalized <= 0) return;
    this.appendLineBatchCount += 1;
    this.appendLineTotalLines += normalized;
    if (normalized > this.appendLineMaxLines) {
      this.appendLineMaxLines = normalized;
    }
  }

  markDiffStart(): void {
    this.diffStart = now();
  }

  markDiffEnd(): void {
    if (this.diffStart === null) return;
    this.diffMs += Math.max(0, now() - this.diffStart);
    this.diffStart = null;
  }

  beginSerialize(): void {
    this.serializeStart = now();
  }

  endSerialize(): void {
    if (this.serializeStart === null) return;
    this.serializeMs += Math.max(0, now() - this.serializeStart);
    this.serializeStart = null;
  }

  finalizePatch(tx: number, patchCount: number, queueDepth: number, patchBytes: number): void {
    this.tx = tx;
    this.patchCount = patchCount;
    this.queueDepth = queueDepth;
    this.patchBytes = patchBytes;
  }

  setBlocksProduced(count: number): void {
    this.blocksProduced = count;
  }

  toPatchMetrics(changedBlocks: number): PatchMetrics {
    return {
      patchCount: this.patchCount,
      changedBlocks,
      diffTime: roundMetric(this.diffMs),
      parseTime: roundMetric(this.parseMs),
      enrichTime: this.enrichMs ? roundMetric(this.enrichMs) : undefined,
      queueDepth: this.queueDepth || undefined,
      patchBytes: this.patchBytes || undefined,
      appendLineBatches: this.appendLineBatchCount || undefined,
      appendLineTotalLines: this.appendLineTotalLines || undefined,
      appendLineMaxLines: this.appendLineMaxLines || undefined,
    };
  }

  toPerformanceMetrics(): PerformanceMetrics {
    return {
      tx: this.tx,
      timestamp: this.startedAt,
      parseMs: roundMetric(this.parseMs),
      parseTime: roundMetric(this.parseMs),
      enrichMs: this.enrichMs ? roundMetric(this.enrichMs) : undefined,
      diffMs: this.diffMs ? roundMetric(this.diffMs) : undefined,
      serializeMs: this.serializeMs ? roundMetric(this.serializeMs) : undefined,
      highlightTime: this.shikiMs ? roundMetric(this.shikiMs) : undefined,
      shikiMs: this.shikiMs ? roundMetric(this.shikiMs) : undefined,
      mdxDetectMs: this.mdxDetectMs ? roundMetric(this.mdxDetectMs) : undefined,
      patchBytes: this.patchBytes || undefined,
      patchCount: this.patchCount || undefined,
      queueDepth: this.queueDepth || undefined,
      blocksProduced: this.blocksProduced || undefined,
      grammarEngine: this.grammarEngine,
      blockCountByType: mapToNumberRecord(this.blockTypeCounts),
      blockEnrichMsByType: mapToNumberRecord(this.blockTypeDurations, true),
      blockSizeByType: mapToNumberRecord(this.blockTypeSizes),
      highlightByLanguage: mapToHighlightRecord(this.highlightByLanguage),
      appendLineBatches: this.appendLineBatchCount || undefined,
      appendLineTotalLines: this.appendLineTotalLines || undefined,
      appendLineMaxLines: this.appendLineMaxLines || undefined,
    };
  }
}

let activeMetricsCollector: WorkerMetricsCollector | null = null;

function setActiveMetricsCollector(collector: WorkerMetricsCollector | null): void {
  activeMetricsCollector = collector;
}

function getActiveMetricsCollector(): WorkerMetricsCollector | null {
  return activeMetricsCollector;
}

function estimatePatchSize(patches: Patch[]): number {
  if (!sharedTextEncoder) return 0;
  try {
    return sharedTextEncoder.encode(JSON.stringify(patches)).length;
  } catch {
    return 0;
  }
}

function countChangedBlocksFromPatches(patches: Patch[]): number {
  if (!patches || patches.length === 0) return 0;
  const ids = new Set<string>();
  for (const patch of patches) {
    const blockId = patch.at?.blockId;
    if (blockId) {
      ids.add(blockId);
    }
  }
  return ids.size;
}

function partitionPatchesForCredits(patches: Patch[], maxImmediate?: number): Patch[] {
  let combined: Patch[] = patches;
  if (deferredPatchQueue.length > 0) {
    combined = deferredPatchQueue.concat(patches);
    deferredPatchQueue = [];
  }
  if (combined.length === 0) {
    return [];
  }

  const immediate: Patch[] = [];
  const deferred: Patch[] = [];

  let heavyBudget = computeHeavyPatchBudget(workerCredits);

  for (const patch of combined) {
    const heavy = isHeavyPatch(patch);
    if (heavy) {
      if (heavyBudget <= 0) {
        if (deferred.length < MAX_DEFERRED_PATCHES) {
          deferred.push(patch);
          continue;
        }
      } else {
        heavyBudget -= 1;
      }
    }
    immediate.push(patch);
  }

  if (typeof maxImmediate === "number" && immediate.length > maxImmediate) {
    const overflow = immediate.splice(maxImmediate);
    deferredPatchQueue = overflow.concat(deferred);
  } else {
    deferredPatchQueue = deferred;
  }
  return immediate;
}

function flushDeferredPatches() {
  if (workerCredits <= 0 || deferredPatchQueue.length === 0) {
    return;
  }
  const immediate = partitionPatchesForCredits([], MAX_DEFERRED_FLUSH_PATCHES);
  if (immediate.length === 0) {
    return;
  }

  const metricsCollector = new WorkerMetricsCollector(workerGrammarEngine);
  metricsCollector.setBlocksProduced(blocks.length);
  const tx = ++txCounter;
  const patchBytes = estimatePatchSize(immediate);
  metricsCollector.finalizePatch(tx, immediate.length, deferredPatchQueue.length, patchBytes);
  const changedBlocks = countChangedBlocksFromPatches(immediate);
  const patchMetrics = metricsCollector.toPatchMetrics(changedBlocks);

  postMessage({
    type: "PATCH",
    tx,
    patches: immediate,
    metrics: patchMetrics,
  } as WorkerOut);

  emitMetricsSample(metricsCollector);
  if (getActiveMetricsCollector() === metricsCollector) {
    setActiveMetricsCollector(null);
  }
}

function emitMetricsSample(collector: WorkerMetricsCollector | null): void {
  if (!collector) return;
  const metrics = collector.toPerformanceMetrics();
  if (!metrics) return;
  postMessage({
    type: "METRICS",
    metrics,
  } as WorkerOut);
}

function mapToNumberRecord(map: Map<string, number>, roundValues = false): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of map.entries()) {
    if (!Number.isFinite(value)) continue;
    if (value === 0) continue;
    result[key] = roundValues ? roundMetric(value) : value;
  }
  return result;
}

function mapToHighlightRecord(map: Map<string, { time: number; count: number }>): Record<string, { count: number; totalMs: number; avgMs: number }> {
  const result: Record<string, { count: number; totalMs: number; avgMs: number }> = {};
  for (const [key, value] of map.entries()) {
    if (!value || value.count <= 0 || !Number.isFinite(value.time)) continue;
    const total = roundMetric(value.time);
    result[key] = {
      count: value.count,
      totalMs: total,
      avgMs: roundMetric(total / value.count),
    };
  }
  return result;
}

/**
 * Safe inline parsing for streaming content that may have incomplete expressions
 */
function parseInlineStreamingSafe(content: string): InlineNode[] {
  // Fast parity checks (avoid regex allocations on hot path).
  let dollarCount = 0;
  let backtickCount = 0;
  let starCount = 0;
  let doubleStarCount = 0;

  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    // '$'
    if (code === 36) {
      dollarCount += 1;
      continue;
    }
    // '`'
    if (code === 96) {
      backtickCount += 1;
      continue;
    }
    // '*'
    if (code === 42) {
      if (i + 1 < content.length && content.charCodeAt(i + 1) === 42) {
        doubleStarCount += 1;
        starCount += 2;
        i += 1;
      } else {
        starCount += 1;
      }
    }
  }

  const hasIncompleteMath = dollarCount % 2 !== 0;
  if (hasIncompleteMath) {
    return [{ kind: "text", text: content }];
  }

  const hasIncompleteCode = backtickCount % 2 !== 0;
  const hasIncompleteStrong = doubleStarCount % 2 !== 0;
  const singleStarCount = starCount - doubleStarCount * 2;
  const hasIncompleteEmphasis = singleStarCount % 2 !== 0;

  if (hasIncompleteCode || hasIncompleteStrong || hasIncompleteEmphasis) {
    return [{ kind: "text", text: content }];
  }

  // Safe to parse with full inline parser; avoid caching intermediate streaming states.
  return inlineParser.parse(content, { cache: false });
}

/**
 * Initialize the worker
 */
async function initialize(
  initialContent = "",
  prewarmLangs: string[] = [],
  docPlugins?: {
    footnotes?: boolean;
    html?: boolean;
    mdx?: boolean;
    tables?: boolean;
    callouts?: boolean;
    math?: boolean;
  },
  mdxOptions?: { compileMode?: WorkerMdxMode },
) {
  performanceTimer = new PerformanceTimer();
  inlineParser = new InlineParser();
  // Make inline parser available to document plugins (e.g., for footnote definition parsing)
  documentPluginState.inlineParser = inlineParser;
  blocks = [];
  lastTree = null;
  currentContent = "";
  deferredPatchQueue = [];

  mdxCompileMode = mdxOptions?.compileMode ?? "server";
  try {
    // Helpful telemetry for demo/dev runs to confirm how MDX is compiled.
    if (DEBUG_MDX) {
      console.debug("[markdown-worker] init", { mdxCompileMode });
    }
  } catch {
    // ignore logging errors
  }
  clearWorkerMdxCaches();

  // Register document-phase plugins (once) based on flags
  const enable = {
    footnotes: docPlugins?.footnotes ?? true,
    html: docPlugins?.html ?? true,
    mdx: docPlugins?.mdx ?? true,
    tables: docPlugins?.tables ?? true,
    callouts: docPlugins?.callouts ?? false,
    math: docPlugins?.math ?? true,
  };

  if (enable.footnotes) registerFootnotesPlugin();
  if (enable.tables) globalDocumentPluginRegistry.register(TablesPlugin);
  if (enable.callouts) globalDocumentPluginRegistry.register(CalloutsPlugin);
  if (enable.html) globalDocumentPluginRegistry.register(HTMLBlockPlugin);
  if (enable.mdx) globalDocumentPluginRegistry.register(MDXDetectionPlugin);

  performanceTimer.mark("highlighter-init");

  // Core languages that should always be available
  const coreLangs = ["javascript", "typescript", "json", "text", "markdown"];
  const initialLangs = [...coreLangs, ...prewarmLangs];

  // Initialize Shiki with JS engine for browser compatibility
  highlighter = await createHighlighter({
    engine: createJavaScriptRegexEngine(),
    langs: initialLangs,
    themes: ["github-dark", "github-light"],
  });

  const highlighterTime = performanceTimer.measure("highlighter-init");

  // Parse initial content if provided
  if (initialContent) {
    currentContent = initialContent;
    const result = await parseAll(initialContent);
    blocks = result.blocks;
    lastTree = result.lastTree;
  }

  txCounter = 0;
  postMessage({
    type: "INITIALIZED",
    blocks,
  } as WorkerOut);

  if (blocks.length > 0) {
    await emitDocumentPatch(blocks);
  }
}

/**
 * Handle append operations for streaming
 */
async function handleAppend(text: string) {
  performanceTimer.mark("append-operation");

  const metricsCollector = new WorkerMetricsCollector(workerGrammarEngine);
  setActiveMetricsCollector(metricsCollector);

  await appendAndReparse(text, metricsCollector);
  const hadPatchMetrics = metricsCollector.patchCount > 0;

  const totalTime = performanceTimer.measure("append-operation");

  if (getActiveMetricsCollector() === metricsCollector) {
    setActiveMetricsCollector(null);
  }

  // Maintain legacy parse timing for compatibility
  if (!hadPatchMetrics && totalTime !== null && Number.isFinite(totalTime)) {
    postMessage({
      type: "METRICS",
      metrics: {
        parseMs: roundMetric(totalTime),
        parseTime: roundMetric(totalTime),
        blocksProduced: blocks.length,
        grammarEngine: workerGrammarEngine,
      } as PerformanceMetrics,
    } as WorkerOut);
  }
}

/**
 * Parse entire content (for initialization or static rendering)
 */
type ParseOptions = {
  /**
   * Treat all blocks as finalized for enrichment + document plugins.
   * Used by FINALIZE so the tail block runs full inline parsing and
   * synthetic document-phase plugins (e.g. footnotes) can append blocks.
   */
  forceFinalize?: boolean;
};

async function parseAll(content: string, options: ParseOptions = {}): Promise<{ blocks: Block[]; lastTree: Tree }> {
  performanceTimer.mark("parse-all");
  const metrics = getActiveMetricsCollector();
  metrics?.markParseStart();

  const tree = mdParser.parse(content);
  let extractedBlocks = await extractBlocks(tree, content, options);

  // Run document-phase plugins for aggregation and synthetic blocks
  extractedBlocks = runDocumentPlugins(extractedBlocks, content);

  performanceTimer.measure("parse-all");
  metrics?.markParseEnd();
  metrics?.setBlocksProduced(extractedBlocks.length);

  return {
    blocks: extractedBlocks,
    lastTree: tree,
  };
}

/**
 * Incremental parsing with Lezer fragments
 */
async function appendAndReparse(appendedText: string, metrics?: WorkerMetricsCollector): Promise<void> {
  performanceTimer.mark("incremental-parse");
  metrics?.markParseStart();

  const newContent = currentContent + appendedText;
  const changeRanges = computeChangedRanges(currentContent, newContent);

  // Use Lezer incremental parsing with fragments
  const newTree = lastTree ? mdParser.parse(newContent, lastTree.fragments) : mdParser.parse(newContent);

  // Find the changed region
  let changedBlocks = await extractBlocks(newTree, newContent);
  changedBlocks = runDocumentPlugins(changedBlocks, newContent);
  const prevBlocks = blocks;

  // Update our state
  blocks = changedBlocks;
  lastTree = newTree;
  currentContent = newContent;

  performanceTimer.measure("incremental-parse");
  metrics?.markParseEnd();
  metrics?.setBlocksProduced(blocks.length);

  await emitBlockDiffPatches(prevBlocks, changedBlocks, changeRanges, metrics);

  // Legacy UPDATE message is no longer emitted; patch batches cover all updates.
}

/**
 * Extract blocks from Lezer tree with fallback
 */
async function extractBlocks(tree: Tree, content: string, options: ParseOptions = {}): Promise<Block[]> {
  try {
    const blocks: Block[] = [];
    const cursor = tree.cursor();

    // Only consider top-level children of the document node
    if (cursor.firstChild()) {
      do {
        const nodeType = cursor.type.name;
        const from = cursor.from;
        const to = cursor.to;
        const raw = content.slice(from, to);

        if (isBlockLevelNode(nodeType)) {
          const blockType = mapLezerNodeToBlockType(nodeType);
          const block = await createBlock(blockType, raw, from, to, content, options);

          // Only add non-empty blocks
          if (block && raw.trim()) {
            blocks.push(block);
          }
        }
      } while (cursor.nextSibling());
    }

    // Fallback: if Lezer didn't extract any blocks, use simple line-based parsing
    if (blocks.length === 0) {
      return await extractBlocksSimple(content, options);
    }

    return blocks;
  } catch (error) {
    const details = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error;
    console.warn("Lezer parsing failed, falling back to simple parsing:", details);
    return await extractBlocksSimple(content, options);
  }
}

/**
 * Simple fallback block extraction
 */
async function extractBlocksSimple(content: string, options: ParseOptions = {}): Promise<Block[]> {
  const blocks: Block[] = [];
  const lines = content.split("\n");
  let currentParagraph: string[] = [];
  let currentPos = 0;

  const finalizeParagraph = async () => {
    if (currentParagraph.length > 0) {
      const raw = currentParagraph.join("\n");
      const from = currentPos - raw.length;
      const to = currentPos;

      // Determine block type
      let blockType = "paragraph";
      if (raw.match(/^#{1,6}\s+/)) {
        blockType = "heading";
      } else if (raw.match(/^```/)) {
        blockType = "code";
      } else if (raw.match(/^>/)) {
        blockType = "blockquote";
      } else if (raw.match(/^[-*+]\s+|^\d+\.\s+/)) {
        blockType = "list";
      }

      const block = await createBlock(blockType, raw, from, to, content, options);
      if (block) {
        blocks.push(block);
      }
      currentParagraph = [];
    }
  };

  for (const line of lines) {
    currentPos += line.length + 1; // +1 for newline

    if (line.trim() === "") {
      await finalizeParagraph();
    } else {
      currentParagraph.push(line);
    }
  }

  // Finalize last paragraph
  await finalizeParagraph();

  return blocks;
}

/**
 * Check if Lezer node is block-level
 */
/**
 * Create a block with enrichment
 */
async function createBlock(type: string, raw: string, from: number, to: number, fullContent: string, options: ParseOptions = {}): Promise<Block | null> {
  if (!raw.trim()) return null;

  const id = generateBlockId(`${from}:${type}`, type);

  // Determine if this is the last block (dirty tail)
  const isFinalized = options.forceFinalize ? true : to < fullContent.length - 1;

  const block: Block = {
    id,
    type,
    isFinalized,
    payload: {
      raw,
      range: { from, to },
    },
  };

  // Apply enrichment based on block type
  await enrichBlock(block);

  return block;
}

/**
 * Enrich blocks with inline parsing, highlighting, etc.
 */
async function enrichBlock(block: Block) {
  performanceTimer.mark("enrich-block");
  const metrics = getActiveMetricsCollector();
  metrics?.countBlockType(block.type);
  const rawLength = typeof block.payload.raw === "string" ? block.payload.raw.length : 0;
  metrics?.recordBlockSize(block.type, rawLength);

  switch (block.type) {
    case "heading": {
      const rawHeading = typeof block.payload.raw === "string" ? block.payload.raw : "";
      const normalizedHeading = removeHeadingMarkers(rawHeading);
      const headingLevel = Math.min(Math.max(rawHeading.match(/^#{1,6}/)?.[0].length ?? 1, 1), 6);
      block.payload.meta = {
        ...(block.payload.meta ?? {}),
        headingLevel,
        headingText: normalizedHeading,
      };
      if (block.isFinalized) {
        block.payload.raw = normalizedHeading;
        block.payload.inline = inlineParser.parse(normalizedHeading);
      } else {
        block.payload.inline = parseInlineStreamingSafe(normalizedHeading);
      }
      break;
    }

    case "blockquote": {
      const normalized = normalizeBlockquoteText(block.payload.raw ?? "");
      block.payload.raw = normalized;
      const segments = extractMixedContentSegments(normalized, undefined, (value) => inlineParser.parse(value));
      const currentMeta = (block.payload.meta ?? {}) as Record<string, unknown>;
      const nextMeta: Record<string, unknown> = {
        ...currentMeta,
        normalizedText: normalized,
      };
      if (segments.length > 0) {
        nextMeta.mixedSegments = segments;
      } else {
        nextMeta.mixedSegments = undefined;
      }
      if (Object.keys(nextMeta).length > 0) {
        block.payload.meta = nextMeta;
      } else {
        block.payload.meta = undefined;
      }

      if (block.isFinalized) {
        block.payload.inline = inlineParser.parse(normalized);
      } else {
        block.payload.inline = parseInlineStreamingSafe(normalized);
      }
      break;
    }

    case "paragraph": {
      const rawParagraph = typeof block.payload.raw === "string" ? block.payload.raw : "";
      // Parse inline content, but be careful with incomplete expressions during streaming
      const inlineParse = block.isFinalized ? (value: string) => inlineParser.parse(value) : parseInlineStreamingSafe;
      block.payload.inline = inlineParse(rawParagraph);

      const currentMeta = (block.payload.meta ?? {}) as Record<string, unknown>;
      const nextMeta: Record<string, unknown> = { ...currentMeta };
      let metaChanged = false;

      const mathRanges = collectMathProtectedRanges(rawParagraph);
      if (mathRanges.length > 0) {
        nextMeta.protectedRanges = mathRanges;
        metaChanged = true;
      } else if (Object.prototype.hasOwnProperty.call(nextMeta, "protectedRanges")) {
        nextMeta.protectedRanges = undefined;
        metaChanged = true;
      }

      const shouldExtractSegments = typeof rawParagraph === "string" && (rawParagraph.includes("<") || rawParagraph.includes("{"));
      if (shouldExtractSegments) {
        const baseOffset = typeof block.payload.range?.from === "number" ? block.payload.range.from : undefined;
        const segments = extractMixedContentSegments(rawParagraph, baseOffset, (value) => inlineParse(value));
        if (segments.length > 0) {
          nextMeta.mixedSegments = segments;
          metaChanged = true;
        } else if (Object.prototype.hasOwnProperty.call(nextMeta, "mixedSegments")) {
          nextMeta.mixedSegments = undefined;
          metaChanged = true;
        }
      } else if (Object.prototype.hasOwnProperty.call(nextMeta, "mixedSegments")) {
        nextMeta.mixedSegments = undefined;
        metaChanged = true;
      }

      if (metaChanged) {
        if (Object.keys(nextMeta).length > 0) {
          block.payload.meta = nextMeta;
        } else {
          block.payload.meta = undefined;
        }
      } else if (!block.payload.meta || Object.keys(block.payload.meta).length === 0) {
        block.payload.meta = undefined;
      }
      break;
    }

    case "code":
      await enrichCodeBlock(block);
      break;

    case "html": {
      const sanitized = sanitizeHtmlInWorker(block.payload.raw);
      block.payload.sanitizedHtml = sanitized;
      block.payload.meta = { ...(block.payload.meta || {}), sanitized: true };
      break;
    }

    case "list":
      enrichListBlock(block);
      break;
  }

  // Check for MDX content (paragraph and HTML blocks can both carry MDX/JSX)
  if (block.type === "paragraph" || block.type === "html") {
    const maybeMeta = block.payload.meta as Record<string, unknown> | undefined;
    const protectedRanges = Array.isArray(maybeMeta?.protectedRanges) ? (maybeMeta?.protectedRanges as ProtectedRange[]) : undefined;
    const blockRange = block.payload.range;
    const baseOffset = typeof blockRange?.from === "number" ? blockRange.from : 0;
    const normalizedRanges =
      protectedRanges && protectedRanges.length > 0
        ? protectedRanges.map((range) => ({
            ...range,
            from: baseOffset + range.from,
            to: baseOffset + range.to,
          }))
        : undefined;
    const mdxOptions =
      normalizedRanges && normalizedRanges.length > 0 ? { protectedRanges: normalizedRanges, baseOffset } : baseOffset ? { baseOffset } : undefined;
    const mdxDetectStart = now();
    let shouldConvertToMDX = detectMDX(block.payload.raw, mdxOptions);
    metrics?.recordMdxDetect(now() - mdxDetectStart);
    if (shouldConvertToMDX && protectedRanges && protectedRanges.length > 0) {
      const exprPattern = /\{[^{}]+\}/g;
      let match: RegExpExecArray | null;
      while (true) {
        match = exprPattern.exec(block.payload.raw);
        if (match === null) {
          break;
        }
        const start = match.index;
        const end = start + match[0].length;
        const covered = protectedRanges.some((range) => range.from <= start && range.to >= end);
        if (!covered) {
          shouldConvertToMDX = true;
          break;
        }
        shouldConvertToMDX = false;
      }
    }
    if (shouldConvertToMDX) {
      if (DEBUG_MDX) {
        try {
          console.debug("[markdown-worker] mdx detected", { blockId: block.id, originalType: block.type });
        } catch {
          // ignore logging errors
        }
      }
      const originalType = block.type;
      block.payload.meta = { ...block.payload.meta, originalType };
      block.type = "mdx";
    } else if (DEBUG_MDX && loggedMdxSkipCount < MAX_MDX_SKIP_LOGS) {
      if (block.payload.raw && block.payload.raw.includes("<Preview")) {
        loggedMdxSkipCount += 1;
        try {
          console.debug("[markdown-worker] mdx detection skipped", {
            blockId: block.id,
            originalType: block.type,
            len: block.payload.raw.length,
            protected: Array.isArray((block.payload.meta as any)?.protectedRanges) ? (block.payload.meta as any).protectedRanges.length : 0,
            sample: block.payload.raw.slice(0, 120),
          });
        } catch {
          // ignore logging errors
        }
      }
    }
  }

  await updateMdxCompilationState(block);

  const enrichDuration = performanceTimer.measure("enrich-block");
  metrics?.recordEnrich(enrichDuration);
  metrics?.recordBlockEnrich(block.type, enrichDuration);
}

function collectMathProtectedRanges(content: string): ProtectedRange[] {
  if (!content) return [];
  const ranges: ProtectedRange[] = [];
  const inlineStack: number[] = [];
  const displayStack: number[] = [];
  const length = content.length;

  let i = 0;
  while (i < length) {
    const char = content[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char !== "$") {
      i++;
      continue;
    }

    const isDouble = i + 1 < length && content[i + 1] === "$";
    if (isDouble) {
      if (displayStack.length > 0) {
        const start = displayStack.pop() as number;
        ranges.push({ from: start, to: i + 2, kind: "math-display" });
      } else {
        displayStack.push(i);
      }
      i += 2;
      continue;
    }

    if (inlineStack.length > 0) {
      const start = inlineStack.pop() as number;
      ranges.push({ from: start, to: i + 1, kind: "math-inline" });
    } else {
      inlineStack.push(i);
    }
    i++;
  }

  return ranges;
}

/**
 * Enrich code blocks with syntax highlighting
 */
async function enrichCodeBlock(block: Block) {
  performanceTimer.mark("highlight-code");
  const metrics = getActiveMetricsCollector();

  const raw = block.payload.raw ?? "";
  const { code, info, hadFence } = stripCodeFence(raw);
  const { lang, meta } = parseCodeFenceInfo(info);
  const requestedLanguage = lang || "text";
  const codeBody = hadFence ? code : dedentIndentedCode(raw);
  let resolvedLanguage = requestedLanguage;
  let cachedHighlight = getHighlightCacheEntry(requestedLanguage, codeBody);

  // Avoid expensive/highly-variable syntax highlighting while a code block is still streaming (dirty tail).
  // This keeps the worker from stalling on large/incomplete code fragments; highlighting is restored once finalized.
  if (!block.isFinalized) {
    block.payload.highlightedHtml = undefined;
    block.payload.meta = {
      ...meta,
      lang: resolvedLanguage,
    };
    return;
  }

  if (!cachedHighlight && highlighter && codeBody.trim()) {
    try {
      const loadedLangs = highlighter.getLoadedLanguages();
      if (!loadedLangs.includes(requestedLanguage)) {
        try {
          await highlighter.loadLanguage(requestedLanguage);
        } catch (loadError) {
          console.warn(`Failed to load language ${requestedLanguage}, falling back to text:`, loadError);
        }
      }

      resolvedLanguage = loadedLangs.includes(requestedLanguage) ? requestedLanguage : "text";
      const highlighted = highlighter.codeToHtml(codeBody, {
        lang: resolvedLanguage,
        themes: {
          dark: "github-dark",
          light: "github-light",
        },
        defaultColor: false,
      });

      const enhanced = enhanceHighlightedHtml(highlighted, resolvedLanguage);
      block.payload.highlightedHtml = enhanced;
      setHighlightCacheEntry(resolvedLanguage, codeBody, enhanced);
      if (resolvedLanguage !== requestedLanguage) {
        setHighlightCacheEntry(requestedLanguage, codeBody, enhanced);
      }
      cachedHighlight = getHighlightCacheEntry(resolvedLanguage, codeBody);
    } catch (error) {
      console.warn("Highlighting failed for", requestedLanguage, error);
      resolvedLanguage = "text";
    }
  }

  if (cachedHighlight) {
    resolvedLanguage = cachedHighlight.lang;
    block.payload.highlightedHtml = cachedHighlight.html;
  }

  block.payload.meta = {
    ...meta,
    lang: resolvedLanguage,
  };

  const highlightDuration = performanceTimer.measure("highlight-code");
  metrics?.recordShiki(highlightDuration);
  metrics?.recordHighlightForLanguage(resolvedLanguage, highlightDuration);
}

function makeHighlightCacheKey(language: string, code: string): string {
  return `${language}::${code}`;
}

function getHighlightCacheEntry(language: string, code: string) {
  if (!language || !code) return null;
  return CODE_HIGHLIGHT_CACHE.get(makeHighlightCacheKey(language, code)) ?? null;
}

function setHighlightCacheEntry(language: string, code: string, html: string) {
  if (!language || !code || typeof html !== "string") return;
  const key = makeHighlightCacheKey(language, code);
  CODE_HIGHLIGHT_CACHE.set(key, { html, lang: language });
  if (CODE_HIGHLIGHT_CACHE.size > MAX_CODE_HIGHLIGHT_CACHE_ENTRIES) {
    const oldest = CODE_HIGHLIGHT_CACHE.keys().next().value;
    if (oldest) {
      CODE_HIGHLIGHT_CACHE.delete(oldest);
    }
  }
}

function enhanceHighlightedHtml(html: string, language: string): string {
  if (!html) return html;

  // Ensure per-line spans carry data-line attributes
  let lineIndex = 0;
  const withLineNumbers = html.replace(/<span class="line"/g, (match) => {
    if (/data-line="\d+"/.test(match)) {
      return match;
    }
    lineIndex += 1;
    return `${match} data-line="${lineIndex}"`;
  });

  // Enhance <code> attributes with language and theme metadata
  const enhancedCode = withLineNumbers.replace(/<code([^>]*)>/, (match, attrs) => {
    const attrMap = parseAttributeString(attrs);
    attrMap["data-language"] = language || "text";
    if (!attrMap["data-theme"]) {
      attrMap["data-theme"] = "github-dark github-light";
    }
    if (!attrMap.style) {
      attrMap.style = "display: grid;";
    } else if (!/display\s*:/.test(attrMap.style)) {
      attrMap.style = `${attrMap.style.trim().replace(/;$/, "")};display: grid;`;
    }
    return `<code${serializeAttributes(attrMap)}>`;
  });

  // Attach data-language to outer <pre> if missing
  return enhancedCode.replace(/<pre([^>]*)>/, (match, attrs) => {
    const attrMap = parseAttributeString(attrs);
    attrMap["data-language"] = language || "text";
    if (attrMap.tabindex !== undefined) {
      attrMap.tabindex = undefined;
    }
    attrMap.style = sanitizeShikiStyle(attrMap.style);
    if (attrMap.style === undefined || attrMap.style.length === 0) {
      attrMap.style = undefined;
    }
    return `<pre${serializeAttributes(attrMap)}>`;
  });
}

function parseAttributeString(fragment: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!fragment) return attrs;
  const regex = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while (true) {
    match = regex.exec(fragment);
    if (match === null) {
      break;
    }
    const [, name, value] = match;
    attrs[name] = value;
  }
  return attrs;
}

function serializeAttributes(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join("");
}

function sanitizeShikiStyle(style: string | undefined): string | undefined {
  const sanitized: string[] = [];

  if (style) {
    for (const rawEntry of style.split(";")) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      const separatorIndex = entry.indexOf(":");
      if (separatorIndex === -1) continue;
      const name = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();
      const lowerName = name.toLowerCase();

      if (lowerName.startsWith("background")) {
        continue;
      }

      if (lowerName === "--shiki-dark-bg" || lowerName === "--shiki-light-bg") {
        continue;
      }

      sanitized.push(`${name}:${value}`);
    }
  }

  // Always force transparent backgrounds so Shiki doesn't override surrounding palette.
  sanitized.push("--shiki-dark-bg: transparent");
  sanitized.push("--shiki-light-bg: transparent");

  return sanitized.length > 0 ? sanitized.join(";") : undefined;
}

function clearWorkerMdxCaches(): void {
  WORKER_MDX_CACHE.clear();
  WORKER_MDX_INFLIGHT.clear();
}

// MDX compile helper moved to a shared module so that worker and server-side
// compilation use the same remark/rehype pipeline.
import { compileMdxContent } from "./mdx-compile";

function cacheWorkerMdxModule(key: string, module: CompiledMdxModule): void {
  const stored: CompiledMdxModule = {
    ...module,
    dependencies: module.dependencies ? [...module.dependencies] : undefined,
  };
  if (!WORKER_MDX_CACHE.has(key) && WORKER_MDX_CACHE.size >= MAX_WORKER_MDX_CACHE_ENTRIES) {
    const oldest = WORKER_MDX_CACHE.keys().next().value;
    if (typeof oldest === "string") {
      WORKER_MDX_CACHE.delete(oldest);
    }
  }
  WORKER_MDX_CACHE.set(key, stored);
}

async function getOrCompileMdxModuleForBlock(block: Block): Promise<CompiledMdxModule> {
  const cacheKey = block.id;
  const cached = WORKER_MDX_CACHE.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      dependencies: cached.dependencies ? [...cached.dependencies] : undefined,
    };
  }

  const inflight = WORKER_MDX_INFLIGHT.get(cacheKey);
  if (inflight) {
    const result = await inflight;
    return {
      ...result,
      dependencies: result.dependencies ? [...result.dependencies] : undefined,
    };
  }

  const source = block.payload.raw ?? "";
  const compilePromise = (async () => {
    const { code, dependencies } = await compileMdxContent(source);
    const module: CompiledMdxModule = {
      id: `worker:${cacheKey}`,
      code,
      dependencies,
      source: "worker",
    };
    cacheWorkerMdxModule(cacheKey, module);
    return module;
  })();

  WORKER_MDX_INFLIGHT.set(cacheKey, compilePromise);
  try {
    const compiled = await compilePromise;
    return {
      ...compiled,
      dependencies: compiled.dependencies ? [...compiled.dependencies] : undefined,
    };
  } finally {
    WORKER_MDX_INFLIGHT.delete(cacheKey);
  }
}

async function updateMdxCompilationState(block: Block): Promise<void> {
  try {
    if (DEBUG_MDX) {
      console.debug("[markdown-worker] mdx update", { blockId: block.id, type: block.type, finalized: block.isFinalized, compileMode: mdxCompileMode });
    }
  } catch {
    // ignore logging errors
  }
  if (block.type !== "mdx") {
    if ("compiledMdxModule" in block.payload) {
      block.payload.compiledMdxModule = undefined;
    }
    return;
  }

  if (mdxCompileMode !== "worker") {
    if ("compiledMdxModule" in block.payload) {
      block.payload.compiledMdxModule = undefined;
    }
    return;
  }

  const baseMeta = (block.payload.meta ?? {}) as Record<string, unknown>;
  const pendingMeta: Record<string, unknown> = { ...baseMeta, mdxStatus: "pending" };
  if ("mdxError" in pendingMeta) {
    pendingMeta.mdxError = undefined;
  }
  block.payload.meta = pendingMeta;

  if (!block.isFinalized) {
    block.payload.compiledMdxModule = null;
    block.payload.compiledMdxRef = { id: "pending" };
    return;
  }

  try {
    const module = await getOrCompileMdxModuleForBlock(block);
    block.payload.compiledMdxModule = {
      ...module,
      dependencies: module.dependencies ? [...module.dependencies] : undefined,
    };
    block.payload.compiledMdxRef = { id: module.id };
    const nextMeta = {
      ...(block.payload.meta ?? {}),
      mdxStatus: "compiled",
    } as Record<string, unknown>;
    if ("mdxError" in nextMeta) {
      nextMeta.mdxError = undefined;
    }
    block.payload.meta = nextMeta;
    if (DEBUG_MDX) {
      try {
        console.debug("[markdown-worker] mdx compiled", { blockId: block.id, id: module.id, deps: module.dependencies?.length ?? 0 });
      } catch {
        // ignore logging errors
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "MDX compilation failed";
    block.payload.compiledMdxModule = null;
    block.payload.compiledMdxRef = undefined;
    const errorMeta = {
      ...(block.payload.meta ?? {}),
      mdxStatus: "error",
      mdxError: message,
    } as Record<string, unknown>;
    block.payload.meta = errorMeta;
    if (DEBUG_MDX) {
      try {
        console.error("[markdown-worker] mdx compile failed", { blockId: block.id, error: message });
      } catch {
        // ignore logging errors
      }
    }
  }
}

/**
 * Enrich list blocks
 */
function enrichListBlock(block: Block) {
  const lines = block.payload.raw.split("\n");
  const itemsRaw: string[] = [];
  let current: string[] | null = null;

  const bulletRe = /^[-*+]\s+(.*)$/;
  const orderedRe = /^\d+\.\s+(.*)$/;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const bare = trimmed.trimStart();
    const bulletMatch = bare.match(bulletRe);
    const orderedMatch = bare.match(orderedRe);

    if (bulletMatch || orderedMatch) {
      if (current) {
        itemsRaw.push(current.join("\n"));
      }
      const content = (bulletMatch ? bulletMatch[1] : orderedMatch?.[1]) ?? "";
      current = [content];
    } else if (current) {
      current.push(bare);
    }
  }

  if (current) {
    itemsRaw.push(current.join("\n"));
  }

  const items: InlineNode[][] = itemsRaw.map((raw) => inlineParser.parse(raw));
  const isOrdered = /^\d+\./.test(lines[0]?.trimStart() || "");
  block.payload.meta = { ordered: isOrdered, items };
}

/**
 * Run document-phase plugins (e.g., footnotes) to mutate blocks and append synthetic blocks.
 */
function runDocumentPlugins(inputBlocks: Block[], content: string): Block[] {
  // Work on a shallow copy to avoid accidental mutation of caller arrays
  const blocks = inputBlocks.slice();
  const aggregatedProtected: ProtectedRange[] = [];
  for (const block of blocks) {
    const meta = block.payload.meta as Record<string, unknown> | undefined;
    const rawRanges = Array.isArray(meta?.protectedRanges) ? (meta.protectedRanges as ProtectedRange[]) : undefined;
    if (!rawRanges || rawRanges.length === 0) continue;
    const base = typeof block.payload.range?.from === "number" ? block.payload.range.from : null;
    if (base === null) continue;
    for (const range of rawRanges) {
      if (typeof range.from !== "number" || typeof range.to !== "number") continue;
      aggregatedProtected.push({
        ...range,
        from: base + range.from,
        to: base + range.to,
      });
    }
  }

  const { syntheticBlocks } = globalDocumentPluginRegistry.run({
    content,
    blocks,
    state: documentPluginState,
    protectedRanges: aggregatedProtected,
  });

  // Ensure only one synthetic footnotes block at the end: remove previous existing footnotes block(s)
  const filtered = blocks.filter((b) => b.type !== "footnotes");
  if (syntheticBlocks && syntheticBlocks.length > 0) {
    const tail = filtered[filtered.length - 1];
    const hasDirtyTail = tail ? !tail.isFinalized : false;
    if (hasDirtyTail) {
      return filtered;
    }
    filtered.push(...syntheticBlocks);
  }
  return filtered;
}

/**
 * Find first changed block index
 */
function findFirstChangedBlock(oldBlocks: Block[], newBlocks: Block[]): number {
  let i = 0;
  while (i < Math.min(oldBlocks.length, newBlocks.length)) {
    const oldBlock = oldBlocks[i];
    const newBlock = newBlocks[i];
    const idChanged = oldBlock.id !== newBlock.id;
    const rawChanged = oldBlock.payload.raw !== newBlock.payload.raw;
    const finalChanged = oldBlock.isFinalized !== newBlock.isFinalized;
    if (idChanged || rawChanged || finalChanged) {
      break;
    }
    i++;
  }
  return i;
}

function isBlockLike(value: unknown): value is Block {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { id?: unknown; type?: unknown; payload?: unknown };
  if (typeof candidate.id !== "string" || typeof candidate.type !== "string") return false;
  return typeof candidate.payload === "object" && candidate.payload !== null;
}

async function enrichNestedCodeBlocks(snapshot: NodeSnapshot, allowHighlight: boolean): Promise<void> {
  if (!allowHighlight || !highlighter) {
    return;
  }
  const stack: NodeSnapshot[] = [snapshot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const props = (current.props ?? {}) as Record<string, unknown>;
    const maybeBlock = props.block;
    if (isBlockLike(maybeBlock) && maybeBlock.type === "code") {
      const block = cloneBlock(maybeBlock);
      const hasHighlight = typeof block.payload.highlightedHtml === "string" && block.payload.highlightedHtml.trim().length > 0;
      if (!hasHighlight) {
        await enrichCodeBlock(block);
        const updated = createBlockSnapshot(block);
        current.type = updated.type;
        current.props = updated.props;
        current.meta = updated.meta;
        current.range = updated.range;
        current.children = updated.children;
        continue;
      }
    }

    const children = current.children ?? [];
    for (let idx = children.length - 1; idx >= 0; idx--) {
      const child = children[idx];
      if (child) {
        stack.push(child);
      }
    }
  }
}

async function blockToNodeSnapshot(block: Block): Promise<NodeSnapshot> {
  const snapshot = createBlockSnapshot(cloneBlock(block));
  await enrichNestedCodeBlocks(snapshot, Boolean(block.isFinalized));
  return snapshot;
}

async function emitDocumentPatch(currentBlocks: Block[]) {
  const patches: Patch[] = [];
  for (let index = 0; index < currentBlocks.length; index++) {
    const block = currentBlocks[index];
    if (!block) continue;
    patches.push({
      op: "insertChild",
      at: { blockId: PATCH_ROOT_ID },
      index,
      node: await blockToNodeSnapshot(block),
    });
  }
  if (patches.length > 0) {
    postMessage({
      type: "PATCH",
      tx: ++txCounter,
      patches,
    } as WorkerOut);
  }
}

async function emitBlockDiffPatches(previousBlocks: Block[], nextBlocks: Block[], changedRanges: ContentChangeRange[], metrics?: WorkerMetricsCollector | null) {
  const patches: Patch[] = [];

  if (previousBlocks === nextBlocks) return;

  let prefix = 0;
  const maxPrefix = Math.min(previousBlocks.length, nextBlocks.length);
  while (prefix < maxPrefix && previousBlocks[prefix].id === nextBlocks[prefix].id) {
    prefix++;
  }

  let prevTail = previousBlocks.length - 1;
  let nextTail = nextBlocks.length - 1;
  while (prevTail >= prefix && nextTail >= prefix && previousBlocks[prevTail].id === nextBlocks[nextTail].id) {
    prevTail--;
    nextTail--;
  }

  const removeCount = prevTail >= prefix ? prevTail - prefix + 1 : 0;
  const addCount = nextTail >= prefix ? nextTail - prefix + 1 : 0;

  if (removeCount === addCount) {
    for (let offset = 0; offset < addCount; offset++) {
      const targetIndex = prefix + offset;
      patches.push({
        op: "replaceChild",
        at: { blockId: PATCH_ROOT_ID },
        index: targetIndex,
        node: await blockToNodeSnapshot(nextBlocks[targetIndex]),
      });
    }
  } else {
    for (let i = removeCount - 1; i >= 0; i--) {
      patches.push({
        op: "deleteChild",
        at: { blockId: PATCH_ROOT_ID },
        index: prefix + i,
      });
    }

    for (let offset = 0; offset < addCount; offset++) {
      const insertIndex = prefix + offset;
      const block = cloneBlock(nextBlocks[insertIndex]);
      patches.push({
        op: "insertChild",
        at: { blockId: PATCH_ROOT_ID },
        index: insertIndex,
        node: await blockToNodeSnapshot(block),
      });
    }
  }

  metrics?.markDiffStart();
  const { patches: contentPatches, changedBlockCount } = await diffBlockContent(previousBlocks, nextBlocks, changedRanges, metrics);
  metrics?.markDiffEnd();

  const combined = patches.concat(contentPatches);
  let paragraphLimit: number | null = null;
  if (workerCredits < 0.9) {
    const dynamicBase = workerCredits < 0.5 ? 48 : 96;
    const dynamicFinalize = workerCredits < 0.5 ? 40 : 64;
    paragraphLimit = computeParagraphPatchLimit(combined, {
      baseLimit: dynamicBase,
      finalizeLimit: dynamicFinalize,
    });
  }
  const immediatePatches = partitionPatchesForCredits(combined, paragraphLimit === null ? undefined : paragraphLimit);

  if (immediatePatches.length === 0) {
    if (metrics) {
      metrics.finalizePatch(txCounter, 0, deferredPatchQueue.length, 0);
      emitMetricsSample(metrics);
      if (getActiveMetricsCollector() === metrics) {
        setActiveMetricsCollector(null);
      }
    }
    return;
  }

  dispatchPatchBatch(immediatePatches, metrics);
}

function dispatchPatchBatch(patches: Patch[], metrics?: WorkerMetricsCollector | null) {
  if (!patches || patches.length === 0) {
    return;
  }

  const tx = ++txCounter;
  const patchBytes = metrics ? estimatePatchSize(patches) : 0;
  metrics?.finalizePatch(tx, patches.length, deferredPatchQueue.length, patchBytes);
  const changedBlockReport = countChangedBlocksFromPatches(patches);
  const patchMetrics: PatchMetrics = metrics
    ? metrics.toPatchMetrics(changedBlockReport)
    : {
        patchCount: patches.length,
        changedBlocks: changedBlockReport,
      };

  const message: WorkerOut = {
    type: "PATCH",
    tx,
    patches,
    metrics: patchMetrics,
  } as WorkerOut;

  metrics?.beginSerialize();
  postMessage(message);
  metrics?.endSerialize();
  emitMetricsSample(metrics ?? null);

  if (metrics && getActiveMetricsCollector() === metrics) {
    setActiveMetricsCollector(null);
  }
}

async function diffBlockContent(
  previousBlocks: Block[],
  nextBlocks: Block[],
  changedRanges: ContentChangeRange[],
  metrics?: WorkerMetricsCollector | null,
): Promise<{ patches: Patch[]; changedBlockCount: number }> {
  const patches: Patch[] = [];
  const prevMap = new Map(previousBlocks.map((block) => [block.id, block]));
  const changedBlockIds = collectChangedBlockIds(previousBlocks, nextBlocks, changedRanges);

  for (const nextBlock of nextBlocks) {
    const prevBlock = prevMap.get(nextBlock.id);
    if (!prevBlock) continue;
    if (prevBlock.type === "mdx" && nextBlock.type === "mdx") {
      preserveMdxMetadata(prevBlock, nextBlock);
    }
    if (changedBlockIds.size > 0 && !changedBlockIds.has(nextBlock.id) && blocksStructurallyEqual(prevBlock, nextBlock)) {
      continue;
    }
    if (changedBlockIds.size === 0 && blocksStructurallyEqual(prevBlock, nextBlock)) continue;

    if (nextBlock.type === "html") {
      const nextSanitized = nextBlock.payload.sanitizedHtml ?? sanitizeHtmlInWorker(nextBlock.payload.raw ?? "");
      const prevSanitized = prevBlock.payload.sanitizedHtml ?? "";
      if (prevSanitized !== nextSanitized || prevBlock.payload.raw !== nextBlock.payload.raw) {
        const cloned = cloneBlock(nextBlock);
        cloned.payload.sanitizedHtml = nextSanitized;
        patches.push({
          op: "setHTML",
          at: { blockId: nextBlock.id },
          html: nextSanitized,
          policy: "markdown-renderer-v2",
          block: cloned,
          meta: nextBlock.payload.meta ? { ...nextBlock.payload.meta } : undefined,
          sanitized: true,
        });
      }
      continue;
    }

    const prevSnapshot = await blockToNodeSnapshot(prevBlock);
    const nextSnapshot = await blockToNodeSnapshot(nextBlock);
    diffNodeSnapshot(nextBlock.id, prevSnapshot, nextSnapshot, patches, metrics);
  }

  return { patches, changedBlockCount: changedBlockIds.size };
}

function preserveMdxMetadata(previous: Block, next: Block) {
  const prevRaw = previous.payload.raw ?? "";
  const nextRaw = next.payload.raw ?? "";
  if (prevRaw !== nextRaw) {
    return;
  }

  if (previous.payload.compiledMdxRef && !next.payload.compiledMdxRef) {
    next.payload.compiledMdxRef = { ...previous.payload.compiledMdxRef };
  }
  if (previous.payload.compiledMdxModule && !next.payload.compiledMdxModule) {
    next.payload.compiledMdxModule = {
      ...previous.payload.compiledMdxModule,
      dependencies: previous.payload.compiledMdxModule.dependencies ? [...previous.payload.compiledMdxModule.dependencies] : undefined,
    };
  } else if (previous.payload.compiledMdxModule === null && typeof next.payload.compiledMdxModule === "undefined") {
    next.payload.compiledMdxModule = null;
  }

  const prevMeta = (previous.payload.meta ?? null) as {
    mdxStatus?: unknown;
    mdxError?: unknown;
  } | null;
  if (!prevMeta) {
    return;
  }

  const currentMeta = (next.payload.meta ?? undefined) as { mdxStatus?: unknown; mdxError?: unknown } | undefined;
  const mergedMeta: Record<string, unknown> = currentMeta ? { ...currentMeta } : {};
  let metaChanged = false;

  if (typeof prevMeta.mdxStatus === "string" && mergedMeta.mdxStatus === undefined) {
    mergedMeta.mdxStatus = prevMeta.mdxStatus;
    metaChanged = true;
  }

  if (typeof prevMeta.mdxError === "string" && mergedMeta.mdxError === undefined) {
    mergedMeta.mdxError = prevMeta.mdxError;
    metaChanged = true;
  }

  if (metaChanged || !currentMeta) {
    next.payload.meta = mergedMeta;
  }
}

function diffNodeSnapshot(blockId: string, prevNode: NodeSnapshot, nextNode: NodeSnapshot, patches: Patch[], metrics?: WorkerMetricsCollector | null) {
  const prevProps = prevNode.props ?? {};
  const nextProps = nextNode.props ?? {};

  if (!shallowEqual(prevProps, nextProps)) {
    patches.push({
      op: "setProps",
      at: { blockId, nodeId: prevNode.id },
      props: nextProps ?? {},
    });
  }

  const prevChildren = prevNode.children ?? [];
  const nextChildren = nextNode.children ?? [];

  if (prevNode.type === "list" && nextNode.type === "list") {
    diffListChildren(blockId, prevNode, prevChildren, nextChildren, patches, metrics);
    return;
  }

  // Special handling for code blocks: detect pure append and emit appendLines.
  if (prevNode.type === "code" && nextNode.type === "code") {
    const commonLength = Math.min(prevChildren.length, nextChildren.length);
    let divergeIndex = 0;
    while (divergeIndex < commonLength && prevChildren[divergeIndex].id === nextChildren[divergeIndex].id) {
      diffNodeSnapshot(blockId, prevChildren[divergeIndex], nextChildren[divergeIndex], patches, metrics);
      divergeIndex++;
    }

    const onlyAppend =
      divergeIndex === prevChildren.length &&
      nextChildren.length >= prevChildren.length &&
      prevChildren.every((child, idx) => child.id === nextChildren[idx].id);

    if (onlyAppend && nextChildren.length > prevChildren.length) {
      const startIndex = prevChildren.length;
      const appended = nextChildren.slice(startIndex);
      patches.push({
        op: "appendLines",
        at: { blockId, nodeId: prevNode.id },
        startIndex,
        lines: appended.map((child) => {
          const text = typeof child.props?.text === "string" ? (child.props?.text as string) : "";
          return text;
        }),
        highlight: appended.map((child) => (typeof child.props?.html === "string" ? (child.props?.html as string) : null)),
      });
      metrics?.recordAppendLines(appended.length);
      return;
    }

    // Fall through to generic handling for other mutations (edits/deletes)
  }

  const minLen = Math.min(prevChildren.length, nextChildren.length);
  let prefix = 0;
  while (prefix < minLen && prevChildren[prefix].id === nextChildren[prefix].id) {
    diffNodeSnapshot(blockId, prevChildren[prefix], nextChildren[prefix], patches, metrics);
    prefix++;
  }

  let suffix = 0;
  while (suffix < minLen - prefix && prevChildren[prevChildren.length - 1 - suffix].id === nextChildren[nextChildren.length - 1 - suffix].id) {
    const prevIdx = prevChildren.length - 1 - suffix;
    const nextIdx = nextChildren.length - 1 - suffix;
    diffNodeSnapshot(blockId, prevChildren[prevIdx], nextChildren[nextIdx], patches, metrics);
    suffix++;
  }

  const prevMid = prevChildren.slice(prefix, prevChildren.length - suffix);
  const nextMid = nextChildren.slice(prefix, nextChildren.length - suffix);

  if (prevMid.length === 0 && nextMid.length === 0) {
    return;
  }

  if (prevMid.length === nextMid.length && prevMid.length > 0) {
    const prevIds = prevMid.map((child) => child.id);
    const nextIds = nextMid.map((child) => child.id);
    if (haveSameMultiset(prevIds, nextIds)) {
      const currentOrder = prevIds.slice();
      const reorderOps: Array<{ from: number; to: number }> = [];
      for (let targetIdx = 0; targetIdx < nextIds.length; targetIdx++) {
        const desiredId = nextIds[targetIdx];
        if (currentOrder[targetIdx] === desiredId) {
          continue;
        }
        const sourceIdx = currentOrder.indexOf(desiredId);
        if (sourceIdx === -1) continue;
        reorderOps.push({
          from: prefix + sourceIdx,
          to: prefix + targetIdx,
        });
        const [moved] = currentOrder.splice(sourceIdx, 1);
        currentOrder.splice(targetIdx, 0, moved);
      }

      for (const op of reorderOps) {
        patches.push({
          op: "reorder",
          at: { blockId, nodeId: prevNode.id },
          from: op.from,
          to: op.to,
          count: 1,
        });
      }

      const prevMap = new Map(prevMid.map((child) => [child.id, child]));
      for (const child of nextMid) {
        const previous = prevMap.get(child.id);
        if (previous) {
          diffNodeSnapshot(blockId, previous, child, patches, metrics);
        }
      }
      return;
    }
  }

  for (let i = prevChildren.length - 1 - suffix; i >= prefix; i--) {
    patches.push({
      op: "deleteChild",
      at: { blockId, nodeId: prevNode.id },
      index: i,
    });
  }

  for (let i = prefix; i < nextChildren.length - suffix; i++) {
    patches.push({
      op: "insertChild",
      at: { blockId, nodeId: prevNode.id },
      index: i,
      node: nextChildren[i],
    });
  }
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const valA = a[key];
    const valB = b[key];
    if (typeof valA === "object" || typeof valB === "object") {
      if (JSON.stringify(valA) !== JSON.stringify(valB)) return false;
    } else if (valA !== valB) {
      return false;
    }
  }
  return true;
}

function haveSameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const id of a) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const id of b) {
    const next = (counts.get(id) ?? 0) - 1;
    if (next < 0) return false;
    counts.set(id, next);
  }
  return Array.from(counts.values()).every((val) => val === 0);
}

function diffListChildren(
  blockId: string,
  listNode: NodeSnapshot,
  prevChildren: NodeSnapshot[],
  nextChildren: NodeSnapshot[],
  patches: Patch[],
  metrics?: WorkerMetricsCollector | null,
) {
  const prevLength = prevChildren.length;
  const nextLength = nextChildren.length;

  if (prevLength === 0 && nextLength === 0) {
    return;
  }

  const commonLength = Math.min(prevLength, nextLength);

  // Diff shared prefix first to propagate nested updates.
  let prefix = 0;
  while (prefix < commonLength && prevChildren[prefix].id === nextChildren[prefix].id) {
    diffNodeSnapshot(blockId, prevChildren[prefix], nextChildren[prefix], patches, metrics);
    prefix++;
  }

  if (prefix === prevLength && prefix === nextLength) {
    return;
  }

  // Pure append: existing prefix matches and prev length exhausted.
  if (prefix === prevLength && nextLength > prevLength) {
    for (let i = prefix; i < nextLength; i++) {
      patches.push({
        op: "insertChild",
        at: { blockId, nodeId: listNode.id },
        index: i,
        node: nextChildren[i],
      });
    }
    return;
  }

  // Pure truncate from tail.
  if (prefix === nextLength && prevLength > nextLength) {
    for (let i = prevLength - 1; i >= nextLength; i--) {
      patches.push({
        op: "deleteChild",
        at: { blockId, nodeId: listNode.id },
        index: i,
      });
    }
    return;
  }

  // Compute suffix after trimming already handled prefix.
  let suffix = 0;
  while (suffix < commonLength - prefix && prevChildren[prevLength - 1 - suffix].id === nextChildren[nextLength - 1 - suffix].id) {
    const prevIdx = prevLength - 1 - suffix;
    const nextIdx = nextLength - 1 - suffix;
    diffNodeSnapshot(blockId, prevChildren[prevIdx], nextChildren[nextIdx], patches, metrics);
    suffix++;
  }

  const prevMidStart = prefix;
  const prevMidEnd = prevLength - suffix;
  const nextMidStart = prefix;
  const nextMidEnd = nextLength - suffix;

  const prevMidLen = Math.max(0, prevMidEnd - prevMidStart);
  const nextMidLen = Math.max(0, nextMidEnd - nextMidStart);

  if (prevMidLen === 0 && nextMidLen === 0) {
    return;
  }

  if (prevMidLen === 0 && nextMidLen > 0) {
    for (let i = nextMidStart; i < nextMidEnd; i++) {
      patches.push({
        op: "insertChild",
        at: { blockId, nodeId: listNode.id },
        index: i,
        node: nextChildren[i],
      });
    }
    return;
  }

  if (prevMidLen > 0 && nextMidLen === 0) {
    for (let i = prevMidEnd - 1; i >= prevMidStart; i--) {
      patches.push({
        op: "deleteChild",
        at: { blockId, nodeId: listNode.id },
        index: i,
      });
    }
    return;
  }

  // When both sides have mid-ranges, fall back to generic handling to account for true reorders/edits.
  const prevMid = prevChildren.slice(prevMidStart, prevMidEnd);
  const nextMid = nextChildren.slice(nextMidStart, nextMidEnd);

  const sharedMid = Math.min(prevMid.length, nextMid.length);
  let midPrefix = 0;
  while (midPrefix < sharedMid && prevMid[midPrefix].id === nextMid[midPrefix].id) {
    diffNodeSnapshot(blockId, prevMid[midPrefix], nextMid[midPrefix], patches, metrics);
    midPrefix++;
  }

  if (midPrefix === prevMid.length && midPrefix === nextMid.length) {
    return;
  }

  if (midPrefix === prevMid.length && nextMid.length > prevMid.length) {
    for (let i = nextMidStart + midPrefix; i < nextMidEnd; i++) {
      patches.push({
        op: "insertChild",
        at: { blockId, nodeId: listNode.id },
        index: i,
        node: nextChildren[i],
      });
    }
    return;
  }

  if (midPrefix === nextMid.length && prevMid.length > nextMid.length) {
    for (let i = prevMidEnd - 1; i >= prevMidStart + midPrefix; i--) {
      patches.push({
        op: "deleteChild",
        at: { blockId, nodeId: listNode.id },
        index: i,
      });
    }
    return;
  }

  const remainingPrevMid = prevMid.slice(midPrefix);
  const remainingNextMid = nextMid.slice(midPrefix);

  if (remainingPrevMid.length === remainingNextMid.length && remainingPrevMid.every((child, idx) => child.id === remainingNextMid[idx].id)) {
    for (let idx = 0; idx < remainingPrevMid.length; idx++) {
      diffNodeSnapshot(blockId, remainingPrevMid[idx], remainingNextMid[idx], patches, metrics);
    }
    return;
  }

  // Otherwise leverage delete/insert to reflect structural moves without reorder.
  for (let i = prevMidEnd - 1; i >= prevMidStart + midPrefix; i--) {
    patches.push({
      op: "deleteChild",
      at: { blockId, nodeId: listNode.id },
      index: i,
    });
  }

  for (let i = nextMidStart + midPrefix; i < nextMidEnd; i++) {
    patches.push({
      op: "insertChild",
      at: { blockId, nodeId: listNode.id },
      index: i,
      node: nextChildren[i],
    });
  }
}

interface ContentChangeRange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

function computeChangedRanges(previous: string, next: string): ContentChangeRange[] {
  if (previous === next) {
    return [];
  }
  let from = 0;
  const minLen = Math.min(previous.length, next.length);
  while (from < minLen && previous.charCodeAt(from) === next.charCodeAt(from)) {
    from++;
  }

  let toA = previous.length;
  let toB = next.length;
  while (toA > from && toB > from && previous.charCodeAt(toA - 1) === next.charCodeAt(toB - 1)) {
    toA--;
    toB--;
  }

  return [
    {
      fromA: from,
      toA,
      fromB: from,
      toB,
    },
  ];
}

function collectChangedBlockIds(previousBlocks: Block[], nextBlocks: Block[], ranges: ContentChangeRange[]): Set<string> {
  const ids = new Set<string>();
  if (!ranges || ranges.length === 0) {
    return ids;
  }
  for (const range of ranges) {
    addIntersectingBlocks(ids, previousBlocks, range.fromA, range.toA);
    addIntersectingBlocks(ids, nextBlocks, range.fromB, range.toB);
  }
  return ids;
}

function addIntersectingBlocks(target: Set<string>, blocks: Block[], from: number, to: number) {
  if (from === to) {
    for (const block of blocks) {
      const range = block.payload.range;
      if (!range) continue;
      if (from >= range.from && from <= range.to) {
        target.add(block.id);
        break;
      }
    }
    return;
  }
  for (const block of blocks) {
    const range = block.payload.range;
    if (!range) continue;
    if (rangesIntersect(range.from, range.to, from, to)) {
      target.add(block.id);
    }
  }
}

function rangesIntersect(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return Math.max(aFrom, bFrom) <= Math.min(aTo, bTo);
}

let messageQueue: Promise<void> = Promise.resolve();

function reportWorkerError(error: unknown, phase: WorkerPhase, meta?: Record<string, unknown>) {
  const payload: WorkerErrorPayload =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: typeof error === "string" ? error : JSON.stringify(error) };
  postMessage({
    type: "ERROR",
    phase,
    error: payload,
    meta,
    timestamp: Date.now(),
  } as WorkerOut);
}

async function finalizeAllBlocks() {
  const metricsCollector = new WorkerMetricsCollector(workerGrammarEngine);
  setActiveMetricsCollector(metricsCollector);

  const prevBlocks = blocks.map((block) => cloneBlock(block));
  const finalizePatches: Patch[] = [];
  const finalizeTargets = new Set<string>();
  for (const block of blocks) {
    if (!block.isFinalized) {
      block.isFinalized = true;
      finalizeTargets.add(block.id);
      finalizePatches.push({
        op: "finalize",
        at: { blockId: block.id },
      });
    }
  }

  if (finalizePatches.length > 0) {
    postMessage({
      type: "PATCH",
      tx: ++txCounter,
      patches: finalizePatches,
    } as WorkerOut);
  }

  const { blocks: reparsedBlocks, lastTree: reparsedTree } = await parseAll(currentContent, { forceFinalize: true });
  for (const block of reparsedBlocks) {
    block.isFinalized = true;
    await updateMdxCompilationState(block);
  }

  blocks = reparsedBlocks;
  lastTree = reparsedTree;
  metricsCollector.setBlocksProduced(blocks.length);

  const fullRange = [
    {
      fromA: 0,
      toA: currentContent.length,
      fromB: 0,
      toB: currentContent.length,
    },
  ];
  await emitBlockDiffPatches(prevBlocks, blocks, fullRange, metricsCollector);

  if (prevBlocks && prevBlocks.length > 0) {
    const finalizeSetProps: Patch[] = [];
    for (const block of blocks) {
      if (!block.isFinalized || !finalizeTargets.has(block.id)) continue;
      finalizeSetProps.push({
        op: "setProps",
        at: { blockId: block.id, nodeId: block.id },
        props: {
          block: cloneBlock(block),
        },
      });
    }
    if (finalizeSetProps.length > 0) {
      dispatchPatchBatch(finalizeSetProps, metricsCollector);
    }
  }

  if (getActiveMetricsCollector() === metricsCollector) {
    setActiveMetricsCollector(null);
  }
}

interface MdxStatusUpdate {
  compiledRef?: { id: string };
  status: "compiled" | "error";
  error?: string;
}

function handleMdxStatus(blockId: string, update: MdxStatusUpdate) {
  if (mdxCompileMode === "worker") {
    return;
  }
  const index = blocks.findIndex((b) => b.id === blockId);
  if (index === -1) return;

  const previous = blocks[index];
  const updated = cloneBlock(previous);
  updated.payload = {
    ...updated.payload,
    compiledMdxRef: update.compiledRef ?? updated.payload.compiledMdxRef,
    meta: {
      ...(updated.payload.meta ?? {}),
      mdxStatus: update.status,
      ...(update.error ? { mdxError: update.error } : {}),
    },
  };

  blocks[index] = updated;

  postMessage({
    type: "PATCH",
    tx: ++txCounter,
    patches: [
      {
        op: "setProps",
        at: { blockId },
        props: {
          block: updated,
        },
      },
    ],
  } as WorkerOut);
}

async function processWorkerMessage(msg: WorkerIn) {
  switch (msg.type) {
    case "INIT":
      await initialize(msg.initialContent, msg.prewarmLangs ?? [], msg.docPlugins, msg.mdx);
      return;
    case "APPEND":
      await handleAppend(msg.text);
      return;
    case "FINALIZE":
      await finalizeAllBlocks();
      return;
    case "MDX_COMPILED":
      handleMdxStatus(msg.blockId, {
        compiledRef: { id: msg.compiledId },
        status: "compiled",
      });
      return;
    case "MDX_ERROR":
      handleMdxStatus(msg.blockId, {
        compiledRef: undefined,
        status: "error",
        error: msg.error,
      });
      return;
    case "SET_CREDITS":
      workerCredits = Math.max(0, Math.min(1, Number(msg.credits ?? 0)));
      if (workerCredits > 0) {
        flushDeferredPatches();
      }
      return;
    default:
      console.warn("Unknown message type:", msg);
  }
}

// Worker message handler (serialized to avoid state races across async awaits).
self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  const task = messageQueue
    .then(async () => {
      try {
        await processWorkerMessage(msg);
      } catch (error) {
        console.error("Worker error:", error);
        reportWorkerError(error, msg.type, { phase: msg.type });
      }
    })
    .catch((error) => {
      console.error("Worker queue error:", error);
      reportWorkerError(error, msg.type, { phase: msg.type, queue: true });
    });
  messageQueue = task;
  return task;
};
