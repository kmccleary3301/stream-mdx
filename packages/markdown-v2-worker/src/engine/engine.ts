import { type SyntaxNode, type Tree, TreeFragment } from "@lezer/common";
import { GFM, Table, parser as mdParser } from "@lezer/markdown";
import type {
  Block,
  BlockResolvedLinkReference,
  CodeHighlightOutputMode,
  CompiledMdxModule,
  DiffKind,
  FormatAnticipationConfig,
  HtmlOptions,
  HtmlTreeNode,
  InlineNode,
  SyntaxRuleSpec,
  NormalizedFormatAnticipation,
  LinkReferenceDefinition,
  Patch,
  NodeSnapshot,
  PreparedNestedSnapshot,
  PatchMetrics,
  PerformanceMetrics,
  ProtectedRange,
  TocHeading,
  TokenLineV1,
  WorkerErrorPayload,
  WorkerIn,
  WorkerOut,
  WorkerPhase,
} from "@stream-mdx/core";
import {
  InlineParser,
  PATCH_ROOT_ID,
  PerformanceTimer,
  blocksStructurallyEqual,
  cloneBlock,
  createBlockSnapshot,
  extractLezerCode,
  prepareNestedBlockSnapshot,
  createBlockCompatibilityExtension,
  collectLinkReferences,
  diffLinkReferences,
  dedentIndentedCode,
  detectMDX,
  extractCodeLines,
  extractMixedContentSegments,
  generateBlockId,
  normalizeFormatAnticipation,
  parseCodeFenceInfo,
  prepareInlineStreamingContent,
  removeHeadingMarkers,
  sanitizeHtmlInWorker,
  sanitizeHtmlTreeInWorker,
  stripCodeFence,
} from "@stream-mdx/core";
import {
  CalloutsPlugin,
  DocumentPluginRegistry,
  type DocumentState,
  HTMLBlockPlugin,
  MDXDetectionPlugin,
  TablesPlugin,
  registerFootnotesPlugin,
} from "@stream-mdx/plugins";
import { isBlockLevelNode, mapLezerNodeToBlockType } from "../parser/block-types";
import { HtmlContinuationExtension } from "../parser/html-extension";
import { containsInlineHtml, groupHtmlOwnership, normalizeHtmlParagraph } from "./html-ownership";
import { computeParagraphPatchLimit } from "../perf/patch-heuristics";
import {
  clampLazyRange,
  type LazyTokenizationPriority,
  type LazyTokenizationRequest,
} from "../lazy-tokenization";
import {
  CODE_HIGHLIGHT_THEMES,
  buildDiffBlocksFromLines,
  buildDiffTokenLines,
  dedentFencedCodeByClosingIndent,
  detectDiffLanguage,
  enhanceHighlightedHtml,
  getSharedHighlighter,
  guessLanguageFromDiffLines,
  looksLikeUnifiedDiff,
  parseUnifiedDiffLine,
  renderShikiLines,
  renderTokenLines,
  resolveHighlightLanguage,
  type SharedHighlighter,
  toDiffLineKind,
} from "./highlight";
import {
  DEFAULT_LAZY_TOKENIZATION_THRESHOLD,
  MAX_LAZY_TOKENIZATION_THRESHOLD,
  MIN_LAZY_TOKENIZATION_THRESHOLD,
  enqueueLazyTokenization,
  getOrInitLazyState,
  makeLazySignature,
  pruneLazyTokenizationStates,
  selectNextLazyRequest,
  shouldLazyTokenizeBlock,
} from "./lazy-tokenization";
import {
  applyMdxStatusUpdate,
  preserveMdxMetadata,
  updateMdxCompilationState,
  type EngineMdxState,
} from "./mdx";
import {
  WorkerMetricsCollector,
  now,
  roundMetric,
} from "./metrics";
import {
  collectAutolinkProtectedRanges,
  collectChangedBlockIds,
  collectHtmlProtectedRangesFromSegments,
  collectMathProtectedRanges,
  computeChangedRanges,
  maybeBuildTocPatch,
  parseGfmTableFromTree,
  reportWorkerStructuralInvariantViolations,
  slugifyHeading,
} from "./parse-extract";
import {
  countChangedBlocksFromPatches,
  diffNodeSnapshot,
  ensureAnnotatedPatchBatch,
  estimatePatchSize,
  partitionPatchesForCredits,
  syncEmittedBlockEpochsFromPatches,
  withPatchKind,
  withPatchKindBatch,
} from "./patch-emit";
import type {
  CodeHighlightingMode,
  ContentChangeRange,
  DiffCursorState,
  EngineExtensions,
  IncrementalHighlightState,
  LazyTokenizationState,
  MarkdownEngineOptions,
  MdxStatusUpdate,
  ParseOptions,
  ShikiThemedToken,
  WorkerMdxMode,
} from "./types";

const MAX_DEFERRED_PATCHES = 400;
const MAX_DEFERRED_FLUSH_PATCHES = 120;
const MAX_CODE_HIGHLIGHT_CACHE_ENTRIES = 200;
const MAX_MDX_SKIP_LOGS = 20;
const MIXED_CONTENT_AUTOCLOSE_NEWLINES = 2;
const DEFAULT_APPEND_CHUNK_SIZE = 1400;
const DEFAULT_APPEND_BATCH_MS = 12;
const MIN_APPEND_CHUNK_SIZE = 256;
const MAX_APPEND_CHUNK_SIZE = 12000;
const MIN_APPEND_BATCH_MS = 4;
const MAX_APPEND_BATCH_MS = 50;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sliceAppendChunk(text: string, maxChars: number): { chunk: string; rest: string } {
  if (text.length <= maxChars) {
    return { chunk: text, rest: "" };
  }
  const sliceEnd = maxChars;
  const newlinePos = text.lastIndexOf("\n", sliceEnd);
  if (newlinePos >= maxChars - 200 && newlinePos < sliceEnd) {
    return {
      chunk: text.slice(0, newlinePos + 1),
      rest: text.slice(newlinePos + 1),
    };
  }
  return {
    chunk: text.slice(0, maxChars),
    rest: text.slice(maxChars),
  };
}

export class MarkdownEngine {
  private readonly postFn: (message: WorkerOut) => void;
  public readonly extensions?: EngineExtensions;
  private mdParser!: typeof mdParser;

  public readonly documentPluginRegistry: DocumentPluginRegistry;
  private readonly documentPluginState: DocumentState = {};
  private inlineParser!: InlineParser;
  private syntaxRules: SyntaxRuleSpec[] = [];
  private htmlConfig?: HtmlOptions;
  private performanceTimer = new PerformanceTimer();
  private highlighter: SharedHighlighter | null = null;

  private blocks: Block[] = [];
  private lastTree: Tree | null = null;
  private treeFragments: readonly TreeFragment[] = [];
  private currentLinkReferences = new Map<string, LinkReferenceDefinition>();
  private blockAttemptedReferences = new Map<string, Set<string>>();
  private currentContent = "";
  private documentGeneration = 0;

  private txCounter = 0;
  private parseEpochCounter = 0;
  private patchStreamSeq = 0;
  private emittedBlockEpochs = new Map<string, number>();

  private readonly workerGrammarEngine: "js" | "wasm" = "js";
  private workerCredits = 1;
  private deferredPatchQueue: Patch[] = [];

  private readonly codeHighlightCache = new Map<string, { html: string; lang: string }>();
  private readonly incrementalHighlightStates = new Map<string, IncrementalHighlightState>();

  private readonly lazyTokenizationStates = new Map<string, LazyTokenizationState>();
  private readonly lazyTokenizationQueue = new Map<string, LazyTokenizationRequest>();
  private lazyTokenizationScheduled = false;
  private lazyTokenizationProcessing = false;
  private lazyTokenizationThresholdLines = DEFAULT_LAZY_TOKENIZATION_THRESHOLD;
  private lazyTokenizationEnabled = true;
  private mdxEnabled = true;
  private readonly workerMdxCache = new Map<string, CompiledMdxModule>();
  private readonly workerMdxInflight = new Map<string, Promise<CompiledMdxModule>>();
  private mdxCompileMode: WorkerMdxMode = "server";
  private mdxComponentAllowlist: Set<string> | null = null;
  private loggedMdxSkipCount = 0;

  private formatAnticipationConfig: NormalizedFormatAnticipation = normalizeFormatAnticipation(false);
  private codeHighlightingMode: CodeHighlightingMode = "final";
  private highlightOutputMode: CodeHighlightOutputMode = "html";
  private emitHighlightTokens = true;
  private emitDiffBlocks = false;
  private liveTokenizationEnabled = true;
  private enableMath = true;

  private tocHeadings: TocHeading[] = [];
  private tocSignature = "";
  private headingIdCounts = new Map<string, number>();

  private lastDiffSummary: unknown = null;
  private lastStructuralDiffSummary: unknown = null;
  private maxEmittedBlockCount = 0;
  private maxDeferredQueueSize = 0;
  private maxStructuralBlockCount = 0;
  private lastHighCountNoStructural: unknown = null;

  private activeMetricsCollector: WorkerMetricsCollector | null = null;
  private lastWorkerInvariantSignature = { value: "" };

  private messageQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: MarkdownEngineOptions) {
    this.postFn = options.post;
    this.extensions = options.extensions;

    this.buildMarkdownParser(true);

    this.documentPluginRegistry = new DocumentPluginRegistry();
    if (this.extensions?.documentPlugins) {
      for (const plugin of this.extensions.documentPlugins) {
        this.documentPluginRegistry.register(plugin);
      }
    }
    if (this.extensions?.syntax) {
      this.syntaxRules.push(...this.extensions.syntax);
    }

    this.buildInlineParser();
  }

  private buildMarkdownParser(tables: boolean): void {
    const gfm = tables ? GFM : GFM.filter((extension) => extension !== Table);
    this.mdParser = mdParser.configure([gfm, createBlockCompatibilityExtension(), HtmlContinuationExtension, ...(this.extensions?.markdown ?? [])]);
  }

  private buildInlineParser(): void {
    const inlineExt = this.extensions?.inline;
    this.inlineParser = new InlineParser({
      enableMath: this.enableMath,
      html: this.htmlConfig,
      ...(inlineExt ? { extensions: inlineExt } : {}),
      ...(this.syntaxRules.length > 0 ? { syntax: this.syntaxRules } : {}),
    });
    this.documentPluginState.inlineParser = this.inlineParser;
  }

  public post(message: WorkerOut): void {
    if (this.disposed) return;
    this.postFn(message);
  }

  public dispose(): void {
    this.disposed = true;
    this.documentGeneration += 1;
    this.lazyTokenizationScheduled = false;
    this.lazyTokenizationProcessing = false;
    this.lazyTokenizationQueue.clear();
    this.lazyTokenizationStates.clear();
    this.deferredPatchQueue = [];
    this.codeHighlightCache.clear();
    this.incrementalHighlightStates.clear();
    this.workerMdxCache.clear();
    this.workerMdxInflight.clear();
    this.documentPluginRegistry.clear();
  }

  public handle(message: WorkerIn): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    const task = this.messageQueue
      .then(async () => {
        if (this.disposed) return;
        try {
          await this.processMessage(message);
        } catch (error) {
          console.error("Worker error:", error);
          this.reportError(error, message.type, { phase: message.type });
        }
      })
      .catch((error) => {
        console.error("Worker queue error:", error);
        this.reportError(error, message.type, { phase: message.type, queue: true });
      });
    this.messageQueue = task;
    return task;
  }

  private reportError(error: unknown, phase: WorkerPhase, meta?: Record<string, unknown>): void {
    const payload: WorkerErrorPayload =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: typeof error === "string" ? error : JSON.stringify(error) };
    this.post({
      type: "ERROR",
      phase,
      error: payload,
      meta,
      timestamp: Date.now(),
    });
  }

  private async processMessage(msg: WorkerIn): Promise<void> {
    switch (msg.type) {
      case "INIT":
        await this.initialize(msg.initialContent, msg.prewarmLangs ?? [], msg.docPlugins, msg.mdx, msg.syntax, msg.html);
        return;
      case "APPEND":
        await this.handleAppend(msg.text);
        return;
      case "FINALIZE":
        await this.finalizeAllBlocks();
        return;
      case "DEBUG_STATE": {
        const blockTypeCounts: Record<string, number> = {};
        for (const block of this.blocks) {
          const key = block.type ?? "unknown";
          blockTypeCounts[key] = (blockTypeCounts[key] || 0) + 1;
        }
        let lastBlockType: string | undefined;
        let lastBlockRange: { from: number; to: number } | undefined;
        let lastBlockRawTail: string | undefined;
        const headingTexts: string[] = [];
        const tailBlocks: Array<{ id: string; type: string; raw: string }> = [];
        const headBlocks: Array<{ id: string; type: string; raw: string }> = [];
        const duplicateBlockIds: string[] = [];
        const seenBlockIds = new Set<string>();
        const headingIndices: Record<string, number> = {};
        for (const block of this.blocks) {
          if (seenBlockIds.has(block.id)) {
            if (duplicateBlockIds.length < 8) {
              duplicateBlockIds.push(block.id);
            }
          } else {
            seenBlockIds.add(block.id);
          }
        }
        if (this.blocks.length > 0) {
          const lastBlock = this.blocks[this.blocks.length - 1];
          lastBlockType = lastBlock.type;
          const range = lastBlock.payload.range;
          if (range && typeof range.from === "number" && typeof range.to === "number") {
            lastBlockRange = { from: range.from, to: range.to };
          }
          const raw = typeof lastBlock.payload.raw === "string" ? lastBlock.payload.raw : "";
          lastBlockRawTail = raw ? raw.slice(Math.max(0, raw.length - 240)) : undefined;
          for (const block of this.blocks) {
            if (block.type === "heading" && typeof block.payload.raw === "string") {
              headingTexts.push(block.payload.raw);
            }
          }
          const targets = ["HTML and MDX Testing", "Inline Code", "Code Blocks", "Media", "Tables", "Footnotes"];
          for (let i = 0; i < this.blocks.length; i++) {
            const block = this.blocks[i];
            if (block.type === "heading" && typeof block.payload.raw === "string") {
              if (targets.includes(block.payload.raw)) {
                headingIndices[block.payload.raw] = i;
              }
            }
          }
          const tailStart = Math.max(0, this.blocks.length - 8);
          for (let i = tailStart; i < this.blocks.length; i++) {
            const block = this.blocks[i];
            const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
            tailBlocks.push({
              id: block.id,
              type: block.type,
              raw: raw.slice(0, 120),
            });
          }
          const headEnd = Math.min(8, this.blocks.length);
          for (let i = 0; i < headEnd; i++) {
            const block = this.blocks[i];
            const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
            headBlocks.push({
              id: block.id,
              type: block.type,
              raw: raw.slice(0, 120),
            });
          }
        }
        const contentTail = this.currentContent.slice(Math.max(0, this.currentContent.length - 500));
        this.post({
          type: "DEBUG_STATE",
          state: {
            contentLength: this.currentContent.length,
            contentTail,
            blockCount: this.blocks.length,
            blockTypeCounts,
            lastBlockType,
            lastBlockRange,
            lastBlockRawTail,
            headingTexts,
            headBlocks,
            tailBlocks,
            headingIndices,
            lastDiffSummary: this.lastDiffSummary,
            lastStructuralDiffSummary: this.lastStructuralDiffSummary,
            maxEmittedBlockCount: this.maxEmittedBlockCount,
            maxDeferredQueueSize: this.maxDeferredQueueSize,
            maxStructuralBlockCount: this.maxStructuralBlockCount,
            lastHighCountNoStructural: this.lastHighCountNoStructural,
            duplicateBlockIds,
            duplicateBlockCount: duplicateBlockIds.length,
            hasInlineCodeHeading: this.currentContent.includes("# Inline Code"),
            hasCodeBlocksHeading: this.currentContent.includes("# Code Blocks"),
            hasMediaHeading: this.currentContent.includes("# Media"),
          },
        } as WorkerOut);
        return;
      }
      case "DUMP_BLOCKS": {
        this.post({
          type: "DUMP_BLOCKS",
          blocks: this.blocks,
          tocHeadings: this.tocHeadings,
        });
        return;
      }
      case "TOKENIZE_RANGE": {
        const priority: LazyTokenizationPriority = msg.priority === "prefetch" ? "prefetch" : "visible";
        enqueueLazyTokenization(this.lazyTokenizationQueue, this.lazyTokenizationEnabled, {
          blockId: msg.blockId,
          startLine: msg.startLine,
          endLine: msg.endLine,
          priority,
          requestedAt: now(),
        });
        this.scheduleLazyTokenizationProcessing();
        return;
      }
      case "MDX_COMPILED":
        this.handleMdxStatus(msg.blockId, {
          compiledRef: { id: msg.compiledId },
          status: "compiled",
          rawSignature: msg.rawSignature,
        });
        return;
      case "MDX_ERROR":
        this.handleMdxStatus(msg.blockId, {
          compiledRef: undefined,
          status: "error",
          error: msg.error,
          rawSignature: msg.rawSignature,
        });
        return;
      case "SET_CREDITS":
        this.workerCredits = Math.max(0, Math.min(1, Number(msg.credits ?? 0)));
        if (this.workerCredits > 0) {
          this.flushDeferredPatches();
        }
        return;
      default:
        console.warn("Unknown message type:", msg);
    }
  }

  private async initialize(
    initialContent = "",
    prewarmLangs: string[] = [],
    docPlugins?: {
      footnotes?: boolean;
      html?: boolean;
      mdx?: boolean;
      tables?: boolean;
      callouts?: boolean;
      math?: boolean;
      formatAnticipation?: FormatAnticipationConfig;
      codeHighlighting?: CodeHighlightingMode;
      outputMode?: CodeHighlightOutputMode;
      liveCodeHighlighting?: boolean;
      liveTokenization?: boolean;
      emitHighlightTokens?: boolean;
      emitDiffBlocks?: boolean;
      mdxComponentNames?: string[];
      lazyTokenization?: { enabled?: boolean; thresholdLines?: number };
    },
    mdxOptions?: { compileMode?: WorkerMdxMode },
    syntax?: SyntaxRuleSpec[],
    html?: HtmlOptions,
  ): Promise<void> {
    this.documentGeneration += 1;
    this.performanceTimer = new PerformanceTimer();
    this.blocks = [];
    this.lastTree = null;
    this.treeFragments = [];
    this.currentLinkReferences = new Map();
    this.blockAttemptedReferences = new Map();
    this.currentContent = "";
    this.deferredPatchQueue = [];
    this.emittedBlockEpochs = new Map();
    this.parseEpochCounter = 0;
    this.patchStreamSeq = 0;
    this.tocHeadings = [];
    this.tocSignature = "";

    this.syntaxRules = [];
    if (this.extensions?.syntax) {
      this.syntaxRules.push(...this.extensions.syntax);
    }
    if (syntax && Array.isArray(syntax)) {
      for (const rule of syntax) {
        try {
          const cleanedFlags = (rule.pattern?.flags || "").replace(/[gy]/g, "");
          new RegExp(rule.pattern?.source ?? "", `${cleanedFlags}y`);
          this.syntaxRules.push(rule);
        } catch (err) {
          this.reportError(err, "INIT", { rule: rule.name });
        }
      }
    }
    this.htmlConfig = html;

    this.documentPluginRegistry.clear();
    for (const key of Object.keys(this.documentPluginState)) {
      delete this.documentPluginState[key];
    }
    this.codeHighlightCache.clear();
    this.incrementalHighlightStates.clear();
    this.lazyTokenizationStates.clear();
    this.lazyTokenizationQueue.clear();
    this.lazyTokenizationScheduled = false;
    this.lazyTokenizationProcessing = false;

    this.mdxCompileMode = mdxOptions?.compileMode ?? "server";
    this.workerMdxCache.clear();
    this.workerMdxInflight.clear();

    const enable = {
      footnotes: docPlugins?.footnotes ?? true,
      html: docPlugins?.html ?? true,
      mdx: docPlugins?.mdx ?? true,
      tables: docPlugins?.tables ?? true,
      callouts: docPlugins?.callouts ?? false,
      math: docPlugins?.math ?? true,
      formatAnticipation: docPlugins?.formatAnticipation ?? false,
      codeHighlighting: docPlugins?.codeHighlighting,
      liveCodeHighlighting: docPlugins?.liveCodeHighlighting ?? false,
      liveTokenization: docPlugins?.liveTokenization ?? true,
      emitHighlightTokens: docPlugins?.emitHighlightTokens ?? true,
      emitDiffBlocks: docPlugins?.emitDiffBlocks ?? false,
    };
    this.buildMarkdownParser(enable.tables);

    this.mdxEnabled = enable.mdx;
    this.enableMath = enable.math;
    this.formatAnticipationConfig = normalizeFormatAnticipation(enable.formatAnticipation);
    if (enable.codeHighlighting === "incremental" || enable.codeHighlighting === "live" || enable.codeHighlighting === "final") {
      this.codeHighlightingMode = enable.codeHighlighting;
    } else {
      this.codeHighlightingMode = enable.liveCodeHighlighting ? "live" : "final";
    }
    if (docPlugins?.outputMode === "html" || docPlugins?.outputMode === "tokens" || docPlugins?.outputMode === "both") {
      this.highlightOutputMode = docPlugins.outputMode;
    } else {
      this.highlightOutputMode = "html";
    }
    this.emitHighlightTokens = enable.emitHighlightTokens;
    this.emitDiffBlocks = enable.emitDiffBlocks;
    this.liveTokenizationEnabled = enable.liveTokenization;
    if (docPlugins?.lazyTokenization) {
      this.lazyTokenizationEnabled = docPlugins.lazyTokenization.enabled ?? true;
      const desiredThreshold = docPlugins.lazyTokenization.thresholdLines ?? DEFAULT_LAZY_TOKENIZATION_THRESHOLD;
      this.lazyTokenizationThresholdLines = clampInt(desiredThreshold, MIN_LAZY_TOKENIZATION_THRESHOLD, MAX_LAZY_TOKENIZATION_THRESHOLD);
    } else {
      this.lazyTokenizationEnabled = true;
      this.lazyTokenizationThresholdLines = DEFAULT_LAZY_TOKENIZATION_THRESHOLD;
    }
    if (Array.isArray(docPlugins?.mdxComponentNames) && docPlugins.mdxComponentNames.length > 0) {
      this.mdxComponentAllowlist = new Set(docPlugins.mdxComponentNames);
    } else {
      this.mdxComponentAllowlist = null;
    }
    this.buildInlineParser();
    this.documentPluginState.inlineParser = this.inlineParser;

    if (enable.footnotes) registerFootnotesPlugin(this.documentPluginRegistry);
    if (enable.tables) this.documentPluginRegistry.register(TablesPlugin);
    if (enable.callouts) this.documentPluginRegistry.register(CalloutsPlugin);
    if (enable.html) this.documentPluginRegistry.register(HTMLBlockPlugin);
    if (enable.mdx) this.documentPluginRegistry.register(MDXDetectionPlugin);
    if (this.extensions?.documentPlugins) {
      for (const plugin of this.extensions.documentPlugins) {
        this.documentPluginRegistry.register(plugin);
      }
    }

    this.performanceTimer.mark("highlighter-init");
    this.highlighter = await getSharedHighlighter(prewarmLangs);
    this.performanceTimer.measure("highlighter-init");

    if (initialContent) {
      this.currentContent = initialContent;
      const result = await this.parseAll(initialContent);
      this.blocks = result.blocks;
      this.lastTree = result.lastTree;
    }

    this.txCounter = 0;
    reportWorkerStructuralInvariantViolations("initialize", this.blocks, this.lastWorkerInvariantSignature);
    this.post({
      type: "INITIALIZED",
      blocks: this.blocks,
    });

    if (this.blocks.length > 0) {
      await this.emitDocumentPatch(this.blocks);
    }
  }

  private async handleAppend(text: string): Promise<void> {
    let remaining = text;
    let batchStartedAt = now();

    while (remaining.length > 0) {
      const { chunk, rest } = sliceAppendChunk(remaining, DEFAULT_APPEND_CHUNK_SIZE);
      remaining = rest;

      this.performanceTimer.mark("append-operation");

      const metricsCollector = new WorkerMetricsCollector(this.workerGrammarEngine);
      this.activeMetricsCollector = metricsCollector;

      await this.appendAndReparse(chunk, metricsCollector);
      const hadPatchMetrics = metricsCollector.patchCount > 0;

      const totalTime = this.performanceTimer.measure("append-operation");

      if (this.activeMetricsCollector === metricsCollector) {
        this.activeMetricsCollector = null;
      }

      if (!hadPatchMetrics && totalTime !== null && Number.isFinite(totalTime)) {
        this.post({
          type: "METRICS",
          metrics: {
            parseMs: roundMetric(totalTime),
            parseTime: roundMetric(totalTime),
            blocksProduced: this.blocks.length,
            grammarEngine: this.workerGrammarEngine,
          } as PerformanceMetrics,
        });
      }

      if (remaining.length > 0 && now() - batchStartedAt >= DEFAULT_APPEND_BATCH_MS) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        batchStartedAt = now();
      }
    }
  }

  private async parseAll(content: string, options: ParseOptions = {}): Promise<{ blocks: Block[]; lastTree: Tree }> {
    this.performanceTimer.mark("parse-all");
    const metrics = this.activeMetricsCollector;
    metrics?.markParseStart();

    const tree = this.mdParser.parse(content);
    this.treeFragments = TreeFragment.addTree(tree);
    this.currentLinkReferences = collectLinkReferences(tree, content);
    this.inlineParser.setReferences(this.currentLinkReferences);
    let extractedBlocks = await this.extractBlocks(tree, content, options);
    extractedBlocks = this.runDocumentPlugins(extractedBlocks, content);

    this.performanceTimer.measure("parse-all");
    metrics?.setBlocksProduced(extractedBlocks.length);

    return {
      blocks: extractedBlocks,
      lastTree: tree,
    };
  }

  private async appendAndReparse(appendedText: string, metrics?: WorkerMetricsCollector): Promise<void> {
    this.performanceTimer.mark("incremental-parse");
    metrics?.markParseStart();
    this.deferredPatchQueue = [];

    const newContent = this.currentContent + appendedText;
    const changeRanges = computeChangedRanges(this.currentContent, newContent);

    const oldLen = this.currentContent.length;
    const newLen = oldLen + appendedText.length;
    const updatedFragments = TreeFragment.applyChanges(this.treeFragments, [
      { fromA: oldLen, toA: oldLen, fromB: oldLen, toB: newLen },
    ]);
    let newTree = this.mdParser.parse(newContent, updatedFragments);
    this.treeFragments = TreeFragment.addTree(newTree, updatedFragments);
    const newReferences = collectLinkReferences(newTree, newContent);
    const changedLabels = diffLinkReferences(this.currentLinkReferences, newReferences);
    this.currentLinkReferences = newReferences;
    this.inlineParser.setReferences(newReferences);

    let changedBlocks = await this.extractBlocks(newTree, newContent, {
      firstChangedPos: oldLen,
      previousBlocks: this.blocks,
    });
    changedBlocks = this.runDocumentPlugins(changedBlocks, newContent);
    const lastRange = changedBlocks.length > 0 ? changedBlocks[changedBlocks.length - 1]?.payload?.range : undefined;
    const lastTo = typeof lastRange?.to === "number" ? lastRange.to : 0;
    if (lastTo < newContent.length - 1) {
      const tail = newContent.slice(lastTo).trim();
      if (tail.length > 0) {
        const fullTree = this.mdParser.parse(newContent);
        this.treeFragments = TreeFragment.addTree(fullTree);
        const fullRefs = collectLinkReferences(fullTree, newContent);
        const fullChangedLabels = diffLinkReferences(this.currentLinkReferences, fullRefs);
        for (const l of fullChangedLabels) changedLabels.add(l);
        this.currentLinkReferences = fullRefs;
        this.inlineParser.setReferences(fullRefs);
        let fullBlocks = await this.extractBlocks(fullTree, newContent);
        fullBlocks = this.runDocumentPlugins(fullBlocks, newContent);
        const fullLast = fullBlocks.length > 0 ? fullBlocks[fullBlocks.length - 1]?.payload?.range?.to ?? 0 : 0;
        if (fullLast >= newContent.length - 1 || fullBlocks.length >= changedBlocks.length) {
          newTree = fullTree;
          changedBlocks = fullBlocks;
        }
      }
    }

    if (changedLabels.size > 0) {
      for (let i = 0; i < changedBlocks.length; i++) {
        const block = changedBlocks[i];
        const attempted = this.blockAttemptedReferences.get(block.id);
        if (!attempted) continue;
        let matched = false;
        for (const label of changedLabels) {
          if (attempted.has(label)) {
            matched = true;
            break;
          }
        }
        if (matched) {
          const cloned = cloneBlock(block);
          await this.enrichBlock(cloned);
          changedBlocks[i] = cloned;
        }
      }
    }
    const prevBlocks = this.blocks;

    this.blocks = changedBlocks;
    this.lastTree = newTree;
    this.currentContent = newContent;
    pruneLazyTokenizationStates(this.lazyTokenizationStates, this.blocks);

    this.performanceTimer.measure("incremental-parse");
    metrics?.markParseEnd();
    metrics?.setBlocksProduced(this.blocks.length);

    await this.emitBlockDiffPatches(prevBlocks, changedBlocks, changeRanges, metrics);
  }

  private async extractBlocks(tree: Tree, content: string, options: ParseOptions = {}): Promise<Block[]> {
    try {
      this.headingIdCounts = new Map<string, number>();
      const extracted: Block[] = [];
      const cursor = tree.cursor();
      const footnotesEnabled = this.documentPluginRegistry.getAll().some((plugin) => plugin.name === "footnotes");
      let hasRecognizedNodes = false;
      const reusableBlockMap =
        options.firstChangedPos !== undefined && options.previousBlocks
          ? new Map(
              options.previousBlocks.map((b) => [
                `${b.payload.range?.from ?? -1}:${b.payload.range?.to ?? -1}:${b.payload.raw ?? ""}`,
                b,
              ]),
            )
          : null;

      if (cursor.firstChild()) {
        do {
          const nodeType = cursor.type.name;
          let from = cursor.from;
          const to = cursor.to;
          if (nodeType === "CodeBlock") {
            const lineStart = content.lastIndexOf("\n", from - 1) + 1;
            from = lineStart;
          }
          const raw = content.slice(from, to);
          const footnoteDefinition = nodeType === "LinkReference" && footnotesEnabled && /^\[\^[A-Za-z0-9_-]+\]:/.test(raw);
          if (nodeType === "LinkReference" && !footnoteDefinition) {
            hasRecognizedNodes = true;
            continue;
          }
          if (isBlockLevelNode(nodeType) || footnoteDefinition) {
            hasRecognizedNodes = true;
            const blockType = footnoteDefinition ? "paragraph" : mapLezerNodeToBlockType(nodeType);
            let block: Block | null = null;
            if (reusableBlockMap && to <= options.firstChangedPos!) {
              const prev = reusableBlockMap.get(`${from}:${to}:${raw}`);
              if (prev && prev.isFinalized && prev.type === blockType) {
                block = prev;
                if (blockType === "heading") {
                  const headingMeta = prev.payload.meta as { headingText?: string } | undefined;
                  const headingText = headingMeta?.headingText ?? raw;
                  const baseSlug = slugifyHeading(headingText);
                  const nextCount = (this.headingIdCounts.get(baseSlug) ?? 0) + 1;
                  this.headingIdCounts.set(baseSlug, nextCount);
                }
              }
            }

            if (!block) {
              block = await this.createBlock(blockType, raw, from, to, content, options, nodeType, cursor.node);
            }
            if (block && raw.trim()) {
              extracted.push(block);
            }
          }
        } while (cursor.nextSibling());
      }

      if (extracted.length === 0 && !hasRecognizedNodes) {
        return await this.extractBlocksSimple(content, options);
      }

      return groupHtmlOwnership(extracted, this.mdParser, content, this.htmlConfig, 0, (text) => this.inlineParser.parse(text));
    } catch (error) {
      console.warn("Lezer parsing failed, falling back to simple parsing:", error);
      return await this.extractBlocksSimple(content, options);
    }
  }

  private async extractBlocksSimple(content: string, options: ParseOptions = {}): Promise<Block[]> {
    const blocks: Block[] = [];
    const lines = content.split("\n");
    let currentParagraph: string[] = [];
    let currentPos = 0;

    const finalizeParagraph = async () => {
      if (currentParagraph.length > 0) {
        const raw = currentParagraph.join("\n");
        const from = currentPos - raw.length;
        const to = currentPos;

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

        const block = await this.createBlock(blockType, raw, from, to, content, options);
        if (block) {
          blocks.push(block);
        }
        currentParagraph = [];
      }
    };

    for (const line of lines) {
      currentPos += line.length + 1;
      if (line.trim() === "") {
        await finalizeParagraph();
      } else if (line.trim().match(/^\[[^\]]+\]:\s*\S+/)) {
        await finalizeParagraph();
      } else {
        currentParagraph.push(line);
      }
    }

    await finalizeParagraph();
    return blocks;
  }

  private async createBlock(
    type: string,
    raw: string,
    from: number,
    to: number,
    fullContent: string,
    options: ParseOptions = {},
    nodeType?: string,
    syntaxNode?: SyntaxNode,
  ): Promise<Block | null> {
    if (!raw.trim()) return null;

    const isFinalized = options.forceFinalize ? true : to < fullContent.length - 1;
    let blockType = type;
    if (blockType === "table" && !isFinalized) {
      blockType = "paragraph";
    }

    const id = generateBlockId(`${from}:${blockType}`, blockType);

    const initialMeta: Record<string, unknown> = nodeType ? { lezerNodeType: nodeType } : {};
    if (type === "code" && syntaxNode) {
      const { code, info } = extractLezerCode(syntaxNode, fullContent);
      initialMeta.code = code;
      initialMeta.info = info;
    }
    if (nodeType === "SetextHeading1") {
      initialMeta.headingLevel = 1;
    } else if (nodeType === "SetextHeading2") {
      initialMeta.headingLevel = 2;
    } else if (nodeType && nodeType.startsWith("ATXHeading")) {
      const lvl = parseInt(nodeType.slice(10), 10);
      if (!Number.isNaN(lvl)) {
        initialMeta.headingLevel = lvl;
      }
    }

    const block: Block = {
      id,
      type: blockType,
      isFinalized,
      payload: {
        raw,
        meta: Object.keys(initialMeta).length > 0 ? initialMeta : undefined,
        range: { from, to },
      },
    };

    await this.enrichBlock(block);
    return block;
  }

  private parseInlineStreaming(content: string): { inline: InlineNode[]; status?: string } {
    const prepared = prepareInlineStreamingContent(content, {
      formatAnticipation: this.formatAnticipationConfig,
      math: this.enableMath,
    });
    if (prepared.kind === "raw") {
      return { inline: [{ kind: "text", text: content }], status: prepared.status };
    }
    let preparedContent = prepared.content;
    let appended = prepared.appended;
    let status = prepared.status;
    if (this.formatAnticipationConfig.regex || this.syntaxRules.some((r) => r.anticipation)) {
      const regexAppend = this.inlineParser.getRegexAnticipationAppend(content);
      if (regexAppend) {
        preparedContent += regexAppend;
        appended += regexAppend;
        status = "anticipated";
      }
    }
    const inlines = this.inlineParser.parse(preparedContent);
    return {
      inline: inlines,
      status,
    };
  }

  private async enrichBlock(block: Block): Promise<void> {
    this.inlineParser.startCollectingAttemptedReferences();
    try {
      await this.enrichBlockContent(block);
    } finally {
      this.recordLinkReferences(block, this.inlineParser.stopCollectingAttemptedReferences());
    }
  }

  /**
   * Remembers which reference labels a block tried to resolve (so a later definition can re-enrich it)
   * and publishes the resolved definitions as `meta.linkReferences` for consumers that re-parse block source.
   */
  private recordLinkReferences(block: Block, attempted: Set<string>): void {
    if (attempted.size === 0) {
      this.blockAttemptedReferences.delete(block.id);
    } else {
      this.blockAttemptedReferences.set(block.id, attempted);
    }
    const resolved: BlockResolvedLinkReference[] = [];
    for (const key of attempted) {
      const def = this.currentLinkReferences.get(key);
      if (def) {
        resolved.push(def.title !== undefined ? { label: def.label ?? key, href: def.href, title: def.title } : { label: def.label ?? key, href: def.href });
      }
    }
    const meta = block.payload.meta;
    if (resolved.length > 0) {
      block.payload.meta = { ...meta, linkReferences: resolved };
    } else if (meta && "linkReferences" in meta) {
      const { linkReferences: _stale, ...rest } = meta;
      block.payload.meta = rest;
    }
  }

  private async enrichBlockContent(block: Block): Promise<void> {
    this.performanceTimer.mark("enrich-block");
    const metrics = this.activeMetricsCollector;
    metrics?.countBlockType(block.type);
    const rawLength = typeof block.payload.raw === "string" ? block.payload.raw.length : 0;
    metrics?.recordBlockSize(block.type, rawLength);

    const shouldTrackInline =
      this.formatAnticipationConfig.inline ||
      this.formatAnticipationConfig.mathInline ||
      this.formatAnticipationConfig.mathBlock ||
      this.formatAnticipationConfig.regex ||
      this.syntaxRules.some((r) => r.anticipation);
    const allowMixed = this.formatAnticipationConfig.html || this.formatAnticipationConfig.mdx;

    switch (block.type) {
      case "heading": {
        const rawHeading = typeof block.payload.raw === "string" ? block.payload.raw : "";
        const normalizedHeading = removeHeadingMarkers(rawHeading);
        const metaLevel = (block.payload.meta as { headingLevel?: number } | undefined)?.headingLevel;
        let headingLevel = metaLevel;
        if (typeof headingLevel !== "number") {
          const atxMatch = rawHeading.match(/^#{1,6}/);
          if (atxMatch) {
            headingLevel = atxMatch[0].length;
          } else if (/(?:\r?\n)\s*=+\s*$/.test(rawHeading)) {
            headingLevel = 1;
          } else if (/(?:\r?\n)\s*-+\s*$/.test(rawHeading)) {
            headingLevel = 2;
          } else {
            headingLevel = 1;
          }
        }
        headingLevel = Math.min(Math.max(headingLevel, 1), 6);
        const baseSlug = slugifyHeading(normalizedHeading) || "heading";
        const nextCount = (this.headingIdCounts.get(baseSlug) ?? 0) + 1;
        this.headingIdCounts.set(baseSlug, nextCount);
        const headingId = nextCount > 1 ? `${baseSlug}-${nextCount}` : baseSlug;
        block.payload.meta = {
          ...(block.payload.meta ?? {}),
          headingLevel,
          headingText: normalizedHeading,
          headingId,
        };
        if (block.isFinalized) {
          block.payload.raw = normalizedHeading;
          block.payload.inline = this.inlineParser.parse(normalizedHeading);
          if (shouldTrackInline && block.payload.meta) {
            delete (block.payload.meta as Record<string, unknown>).inlineStatus;
          }
        } else {
          const parsed = this.parseInlineStreaming(normalizedHeading);
          block.payload.inline = parsed.inline;
          if (shouldTrackInline && block.payload.meta) {
            (block.payload.meta as Record<string, unknown>).inlineStatus = parsed.status;
          }
        }
        break;
      }

      case "blockquote":
        await this.prepareNestedChildren(block);
        break;

      case "paragraph": {
        const rawParagraph = typeof block.payload.raw === "string" ? block.payload.raw : "";
        const streamingParsed = !block.isFinalized ? this.parseInlineStreaming(rawParagraph) : null;
        block.payload.inline = block.isFinalized ? this.inlineParser.parse(rawParagraph) : streamingParsed?.inline ?? [{ kind: "text", text: rawParagraph }];

        const currentMeta = (block.payload.meta ?? {}) as Record<string, unknown>;
        const nextMeta: Record<string, unknown> = { ...currentMeta };
        let metaChanged = false;

        if (shouldTrackInline) {
          const desired = block.isFinalized ? undefined : streamingParsed?.status;
          if (desired !== undefined) {
            if (!Object.prototype.hasOwnProperty.call(nextMeta, "inlineStatus") || nextMeta.inlineStatus !== desired) {
              nextMeta.inlineStatus = desired;
              metaChanged = true;
            }
          } else if (Object.prototype.hasOwnProperty.call(nextMeta, "inlineStatus")) {
            delete nextMeta.inlineStatus;
            metaChanged = true;
          }
        } else if (Object.prototype.hasOwnProperty.call(nextMeta, "inlineStatus")) {
          delete nextMeta.inlineStatus;
          metaChanged = true;
        }

        const baseOffset = typeof block.payload.range?.from === "number" ? block.payload.range.from : undefined;
        const protectedRanges: ProtectedRange[] = [];
        if (this.enableMath) {
          protectedRanges.push(...collectMathProtectedRanges(rawParagraph));
        }
        const autolinkRanges = collectAutolinkProtectedRanges(rawParagraph);
        if (autolinkRanges.length > 0) {
          protectedRanges.push(...autolinkRanges);
        }

        const shouldExtractSegments = typeof rawParagraph === "string" && (rawParagraph.includes("<") || rawParagraph.includes("{"));
        if (shouldExtractSegments) {
          const mixedOptions =
            !block.isFinalized && allowMixed
              ? {
                  html: this.formatAnticipationConfig.html ? { autoClose: true, maxNewlines: MIXED_CONTENT_AUTOCLOSE_NEWLINES } : undefined,
                  mdx: this.formatAnticipationConfig.mdx
                    ? { autoClose: true, maxNewlines: MIXED_CONTENT_AUTOCLOSE_NEWLINES, componentAllowlist: this.mdxComponentAllowlist ?? undefined }
                    : undefined,
                }
              : undefined;
          const protectedRangesAbsolute =
            typeof baseOffset === "number" && protectedRanges.length > 0
              ? protectedRanges.map((range) => ({
                  ...range,
                  from: baseOffset + range.from,
                  to: baseOffset + range.to,
                }))
              : undefined;
          const mixedSegmentOptions = {
            ...mixedOptions,
            ...(protectedRangesAbsolute ? { protectedRanges: protectedRangesAbsolute } : {}),
            ...(this.htmlConfig?.allowedTags ? { allowedTags: this.htmlConfig.allowedTags } : {}),
            ...(this.htmlConfig?.literalTagContent ? { literalTagContent: this.htmlConfig.literalTagContent } : {}),
          };
          const inlineFn = block.isFinalized ? (v: string) => this.inlineParser.parse(v) : (v: string) => this.parseInlineStreaming(v).inline;
          const segments = extractMixedContentSegments(rawParagraph, baseOffset, inlineFn, mixedSegmentOptions);
          const hasStructuredSegments = segments.some((segment) => segment.kind === "mdx");
          const htmlRanges = collectHtmlProtectedRangesFromSegments(segments, baseOffset);
          if (htmlRanges.length > 0) {
            protectedRanges.push(...htmlRanges);
          }
          if (hasStructuredSegments) {
            nextMeta.mixedSegments = segments;
            metaChanged = true;
            if (allowMixed) {
              nextMeta.allowMixedStreaming = true;
              metaChanged = true;
            } else if (Object.prototype.hasOwnProperty.call(nextMeta, "allowMixedStreaming")) {
              delete nextMeta.allowMixedStreaming;
              metaChanged = true;
            }
          } else if (Object.prototype.hasOwnProperty.call(nextMeta, "mixedSegments")) {
            delete nextMeta.mixedSegments;
            metaChanged = true;
            if (Object.prototype.hasOwnProperty.call(nextMeta, "allowMixedStreaming")) {
              delete nextMeta.allowMixedStreaming;
              metaChanged = true;
            }
          }
        } else if (Object.prototype.hasOwnProperty.call(nextMeta, "mixedSegments")) {
          delete nextMeta.mixedSegments;
          metaChanged = true;
          if (Object.prototype.hasOwnProperty.call(nextMeta, "allowMixedStreaming")) {
            delete nextMeta.allowMixedStreaming;
            metaChanged = true;
          }
        }

        if (protectedRanges.length > 0) {
          nextMeta.protectedRanges = protectedRanges;
          metaChanged = true;
        } else if (Object.prototype.hasOwnProperty.call(nextMeta, "protectedRanges")) {
          delete nextMeta.protectedRanges;
          metaChanged = true;
        }

        if (!nextMeta.mixedSegments && containsInlineHtml(block.payload.inline ?? [])) {
          nextMeta.htmlParagraphTree = normalizeHtmlParagraph(block, this.htmlConfig);
          metaChanged = true;
        } else if (nextMeta.htmlParagraphTree) {
          delete nextMeta.htmlParagraphTree;
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
        await this.enrichCodeBlock(block);
        break;

      case "html": {
        const rawHtml = typeof block.payload.raw === "string" ? block.payload.raw : "";
        const sanitized = sanitizeHtmlInWorker(rawHtml, this.htmlConfig);
        block.payload.sanitizedHtml = sanitized;
        const nextMeta: Record<string, unknown> = { ...(block.payload.meta || {}), sanitized: true };
        if (!nextMeta.htmlOwnership) {
          nextMeta.htmlTree = sanitizeHtmlTreeInWorker(rawHtml, this.htmlConfig, undefined, (text) => this.inlineParser.parse(text));
        }
        if (rawHtml) {
          nextMeta.protectedRanges = [{ from: 0, to: rawHtml.length, kind: "html-block" }];
        }
        block.payload.meta = nextMeta;
        break;
      }

      case "list":
        await this.prepareNestedChildren(block);
        break;

      case "table": {
        const tableData = parseGfmTableFromTree(block.payload.raw ?? "", this.inlineParser);
        if (tableData) {
          block.payload.inline = [];
          block.payload.meta = {
            ...(block.payload.meta ?? {}),
            header: tableData.header,
            align: tableData.align,
            rows: tableData.rows,
          };
        }
        break;
      }
    }
    if (this.mdxEnabled && (block.type === "paragraph" || block.type === "html")) {
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
      if (!shouldConvertToMDX && block.type === "html") {
        const fallbackOptions = baseOffset ? { baseOffset } : undefined;
        shouldConvertToMDX = detectMDX(block.payload.raw, fallbackOptions);
      }
      metrics?.recordMdxDetect(now() - mdxDetectStart);
      if (shouldConvertToMDX && protectedRanges && protectedRanges.length > 0 && block.type !== "html") {
        const exprPattern = /\{[^{}]+\}/g;
        let match: RegExpExecArray | null;
        while (true) {
          match = exprPattern.exec(block.payload.raw);
          if (match === null) break;
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
        const originalType = block.type;
        block.payload.meta = { ...block.payload.meta, originalType };
        block.type = "mdx";
      }
    }

    const mdxState: EngineMdxState = {
      cache: this.workerMdxCache,
      inflight: this.workerMdxInflight,
      compileMode: this.mdxCompileMode,
      debugMdx: false,
    };
    await updateMdxCompilationState(mdxState, block);

    const enrichDuration = this.performanceTimer.measure("enrich-block");
    metrics?.recordEnrich(enrichDuration);
    metrics?.recordBlockEnrich(block.type, enrichDuration);
  }

  private canonicalizePreparedSnapshot(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) this.canonicalizePreparedSnapshot(child);
    } else {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (record[key] === undefined) delete record[key];
        else this.canonicalizePreparedSnapshot(record[key]);
      }
    }
  }

  private async prepareNestedChildren(block: Block): Promise<void> {
    block.payload.meta = { ...block.payload.meta, mathEnabled: this.enableMath, formatAnticipation: this.formatAnticipationConfig };
    const prepared = prepareNestedBlockSnapshot(block, this.inlineParser, this.mdParser, (text) => this.parseInlineStreaming(text).inline);
    const groupChildren = (children: NodeSnapshot[]): NodeSnapshot[] => {
      const grouped: NodeSnapshot[] = [];
      let sequence: NodeSnapshot[] = [];
      const flush = () => {
        const blocks = sequence.map((child) => child.props?.block as Block);
        const owned = groupHtmlOwnership(blocks, this.mdParser, block.payload.raw, this.htmlConfig, block.payload.range?.from ?? 0, (text) => this.inlineParser.parse(text));
        for (const child of owned) {
          const original = sequence.find((candidate) => candidate.props?.block === child);
          grouped.push(original ?? createBlockSnapshot(child));
        }
        sequence = [];
      };
      for (const child of children) {
        if (child.props?.block) sequence.push(child);
        else {
          flush();
          grouped.push(child);
        }
      }
      flush();
      return grouped;
    };
    const enrich = async (snapshot: NodeSnapshot): Promise<void> => {
      for (const child of snapshot.children ?? []) await enrich(child);
      snapshot.children = groupChildren(snapshot.children ?? []);
      const nested = snapshot.props?.block as Block | undefined;
      if (!nested) return;
      if (nested.type === "list" || nested.type === "blockquote" || nested.type === "list-item") {
        const { block: _block, ...props } = snapshot.props ?? {};
        nested.payload.meta = { ...nested.payload.meta, preparedNested: { props, children: snapshot.children ?? [] } };
      } else {
        await this.enrichBlockContent(nested);
        const updated = createBlockSnapshot(nested);
        snapshot.type = updated.type;
        snapshot.props = { ...snapshot.props, ...updated.props, inline: nested.payload.inline };
        snapshot.meta = updated.meta;
        snapshot.children = updated.children;
      }
    };
    for (const child of prepared.children) await enrich(child);
    prepared.children = groupChildren(prepared.children);
    this.canonicalizePreparedSnapshot(prepared);
    block.payload.meta = {
      ...block.payload.meta,
      ...prepared.props,
      ...(block.type === "list" ? { items: prepared.children.map((child) => child.props?.inline ?? []) } : {}),
      preparedNested: prepared,
    };
  }

  public async enrichCodeBlock(block: Block): Promise<void> {
    this.performanceTimer.mark("highlight-code");
    const metrics = this.activeMetricsCollector;

    const raw = block.payload.raw ?? "";
    const extracted = stripCodeFence(raw);
    const preparedCode = block.payload.meta?.code;
    const info = typeof block.payload.meta?.info === "string" ? block.payload.meta.info : extracted.info;
    const { lang, meta } = parseCodeFenceInfo(info);
    let diffInfo = detectDiffLanguage(lang, meta);
    const codeBody = typeof preparedCode === "string" ? preparedCode
      : extracted.hadFence ? dedentFencedCodeByClosingIndent(raw, extracted.code) : dedentIndentedCode(raw);
    const codeLines = codeBody.split("\n");
    if (!diffInfo.isDiff && this.emitDiffBlocks && looksLikeUnifiedDiff(codeLines)) {
      diffInfo = {
        isDiff: true,
        diffLang: "diff",
        baseLang: guessLanguageFromDiffLines(codeLines),
      };
    }
    const requestedLanguage = diffInfo.isDiff ? diffInfo.diffLang : lang || "text";
    const tokenLanguage = diffInfo.isDiff ? diffInfo.baseLang ?? "text" : requestedLanguage;
    const baseMeta = (block.payload.meta ?? {}) as Record<string, unknown>;
    let resolvedLanguage = requestedLanguage;
    let resolvedTokenLanguage = tokenLanguage;
    const hasHighlighter = Boolean(this.highlighter);
    const hasHighlightableContent = codeBody.trim().length > 0;
    const wantsHtml = this.highlightOutputMode === "html" || this.highlightOutputMode === "both";
    const wantsTokens = (this.highlightOutputMode === "tokens" || this.highlightOutputMode === "both") && this.emitHighlightTokens;
    const wantsTokensNow = wantsTokens && (block.isFinalized || this.liveTokenizationEnabled);

    if (!block.isFinalized) {
      if (this.codeHighlightingMode === "final" || !hasHighlighter || !hasHighlightableContent) {
        this.incrementalHighlightStates.delete(block.id);
        block.payload.highlightedHtml = undefined;
        const nextMeta = { ...baseMeta, ...meta, lang: requestedLanguage, highlightLang: resolvedLanguage } as Record<string, unknown>;
        nextMeta.code = codeBody;
        delete nextMeta.highlightedLines;
        delete nextMeta.tokenLines;
        delete nextMeta.diffKind;
        delete nextMeta.oldNo;
        delete nextMeta.newNo;
        delete nextMeta.diffBlocks;
        block.payload.meta = nextMeta;
        return;
      }

      if (this.codeHighlightingMode === "incremental") {
        if (hasHighlighter) {
          if (wantsHtml) {
            resolvedLanguage = await resolveHighlightLanguage(this.highlighter, requestedLanguage);
          }
          if (wantsTokens) {
            resolvedTokenLanguage = await resolveHighlightLanguage(this.highlighter, tokenLanguage);
          }
        }
        let state = this.incrementalHighlightStates.get(block.id);
        if (!state || state.lang !== resolvedLanguage || (wantsTokens && state.tokenLang && state.tokenLang !== resolvedTokenLanguage) || codeBody.length < state.processedLength) {
          state = {
            lang: resolvedLanguage,
            tokenLang: wantsTokens ? resolvedTokenLanguage : undefined,
            processedLength: 0,
            pendingLine: "",
            highlightedLines: [],
            tokenLines: [],
            diffKind: [],
            oldNo: [],
            newNo: [],
            diffCursor: undefined,
            grammarState: undefined,
          };
          this.incrementalHighlightStates.set(block.id, state);
        }
        state.tokenLang = wantsTokens ? resolvedTokenLanguage : undefined;

        const appended = codeBody.slice(state.processedLength);
        const combined = state.pendingLine + appended;
        const diffEnabled = diffInfo.isDiff && wantsTokensNow;
        if (combined.length > 0) {
          const parts = combined.split("\n");
          const completeLines = parts.slice(0, -1);
          const tail = parts.length > 0 ? parts[parts.length - 1] ?? "" : "";
          if (completeLines.length > 0) {
            if (wantsHtml || (wantsTokensNow && !diffEnabled)) {
              try {
                const sharedLanguage = wantsHtml ? resolvedLanguage : resolvedTokenLanguage;
                const tokens = this.highlighter?.codeToTokensWithThemes(completeLines.join("\n"), {
                  lang: sharedLanguage as never,
                  themes: CODE_HIGHLIGHT_THEMES,
                  grammarState: state.grammarState as never,
                } as never) as ShikiThemedToken[][];
                if (wantsHtml) {
                  const htmlLines = renderShikiLines(tokens);
                  state.highlightedLines.push(...htmlLines);
                }
                if (wantsTokensNow && !diffEnabled) {
                  const tokenLines = renderTokenLines(tokens);
                  state.tokenLines.push(...tokenLines);
                }
                state.grammarState = this.highlighter?.getLastGrammarState(tokens as never);
              } catch (error) {
                console.warn("Incremental highlighting failed for", requestedLanguage, error);
                if (wantsHtml) {
                  state.highlightedLines.push(...completeLines.map(() => null));
                }
                if (wantsTokensNow && !diffEnabled) {
                  state.tokenLines.push(...completeLines.map(() => null));
                }
              }
            }

            if (wantsTokensNow && diffEnabled) {
              const cursor = state.diffCursor ?? { oldLine: null, newLine: null };
              const diffLines = completeLines.map((line) => parseUnifiedDiffLine(line, cursor));
              state.diffCursor = cursor;
              state.diffKind.push(...diffLines.map((line) => toDiffLineKind(line.kind)));
              state.oldNo.push(...diffLines.map((line) => line.oldNo ?? null));
              state.newNo.push(...diffLines.map((line) => line.newNo ?? null));

              if (this.highlighter) {
                const grammarObj = { context: state.grammarState };
                const { tokenLines, grammarState: nextState } = await buildDiffTokenLines(
                  diffLines,
                  resolvedTokenLanguage,
                  grammarObj,
                  this.highlighter,
                );
                state.grammarState = nextState.context;
                state.tokenLines.push(...tokenLines);
              } else {
                state.tokenLines.push(...completeLines.map(() => null));
              }
            }
          }
          state.pendingLine = tail;
          state.processedLength = codeBody.length;
        }

        const nextMeta: Record<string, unknown> = {
          ...baseMeta,
          ...meta,
          lang: requestedLanguage,
          highlightLang: resolvedLanguage,
          code: codeBody,
        };
        if (wantsHtml) {
          nextMeta.highlightedLines = [...state.highlightedLines];
        }
        if (wantsTokensNow) {
          nextMeta.tokenLines = state.tokenLines;
          if (diffEnabled) {
            nextMeta.diffKind = state.diffKind;
            nextMeta.oldNo = state.oldNo;
            nextMeta.newNo = state.newNo;
          } else {
            if ("diffKind" in nextMeta) delete nextMeta.diffKind;
            if ("oldNo" in nextMeta) delete nextMeta.oldNo;
            if ("newNo" in nextMeta) delete nextMeta.newNo;
          }
        } else if ("tokenLines" in nextMeta) {
          delete nextMeta.tokenLines;
          if ("diffKind" in nextMeta) delete nextMeta.diffKind;
          if ("oldNo" in nextMeta) delete nextMeta.oldNo;
          if ("newNo" in nextMeta) delete nextMeta.newNo;
        }
        if (this.emitDiffBlocks && diffInfo.isDiff && this.liveTokenizationEnabled) {
          const cursor: DiffCursorState = { oldLine: null, newLine: null };
          const diffLines = codeLines.map((line) => parseUnifiedDiffLine(line, cursor));
          nextMeta.diffBlocks = buildDiffBlocksFromLines(
            diffLines,
            codeLines,
            wantsTokensNow ? state.tokenLines : null,
            diffInfo.baseLang ?? null,
          );
        } else if ("diffBlocks" in nextMeta) {
          delete nextMeta.diffBlocks;
        }
        block.payload.meta = nextMeta;
        return;
      }
    }

    if (
      block.isFinalized &&
      shouldLazyTokenizeBlock(
        this.lazyTokenizationEnabled,
        codeLines.length,
        this.lazyTokenizationThresholdLines,
        hasHighlighter,
        hasHighlightableContent,
      ) &&
      (wantsHtml || wantsTokens)
    ) {
      if (hasHighlighter) {
        if (wantsHtml) {
          resolvedLanguage = await resolveHighlightLanguage(this.highlighter, requestedLanguage);
        }
        if (wantsTokens) {
          resolvedTokenLanguage = await resolveHighlightLanguage(this.highlighter, tokenLanguage);
        }
      }
      const diffEnabled = diffInfo.isDiff && wantsTokens;
      const signature = makeLazySignature(codeBody, resolvedLanguage, resolvedTokenLanguage, diffEnabled);
      const state = getOrInitLazyState(
        this.lazyTokenizationStates,
        block.id,
        signature,
        codeLines.length,
        resolvedLanguage,
        resolvedTokenLanguage,
        diffEnabled,
      );
      const effectiveLang = wantsHtml ? resolvedLanguage : resolvedTokenLanguage;
      const nextMeta = { ...baseMeta, ...meta, lang: requestedLanguage, highlightLang: effectiveLang } as Record<string, unknown>;
      nextMeta.code = codeBody;
      nextMeta.lazyTokenization = true;
      nextMeta.lazyTokenizedUntil = state.processedLines;
      if (wantsHtml) {
        nextMeta.highlightedLines = state.highlightedLines;
      } else if ("highlightedLines" in nextMeta) {
        delete nextMeta.highlightedLines;
      }
      if (wantsTokens) {
        nextMeta.tokenLines = state.tokenLines;
        if (diffEnabled) {
          nextMeta.diffKind = state.diffKind;
          nextMeta.oldNo = state.oldNo;
          nextMeta.newNo = state.newNo;
        } else {
          if ("diffKind" in nextMeta) delete nextMeta.diffKind;
          if ("oldNo" in nextMeta) delete nextMeta.oldNo;
          if ("newNo" in nextMeta) delete nextMeta.newNo;
        }
      } else if ("tokenLines" in nextMeta) {
        delete nextMeta.tokenLines;
        if ("diffKind" in nextMeta) delete nextMeta.diffKind;
        if ("oldNo" in nextMeta) delete nextMeta.oldNo;
        if ("newNo" in nextMeta) delete nextMeta.newNo;
      }
      if (this.emitDiffBlocks && diffInfo.isDiff) {
        const cursor: DiffCursorState = { oldLine: null, newLine: null };
        const diffLines = codeLines.map((line) => parseUnifiedDiffLine(line, cursor));
        nextMeta.diffBlocks = buildDiffBlocksFromLines(diffLines, codeLines, wantsTokens ? state.tokenLines : null, diffInfo.baseLang ?? null);
      } else if ("diffBlocks" in nextMeta) {
        delete nextMeta.diffBlocks;
      }
      block.payload.highlightedHtml = undefined;
      block.payload.meta = nextMeta;
      return;
    }

    if (hasHighlighter) {
      if (wantsHtml) {
        resolvedLanguage = await resolveHighlightLanguage(this.highlighter, requestedLanguage);
      }
      if (wantsTokens) {
        resolvedTokenLanguage = await resolveHighlightLanguage(this.highlighter, tokenLanguage);
      }
    }

    const nextMeta: Record<string, unknown> = {
      ...baseMeta,
      ...meta,
      lang: requestedLanguage,
      highlightLang: resolvedLanguage,
      code: codeBody,
    };

    if (wantsHtml && hasHighlighter && hasHighlightableContent) {
      const cacheKey = `${resolvedLanguage}::${codeBody}`;
      const cached = this.codeHighlightCache.get(cacheKey);
      if (cached) {
        block.payload.highlightedHtml = cached.html;
      } else {
        try {
          const highlighted = this.highlighter!.codeToHtml(codeBody, {
            lang: resolvedLanguage as never,
            themes: CODE_HIGHLIGHT_THEMES,
            defaultColor: false,
          });
          const enhanced = enhanceHighlightedHtml(highlighted, resolvedLanguage);
          block.payload.highlightedHtml = enhanced;
          if (this.codeHighlightCache.size >= MAX_CODE_HIGHLIGHT_CACHE_ENTRIES) {
            const first = this.codeHighlightCache.keys().next().value;
            if (typeof first === "string") {
              this.codeHighlightCache.delete(first);
            }
          }
          this.codeHighlightCache.set(cacheKey, { html: enhanced, lang: resolvedLanguage });
        } catch (error) {
          console.warn("Shiki codeToHtml failed:", error);
        }
      }
    }

    let tokenLines: Array<TokenLineV1 | null> | undefined;
    let diffKind: Array<DiffKind | null> | undefined;
    let diffOldNo: Array<number | null> | undefined;
    let diffNewNo: Array<number | null> | undefined;

    if (wantsTokens) {
      let diffLines: string[] = [];
      if (diffInfo.isDiff) {
        diffLines = codeBody.length > 0 ? codeBody.split("\n") : [];
        const cursor: DiffCursorState = { oldLine: null, newLine: null };
        const diffInfoLines = diffLines.map((line) => parseUnifiedDiffLine(line, cursor));
        diffKind = diffInfoLines.map((line) => line.kind);
        diffOldNo = diffInfoLines.map((line) => line.oldNo ?? null);
        diffNewNo = diffInfoLines.map((line) => line.newNo ?? null);
        if (!hasHighlighter || !hasHighlightableContent) {
          tokenLines = diffInfoLines.map((line) =>
            (line.text ?? line.raw).length > 0 ? { spans: [{ t: line.text ?? line.raw }] } : { spans: [] },
          );
        } else {
          try {
            const { tokenLines: diffTokens } = await buildDiffTokenLines(
              diffInfoLines,
              resolvedTokenLanguage,
              {},
              this.highlighter!,
            );
            tokenLines = diffTokens;
          } catch (error) {
            console.warn("Diff tokenization failed for", requestedLanguage, error);
            tokenLines = new Array(codeLines.length).fill(null);
          }
        }
      } else if (!hasHighlighter || !hasHighlightableContent) {
        tokenLines = codeLines.map((line) => (line.length > 0 ? { spans: [{ t: line }] } : { spans: [] }));
      } else {
        try {
          const tokens = this.highlighter!.codeToTokensWithThemes(codeBody, {
            lang: resolvedTokenLanguage as never,
            themes: CODE_HIGHLIGHT_THEMES,
          }) as ShikiThemedToken[][];
          tokenLines = renderTokenLines(tokens);
        } catch (error) {
          console.warn("Shiki codeToTokens failed:", error);
          tokenLines = new Array(codeLines.length).fill(null);
        }
      }
    }

    if (wantsTokens) {
      nextMeta.tokenLines = tokenLines ?? [];
      if (diffKind) {
        nextMeta.diffKind = diffKind;
        nextMeta.oldNo = diffOldNo ?? [];
        nextMeta.newNo = diffNewNo ?? [];
      } else {
        if ("diffKind" in nextMeta) delete nextMeta.diffKind;
        if ("oldNo" in nextMeta) delete nextMeta.oldNo;
        if ("newNo" in nextMeta) delete nextMeta.newNo;
      }
    } else if ("tokenLines" in nextMeta) {
      delete nextMeta.tokenLines;
      if ("diffKind" in nextMeta) delete nextMeta.diffKind;
      if ("oldNo" in nextMeta) delete nextMeta.oldNo;
      if ("newNo" in nextMeta) delete nextMeta.newNo;
    }
    if (this.emitDiffBlocks && diffInfo.isDiff) {
      const cursor: DiffCursorState = { oldLine: null, newLine: null };
      const diffLines = codeLines.map((line) => parseUnifiedDiffLine(line, cursor));
      nextMeta.diffBlocks = buildDiffBlocksFromLines(
        diffLines,
        codeLines,
        wantsTokens ? ((nextMeta.tokenLines as Array<TokenLineV1 | null>) ?? null) : null,
        diffInfo.baseLang ?? null,
      );
    } else if ("diffBlocks" in nextMeta) {
      delete nextMeta.diffBlocks;
    }

    block.payload.meta = nextMeta;
  }

  private runDocumentPlugins(inputBlocks: Block[], content: string): Block[] {
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

    const { syntheticBlocks } = this.documentPluginRegistry.run({
      content,
      blocks,
      state: this.documentPluginState,
      protectedRanges: aggregatedProtected,
    });

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

  private async emitDocumentPatch(currentBlocks: Block[]): Promise<void> {
    const patches: Patch[] = [];
    const { patch: tocPatch, nextHeadings, nextSignature } = maybeBuildTocPatch(currentBlocks, this.tocSignature);
    this.tocHeadings = nextHeadings;
    this.tocSignature = nextSignature;

    
    for (let index = 0; index < currentBlocks.length; index++) {
      const block = currentBlocks[index];
      if (!block) continue;
      patches.push({
        op: "insertChild",
        at: { blockId: PATCH_ROOT_ID },
        index,
        node: createBlockSnapshot(block),
      });
    }
    if (tocPatch) {
      patches.push(tocPatch);
    }
    if (patches.length > 0) {
      const tx = ++this.txCounter;
      const parseEpochCounterRef = { value: this.parseEpochCounter };
      const streamSeqCounterRef = { value: this.patchStreamSeq };
      const { patches: annotated, parseEpoch } = ensureAnnotatedPatchBatch(
        patches,
        tx,
        parseEpochCounterRef,
        streamSeqCounterRef,
        undefined,
        this.emittedBlockEpochs,
      );
      this.parseEpochCounter = parseEpochCounterRef.value;
      this.patchStreamSeq = streamSeqCounterRef.value;
      syncEmittedBlockEpochsFromPatches(annotated, parseEpoch, this.emittedBlockEpochs);
      this.post({
        type: "PATCH",
        tx,
        patches: annotated,
      });
    }
  }

  private async emitBlockDiffPatches(
    previousBlocks: Block[],
    nextBlocks: Block[],
    changedRanges: ContentChangeRange[],
    metrics?: WorkerMetricsCollector | null,
    parseEpoch?: number,
    extraPatches: Patch[] = [],
  ): Promise<void> {
    const patches: Patch[] = [];
    const { patch: tocPatch, nextHeadings, nextSignature } = maybeBuildTocPatch(nextBlocks, this.tocSignature);
    this.tocHeadings = nextHeadings;
    this.tocSignature = nextSignature;

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
          node: createBlockSnapshot(nextBlocks[targetIndex]),
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
          node: createBlockSnapshot(block),
        });
      }
    }

    metrics?.markDiffStart();
    const { patches: contentPatches } = await this.diffBlockContent(previousBlocks, nextBlocks, changedRanges, metrics);
    metrics?.markDiffEnd();

    const combined = patches.concat(extraPatches, contentPatches);
    if (tocPatch) {
      combined.push(tocPatch);
    }

    let paragraphLimit: number | null = null;
    if (this.workerCredits < 0.9) {
      const dynamicBase = this.workerCredits < 0.5 ? 48 : 96;
      const dynamicFinalize = this.workerCredits < 0.5 ? 40 : 64;
      paragraphLimit = computeParagraphPatchLimit(combined, {
        baseLimit: dynamicBase,
        finalizeLimit: dynamicFinalize,
      });
    }

    const parseEpochCounterRef = { value: this.parseEpochCounter };
    const streamSeqCounterRef = { value: this.patchStreamSeq };
    const annotatedCombined = ensureAnnotatedPatchBatch(
      combined,
      this.txCounter + 1,
      parseEpochCounterRef,
      streamSeqCounterRef,
      parseEpoch,
      this.emittedBlockEpochs,
    ).patches;
    this.parseEpochCounter = parseEpochCounterRef.value;
    this.patchStreamSeq = streamSeqCounterRef.value;

    const immediatePatches = partitionPatchesForCredits(
      annotatedCombined,
      this.workerCredits,
      this.deferredPatchQueue,
      paragraphLimit === null ? undefined : paragraphLimit,
    );
    if (this.deferredPatchQueue.length > this.maxDeferredQueueSize) {
      this.maxDeferredQueueSize = this.deferredPatchQueue.length;
    }

    let structuralCount = 0;
    for (const patch of patches) {
      if (patch.op === "insertChild" || patch.op === "deleteChild" || patch.op === "replaceChild" || patch.op === "reorder") {
        structuralCount += 1;
      }
    }
    this.lastDiffSummary = {
      prevCount: previousBlocks.length,
      nextCount: nextBlocks.length,
      prefix,
      removeCount,
      addCount,
      structuralPatches: structuralCount,
      contentPatches: contentPatches.length,
      immediatePatches: immediatePatches.length,
      deferredQueue: this.deferredPatchQueue.length,
    };
    if (addCount > 0 || removeCount > 0 || structuralCount > 0 || this.deferredPatchQueue.length > 0) {
      this.lastStructuralDiffSummary = { ...(this.lastDiffSummary as Record<string, unknown>) };
    }

    if (immediatePatches.length > 0) {
      this.maxEmittedBlockCount = Math.max(this.maxEmittedBlockCount, nextBlocks.length);
    }
    if (structuralCount > 0) {
      this.maxStructuralBlockCount = Math.max(this.maxStructuralBlockCount, nextBlocks.length);
    }

    if (immediatePatches.length === 0) {
      if (metrics) {
        metrics.finalizePatch(this.txCounter, 0, this.deferredPatchQueue.length, 0);
        if (this.activeMetricsCollector === metrics) {
          this.activeMetricsCollector = null;
        }
      }
      return;
    }

    this.dispatchPatchBatch(immediatePatches, metrics);
  }

  private async diffBlockContent(
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
        const nextSanitized = nextBlock.payload.sanitizedHtml ?? sanitizeHtmlInWorker(nextBlock.payload.raw ?? "", this.htmlConfig);
        const prevSanitized = prevBlock.payload.sanitizedHtml ?? "";
        if (prevSanitized !== nextSanitized || !blocksStructurallyEqual(prevBlock, nextBlock)) {
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

      const prevSnapshot = createBlockSnapshot(prevBlock);
      const nextSnapshot = createBlockSnapshot(nextBlock);
      diffNodeSnapshot(nextBlock.id, prevSnapshot, nextSnapshot, patches, metrics);
    }

    return { patches, changedBlockCount: changedBlockIds.size };
  }

  private dispatchPatchBatch(patches: Patch[], metrics?: WorkerMetricsCollector | null): void {
    if (!patches || patches.length === 0) {
      return;
    }

    const tx = ++this.txCounter;
    const parseEpochCounterRef = { value: this.parseEpochCounter };
    const streamSeqCounterRef = { value: this.patchStreamSeq };
    const { patches: annotatedPatches, parseEpoch } = ensureAnnotatedPatchBatch(
      patches,
      tx,
      parseEpochCounterRef,
      streamSeqCounterRef,
      undefined,
      this.emittedBlockEpochs,
    );
    this.parseEpochCounter = parseEpochCounterRef.value;
    this.patchStreamSeq = streamSeqCounterRef.value;

    syncEmittedBlockEpochsFromPatches(annotatedPatches, parseEpoch, this.emittedBlockEpochs);
    const patchBytes = metrics ? estimatePatchSize(annotatedPatches) : 0;
    metrics?.finalizePatch(tx, annotatedPatches.length, this.deferredPatchQueue.length, patchBytes);
    const changedBlockReport = countChangedBlocksFromPatches(annotatedPatches);
    const patchMetrics: PatchMetrics = metrics
      ? metrics.toPatchMetrics(changedBlockReport)
      : {
          patchCount: annotatedPatches.length,
          changedBlocks: changedBlockReport,
        };

    const message: WorkerOut = {
      type: "PATCH",
      tx,
      patches: annotatedPatches,
      metrics: patchMetrics,
    };

    reportWorkerStructuralInvariantViolations("dispatchPatchBatch", this.blocks, this.lastWorkerInvariantSignature);
    metrics?.beginSerialize();
    this.post(message);
    metrics?.endSerialize();

    if (metrics && this.activeMetricsCollector === metrics) {
      this.activeMetricsCollector = null;
    }
  }

  private async finalizeAllBlocks(): Promise<void> {
    const metricsCollector = new WorkerMetricsCollector(this.workerGrammarEngine);
    this.activeMetricsCollector = metricsCollector;
    this.deferredPatchQueue = [];
    this.lazyTokenizationQueue.clear();

    const prevBlocks = this.blocks.map((block) => cloneBlock(block));
    const finalizePatches: Patch[] = [];
    for (const block of this.blocks) {
      if (!block.isFinalized) {
        block.isFinalized = true;
        finalizePatches.push({
          op: "finalize",
          at: { blockId: block.id },
        });
      }
    }

    const { blocks: reparsedBlocks, lastTree: reparsedTree } = await this.parseAll(this.currentContent, { forceFinalize: true });
    const mdxState: EngineMdxState = {
      cache: this.workerMdxCache,
      inflight: this.workerMdxInflight,
      compileMode: this.mdxCompileMode,
      debugMdx: false,
    };
    for (const block of reparsedBlocks) {
      block.isFinalized = true;
      await updateMdxCompilationState(mdxState, block);
    }

    this.blocks = reparsedBlocks;
    this.lastTree = reparsedTree;
    this.treeFragments = TreeFragment.addTree(reparsedTree);
    metricsCollector.setBlocksProduced(this.blocks.length);

    const fullRange = [
      {
        fromA: 0,
        toA: this.currentContent.length,
        fromB: 0,
        toB: this.currentContent.length,
      },
    ];
    this.parseEpochCounter += 1;
    const finalParseEpoch = this.parseEpochCounter;
    await this.emitBlockDiffPatches(prevBlocks, this.blocks, fullRange, metricsCollector, finalParseEpoch, finalizePatches);
    if (finalizePatches.length > 0) {
      await this.dispatchFinalCanonicalSnapshot(this.blocks);
    }

    if (this.deferredPatchQueue.length > 0) {
      const previousCredits = this.workerCredits;
      this.workerCredits = 1;
      const maxIterations = Math.ceil(this.deferredPatchQueue.length / MAX_DEFERRED_FLUSH_PATCHES) + 8;

      for (let i = 0; i < maxIterations && this.deferredPatchQueue.length > 0; i++) {
        const before = this.deferredPatchQueue.length;
        this.flushDeferredPatches({ ignoreCredits: true });
        if (this.deferredPatchQueue.length >= before) {
          break;
        }
      }

      this.workerCredits = previousCredits;
    }

    reportWorkerStructuralInvariantViolations("finalizeAllBlocks", this.blocks, this.lastWorkerInvariantSignature);
    this.post({
      type: "FINALIZED",
    });

    if (this.activeMetricsCollector === metricsCollector) {
      this.activeMetricsCollector = null;
    }
  }

  private async dispatchFinalCanonicalSnapshot(finalBlocks: Block[]): Promise<void> {
    const patches: Patch[] = [];
    
    for (let index = 0; index < finalBlocks.length; index++) {
      const block = finalBlocks[index];
      if (!block) continue;
      patches.push({
        op: "replaceChild",
        at: { blockId: PATCH_ROOT_ID },
        index,
        node: createBlockSnapshot(block),
      });
    }
    this.dispatchPatchBatch(patches);
  }

  private flushDeferredPatches(options?: { ignoreCredits?: boolean }): void {
    if (this.workerCredits <= 0 || this.deferredPatchQueue.length === 0) {
      return;
    }
    const immediate = partitionPatchesForCredits(
      [],
      this.workerCredits,
      this.deferredPatchQueue,
      MAX_DEFERRED_FLUSH_PATCHES,
      options,
    );
    if (immediate.length === 0) {
      return;
    }

    const metricsCollector = new WorkerMetricsCollector(this.workerGrammarEngine);
    metricsCollector.setBlocksProduced(this.blocks.length);
    this.dispatchPatchBatch(immediate, metricsCollector);
  }
  private handleMdxStatus(blockId: string, update: MdxStatusUpdate): void {
    if (this.mdxCompileMode === "worker") {
      return;
    }
    const { updatedBlock } = applyMdxStatusUpdate(this.blocks, blockId, update);
    if (!updatedBlock) return;

    reportWorkerStructuralInvariantViolations("handleMdxStatus", this.blocks, this.lastWorkerInvariantSignature);
    this.dispatchPatchBatch([
      withPatchKind(
        {
          op: "setProps",
          at: { blockId },
          props: {
            block: updatedBlock,
          },
        },
        "semantic",
      ),
    ]);
  }

  private scheduleLazyTokenizationProcessing(): void {
    if (this.lazyTokenizationScheduled) return;
    this.lazyTokenizationScheduled = true;
    const generation = this.documentGeneration;
    queueMicrotask(async () => {
      if (this.disposed || generation !== this.documentGeneration) return;
      this.lazyTokenizationScheduled = false;
      await this.processLazyTokenizationQueue();
    });
  }

  private async processLazyTokenizationQueue(): Promise<void> {
    if (this.lazyTokenizationProcessing) return;
    this.lazyTokenizationProcessing = true;
    const generation = this.documentGeneration;
    try {
      while (!this.disposed && generation === this.documentGeneration && this.lazyTokenizationQueue.size > 0) {
        const next = selectNextLazyRequest(this.lazyTokenizationQueue);
        if (!next) break;
        this.lazyTokenizationQueue.delete(next.blockId);
        await this.handleLazyTokenizationRequest(next);
      }
    } finally {
      if (generation === this.documentGeneration) this.lazyTokenizationProcessing = false;
    }
  }

  private findPreparedCode(blockId: string): { rootIndex: number; block: Block } | undefined {
    const seen = new WeakSet<object>();
    const findTree = (tree: HtmlTreeNode[]): Block | undefined => {
      for (const node of tree) {
        const block = node.kind === "block" ? findBlock(node.block)
          : node.kind === "element" ? findTree(node.children) : undefined;
        if (block) return block;
      }
      return undefined;
    };
    const findSnapshots = (children: NodeSnapshot[]): Block | undefined => {
      for (const snapshot of children) {
        if (seen.has(snapshot)) continue;
        seen.add(snapshot);
        const block = snapshot.props?.block as Block | undefined;
        const found = block ? findBlock(block) : undefined;
        if (found) return found;
        if (snapshot.type === "code") continue;
        const nested = findSnapshots(snapshot.children ?? []);
        if (nested) return nested;
      }
      return undefined;
    };
    const findBlock = (block: Block): Block | undefined => {
      if (block.id === blockId && block.type === "code") return block;
      if (seen.has(block)) return undefined;
      seen.add(block);
      const meta = block.payload.meta;
      const prepared = meta?.preparedNested as PreparedNestedSnapshot | undefined;
      const nested = prepared ? findSnapshots(prepared.children) : undefined;
      if (nested) return nested;
      for (const key of ["htmlTree", "htmlParagraphTree"]) {
        const tree = meta?.[key] as HtmlTreeNode[] | undefined;
        const owned = tree ? findTree(tree) : undefined;
        if (owned) return owned;
      }
      return undefined;
    };
    for (let rootIndex = 0; rootIndex < this.blocks.length; rootIndex++) {
      const block = findBlock(this.blocks[rootIndex]);
      if (block) return { rootIndex, block };
    }
    return undefined;
  }

  private replacePreparedCode(root: Block, updated: Block): Block {
    if (root.id === updated.id) return updated;
    const codeSnapshot = createBlockSnapshot(updated);
    this.canonicalizePreparedSnapshot(codeSnapshot);
    const codeBlock = codeSnapshot.props?.block as Block;
    const replaced = new WeakMap<object, object>();
    const mapChanged = <T>(values: T[], map: (value: T) => T): T[] => {
      let result: T[] | undefined;
      for (let index = 0; index < values.length; index++) {
        const value = map(values[index]);
        if (value === values[index]) continue;
        if (!result) result = values.slice();
        result[index] = value;
      }
      return result ?? values;
    };
    const replaceTreeNode = (node: HtmlTreeNode): HtmlTreeNode => {
      const cached = replaced.get(node) as HtmlTreeNode | undefined;
      if (cached) return cached;
      let result = node;
      if (node.kind === "block") {
        const block = replaceBlock(node.block);
        if (block !== node.block) result = { ...node, block };
      } else if (node.kind === "element") {
        const children = mapChanged(node.children, replaceTreeNode);
        if (children !== node.children) result = { ...node, children };
      }
      replaced.set(node, result);
      return result;
    };
    const replaceMeta = (meta: Record<string, unknown>): Record<string, unknown> => {
      const cached = replaced.get(meta) as Record<string, unknown> | undefined;
      if (cached) return cached;
      let result = meta;
      const set = (key: string, value: unknown) => {
        if (value === meta[key]) return;
        if (result === meta) result = { ...meta };
        result[key] = value;
      };
      const prepared = meta.preparedNested as PreparedNestedSnapshot | undefined;
      if (prepared) {
        const children = mapChanged(prepared.children, replaceSnapshot);
        set("preparedNested", children === prepared.children ? prepared : { ...prepared, children });
      }
      for (const key of ["htmlTree", "htmlParagraphTree"]) {
        const tree = meta[key] as HtmlTreeNode[] | undefined;
        if (tree) set(key, mapChanged(tree, replaceTreeNode));
      }
      replaced.set(meta, result);
      return result;
    };
    const replaceBlock = (block: Block): Block => {
      if (block.id === updated.id) return codeBlock;
      const cached = replaced.get(block) as Block | undefined;
      if (cached) return cached;
      const meta = block.payload.meta ? replaceMeta(block.payload.meta) : block.payload.meta;
      const result = meta === block.payload.meta ? block : { ...block, payload: { ...block.payload, meta } };
      replaced.set(block, result);
      return result;
    };
    const replaceSnapshot = (snapshot: NodeSnapshot): NodeSnapshot => {
      if (snapshot.id === updated.id) return { ...codeSnapshot, props: { ...snapshot.props, ...codeSnapshot.props } };
      if (snapshot.type === "code") return snapshot;
      const cached = replaced.get(snapshot) as NodeSnapshot | undefined;
      if (cached) return cached;
      const block = snapshot.props?.block as Block | undefined;
      const nextBlock = block ? replaceBlock(block) : undefined;
      const meta = snapshot.meta ? replaceMeta(snapshot.meta) : snapshot.meta;
      const children = snapshot.children ? mapChanged(snapshot.children, replaceSnapshot) : snapshot.children;
      const result = nextBlock === block && meta === snapshot.meta && children === snapshot.children ? snapshot : {
        ...snapshot,
        ...(nextBlock !== block ? { props: { ...snapshot.props, block: nextBlock } } : {}),
        ...(meta !== snapshot.meta ? { meta } : {}),
        ...(children !== snapshot.children ? { children } : {}),
      };
      replaced.set(snapshot, result);
      return result;
    };
    return replaceBlock(root);
  }

  private async handleLazyTokenizationRequest(request: LazyTokenizationRequest): Promise<void> {
    if (!this.lazyTokenizationEnabled || !this.highlighter) return;
    const generation = this.documentGeneration;
    const target = this.findPreparedCode(request.blockId);
    if (!target) return;
    const { block } = target;
    if (block.type !== "code" || !block.isFinalized) return;
    const currentTarget = () => {
      if (this.disposed || generation !== this.documentGeneration) return undefined;
      const current = this.findPreparedCode(block.id);
      return current?.block === block ? current : undefined;
    };

    const raw = block.payload.raw ?? "";
    const extracted = stripCodeFence(raw);
    const info = typeof block.payload.meta?.info === "string" ? block.payload.meta.info : extracted.info;
    const { lang, meta } = parseCodeFenceInfo(info);
    const codeBody = typeof block.payload.meta?.code === "string" ? block.payload.meta.code
      : extracted.hadFence ? dedentFencedCodeByClosingIndent(raw, extracted.code) : dedentIndentedCode(raw);
    const codeLines = codeBody.replace(/\r\n?/g, "\n").split("\n");
    let diffInfo = detectDiffLanguage(lang, meta);
    if (!diffInfo.isDiff && this.emitDiffBlocks && looksLikeUnifiedDiff(codeLines)) {
      diffInfo = {
        isDiff: true,
        diffLang: "diff",
        baseLang: guessLanguageFromDiffLines(codeLines),
      };
    }
    const requestedLanguage = diffInfo.isDiff ? diffInfo.diffLang : lang || "text";
    const tokenLanguage = diffInfo.isDiff ? diffInfo.baseLang ?? "text" : requestedLanguage;
    const hasHighlightableContent = codeBody.trim().length > 0;
    if (!shouldLazyTokenizeBlock(this.lazyTokenizationEnabled, codeLines.length, this.lazyTokenizationThresholdLines, Boolean(this.highlighter), hasHighlightableContent)) {
      return;
    }

    const wantsHtml = this.highlightOutputMode === "html" || this.highlightOutputMode === "both";
    const wantsTokens = (this.highlightOutputMode === "tokens" || this.highlightOutputMode === "both") && this.emitHighlightTokens;
    const diffEnabled = diffInfo.isDiff && wantsTokens;
    if (!wantsHtml && !wantsTokens) return;

    const { startLine, endLine } = clampLazyRange(request.startLine, request.endLine, codeLines.length);
    if (endLine <= startLine) return;

    let resolvedLanguage = requestedLanguage;
    let resolvedTokenLanguage = tokenLanguage;
    if (wantsHtml) {
      resolvedLanguage = await resolveHighlightLanguage(this.highlighter, requestedLanguage);
      if (!currentTarget()) return;
    }
    if (wantsTokens) {
      resolvedTokenLanguage = await resolveHighlightLanguage(this.highlighter, tokenLanguage);
      if (!currentTarget()) return;
    }

    const signature = makeLazySignature(codeBody, resolvedLanguage, resolvedTokenLanguage, diffEnabled);
    const state = getOrInitLazyState(this.lazyTokenizationStates, block.id, signature, codeLines.length, resolvedLanguage, resolvedTokenLanguage, diffEnabled);
    if (state.processedLines < 0 || state.processedLines > codeLines.length) {
      state.processedLines = 0;
    }

    const targetEnd = Math.min(endLine, codeLines.length);
    if (targetEnd <= state.processedLines) {
      return;
    }

    const metricsCollector = new WorkerMetricsCollector(this.workerGrammarEngine);
    this.activeMetricsCollector = metricsCollector;
    metricsCollector.setBlocksProduced(this.blocks.length);
    
    const previousCode = cloneBlock(block);

    const tokenizationStart = now();
    const segmentLines = codeLines.slice(state.processedLines, targetEnd);

    if (segmentLines.length > 0) {
      if (wantsHtml || (wantsTokens && !diffEnabled)) {
        try {
          const sharedLanguage = wantsHtml ? resolvedLanguage : resolvedTokenLanguage;
          const tokens = this.highlighter.codeToTokensWithThemes(segmentLines.join("\n"), {
            lang: sharedLanguage as never,
            themes: CODE_HIGHLIGHT_THEMES,
            grammarState: state.grammarState as never,
          } as never) as ShikiThemedToken[][];
          if (wantsHtml) {
            const htmlLines = renderShikiLines(tokens);
            for (let i = 0; i < htmlLines.length; i += 1) {
              state.highlightedLines[state.processedLines + i] = htmlLines[i] ?? null;
            }
          }
          if (wantsTokens && !diffEnabled) {
            const tokenLines = renderTokenLines(tokens);
            for (let i = 0; i < tokenLines.length; i += 1) {
              state.tokenLines[state.processedLines + i] = tokenLines[i] ?? null;
            }
          }
          state.grammarState = this.highlighter.getLastGrammarState(tokens as never);
        } catch (error) {
          console.warn("Lazy tokenization failed for", requestedLanguage, error);
        }
      }

      if (wantsTokens && diffEnabled) {
        const cursor = state.diffCursor ?? { oldLine: null, newLine: null };
        const diffLines = segmentLines.map((line) => parseUnifiedDiffLine(line, cursor));
        state.diffCursor = cursor;

        const grammarObj = { context: state.grammarState };
        const { tokenLines, grammarState: nextState } = await buildDiffTokenLines(
          diffLines,
          resolvedTokenLanguage,
          grammarObj,
          this.highlighter,
        );
        if (!currentTarget()) {
          if (this.activeMetricsCollector === metricsCollector) this.activeMetricsCollector = null;
          return;
        }
        state.grammarState = nextState.context;

        for (let i = 0; i < diffLines.length; i += 1) {
          const idx = state.processedLines + i;
          state.diffKind[idx] = toDiffLineKind(diffLines[i].kind);
          state.oldNo[idx] = diffLines[i].oldNo ?? null;
          state.newNo[idx] = diffLines[i].newNo ?? null;
          state.tokenLines[idx] = tokenLines[i] ?? null;
        }
      }
      state.processedLines = targetEnd;
    }

    const commitTarget = currentTarget();
    if (!commitTarget) {
      if (this.activeMetricsCollector === metricsCollector) this.activeMetricsCollector = null;
      return;
    }
    const root = this.blocks[commitTarget.rootIndex];
    const prevSnapshot = createBlockSnapshot(this.replacePreparedCode(root, previousCode));
    const tokenizationDuration = now() - tokenizationStart;
    metricsCollector.recordLazyTokenization(targetEnd - startLine, tokenizationDuration, this.lazyTokenizationQueue.size);

    const updated = cloneBlock(block);
    delete updated.payload.highlightedHtml;
    const effectiveLang = wantsHtml ? resolvedLanguage : resolvedTokenLanguage;
    const nextMeta = { ...(updated.payload.meta ?? {}), ...meta, lang: requestedLanguage, highlightLang: effectiveLang } as Record<string, unknown>;
    nextMeta.lazyTokenization = true;
    nextMeta.lazyTokenizedUntil = state.processedLines;
    if (wantsHtml) {
      nextMeta.highlightedLines = state.highlightedLines;
    } else if ("highlightedLines" in nextMeta) {
      delete nextMeta.highlightedLines;
    }
    if (wantsTokens) {
      nextMeta.tokenLines = state.tokenLines;
      if (diffEnabled) {
        nextMeta.diffKind = state.diffKind;
        nextMeta.oldNo = state.oldNo;
        nextMeta.newNo = state.newNo;
      } else {
        if ("diffKind" in nextMeta) delete nextMeta.diffKind;
        if ("oldNo" in nextMeta) delete nextMeta.oldNo;
        if ("newNo" in nextMeta) delete nextMeta.newNo;
      }
    } else if ("tokenLines" in nextMeta) {
      delete nextMeta.tokenLines;
      if ("diffKind" in nextMeta) delete nextMeta.diffKind;
      if ("oldNo" in nextMeta) delete nextMeta.oldNo;
      if ("newNo" in nextMeta) delete nextMeta.newNo;
    }
    if (this.emitDiffBlocks && diffInfo.isDiff) {
      const cursor: DiffCursorState = { oldLine: null, newLine: null };
      const diffLines = codeLines.map((line) => parseUnifiedDiffLine(line, cursor));
      nextMeta.diffBlocks = buildDiffBlocksFromLines(diffLines, codeLines, wantsTokens ? state.tokenLines : null, diffInfo.baseLang ?? null);
    } else if ("diffBlocks" in nextMeta) {
      delete nextMeta.diffBlocks;
    }
    updated.payload.meta = nextMeta;
    const updatedRoot = this.replacePreparedCode(root, updated);
    this.blocks[commitTarget.rootIndex] = updatedRoot;
    const nextSnapshot = createBlockSnapshot(updatedRoot);

    const patches: Patch[] = [];
    diffNodeSnapshot(updatedRoot.id, prevSnapshot, nextSnapshot, patches, metricsCollector);
    if (patches.length > 0) {
      this.dispatchPatchBatch(withPatchKindBatch(patches, "enrichment"), metricsCollector);
    } else {
      if (metricsCollector) {
        const metrics = metricsCollector.toPerformanceMetrics();
        if (metrics) {
          this.post({ type: "METRICS", metrics });
        }
      }
      if (this.activeMetricsCollector === metricsCollector) {
        this.activeMetricsCollector = null;
      }
    }
  }
}
