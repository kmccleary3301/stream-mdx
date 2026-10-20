import { type SyntaxNode, type Tree, TreeFragment } from "@lezer/common";
import { GFM, Table, parser as mdParser } from "@lezer/markdown";
import type {
  Block,
  BlockResolvedLinkReference,
  CodeHighlightOutputMode,
  CodeHighlightThemes,
  DiffLineKind,
  FormatAnticipationConfig,
  HtmlOptions,
  HtmlTreeNode,
  InlineNode,
  InlineStreamingInlineStatus,
  InlineLookaheadPrepareResult,
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
  ContentPolicy,
  RestrictedComponentDescriptor,
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
  extractMixedContentSegmentsWithLookahead,
  prepareTrustedMdxInlineNodes,
  generateBlockId,
  createContainerSignature,
  normalizeFormatAnticipation,
  normalizeLang,
  parseCodeFenceInfo,
  prepareInlineStreamingLookahead,
  removeHeadingMarkers,
  sanitizeHtmlInWorker,
  sanitizeHtmlTreeInWorker,
  dedentIndentedCode,
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
import {
  containsInlineHtml,
  getActiveHtmlTreeKey,
  groupHtmlOwnership,
  normalizeHtmlParagraph,
  preserveInlineComponentSource,
} from "./html-ownership";
import { parseTrustedMdxSourceSpans } from "../mdx-source-spans";
import { buildRestrictedComponentInlineTree, buildRestrictedComponentTree } from "./restricted-component-ownership";
import { computeParagraphPatchLimit } from "../perf/patch-heuristics";
import {
  clampLazyRange,
  type LazyTokenizationPriority,
  type LazyTokenizationRequest,
} from "../lazy-tokenization";
import {
  DEFAULT_CODE_HIGHLIGHT_THEMES,
  type CodeThemePair,
  buildDiffBlocksFromLines,
  buildDiffTokenLines,
  dedentFencedCodeByClosingIndent,
  detectDiffLanguage,
  enhanceHighlightedHtml,
  getCachedHighlight,
  getSharedHighlighter,
  guessLanguageFromDiffLines,
  looksLikeUnifiedDiff,
  parseUnifiedDiffLine,
  renderShikiLines,
  renderTokenLines,
  resolveHighlightLanguage,
  resolveHighlightThemes,
  setCachedHighlight,
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
  WorkerMetricsCollector,
  now,
  roundMetric,
} from "./metrics";
import {
  collectAutolinkProtectedRanges,
  collectChangedBlockIds,
  collectCodeProtectedRanges,
  collectHtmlProtectedRangesFromSegments,
  collectMathProtectedRanges,
  collectNestedListItemInlineSources,
  getNativeHeadingContentRange,
  maybeBuildTocPatch,
  parseGfmTableFromTree,
  reportWorkerStructuralInvariantViolations,
  slugifyHeading,
  trimProvisionalFenceTail,
  trimProvisionalNativeCode,
} from "./parse-extract";
import {
  countChangedBlocksFromPatches,
  diffNodeSnapshot,
  ensureAnnotatedPatchBatch,
  estimatePatchSize,
  partitionPatchesForCredits,
  syncEmittedBlockEpochsFromPatches,
  withPatchKindBatch,
} from "./patch-emit";
import type {
  CodeHighlightingMode,
  ContentChangeRange,
  DiffCursorState,
  DiffLineInfo,
  EngineExtensions,
  IncrementalHighlightState,
  LazyTokenizationState,
  MarkdownEngineOptions,
  ParseOptions,
  ShikiThemedToken,
} from "./types";

const MAX_DEFERRED_PATCHES = 400;
const MAX_DEFERRED_FLUSH_PATCHES = 120;
const MAX_MDX_SKIP_LOGS = 20;
const MIXED_CONTENT_AUTOCLOSE_NEWLINES = 2;
const DEFAULT_APPEND_CHUNK_SIZE = 1400;
const DEFAULT_APPEND_BATCH_MS = 12;
const MIN_APPEND_CHUNK_SIZE = 256;
const MAX_APPEND_CHUNK_SIZE = 12000;
const MIN_APPEND_BATCH_MS = 4;
const MAX_APPEND_BATCH_MS = 50;

function appendPreparedNativeBlocksInRange(
  nodes: readonly HtmlTreeNode[] | undefined,
  from: number,
  to: number,
  exact: boolean,
  mdxOnly: boolean,
  output: Block[],
  seenOwners: Set<Block>,
): void {
  if (!nodes || nodes.length === 0) return;
  const pending: HtmlTreeNode[] = [];
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (node) pending.push(node);
  }
  const visitedNodes = new WeakSet<object>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || visitedNodes.has(node)) continue;
    visitedNodes.add(node);
    if (node.kind === "block") {
      const block = node.block;
      const range = block.payload.range;
      const isPreparedOwner = Boolean(
        range &&
        (exact ? range.from === from && range.to === to : range.from >= from && range.to <= to) &&
        (!mdxOnly || block.type === "mdx") &&
        range.to > range.from
      );
      if (isPreparedOwner && range) {
        if (!seenOwners.has(block)) {
          seenOwners.add(block);
          output.push(block);
        }
      } else {
        const meta = block.payload.meta;
        const nestedNativeChildren = meta?.trustedMdxNativeChildren;
        let nestedTree: readonly HtmlTreeNode[] | undefined;
        if (Array.isArray(nestedNativeChildren)) {
          nestedTree = nestedNativeChildren;
        } else {
          const treeKey = getActiveHtmlTreeKey(meta);
          nestedTree = treeKey ? (meta?.[treeKey] as HtmlTreeNode[] | undefined) : undefined;
        }
        if (nestedTree) {
          for (let index = nestedTree.length - 1; index >= 0; index--) {
            const child = nestedTree[index];
            if (child) pending.push(child);
          }
        }
      }
    } else if (node.kind === "element" || node.kind === "component") {
      for (let index = node.children.length - 1; index >= 0; index--) {
        const child = node.children[index];
        if (child) pending.push(child);
      }
    }
  }
}

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

type LookaheadContainerContext = InlineLookaheadPrepareResult["container"];
type LookaheadDecisionTrace = InlineLookaheadPrepareResult["trace"][number];

type InlineStreamingParseResult = {
  inline: InlineNode[];
  status: InlineStreamingInlineStatus;
  lookahead: LookaheadDecisionTrace[];
  containerSignature: string;
};

export class MarkdownEngine {
  private readonly postFn: (message: WorkerOut) => void;
  public readonly extensions?: EngineExtensions;
  private mdParser!: typeof mdParser;

  public readonly documentPluginRegistry: DocumentPluginRegistry;
  private readonly documentPluginState: DocumentState = {};
  private inlineParser!: InlineParser;
  private syntaxRules: SyntaxRuleSpec[] = [];
  private htmlConfig?: HtmlOptions;
  private mixedHtmlConfig: HtmlOptions = { literalTagContent: [] };
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
  private codeThemes: CodeThemePair = {
    dark: DEFAULT_CODE_HIGHLIGHT_THEMES.dark,
    light: DEFAULT_CODE_HIGHLIGHT_THEMES.light,
  };
  private readonly incrementalHighlightStates = new Map<string, IncrementalHighlightState>();

  private readonly lazyTokenizationStates = new Map<string, LazyTokenizationState>();
  private readonly lazyTokenizationQueue = new Map<string, LazyTokenizationRequest>();
  private lazyTokenizationScheduled = false;
  private lazyTokenizationProcessing = false;
  private lazyTokenizationThresholdLines = DEFAULT_LAZY_TOKENIZATION_THRESHOLD;
  private lazyTokenizationEnabled = true;
  private mdxEnabled = true;
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
  private contentPolicy: ContentPolicy = "restricted";
  private contentComponents: Map<string, RestrictedComponentDescriptor> = new Map();
  private messageQueue: Promise<void> = Promise.resolve();
  private inputPolicy: ContentPolicy = "restricted";
  private inputSealed = false;
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
    this.mdParser = mdParser.configure([gfm, createBlockCompatibilityExtension(() => this.contentPolicy === "restricted" ? this.contentComponents : undefined), HtmlContinuationExtension, ...(this.extensions?.markdown ?? [])]);
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
    this.deferredPatchQueue = [];
    this.incrementalHighlightStates.clear();
    this.documentPluginRegistry.clear();
    this.blocks = [];
    this.lastTree = null;
    this.treeFragments = [];
    this.currentContent = "";
    this.currentLinkReferences.clear();
    this.blockAttemptedReferences.clear();
    this.emittedBlockEpochs.clear();
    this.tocHeadings = [];
    this.headingIdCounts.clear();
  }

  public handle(message: WorkerIn): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    // Trusted MDX revisions are sealed; Markdown and restricted streams may reopen after EOF.
    const rejectAppend = message.type === "APPEND" && this.inputSealed;
    if (message.type === "INIT") {
      this.inputPolicy = message.contentPolicy ?? "restricted";
      this.inputSealed = false;
    } else if (message.type === "FINALIZE") {
      this.inputSealed = this.inputPolicy === "trusted-mdx";
    }
    const task = this.messageQueue
      .then(async () => {
        if (this.disposed) return;
        try {
          if (rejectAppend) throw new Error("Cannot append after FINALIZE; start a new generation with INIT.");
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
        await this.initialize(
          msg.initialContent,
          msg.prewarmLangs ?? [],
          msg.docPlugins,
          msg.syntax,
          msg.html,
          msg.themes ?? msg.docPlugins?.themes,
          msg.contentPolicy,
          msg.contentComponents,
        );
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
      lazyTokenization?: { enabled?: boolean; thresholdLines?: number };
      themes?: CodeHighlightThemes;
    },
    syntax?: SyntaxRuleSpec[],
    html?: HtmlOptions,
    themes?: CodeHighlightThemes,
    contentPolicy?: ContentPolicy,
    contentComponents?: readonly RestrictedComponentDescriptor[],
  ): Promise<void> {
    this.contentPolicy = contentPolicy ?? "restricted";
    this.contentComponents = new Map();
    if (contentComponents && Array.isArray(contentComponents)) {
      for (const comp of contentComponents) {
        if (comp?.name) this.contentComponents.set(comp.name, comp);
      }
    }
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
    this.mixedHtmlConfig = { ...html, literalTagContent: html?.literalTagContent ?? [] };

    this.documentPluginRegistry.clear();
    for (const key of Object.keys(this.documentPluginState)) {
      delete this.documentPluginState[key];
    }
    this.incrementalHighlightStates.clear();
    this.incrementalHighlightStates.clear();
    this.lazyTokenizationStates.clear();
    this.lazyTokenizationQueue.clear();
    this.lazyTokenizationScheduled = false;
    this.lazyTokenizationProcessing = false;


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
    this.buildInlineParser();
    this.documentPluginState.inlineParser = this.inlineParser;

    if (enable.footnotes) registerFootnotesPlugin(this.documentPluginRegistry);
    if (enable.tables) this.documentPluginRegistry.register(TablesPlugin);
    if (enable.callouts) this.documentPluginRegistry.register(CalloutsPlugin);
    if (enable.html) this.documentPluginRegistry.register(HTMLBlockPlugin);
    if (enable.mdx && this.contentPolicy === "trusted-mdx") {
      this.documentPluginRegistry.register(MDXDetectionPlugin);
    }
    if (this.extensions?.documentPlugins) {
      for (const plugin of this.extensions.documentPlugins) {
        this.documentPluginRegistry.register(plugin);
      }
    }

    this.performanceTimer.mark("highlighter-init");
    this.highlighter = await getSharedHighlighter(prewarmLangs);
    this.performanceTimer.measure("highlighter-init");

    const requestedThemes = themes ?? docPlugins?.themes;
    const { themes: resolvedThemes, errors: themeErrors } = await resolveHighlightThemes(
      this.highlighter,
      requestedThemes,
    );
    for (const error of themeErrors) {
      this.reportError(error, "INIT", { theme: requestedThemes });
    }
    this.codeThemes = resolvedThemes;
    if (initialContent) {
      this.currentContent = initialContent;
      const result = await this.parseAll(initialContent);
      this.blocks = result.blocks;
      this.lastTree = result.lastTree;
    }

    // Carry producer epochs on the initial wire projection, not in canonical semantic metadata.
    const initialBlocks = this.blocks.map((block) => {
      const blockEpoch = this.emittedBlockEpochs.get(block.id) ?? 1;
      this.emittedBlockEpochs.set(block.id, blockEpoch);
      return {
        ...block,
        payload: { ...block.payload, meta: { ...block.payload.meta, blockEpoch } },
      };
    });

    this.txCounter = 0;
    reportWorkerStructuralInvariantViolations("initialize", this.blocks, this.lastWorkerInvariantSignature);
    this.post({
      type: "INITIALIZED",
      blocks: initialBlocks,
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
    const oldLen = this.currentContent.length;
    const newLen = oldLen + appendedText.length;
    // Append-only: the single changed range is the appended tail (no document-wide diff needed).
    const changeRanges: ContentChangeRange[] = appendedText.length > 0 ? [{ fromA: oldLen, toA: oldLen, fromB: oldLen, toB: newLen }] : [];
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

  private findTrustedMdxFlowRootEnd(raw: string): number | null {
    if (this.contentPolicy !== "trusted-mdx" || !this.mdxEnabled) return null;
    const parsed = parseTrustedMdxSourceSpans(raw);
    if (parsed.kind !== "parsed") return null;
    const flowRoot = parsed.regions.find(
      (region) =>
        region.kind === "jsx" &&
        region.placement === "flow" &&
        typeof region.rootElementName === "string" &&
        raw.slice(0, region.from).trim() === "" &&
        raw.slice(region.to).trim() !== "",
    );
    return flowRoot?.to ?? null;
  }

  private async extractBlocks(
    tree: Tree,
    content: string,
    options: ParseOptions = {},
    sourceOffset = 0,
  ): Promise<Block[]> {
    try {
      if (sourceOffset === 0) this.headingIdCounts = new Map<string, number>();
      const extracted: Block[] = [];
      const cursor = tree.cursor();
      const footnotesEnabled = this.documentPluginRegistry.getAll().some((plugin) => plugin.name === "footnotes");
      let hasRecognizedNodes = false;
      // Keyed by range only: a key embedding `raw` hashes the whole document on every append. `raw` is checked on hit.
      const reusableBlockMap =
        sourceOffset === 0 && options.firstChangedPos !== undefined && options.previousBlocks
          ? new Map(options.previousBlocks.map((b) => [`${b.payload.range?.from ?? -1}:${b.payload.range?.to ?? -1}`, b]))
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
            const flowRootEnd = blockType === "html" ? this.findTrustedMdxFlowRootEnd(raw) : null;
            if (flowRootEnd !== null) {
              // Lezer can extend an HTML block across a following fence; reparse after the exact authored JSX root.
              const prefix = raw.slice(0, flowRootEnd);
              const suffix = raw.slice(flowRootEnd);
              const prefixBlocks = await this.extractBlocks(
                this.mdParser.parse(prefix),
                prefix,
                { ...options, forceFinalize: true },
                sourceOffset + from,
              );
              const suffixBlocks = await this.extractBlocks(
                this.mdParser.parse(suffix),
                suffix,
                options,
                sourceOffset + from + flowRootEnd,
              );
              extracted.push(...prefixBlocks, ...suffixBlocks);
              continue;
            }
            let block: Block | null = null;
            if (reusableBlockMap && to <= options.firstChangedPos!) {
              const prev = reusableBlockMap.get(`${from + sourceOffset}:${to + sourceOffset}`);
              if (prev && prev.isFinalized && prev.type === blockType && prev.payload.raw === raw) {
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
              block = await this.createBlock(blockType, raw, from, to, content, options, nodeType, cursor.node, sourceOffset);
            }
            if (block && raw.trim()) {
              extracted.push(block);
            }
          }
        } while (cursor.nextSibling());
      }

      if (extracted.length === 0 && !hasRecognizedNodes) {
        return await this.extractBlocksSimple(content, options, sourceOffset);
      }

      return groupHtmlOwnership(extracted, this.mdParser, content, this.htmlConfig, sourceOffset, (text) => this.inlineParser.parse(text), {
        mdxComponents: this.mdxEnabled && this.contentPolicy === "trusted-mdx",
        contentPolicy: this.contentPolicy,
        contentComponents: this.contentComponents,
        forceFinalize: options.forceFinalize,
      });
    } catch (error) {
      console.warn("Lezer parsing failed, falling back to simple parsing:", error);
      return await this.extractBlocksSimple(content, options, sourceOffset);
    }
  }

  private async extractBlocksSimple(
    content: string,
    options: ParseOptions = {},
    sourceOffset = 0,
  ): Promise<Block[]> {
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

        const block = await this.createBlock(blockType, raw, from, to, content, options, undefined, undefined, sourceOffset);
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
    sourceOffset = 0,
  ): Promise<Block | null> {
    if (!raw.trim()) return null;

    const isFinalized = options.forceFinalize ? true : to < fullContent.length - 1;
    let blockType = type;
    if (blockType === "table" && !isFinalized) {
      blockType = "paragraph";
    }

    const id = generateBlockId(`${from + sourceOffset}:${blockType}`, blockType);

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
        range: { from: from + sourceOffset, to: to + sourceOffset },
      },
    };

    await this.enrichBlock(block, options, syntaxNode);
    await this.prepareTrustedMdxFlowChildren(block);
    return block;
  }

  private async prepareTrustedMdxInlineChild(raw: string, from: number, to: number): Promise<Block> {
    const child: Block = {
      id: generateBlockId(`${from}:paragraph`, "paragraph"),
      type: "paragraph",
      isFinalized: true,
      payload: { raw, range: { from, to }, meta: { trustedMdxSource: true } },
    };
    await this.enrichBlock(child, { forceFinalize: true });
    return child;
  }

  private async prepareTrustedMdxFlowChildren(block: Block): Promise<void> {
    if (
      this.contentPolicy !== "trusted-mdx" ||
      !this.mdxEnabled ||
      !block.isFinalized ||
      !this.hasTrustedNativeSource(block) ||
      (block.type !== "paragraph" && block.type !== "html")
    ) {
      return;
    }
    const raw = block.payload.raw ?? "";
    if (!raw.includes("<")) return;
    const sourceFrom = block.payload.range?.from;
    if (typeof sourceFrom !== "number" || !Number.isSafeInteger(sourceFrom) || sourceFrom < 0) return;
    const parsedSource = parseTrustedMdxSourceSpans(raw);
    if (parsedSource.kind !== "parsed") return;
    const flowRoot = parsedSource.regions.find(
      (region) =>
        region.kind === "jsx" &&
        region.placement === "flow" &&
        region.rootElementName !== undefined &&
        raw.slice(0, region.from).trim() === "" &&
        raw.slice(region.to).trim() === "",
    );
    if (!flowRoot || flowRoot.flowChildren === undefined) return;
    const meta = block.payload.meta;
    const treeKey = getActiveHtmlTreeKey(meta);
    const activeTree = treeKey ? (meta?.[treeKey] as HtmlTreeNode[] | undefined) : undefined;
    const canonicalNativeChildren = Array.isArray(meta?.trustedMdxNativeChildren)
      ? meta.trustedMdxNativeChildren
      : undefined;
    const mdxDetection = this.documentPluginRegistry.getAll().find((plugin) => plugin.name === "mdx-detection");
    const nativeChildren: HtmlTreeNode[] = [];
    for (const child of flowRoot.flowChildren) {
      if (child.kind === "expression") continue;
      const childSource = raw.slice(child.from, child.to);
      if (child.kind !== "inline" && childSource.trim() === "") continue;
      const childFrom = sourceFrom + child.from;
      const childTo = sourceFrom + child.to;
      const childBlocks: Block[] = [];
      const seenOwners = new Set<Block>();
      const exact = child.kind !== "markdown";
      const mdxOnly = child.kind === "jsx";
      appendPreparedNativeBlocksInRange(canonicalNativeChildren ?? activeTree, childFrom, childTo, exact, mdxOnly, childBlocks, seenOwners);
      if (childBlocks.length === 0) {
        const parsedChildBlocks = child.kind === "inline"
          ? [await this.prepareTrustedMdxInlineChild(childSource, childFrom, childTo)]
          : await this.extractBlocks(
            this.mdParser.parse(childSource),
            childSource,
            { forceFinalize: true },
            childFrom,
          );
        if ((child.kind === "markdown" || child.kind === "inline") && parsedChildBlocks.length === 0) {
          throw new Error("A compiler-authored Markdown child in an MDX flow root has no native block owner.");
        }
        if (parsedChildBlocks.length === 0) continue;
        mdxDetection?.process({ content: childSource, blocks: parsedChildBlocks, state: this.documentPluginState });
        childBlocks.push(...parsedChildBlocks);
      }
      for (const childBlock of childBlocks) {
        nativeChildren.push({ kind: "block", block: childBlock });
      }
    }
    block.payload.meta = {
      ...meta,
      trustedMdxNativeChildren: nativeChildren,
    };
  }

  private inlineContext(block: Block, ancestorTypes: readonly string[] = [], segmentOrigin: "direct-inline" | "mixed-content" = "direct-inline"): LookaheadContainerContext {
    const context = {
      blockType: block.type,
      ancestorTypes,
      listDepth: ancestorTypes.filter((type) => type === "list").length + (block.type === "list" ? 1 : 0),
      blockquoteDepth: ancestorTypes.filter((type) => type === "blockquote").length + (block.type === "blockquote" ? 1 : 0),
      insideHtml: ancestorTypes.includes("html"),
      insideMdx: ancestorTypes.includes("mdx"),
      segmentOrigin,
      provisional: !block.isFinalized,
      localTextField: segmentOrigin === "mixed-content" ? `${block.type}-inline` : block.type === "heading" ? "heading-text" : block.type === "list-item" ? "list-item-paragraph" : "raw",
    };
    return { ...context, containerSignature: createContainerSignature(context) };
  }

  private parseInlineStreaming(content: string, context: LookaheadContainerContext, existingInline?: InlineNode[]): InlineStreamingParseResult {
    const regexEnabled = this.formatAnticipationConfig.regex || this.syntaxRules.some((rule) => rule.anticipation);
    const orchestration = prepareInlineStreamingLookahead(content, {
      formatAnticipation: { ...this.formatAnticipationConfig, regex: regexEnabled },
      math: this.enableMath,
      regexAppend: regexEnabled ? this.inlineParser.getRegexAnticipationAppend(content) : null,
      context,
    });
    const prepared = orchestration.prepared;
    return {
      inline: existingInline ?? (prepared.kind === "raw" ? [{ kind: "text", text: content }] : this.inlineParser.parse(prepared.content, { cache: false })),
      status: prepared.status,
      lookahead: orchestration.trace,
      containerSignature: orchestration.container.containerSignature,
    };
  }

  private updateInlineLookaheadMeta(block: Block, parsed: InlineStreamingParseResult | null, shouldTrackInline: boolean): void {
    const meta = { ...block.payload.meta };
    const previousSignature = meta.inlineContainerSignature;
    if (parsed) {
      meta.inlineContainerSignature = parsed.containerSignature;
      meta.inlineLookahead = parsed.lookahead;
      if (typeof previousSignature === "string" && previousSignature !== parsed.containerSignature) {
        meta.inlineLookaheadInvalidated = "container-signature-changed";
      } else {
        delete meta.inlineLookaheadInvalidated;
      }
    } else {
      delete meta.inlineContainerSignature;
      delete meta.inlineLookahead;
      delete meta.inlineLookaheadInvalidated;
      delete meta.mixedLookahead;
    }
    if (parsed && shouldTrackInline) meta.inlineStatus = parsed.status;
    else delete meta.inlineStatus;
    block.payload.meta = Object.keys(meta).length > 0 ? meta : undefined;
  }

  private tracksInlineStatus(): boolean {
    return this.formatAnticipationConfig.inline ||
      this.formatAnticipationConfig.mathInline ||
      this.formatAnticipationConfig.mathBlock ||
      this.formatAnticipationConfig.regex ||
      this.syntaxRules.some((rule) => rule.anticipation);
  }

  private updateContainerLookaheadMeta(block: Block, children: readonly NodeSnapshot[], ancestorTypes: readonly string[]): void {
    if (block.isFinalized) {
      this.updateInlineLookaheadMeta(block, null, false);
      return;
    }
    const lookahead: LookaheadDecisionTrace[] = [];
    const mixedLookahead: LookaheadDecisionTrace[] = [];
    let status: InlineStreamingInlineStatus = "complete";
    const collect = (snapshot: NodeSnapshot): void => {
      const owner = snapshot.props?.block as Block | undefined;
      if (owner && owner.type !== "list" && owner.type !== "blockquote") {
        const meta = owner.payload.meta as {
          inlineLookahead?: LookaheadDecisionTrace[];
          mixedLookahead?: LookaheadDecisionTrace[];
          inlineStatus?: InlineStreamingInlineStatus;
        } | undefined;
        if (meta?.inlineLookahead) lookahead.push(...meta.inlineLookahead);
        if (meta?.mixedLookahead) mixedLookahead.push(...meta.mixedLookahead);
        if (meta?.inlineStatus === "raw") status = "raw";
        else if (meta?.inlineStatus === "anticipated" && status !== "raw") status = "anticipated";
      }
      for (const child of snapshot.children ?? []) collect(child);
    };
    for (const child of children) collect(child);
    this.updateInlineLookaheadMeta(block, {
      inline: [],
      status,
      lookahead,
      containerSignature: this.inlineContext(block, ancestorTypes).containerSignature,
    }, this.tracksInlineStatus());
    if (mixedLookahead.length > 0) {
      block.payload.meta = { ...block.payload.meta, mixedLookahead };
    } else if (block.payload.meta) {
      delete block.payload.meta.mixedLookahead;
    }
  }
  private hasTrustedNativeSource(block: Block, nativeNode?: SyntaxNode): boolean {
    const meta = block.payload.meta as Record<string, unknown> | undefined;
    const hasSourcePositions = Array.isArray(meta?.inlineSourcePositions);
    const hasNativeSource = nativeNode !== undefined ||
      typeof meta?.lezerNodeType === "string" ||
      meta?.trustedMdxSource === true ||
      hasSourcePositions;
    const sourceRange = block.payload.range;
    const baseOffset = sourceRange?.from;
    const endOffset = sourceRange?.to;
    return this.contentPolicy === "trusted-mdx" &&
      this.mdxEnabled &&
      block.isFinalized &&
      hasNativeSource &&
      typeof baseOffset === "number" &&
      Number.isSafeInteger(baseOffset) &&
      baseOffset >= 0 &&
      typeof endOffset === "number" &&
      Number.isSafeInteger(endOffset) &&
      endOffset >= baseOffset;
  }

  private prepareTrustedNativeInline(
    nodes: InlineNode[],
    rawSource: string,
    ownerIdPrefix: string,
    baseOffset: number,
    sourcePositions?: readonly number[],
    localProtectedRanges?: readonly ProtectedRange[],
  ): InlineNode[] {
    if (!rawSource.includes("<") && !rawSource.includes("{")) return nodes;
    const protectedRanges = localProtectedRanges ?? [
      ...collectCodeProtectedRanges(rawSource),
      ...(this.enableMath ? collectMathProtectedRanges(rawSource) : []),
      ...collectAutolinkProtectedRanges(rawSource),
    ];
    const absoluteProtectedRanges: ProtectedRange[] = [];
    for (const range of protectedRanges) {
      if (range.from < 0 || range.to <= range.from) continue;
      let from: number;
      let to: number;
      if (sourcePositions) {
        if (range.to > sourcePositions.length) continue;
        from = sourcePositions[range.from];
        to = sourcePositions[range.to - 1] + 1;
      } else {
        from = baseOffset + range.from;
        to = baseOffset + range.to;
      }
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) continue;
      absoluteProtectedRanges.push({ ...range, from, to });
    }
    return prepareTrustedMdxInlineNodes(
      nodes,
      rawSource,
      sourcePositions ? 0 : baseOffset,
      ownerIdPrefix,
      absoluteProtectedRanges.length > 0 ? { protectedRanges: absoluteProtectedRanges } : undefined,
      sourcePositions,
    );
  }

  

  private async enrichBlock(block: Block, options?: ParseOptions, nativeNode?: SyntaxNode): Promise<void> {
    this.inlineParser.startCollectingAttemptedReferences();
    try {
      await this.enrichBlockContent(block, options, [], nativeNode);
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

  private async enrichBlockContent(block: Block, options?: ParseOptions, ancestorTypes: readonly string[] = [], nativeNode?: SyntaxNode): Promise<void> {
    this.performanceTimer.mark("enrich-block");
    const metrics = this.activeMetricsCollector;
    metrics?.countBlockType(block.type);
    const rawLength = typeof block.payload.raw === "string" ? block.payload.raw.length : 0;
    metrics?.recordBlockSize(block.type, rawLength);

    const shouldTrackInline = this.tracksInlineStatus();
    const allowMixed = this.formatAnticipationConfig.html || this.formatAnticipationConfig.mdx;
    const trustedNativePath = this.hasTrustedNativeSource(block, nativeNode);

    switch (block.type) {
      case "heading": {
        const rawHeading = typeof block.payload.raw === "string" ? block.payload.raw : "";
        const headingMeta = block.payload.meta as Record<string, unknown> | undefined;
        let normalizedHeading = removeHeadingMarkers(rawHeading);
        const trustedNativeSource = this.hasTrustedNativeSource(block, nativeNode);
        let inlineSourceText = trustedNativeSource && typeof headingMeta?.inlineSourceText === "string"
          ? headingMeta.inlineSourceText
          : undefined;
        const inlineSourcePositions = trustedNativeSource && Array.isArray(headingMeta?.inlineSourcePositions)
          ? headingMeta.inlineSourcePositions as number[]
          : undefined;
        let inlineSourceRange: { from: number; to: number } | undefined;
        const storedRangeValue = headingMeta?.inlineSourceRange;
        if (storedRangeValue && typeof storedRangeValue === "object" && "from" in storedRangeValue && "to" in storedRangeValue) {
          const from = storedRangeValue.from;
          const to = storedRangeValue.to;
          if (typeof from === "number" && typeof to === "number" &&
              Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to > from) {
            inlineSourceRange = { from, to };
          }
        }
        if (trustedNativeSource && nativeNode) {
          const baseOffset = block.payload.range?.from;
          if (typeof baseOffset === "number" && Number.isSafeInteger(baseOffset) && baseOffset >= 0) {
            const nativeRange = getNativeHeadingContentRange(nativeNode, rawHeading, baseOffset);
            if (nativeRange) {
              inlineSourceRange = nativeRange;
              inlineSourceText = rawHeading.slice(nativeRange.from - baseOffset, nativeRange.to - baseOffset);
            }
          }
        }
        const hasMappedInlineSource = inlineSourceText !== undefined &&
          inlineSourcePositions !== undefined &&
          inlineSourcePositions.length === inlineSourceText.length &&
          Array.isArray(block.payload.inline);
        const hasContiguousInlineSource = inlineSourceText !== undefined &&
          inlineSourceRange !== undefined &&
          inlineSourceRange.to - inlineSourceRange.from === inlineSourceText.length;
        if (trustedNativeSource && (hasMappedInlineSource || hasContiguousInlineSource)) {
          normalizedHeading = inlineSourceText ?? normalizedHeading;
        }
        const rawMetaLevel = headingMeta?.headingLevel;
        const metaLevel = typeof rawMetaLevel === "number" ? rawMetaLevel : undefined;
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
          ...(inlineSourceText !== undefined && hasContiguousInlineSource ? { inlineSourceText, inlineSourceRange } : {}),
        };
        if (block.isFinalized) {
          block.payload.raw = normalizedHeading;
          const hasTrustedInlineSource = trustedNativeSource && (hasMappedInlineSource || hasContiguousInlineSource);
          if (hasTrustedInlineSource && inlineSourceText !== undefined) {
            const sourcePositions = hasMappedInlineSource ? inlineSourcePositions : undefined;
            const baseOffset = sourcePositions ? 0 : inlineSourceRange?.from ?? 0;
            const nodes = sourcePositions && Array.isArray(block.payload.inline)
              ? block.payload.inline
              : this.inlineParser.parse(inlineSourceText, { sourceOffset: baseOffset });
            block.payload.inline = this.prepareTrustedNativeInline(
              nodes,
              inlineSourceText,
              block.id,
              baseOffset,
              sourcePositions,
            );
          } else {
            block.payload.inline = this.inlineParser.parse(normalizedHeading);
          }
          this.updateInlineLookaheadMeta(block, null, shouldTrackInline);
        } else {
          const parsed = this.parseInlineStreaming(normalizedHeading, this.inlineContext(block, ancestorTypes));
          block.payload.inline = parsed.inline;
          this.updateInlineLookaheadMeta(block, parsed, shouldTrackInline);
        }
        break;
      }

      case "blockquote":
        await this.prepareNestedChildren(block, options, ancestorTypes, nativeNode);
        break;

      case "paragraph": {
        const rawParagraph = typeof block.payload.raw === "string" ? block.payload.raw : "";
        const streamingParsed = !block.isFinalized ? this.parseInlineStreaming(rawParagraph, this.inlineContext(block, ancestorTypes)) : null;
        this.updateInlineLookaheadMeta(block, streamingParsed, shouldTrackInline);

        const currentMeta = (block.payload.meta ?? {}) as Record<string, unknown>;
        const trustedInlineSourceText = trustedNativePath && typeof currentMeta.inlineSourceText === "string"
          ? currentMeta.inlineSourceText
          : rawParagraph;
        const trustedInlineSourcePositions = trustedNativePath && Array.isArray(currentMeta.inlineSourcePositions)
          ? currentMeta.inlineSourcePositions as number[]
          : undefined;
        const hasMappedTrustedInlineSource = trustedInlineSourcePositions !== undefined &&
          trustedInlineSourcePositions.length === trustedInlineSourceText.length;
        const hasMappedTrustedInlineNodes = hasMappedTrustedInlineSource && Array.isArray(block.payload.inline);
        const baseOffset = block.payload.range?.from ?? 0;
        if (block.isFinalized) {
          if (!hasMappedTrustedInlineNodes) {
            if (trustedNativePath && trustedInlineSourcePositions === undefined) {
              block.payload.inline = this.inlineParser.parse(rawParagraph, { sourceOffset: baseOffset });
            } else if (trustedNativePath) {
              block.payload.inline = this.inlineParser.parse(trustedInlineSourceText);
            } else {
              block.payload.inline = this.inlineParser.parse(rawParagraph);
            }
          }
        } else {
          block.payload.inline = streamingParsed?.inline ?? [{ kind: "text", text: rawParagraph }];
        }

        const nextMeta: Record<string, unknown> = { ...currentMeta };
        let metaChanged = false;
        const protectedSource = trustedNativePath ? trustedInlineSourceText : rawParagraph;
        const protectedRanges = collectCodeProtectedRanges(protectedSource);
        if (this.enableMath) {
          protectedRanges.push(...collectMathProtectedRanges(protectedSource, protectedRanges));
        }
        const autolinkRanges = collectAutolinkProtectedRanges(protectedSource);
        if (autolinkRanges.length > 0) {
          protectedRanges.push(...autolinkRanges);
        }

        if (trustedNativePath && block.isFinalized) {
          if (trustedInlineSourcePositions === undefined) {
            block.payload.inline = this.prepareTrustedNativeInline(
              block.payload.inline ?? [],
              rawParagraph,
              block.id,
              baseOffset,
              undefined,
              protectedRanges,
            );
          } else if (hasMappedTrustedInlineNodes && Array.isArray(block.payload.inline)) {
            block.payload.inline = this.prepareTrustedNativeInline(
              block.payload.inline,
              trustedInlineSourceText,
              block.id,
              baseOffset,
              trustedInlineSourcePositions,
              protectedRanges,
            );
          }
        }
        const shouldExtractSegments = protectedSource.includes("<") || protectedSource.includes("{");
        const hasOwnedHtmlTree = nextMeta.htmlOwnership === true && Array.isArray(nextMeta.htmlTree);
        if (trustedNativePath || hasOwnedHtmlTree) {
          delete nextMeta.mixedLookahead;
          delete nextMeta.mixedSegments;
          delete nextMeta.mixedHtmlTrees;
          delete nextMeta.allowMixedStreaming;
          metaChanged = true;
        } else if (shouldExtractSegments) {
          const mixedOptions =
            allowMixed
              ? {
                  html: this.formatAnticipationConfig.html ? { autoClose: true, maxNewlines: MIXED_CONTENT_AUTOCLOSE_NEWLINES } : undefined,
                  mdx: this.formatAnticipationConfig.mdx
                    ? {
                        autoClose: true,
                        maxNewlines: MIXED_CONTENT_AUTOCLOSE_NEWLINES,
                        componentAllowlist:
                          this.contentPolicy === "trusted-mdx" || this.contentComponents.size === 0
                            ? undefined
                            : this.contentComponents.keys(),
                      }
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
            lookaheadContext: this.inlineContext(block, ancestorTypes, "mixed-content"),
          };
          const inlineFn = (value: string) => {
            const inline = block.isFinalized ? this.inlineParser.parse(value) : this.parseInlineStreaming(value, this.inlineContext(block, ancestorTypes, "mixed-content")).inline;
            return this.mdxEnabled ? preserveInlineComponentSource(inline) : inline;
          };
          const mixedExtraction = extractMixedContentSegmentsWithLookahead(rawParagraph, baseOffset, inlineFn, mixedSegmentOptions);
          const segments = mixedExtraction.segments;
          if (!block.isFinalized && mixedExtraction.lookahead.length > 0) {
            nextMeta.mixedLookahead = mixedExtraction.lookahead;
          } else {
            delete nextMeta.mixedLookahead;
          }
          metaChanged = true;
          const hasStructuredSegments = segments.some((segment) => segment.kind === "mdx");
          const htmlRanges = collectHtmlProtectedRangesFromSegments(segments, baseOffset);
          if (htmlRanges.length > 0) {
            protectedRanges.push(...htmlRanges);
          }
          if (hasStructuredSegments) {
            nextMeta.mixedSegments = segments;
            let htmlTrees: Record<number, HtmlTreeNode[]> | undefined;
            for (let index = 0; index < segments.length; index++) {
              const segment = segments[index];
              if (segment.kind !== "html") continue;
              (htmlTrees ??= {})[index] = sanitizeHtmlTreeInWorker(segment.value, this.mixedHtmlConfig, undefined, inlineFn);
            }
            if (htmlTrees) nextMeta.mixedHtmlTrees = htmlTrees;
            else delete nextMeta.mixedHtmlTrees;
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
            delete nextMeta.mixedHtmlTrees;
            metaChanged = true;
            if (Object.prototype.hasOwnProperty.call(nextMeta, "allowMixedStreaming")) {
              delete nextMeta.allowMixedStreaming;
              metaChanged = true;
            }
          }
        } else if (Object.prototype.hasOwnProperty.call(nextMeta, "mixedSegments")) {
          delete nextMeta.mixedLookahead;
          delete nextMeta.mixedSegments;
          delete nextMeta.mixedHtmlTrees;
          metaChanged = true;
          if (Object.prototype.hasOwnProperty.call(nextMeta, "allowMixedStreaming")) {
            delete nextMeta.allowMixedStreaming;
            metaChanged = true;
          }
        }
        if (this.mdxEnabled) {
          const inline = preserveInlineComponentSource(block.payload.inline ?? []);
          if (inline !== block.payload.inline) nextMeta.inlineComponentSource = true;
          else delete nextMeta.inlineComponentSource;
          block.payload.inline = inline;
          metaChanged = true;
        }
        if (!shouldExtractSegments && "mixedLookahead" in nextMeta) {
          delete nextMeta.mixedLookahead;
          metaChanged = true;
        }

        if (protectedRanges.length > 0) {
          nextMeta.protectedRanges = protectedRanges;
          metaChanged = true;
        } else if (Object.prototype.hasOwnProperty.call(nextMeta, "protectedRanges")) {
          delete nextMeta.protectedRanges;
          metaChanged = true;
        }

        if (nextMeta.htmlOwnership !== true && !nextMeta.mixedSegments && containsInlineHtml(block.payload.inline ?? [])) {
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
        if (rawHtml && this.contentPolicy !== "trusted-mdx") {
          nextMeta.protectedRanges = [{ from: 0, to: rawHtml.length, kind: "html-block" }];
        }
        block.payload.meta = nextMeta;
        break;
      }

      case "list":
        await this.prepareNestedChildren(block, options, ancestorTypes, nativeNode);
        break;

      case "table": {
        const rawTable = block.payload.raw ?? "";
        const baseOffset = block.payload.range?.from;
        const tableData = parseGfmTableFromTree(
          rawTable,
          this.inlineParser,
          trustedNativePath ? baseOffset : undefined,
        );
        if (tableData) {
          const header = tableData.header.map((inline, column) => {
            const source = tableData.headerCellSources?.[column];
            const range = tableData.headerCellRanges?.[column];
            return trustedNativePath && source !== undefined && range
              ? this.prepareTrustedNativeInline(inline, source, `${block.id}::th:${column}`, range.from)
              : inline;
          });
          const rows = tableData.rows.map((row, rowIndex) => row.map((inline, column) => {
            const source = tableData.rowCellSources?.[rowIndex]?.[column];
            const range = tableData.rowCellRanges?.[rowIndex]?.[column];
            return trustedNativePath && source !== undefined && range
              ? this.prepareTrustedNativeInline(inline, source, `${block.id}::td:${rowIndex}:${column}`, range.from)
              : inline;
          }));
          block.payload.inline = [];
          block.payload.meta = {
            ...(block.payload.meta ?? {}),
            header,
            align: tableData.align,
            rows,
          };
        }
        break;
      }
    }


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

  private async prepareNestedChildren(block: Block, options?: ParseOptions, ancestorTypes: readonly string[] = [], nativeNode?: SyntaxNode): Promise<void> {
    const trustedNativeSource = this.hasTrustedNativeSource(block, nativeNode);
    const containerMeta: NonNullable<Block["payload"]["meta"]> = { ...block.payload.meta, mathEnabled: this.enableMath, formatAnticipation: this.formatAnticipationConfig };
    if (trustedNativeSource) containerMeta.trustedMdxSource = true;
    else delete containerMeta.trustedMdxSource;
    block.payload.meta = containerMeta;
    const prepared = prepareNestedBlockSnapshot(block, this.inlineParser, this.mdParser, (text) => this.parseInlineStreaming(text, this.inlineContext(block, ancestorTypes)).inline);
    const listItemSources = collectNestedListItemInlineSources(block, this.mdParser, nativeNode, trustedNativeSource);
    const groupChildren = async (children: NodeSnapshot[], ancestors: readonly string[]): Promise<NodeSnapshot[]> => {
      const grouped: NodeSnapshot[] = [];
      let sequence: NodeSnapshot[] = [];
      const flush = async () => {
        const blocks = sequence.map((child) => child.props?.block as Block);
        const owned = groupHtmlOwnership(blocks, this.mdParser, block.payload.raw, this.htmlConfig, block.payload.range?.from ?? 0, (text) => this.inlineParser.parse(text), {
          joinLeafRaws: true,
          forceFinalize: options?.forceFinalize,
          mdxComponents: this.mdxEnabled && this.contentPolicy === "trusted-mdx",
          contentPolicy: this.contentPolicy,
          contentComponents: this.contentComponents,
        });
        const retained = new Set<Block>(owned);
        // Markdown leaves absorbed into an owner keep their consumer metadata (code highlighting,
        // inline segments): the owner owns their source, their tree slots still reference them.
        for (const leaf of blocks) {
          if (retained.has(leaf) || leaf.type === "html") continue;
          await this.enrichBlockContent(leaf, options, [...ancestors, "html"]);
        }
        for (const child of owned) {
          const original = sequence.find((candidate) => candidate.props?.block === child);
          grouped.push(original ?? createBlockSnapshot(child));
        }
        sequence = [];
      };
      for (const child of children) {
        if (child.props?.block) sequence.push(child);
        else {
          await flush();
          grouped.push(child);
        }
      }
      await flush();
      return grouped;
    };
    const enrich = async (snapshot: NodeSnapshot, ancestors: readonly string[]): Promise<void> => {
      // Group ownership on the native leaves before enrichment: enrichment retags open html leaves
      // as `mdx`, which would hide their native identity from the ownership stack.
      snapshot.children = await groupChildren(snapshot.children ?? [], [...ancestors, snapshot.type]);
      const childAncestors = [...ancestors, snapshot.type];
      for (const child of snapshot.children ?? []) await enrich(child, childAncestors);
      const nested = snapshot.props?.block as Block | undefined;
      if (!nested) return;
      if (nested.type === "list" || nested.type === "blockquote" || nested.type === "list-item") {
        if (nested.type === "list-item") {
          const range = nested.payload.range;
          const source = range ? listItemSources.get(`${range.from}:${range.to}`) : undefined;
          if (source !== undefined) {
            const { text, from: baseOffset, sourcePositions } = source;
            const trustedNativeListItem = this.hasTrustedNativeSource(nested);
            if (trustedNativeListItem) {
              const protectedRanges = collectCodeProtectedRanges(text);
              if (this.enableMath) protectedRanges.push(...collectMathProtectedRanges(text, protectedRanges));
              protectedRanges.push(...collectAutolinkProtectedRanges(text));
              if (
                sourcePositions !== undefined &&
                sourcePositions.length === text.length &&
                Array.isArray(nested.payload.inline)
              ) {
                nested.payload.inline = this.prepareTrustedNativeInline(
                  nested.payload.inline,
                  text,
                  nested.id,
                  baseOffset,
                  sourcePositions,
                  protectedRanges,
                );
              }
              const nativeInline = nested.payload.inline ?? [];
              const inline = this.mdxEnabled
                ? preserveInlineComponentSource(nativeInline)
                : nativeInline;
              if (this.mdxEnabled) {
                const meta = { ...nested.payload.meta };
                if (inline !== nested.payload.inline) meta.inlineComponentSource = true;
                else delete meta.inlineComponentSource;
                nested.payload.meta = meta;
              }
              nested.payload.inline = inline;
              snapshot.props = { ...snapshot.props, inline };
              const segmentPrefix = `${nested.id}::list-item:segment:`;
              snapshot.children = (snapshot.children ?? []).filter((child) => !child.id.startsWith(segmentPrefix));
              const meta = { ...nested.payload.meta };
              delete meta.mixedLookahead;
              delete meta.mixedSegments;
              delete meta.mixedHtmlTrees;
              delete meta.allowMixedStreaming;
              if (protectedRanges.length > 0) meta.protectedRanges = protectedRanges;
              else delete meta.protectedRanges;
              nested.payload.meta = meta;
              this.updateInlineLookaheadMeta(nested, null, false);
            } else {
              const localCodeRanges = collectCodeProtectedRanges(text);
              const codeRanges = localCodeRanges.map((range) => ({
                ...range,
                from: baseOffset + range.from,
                to: baseOffset + range.to,
              }));
              const parsed = nested.isFinalized ? null : this.parseInlineStreaming(text, this.inlineContext(nested, ancestors), nested.payload.inline);
              this.updateInlineLookaheadMeta(nested, parsed, this.tracksInlineStatus());
              if (text.includes("<") || text.includes("{")) {
                let restrictedInlineTree: HtmlTreeNode[] | null = null;
                if (this.contentPolicy === "restricted" && text.includes("<")) {
                  const protectedRanges = localCodeRanges;
                  if (this.enableMath) protectedRanges.push(...collectMathProtectedRanges(text, protectedRanges));
                  protectedRanges.push(...collectAutolinkProtectedRanges(text));
                  restrictedInlineTree = buildRestrictedComponentInlineTree(text, this.contentComponents, {
                    forceFinalize: options?.forceFinalize,
                    parseInline: (value) => this.inlineParser.parse(value),
                    parser: this.mdParser,
                    htmlOptions: this.htmlConfig,
                    literalTagContent: this.htmlConfig?.literalTagContent,
                    protectedRanges,
                  });
                }
                const extraction = restrictedInlineTree && nested.isFinalized
                  ? null
                  : extractMixedContentSegmentsWithLookahead(
                      text,
                      baseOffset,
                      restrictedInlineTree
                        ? () => []
                        : (value) => {
                            const inline = nested.isFinalized
                              ? this.inlineParser.parse(value)
                              : this.parseInlineStreaming(value, this.inlineContext(nested, ancestors, "mixed-content")).inline;
                            return this.mdxEnabled ? preserveInlineComponentSource(inline) : inline;
                          },
                      {
                        html: !nested.isFinalized && this.formatAnticipationConfig.html
                          ? { autoClose: true, maxNewlines: MIXED_CONTENT_AUTOCLOSE_NEWLINES }
                          : undefined,
                        mdx: {
                          autoClose: !nested.isFinalized && this.formatAnticipationConfig.mdx,
                          maxNewlines: MIXED_CONTENT_AUTOCLOSE_NEWLINES,
                          componentAllowlist:
                            this.contentPolicy === "trusted-mdx" || this.contentComponents.size === 0
                              ? undefined
                              : this.contentComponents.keys(),
                        },
                        protectedRanges: codeRanges,
                        allowedTags: this.htmlConfig?.allowedTags,
                        literalTagContent: this.htmlConfig?.literalTagContent,
                        lookaheadContext: this.inlineContext(nested, ancestors, "mixed-content"),
                      },
                    );
                if (extraction && !nested.isFinalized && extraction.lookahead.length > 0) {
                  nested.payload.meta = { ...nested.payload.meta, mixedLookahead: extraction.lookahead };
                }
                const segmentPrefix = `${nested.id}::list-item:segment:`;
                const blockChildren = (snapshot.children ?? []).filter((child) => !child.id.startsWith(segmentPrefix));
                const segments = extraction?.segments ?? [];
                const segmentChildren: NodeSnapshot[] = restrictedInlineTree
                  ? [{
                      id: `${segmentPrefix}0`,
                      type: "list-item-html",
                      range: sourcePositions && sourcePositions.length === text.length && sourcePositions.length > 0
                        ? { from: sourcePositions[0], to: sourcePositions[sourcePositions.length - 1] + 1 }
                        : { from: baseOffset, to: baseOffset + text.length },
                      props: { raw: text, htmlTree: restrictedInlineTree },
                      children: [],
                    }]
                  : segments.some((segment) => segment.kind === "mdx") ? segments.map((segment, index) => {
                      const restrictedTree = segment.kind === "mdx" && this.contentPolicy === "restricted"
                        ? buildRestrictedComponentTree(segment.value, this.contentComponents, {
                            forceFinalize: options?.forceFinalize,
                            parseInline: (value) => this.inlineParser.parse(value),
                            parser: this.mdParser,
                            literalTagContent: this.htmlConfig?.literalTagContent,
                          })
                        : null;
                      return {
                        id: `${segmentPrefix}${index}`,
                        type: restrictedTree ? "list-item-html" : `list-item-${segment.kind}`,
                        range: segment.range ? { ...segment.range } : undefined,
                        props: segment.kind === "text" ? { inline: segment.inline, text: segment.value }
                          : segment.kind === "html" ? {
                              raw: segment.value, html: segment.sanitized ?? segment.value,
                              htmlTree: sanitizeHtmlTreeInWorker(segment.value, this.mixedHtmlConfig, undefined, (value) => this.inlineParser.parse(value)),
                            }
                          : restrictedTree ? { raw: segment.value, htmlTree: restrictedTree }
                          : { raw: segment.value },
                        children: [],
                      };
                    }) : [];
                if (this.mdxEnabled) {
                  nested.payload.inline = preserveInlineComponentSource(nested.payload.inline ?? []);
                  snapshot.props = { ...snapshot.props, inline: nested.payload.inline };
                }
                snapshot.children = [...segmentChildren, ...blockChildren];
              }
            }
          }
        }
        if (nested.type !== "list-item") this.updateContainerLookaheadMeta(nested, snapshot.children ?? [], ancestors);
        const { block: _block, ...props } = snapshot.props ?? {};
        nested.payload.meta = { ...nested.payload.meta, preparedNested: { props, children: snapshot.children ?? [] } };
      } else {
        await this.enrichBlockContent(nested, options, ancestors);
        const updated = createBlockSnapshot(nested);
        snapshot.type = updated.type;
        snapshot.props = { ...snapshot.props, ...updated.props, inline: nested.payload.inline };
        snapshot.meta = updated.meta;
        snapshot.children = updated.children;
      }
    };
    prepared.children = await groupChildren(prepared.children, [...ancestorTypes, block.type]);
    for (const child of prepared.children) await enrich(child, [...ancestorTypes, block.type]);
    this.updateContainerLookaheadMeta(block, prepared.children, ancestorTypes);
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
    const extracted = stripCodeFence(block.isFinalized ? raw : trimProvisionalFenceTail(raw));
    const preparedCode = block.payload.meta?.code;
    const info = typeof block.payload.meta?.info === "string" ? block.payload.meta.info : extracted.info;
    const { lang, meta } = parseCodeFenceInfo(info);
    let diffInfo = detectDiffLanguage(lang, meta);
    const codeBody = typeof preparedCode === "string" ? block.isFinalized ? preparedCode : trimProvisionalNativeCode(raw, preparedCode)
      : extracted.hadFence ? dedentFencedCodeByClosingIndent(raw, extracted.code) : dedentIndentedCode(raw);
    const codeLines = codeBody.split("\n");
    if (!diffInfo.isDiff && this.emitDiffBlocks && looksLikeUnifiedDiff(codeLines)) {
      diffInfo = {
        isDiff: true,
        diffLang: "diff",
        baseLang: guessLanguageFromDiffLines(codeLines),
      };
    }
    const requestedLanguage = diffInfo.isDiff ? diffInfo.diffLang : (lang || undefined);
    const highlightLanguage = diffInfo.isDiff ? diffInfo.diffLang : (normalizeLang(lang) || "text");
    const tokenLanguage = diffInfo.isDiff ? diffInfo.baseLang ?? "text" : highlightLanguage;
    const baseMeta = (block.payload.meta ?? {}) as Record<string, unknown>;
    let resolvedLanguage = highlightLanguage;
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
        if (requestedLanguage === undefined) delete nextMeta.lang;
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
            resolvedLanguage = await resolveHighlightLanguage(this.highlighter, highlightLanguage);
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
                  themes: this.codeThemes,
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
                  this.codeThemes,
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
        if (requestedLanguage === undefined) delete nextMeta.lang;
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
          resolvedLanguage = await resolveHighlightLanguage(this.highlighter, highlightLanguage);
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
      if (requestedLanguage === undefined) delete nextMeta.lang;
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
        resolvedLanguage = await resolveHighlightLanguage(this.highlighter, highlightLanguage);
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
    if (requestedLanguage === undefined) delete nextMeta.lang;

    if (wantsHtml && hasHighlighter && hasHighlightableContent) {
      // The shared cache holds raw Shiki HTML; the language class depends on the authored info string.
      const cached = getCachedHighlight(resolvedLanguage, this.codeThemes, codeBody);
      if (cached?.html) {
        block.payload.highlightedHtml = enhanceHighlightedHtml(cached.html, requestedLanguage);
      } else {
        try {
          const highlighted = this.highlighter!.codeToHtml(codeBody, {
            lang: resolvedLanguage as never,
            themes: this.codeThemes,
            defaultColor: false,
          });
          block.payload.highlightedHtml = enhanceHighlightedHtml(highlighted, requestedLanguage);
          setCachedHighlight(resolvedLanguage, this.codeThemes, codeBody, {
            ...cached,
            html: highlighted,
            lang: resolvedLanguage,
          });
        } catch (error) {
          console.warn("Shiki codeToHtml failed:", error);
        }
      }
    }

    let tokenLines: Array<TokenLineV1 | null> | undefined;
    let diffKind: Array<DiffLineKind | null> | undefined;
    let diffOldNo: Array<number | null> | undefined;
    let diffNewNo: Array<number | null> | undefined;

    if (wantsTokens) {
      let diffLines: string[] = [];
      if (diffInfo.isDiff) {
        diffLines = codeBody.length > 0 ? codeBody.split("\n") : [];
        const cursor: DiffCursorState = { oldLine: null, newLine: null };
        const diffInfoLines = diffLines.map((line) => parseUnifiedDiffLine(line, cursor));
        diffKind = diffInfoLines.map((line) => toDiffLineKind(line.kind));
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
              this.codeThemes,
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
        const cached = getCachedHighlight(resolvedTokenLanguage, this.codeThemes, codeBody);
        if (cached?.tokenLines) {
          tokenLines = cached.tokenLines;
        } else {
          try {
            const tokens = this.highlighter!.codeToTokensWithThemes(codeBody, {
              lang: resolvedTokenLanguage as never,
              themes: this.codeThemes,
            }) as ShikiThemedToken[][];
            tokenLines = renderTokenLines(tokens);
            setCachedHighlight(resolvedTokenLanguage, this.codeThemes, codeBody, {
              ...cached,
              tokenLines,
              lang: resolvedTokenLanguage,
            });
          } catch (error) {
            console.warn("Shiki codeToTokens failed:", error);
            tokenLines = new Array(codeLines.length).fill(null);
          }
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
    for (const block of reparsedBlocks) {
      block.isFinalized = true;
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

  private scheduleLazyTokenizationProcessing(): void {
    if (this.lazyTokenizationScheduled) return;
    this.lazyTokenizationScheduled = true;
    const generation = this.documentGeneration;
    queueMicrotask(async () => {
      if (this.disposed || generation !== this.documentGeneration) return;
      this.lazyTokenizationScheduled = false;
      try {
        await this.processLazyTokenizationQueue();
      } catch (error) {
        console.error("Lazy tokenization error:", error);
        this.reportError(error, "TOKENIZE_RANGE", { phase: "TOKENIZE_RANGE" });
      }
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
          : (node.kind === "element" || node.kind === "component") ? findTree(node.children) : undefined;
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
      const treeKey = getActiveHtmlTreeKey(meta);
      const tree = treeKey ? (meta?.[treeKey] as HtmlTreeNode[] | undefined) : undefined;
      const owned = tree ? findTree(tree) : undefined;
      if (owned) return owned;
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
      } else if (node.kind === "element" || node.kind === "component") {
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
      const treeKey = getActiveHtmlTreeKey(meta);
      if (treeKey) {
        const tree = meta[treeKey] as HtmlTreeNode[] | undefined;
        if (tree) set(treeKey, mapChanged(tree, replaceTreeNode));
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
    const sourceRaw = block.payload.raw;
    const sourceCode = block.payload.meta?.code;
    const sourceInfo = block.payload.meta?.info;
    const sourceLanguage = block.payload.meta?.lang;
    const sourceHighlightLanguage = block.payload.meta?.highlightLang;
    const themeDark = this.codeThemes.dark;
    const themeLight = this.codeThemes.light;
    const currentTarget = () => {
      if (this.disposed || generation !== this.documentGeneration) return undefined;
      const current = this.findPreparedCode(block.id);
      const leaf = current?.block;
      return leaf?.type === "code" && leaf.isFinalized && leaf.payload.raw === sourceRaw
        && leaf.payload.meta?.code === sourceCode && leaf.payload.meta?.info === sourceInfo
        && leaf.payload.meta?.lang === sourceLanguage && leaf.payload.meta?.highlightLang === sourceHighlightLanguage
        && this.codeThemes.dark === themeDark && this.codeThemes.light === themeLight ? current : undefined;
    };

    const raw = block.payload.raw ?? "";
    const extracted = stripCodeFence(block.isFinalized ? raw : trimProvisionalFenceTail(raw));
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
    const requestedLanguage = diffInfo.isDiff ? diffInfo.diffLang : (lang || undefined);
    const highlightLanguage = diffInfo.isDiff ? diffInfo.diffLang : (normalizeLang(lang) || "text");
    const tokenLanguage = diffInfo.isDiff ? diffInfo.baseLang ?? "text" : highlightLanguage;
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

    let resolvedLanguage = highlightLanguage;
    let resolvedTokenLanguage = tokenLanguage;
    if (wantsHtml) {
      resolvedLanguage = await resolveHighlightLanguage(this.highlighter, highlightLanguage);
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

    const tokenizationStart = now();
    const segmentLines = codeLines.slice(state.processedLines, targetEnd);
    let nextGrammarState = state.grammarState;
    let highlightedSegment: Array<string | null> | undefined;
    let tokenizedSegment: Array<TokenLineV1 | null> | undefined;
    let nextDiffCursor: DiffCursorState | undefined;
    let diffSegment: DiffLineInfo[] | undefined;

    if (segmentLines.length > 0) {
      if (wantsHtml || (wantsTokens && !diffEnabled)) {
        try {
          const sharedLanguage = wantsHtml ? resolvedLanguage : resolvedTokenLanguage;
          const tokens = this.highlighter.codeToTokensWithThemes(segmentLines.join("\n"), {
            lang: sharedLanguage as never,
            themes: this.codeThemes,
            grammarState: nextGrammarState as never,
          } as never) as ShikiThemedToken[][];
          if (wantsHtml) highlightedSegment = renderShikiLines(tokens);
          if (wantsTokens && !diffEnabled) tokenizedSegment = renderTokenLines(tokens);
          nextGrammarState = this.highlighter.getLastGrammarState(tokens as never);
        } catch (error) {
          console.warn("Lazy tokenization failed for", requestedLanguage, error);
        }
      }

      if (wantsTokens && diffEnabled) {
        const cursor = { oldLine: state.diffCursor?.oldLine ?? null, newLine: state.diffCursor?.newLine ?? null };
        const diffLines = segmentLines.map((line) => parseUnifiedDiffLine(line, cursor));
        const grammarObj = { context: nextGrammarState };
        const { tokenLines, grammarState: nextState } = await buildDiffTokenLines(
          diffLines,
          resolvedTokenLanguage,
          grammarObj,
          this.highlighter,
          this.codeThemes,
        );
        if (!currentTarget()) {
          if (this.activeMetricsCollector === metricsCollector) this.activeMetricsCollector = null;
          return;
        }
        nextGrammarState = nextState.context;
        nextDiffCursor = cursor;
        diffSegment = diffLines;
        tokenizedSegment = tokenLines;
      }
    }

    const commitTarget = currentTarget();
    if (!commitTarget) {
      if (this.activeMetricsCollector === metricsCollector) this.activeMetricsCollector = null;
      return;
    }
    const root = this.blocks[commitTarget.rootIndex];
    const prevSnapshot = createBlockSnapshot(root);
    for (let i = 0; i < segmentLines.length; i++) {
      const index = state.processedLines + i;
      if (highlightedSegment) state.highlightedLines[index] = highlightedSegment[i] ?? null;
      if (tokenizedSegment) state.tokenLines[index] = tokenizedSegment[i] ?? null;
      if (diffSegment) {
        state.diffKind[index] = toDiffLineKind(diffSegment[i].kind);
        state.oldNo[index] = diffSegment[i].oldNo ?? null;
        state.newNo[index] = diffSegment[i].newNo ?? null;
      }
    }
    state.grammarState = nextGrammarState;
    if (nextDiffCursor) state.diffCursor = nextDiffCursor;
    state.processedLines = targetEnd;
    const tokenizationDuration = now() - tokenizationStart;
    metricsCollector.recordLazyTokenization(targetEnd - startLine, tokenizationDuration, this.lazyTokenizationQueue.size);

    const updated = cloneBlock(commitTarget.block);
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
