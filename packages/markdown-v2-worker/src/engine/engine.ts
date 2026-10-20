declare const __STREAM_MDX_COUNTERS__: boolean;

interface ProgressPublicationContext {
  readonly generation: number;
  readonly publicationId: number;
  readonly sourceUnits: number;
  nextOrdinal: number;
}


interface CampaignCounterSink {
  recordTokenization(lines: number, units: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordInlineSourceUnits(units: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordSnapshotNodes(count?: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordPrefixComparisons(count?: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordPatchesEmitted(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordStoreRecordsTouched(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordSourceUnitsRead(units: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordSourceUnitsMaterialized(units: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordSourceDirectoryEntriesCopied(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordRecordSlotsAllocated(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordCodeSourceUnitsPrepared(units: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  attachSourceSnapshotReader(reader: () => SourceSnapshot): void;
  recordBlockReprepared(cause?: string, blockId?: string, fields?: string[], stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordInvalidation(cause: string, blockId: string, fields?: string[]): void;
  recordPublication(tx: number, frontier: number): void;
  recordProcessedFrontier(frontier: number, tx?: number): void;
  isProgressTraceEnabled?(): boolean;
  beginProgressDocument?(generation: number): void;
  recordEngineEntered?(generation: number, sourceUnits: number): void;
  recordParsedPublication?(publication: {
    readonly generation: number;
    readonly publicationId: number;
    readonly sourceUnits: number;
    readonly semanticPatchCount: number;
  }): void;
  reset(): void;
}

import { type SyntaxNode, type Tree, TreeFragment } from "@lezer/common";
import { GFM, Table, parser as mdParser } from "@lezer/markdown";
import type {
  Block,
  BlockResolvedLinkReference,
  CodeHighlightOutputMode,
  CodeHighlightThemes,
  CompiledMdxModule,
  DiffLineKind,
  FormatAnticipationConfig,
  HtmlOptions,
  HtmlTreeNode,
  MixedContentSegment,
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
  ParagraphSpanChildSnapshot,
  ParagraphSpanRecord,
  WorkerErrorPayload,
  WorkerIn,
  WorkerOut,
  WorkerPhase,
  SourceSnapshot,
} from "@stream-mdx/core";
import {
  AppendSourceDocument,
  STREAM_MDX_SCHEMA_VERSION,
  InlineParser,
  PATCH_ROOT_ID,
  PerformanceTimer,
  blocksStructurallyEqual,
  cloneBlock,
  createBlockSnapshot,
  extractHighlightedLines,
  extractLezerCode,
  prepareNestedBlockSnapshot,
  createBlockCompatibilityExtension,
  collectLinkReferences,
  diffLinkReferences,
  dedentIndentedCode,
  detectMDX,
  extractMixedContentSegmentsWithLookahead,
  generateBlockId,
  createContainerSignature,
  normalizeFormatAnticipation,
  normalizeLang,
  parseCodeFenceInfo,
  prepareInlineStreamingLookahead,
  removeHeadingMarkers,
  sanitizeHtmlInWorker,
  sanitizeHtmlTreeInWorker,
  stripCodeFence,
} from "@stream-mdx/core";
import {
  CalloutsPlugin,
  DocumentPluginRegistry,
  type DocumentState,
  type FootnoteParagraphTargetDelta,
  type FootnoteParagraphTargetUpdate,
  HTMLBlockPlugin,
  MDXDetectionPlugin,
  TablesPlugin,
  registerFootnotesPlugin,
} from "@stream-mdx/plugins";
import { isBlockLevelNode, mapLezerNodeToBlockType } from "../parser/block-types";
import { HtmlContinuationExtension } from "../parser/html-extension";
import { applyHtmlTagBalance, containsInlineHtml, groupHtmlOwnership, normalizeHtmlParagraph, preserveInlineComponentSource } from "./html-ownership";
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
  collectCodeProtectedRanges,
  collectHtmlProtectedRangesFromSegments,
  collectMathProtectedRanges,
  collectNestedListItemInlineSources,
  maybeBuildTocPatch,
  parseGfmTableFromTree,
  reportWorkerStructuralInvariantViolations,
  slugifyHeading,
  trimProvisionalFenceTail,
  trimProvisionalNativeCode,
} from "./parse-extract";
import {
  createRootCodeOwners,
  rootCodeAppendChange,
  rootCodeAppendPatch,
  rootCodeDecoratePatch,
  rootCodeNodeSnapshot,
  RootCodeHighlighter,
  SourceRangeInput,
  type RootCodeHighlightConfiguration,
} from "./root-code-pipeline";
import type { RootCodeSourceOwner } from "./root-code-owner";
import { NativeMarkdownInput } from "./native-markdown-input";
import {
  createRootTableOwners,
  rootTableAppendChange,
  rootTableAppendPatch,
  rootTableNodeSnapshot,
  rootTableSemanticPatch,
} from "./root-table-pipeline";
import { RootTableSourceOwner, type RootTableFootnoteProjection } from "./root-table-owner";
import {
  advanceRootParagraphOwner,
  createRootParagraphOwners,
  finalizeRootParagraphOwner,
  isFinalizedRootParagraphAppendCandidate,
  probeFinalizedRootParagraphAppend,
  releaseRootParagraphOwner,
  rootParagraphAppendChange,
  rootParagraphAppendPatch,
  rootParagraphChangeNeedsReplacement,
  rootParagraphNodeSnapshot,
  rootParagraphPendingRootOffset,
  rootParagraphSemanticPatch,
} from "./root-paragraph-pipeline";
import {
  attestNativeParagraphWindowGrammar,
  type NativeParagraphWindowAttestation,
} from "./native-paragraph-tail";
import {
  RootParagraphSourceOwner,
  type ParagraphInlineSettlementMode,
  type PreparedParagraphSpanContent,
} from "./root-paragraph-owner";
import {
  countChangedBlocksFromPatches,
  dedupeSetPropsByTargetKeepingLatest,
  diffNodeSnapshot,
  ensureAnnotatedPatchBatch,
  estimatePatchSize,
  partitionPatchesForCredits,
  syncEmittedBlockEpochsFromPatches,
  withPatchKind,
  withPatchKindBatch,
} from "./patch-emit";
import { getPatchKind } from "@stream-mdx/core/perf/patch-batching";
import type {
  CodeHighlightingMode,
  ContentChangeRange,
  DiffCursorState,
  DiffLineInfo,
  EngineExtensions,
  IncrementalHighlightState,
  LazyTokenizationState,
  MarkdownEngineOptions,
  MdxStatusUpdate,
  ParseOptions,
  ShikiThemedToken,
  WorkerMdxMode,
} from "./types";

const NO_ROOT_PARAGRAPH_OWNERS: readonly RootParagraphSourceOwner[] = Object.freeze([]);


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
const LINK_REFERENCE_FREE_BLOCKS = new Set([
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "CommentBlock",
  "ProcessingInstructionBlock",
  "HorizontalRule",
  "Table",
]);

type SourceText = string | SourceSnapshot;

function readSourceRange(source: SourceText, from: number, to: number): string {
  return typeof source === "string" ? source.slice(from, to) : source.read(from, to);
}
function collectLinkReferenceStarts(
  tree: Tree,
  source: SourceText,
  sourceOffset: number,
  references: ReadonlyMap<string, LinkReferenceDefinition>,
): Map<string, number> {
  const labels = new Map<string, string>();
  for (const [key, reference] of references) {
    labels.set(reference.label ?? key, key);
  }
  const starts = new Map<string, number>();
  tree.iterate({
    enter(node) {
      if (LINK_REFERENCE_FREE_BLOCKS.has(node.name)) return false;
      if (node.name !== "LinkReference") return;
      let labelNode = node.node.firstChild;
      while (labelNode && labelNode.name !== "LinkLabel") labelNode = labelNode.nextSibling;
      if (!labelNode) return false;
      let rawLabel = readSourceRange(source, labelNode.from, labelNode.to);
      if (rawLabel.startsWith("[") && rawLabel.endsWith("]")) rawLabel = rawLabel.slice(1, -1);
      const key = labels.get(rawLabel);
      if (key !== undefined && !starts.has(key)) starts.set(key, sourceOffset + node.from);
      return false;
    },
  });
  return starts;
}


function sourceCharAt(source: SourceText, index: number): string {
  return typeof source === "string" ? (source[index] ?? "") : source.read(index, index + 1);
}

function sourceLineStart(source: SourceText, before: number): number {
  if (typeof source === "string") return source.lastIndexOf("\n", before - 1) + 1;
  let cursor = Math.max(0, Math.min(source.length, before));
  while (cursor > 0) {
    const start = Math.max(0, cursor - 4096);
    const newline = source.read(start, cursor).lastIndexOf("\n");
    if (newline >= 0) return start + newline + 1;
    cursor = start;
  }
  return 0;
}

function sourceRangeHasNonWhitespace(source: SourceText, from: number, to: number): boolean {
  if (typeof source === "string") return /\S/.test(source.slice(from, to));
  let cursor = Math.max(0, from);
  const end = Math.min(source.length, to);
  while (cursor < end) {
    const chunk = source.chunk(cursor);
    if (chunk.length === 0) return false;
    const count = Math.min(chunk.length, end - cursor);
    const range = count === chunk.length ? chunk : chunk.slice(0, count);
    if (/\S/.test(range)) return true;
    cursor += count;
  }
  return false;
}

function sourceLength(source: SourceText): number {
  return source.length;
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

function nestedCodeBlockIds(blocks: readonly Block[]): ReadonlySet<string> {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();

  const visitSnapshots = (snapshots: readonly NodeSnapshot[]): void => {
    for (const snapshot of snapshots) {
      if (seen.has(snapshot)) continue;
      seen.add(snapshot);
      if (snapshot.type === "code") ids.add(snapshot.id);
      const block = snapshot.props?.block as Block | undefined;
      if (block) visitBlock(block, true);
      visitSnapshots(snapshot.children ?? []);
    }
  };

  const visitTree = (tree: readonly HtmlTreeNode[]): void => {
    for (const node of tree) {
      if (node.kind === "block") visitBlock(node.block, true);
      else if (node.kind === "element") visitTree(node.children);
    }
  };

  const visitBlock = (block: Block, nested: boolean): void => {
    if (nested && block.type === "code") ids.add(block.id);
    if (seen.has(block)) return;
    seen.add(block);
    const prepared = block.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
    if (prepared) visitSnapshots(prepared.children);
    for (const key of ["htmlTree", "htmlParagraphTree"]) {
      const tree = block.payload.meta?.[key] as HtmlTreeNode[] | undefined;
      if (tree) visitTree(tree);
    }
  };

  for (const block of blocks) visitBlock(block, false);
  return ids;
}

function rootCodeStartsInsideOpenHtml(
  tree: Tree,
  source: SourceSnapshot,
  sourceOffset: number,
  parser: typeof mdParser,
  mdxComponents: boolean,
): ReadonlySet<number> {
  const nestedStarts = new Set<number>();
  const stack: string[] = [];
  const cursor = tree.cursor();
  if (!cursor.firstChild()) return nestedStarts;
  do {
    if (cursor.type.name === "FencedCode" && stack.length > 0) {
      nestedStarts.add(cursor.from + sourceOffset);
    } else if (cursor.type.name === "HTMLBlock") {
      applyHtmlTagBalance(source.read(cursor.from + sourceOffset, cursor.to + sourceOffset), parser, stack, mdxComponents);
    }
  } while (cursor.nextSibling());
  return nestedStarts;
}

function excludeRootCodeOwnersInsideOpenHtml(
  owners: readonly RootCodeSourceOwner[],
  tree: Tree,
  source: SourceSnapshot,
  sourceOffset: number,
  parser: typeof mdParser,
  mdxComponents: boolean,
): RootCodeSourceOwner[] {
  const nestedStarts = rootCodeStartsInsideOpenHtml(tree, source, sourceOffset, parser, mdxComponents);
  return owners.filter((owner) => !nestedStarts.has(owner.getMetadata().sourceRange.from));
}

export class MarkdownEngine {
  private readonly postFn: (message: WorkerOut) => void;
  public readonly extensions?: EngineExtensions;
  private mdParser!: typeof mdParser;
  private rootParagraphWindowAttestation?: NativeParagraphWindowAttestation;

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
  private currentLinkReferenceStarts = new Map<string, number>();
  private currentLinkReferences = new Map<string, LinkReferenceDefinition>();
  private blockAttemptedReferences = new Map<string, Set<string>>();
  private sourceDocument: AppendSourceDocument;
  private rootCodeOwners: RootCodeSourceOwner[] = [];
  private rootTableOwners: RootTableSourceOwner[] = [];
  private rootParagraphOwners: RootParagraphSourceOwner[] = [];
  private readonly rootParagraphOwnersByStart = new Map<number, RootParagraphSourceOwner>();
  private readonly emittedRootParagraphIds = new Set<string>();
  private pendingRootParagraphPatches: Patch[] = [];
  private readonly rootTableOwnersByStart = new Map<number, RootTableSourceOwner>();
  private readonly emittedRootTableIds = new Set<string>();
  private pendingRootTablePatches: Patch[] = [];
  private rootNativeFragmentOffset: number | null = null;
  private readonly rootCodeOwnersByStart = new Map<number, RootCodeSourceOwner>();
  private readonly emittedRootCodeIds = new Set<string>();
  private readonly rootCodeHighlighter = new RootCodeHighlighter();
  private rootCodeConfigurationRevision = 0;
  private rootParagraphGeneration = 0;
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
  declare private campaignCounters?: CampaignCounterSink;
  declare private progressPublicationId?: number;


  constructor(options: MarkdownEngineOptions) {
    this.postFn = options.post;
    this.extensions = options.extensions;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters = (options as MarkdownEngineOptions & { campaignCounters?: CampaignCounterSink }).campaignCounters;
    }
    this.sourceDocument = this.createSourceDocument();
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.attachSourceSnapshotReader(() => this.sourceDocument.snapshot());
    }

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

  private createSourceDocument(): AppendSourceDocument {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      return new AppendSourceDocument({ counters: this.campaignCounters } as never);
    }
    return new AppendSourceDocument();
  }

  private buildMarkdownParser(tables: boolean): void {
    const gfm = tables ? GFM : GFM.filter((extension) => extension !== Table);
    this.mdParser = mdParser.configure([gfm, createBlockCompatibilityExtension(), HtmlContinuationExtension, ...(this.extensions?.markdown ?? [])]);
    const customMarkdownExtensions = this.extensions?.markdown ?? [];
    this.rootParagraphWindowAttestation = customMarkdownExtensions.length === 0
      ? attestNativeParagraphWindowGrammar(this.mdParser, {
          tablesEnabled: tables,
          blockCompatibility: true,
          htmlContinuation: true,
          customMarkdownExtensions,
        })
      : undefined;
  }

  private rootParagraphOwnershipSupported(): boolean {
    return Boolean(this.rootParagraphWindowAttestation)
      && (this.extensions?.documentPlugins?.length ?? 0) === 0
      && (this.extensions?.inline?.length ?? 0) === 0
      && this.syntaxRules.length === 0;
  }

  private rootParagraphInlineSettlement(): ParagraphInlineSettlementMode {
    return (this.extensions?.inline?.length ?? 0) > 0 || this.syntaxRules.length > 0
      ? "original-context"
      : "native-tail";
  }

  private admitRootParagraphOwners(tree: Tree, sourceOffset = 0, finalized = false): readonly RootParagraphSourceOwner[] {
    if (!this.rootParagraphOwnershipSupported()) return [];
    return createRootParagraphOwners(tree, this.sourceDocument, this.rootParagraphGeneration, {
      parser: this.mdParser,
      inlineParser: this.inlineParser,
      inlineSettlement: this.rootParagraphInlineSettlement(),
      prepareProvisionalInline: (content, onAttemptedReference) => this.parseInlineStreaming(
        content,
        this.rootParagraphInlineContext(),
        undefined,
        onAttemptedReference,
        false,
      ).inline,
      prepareSpanChildren: (content, baseOffset, provisional, ownerId, ownerGeneration, spanIndex) =>
        this.rootParagraphSpanChildren(content, baseOffset, provisional, ownerId, ownerGeneration, spanIndex),
      ...(this.rootParagraphWindowAttestation ? { attestation: this.rootParagraphWindowAttestation } : {}),
      sourceOffset,
      finalized,
      ...(typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.campaignCounters
        ? { counters: this.campaignCounters }
        : {}),
    });
  }

  private rootParagraphInlineContext(
    segmentOrigin: "direct-inline" | "mixed-content" = "direct-inline",
  ): LookaheadContainerContext {
    const context = {
      blockType: "paragraph",
      ancestorTypes: [],
      listDepth: 0,
      blockquoteDepth: 0,
      insideHtml: false,
      insideMdx: false,
      segmentOrigin,
      provisional: true,
      localTextField: segmentOrigin === "mixed-content" ? "paragraph-inline" : "raw",
    };
    return { ...context, containerSignature: createContainerSignature(context) };
  }

  private rootParagraphSpanChildren(
    content: string,
    baseOffset: number,
    provisional: boolean,
    ownerId: string,
    ownerGeneration: number,
    spanIndex: number,
  ): PreparedParagraphSpanContent | null {
    if (!content.includes("<") && !content.includes("{")) return null;
    const protectedRanges = collectCodeProtectedRanges(content);
    if (this.enableMath) protectedRanges.push(...collectMathProtectedRanges(content, protectedRanges));
    protectedRanges.push(...collectAutolinkProtectedRanges(content));
    const absoluteProtectedRanges = protectedRanges.map((range) => ({
      ...range,
      from: baseOffset + range.from,
      to: baseOffset + range.to,
    }));
    const context = this.rootParagraphInlineContext("mixed-content");
    const attemptedReferences = new Set<string>();
    const onAttemptedReference = (label: string) => attemptedReferences.add(label);
    const inline = (value: string): InlineNode[] => {
      const parsed = provisional
        ? this.parseInlineStreaming(value, context, undefined, onAttemptedReference, false).inline
        : this.inlineParser.parse(value, { cache: false, onAttemptedReference });
      return this.mdxEnabled ? preserveInlineComponentSource(parsed) : parsed;
    };
    const extraction = extractMixedContentSegmentsWithLookahead(content, baseOffset, inline, {
      html: provisional && this.formatAnticipationConfig.html
        ? { autoClose: true, maxNewlines: MIXED_CONTENT_AUTOCLOSE_NEWLINES }
        : undefined,
      mdx: {
        autoClose: provisional && this.mdxEnabled && this.formatAnticipationConfig.mdx,
        maxNewlines: MIXED_CONTENT_AUTOCLOSE_NEWLINES,
        componentAllowlist: this.mdxEnabled ? this.mdxComponentAllowlist ?? undefined : [],
      },
      protectedRanges: absoluteProtectedRanges,
      allowedTags: this.htmlConfig?.allowedTags,
      literalTagContent: this.htmlConfig?.literalTagContent,
      lookaheadContext: context,
    });
    const sourceEnd = baseOffset + content.length;
    const rangedSegments: Array<{
      segment: (typeof extraction.segments)[number];
      range: { readonly from: number; readonly to: number };
    }> = [];
    let expectedFrom = baseOffset;
    for (const segment of extraction.segments) {
      const range = segment.range;
      if (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
        || range.from !== expectedFrom || range.to <= range.from || range.to > sourceEnd) {
        throw new RangeError(`Invalid native paragraph segment range for ${ownerId} span ${spanIndex}`);
      }
      if (segment.kind === "text" && !segment.inline) {
        throw new Error(`Missing prepared inline meaning in native paragraph span ${ownerId}:${spanIndex}`);
      }
      rangedSegments.push({ segment, range });
      expectedFrom = range.to;
    }
    if (expectedFrom !== sourceEnd) {
      throw new RangeError(`Incomplete native paragraph segment coverage for ${ownerId} span ${spanIndex}`);
    }
    if (!rangedSegments.some(({ segment }) => segment.kind !== "text")) {
      return {
        nodes: rangedSegments.flatMap(({ segment }) => {
          if (segment.kind !== "text") return [];
          if (!segment.inline) throw new Error(`Missing prepared inline meaning in native paragraph span ${ownerId}:${spanIndex}`);
          return segment.inline;
        }),
        attemptedReferences: Object.freeze(Array.from(attemptedReferences).sort()),
      };
    }
    const children = rangedSegments.map(({ segment, range }, index) => {
      const meta = provisional && segment.lookahead?.length ? { lookahead: segment.lookahead } : undefined;
      let props: Record<string, unknown>;
      if (segment.kind === "text") {
        if (!segment.inline) throw new Error(`Missing prepared inline meaning in native paragraph span ${ownerId}:${spanIndex}`);
        props = { text: segment.value, inline: segment.inline };
      } else if (segment.kind === "html") {
        props = {
          raw: segment.value,
          html: segment.sanitized ?? segment.value,
          htmlTree: sanitizeHtmlTreeInWorker(segment.value, this.mixedHtmlConfig, undefined, inline),
        };
      } else {
        props = { raw: segment.value, status: segment.status ?? "pending", error: segment.error };
      }
      return {
        id: `${ownerId}:g${ownerGeneration}:span:${spanIndex}:segment:${index}`,
        type: `paragraph-${segment.kind}`,
        range,
        props,
        ...(meta ? { meta } : {}),
      } satisfies ParagraphSpanChildSnapshot;
    });
    return {
      children,
      attemptedReferences: Object.freeze(Array.from(attemptedReferences).sort()),
    };
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
    this.workerMdxCache.clear();
    this.workerMdxInflight.clear();
    this.documentPluginRegistry.clear();
    this.blocks = [];
    this.lastTree = null;
    this.treeFragments = [];
    this.rootNativeFragmentOffset = null;
    for (const owner of this.rootParagraphOwners) releaseRootParagraphOwner(owner);
    this.sourceDocument = this.createSourceDocument();
    this.rootCodeOwners = [];
    this.rootParagraphOwners = [];
    this.rootParagraphOwnersByStart.clear();
    this.emittedRootParagraphIds.clear();
    this.pendingRootParagraphPatches = [];
    this.rootCodeOwnersByStart.clear();
    this.emittedRootCodeIds.clear();
    this.rootTableOwners = [];
    this.rootTableOwnersByStart.clear();
    this.emittedRootTableIds.clear();
    this.pendingRootTablePatches = [];
    this.rootCodeHighlighter.clear();
    this.currentLinkReferences.clear();
    this.currentLinkReferenceStarts.clear();
    this.blockAttemptedReferences.clear();
    this.emittedBlockEpochs.clear();
    this.tocHeadings = [];
    this.headingIdCounts.clear();
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.reset();
    }
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

  private createProgressPublication(sourceUnits: number): ProgressPublicationContext | undefined {
    if (!(typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__)) return undefined;
    const publicationId = (this.progressPublicationId ?? 0) + 1;
    this.progressPublicationId = publicationId;
    return {
      generation: this.documentGeneration,
      publicationId,
      sourceUnits,
      nextOrdinal: 0,
    };
  }

  private tagSemanticPatchesForProgress(
    patches: Patch[],
    publication: ProgressPublicationContext,
    currentPatches?: Set<Patch>,
  ): void {
    if (!(typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__)) return;
    for (let index = 0; index < patches.length; index += 1) {
      const patch = patches[index];
      if (!patch || (currentPatches && !currentPatches.has(patch)) || getPatchKind(patch) !== "semantic") {
        continue;
      }
      const taggedPatch = {
        ...patch,
        __streamMdxDiagnosticPatchTag: {
          generation: publication.generation,
          publicationId: publication.publicationId,
          ordinal: publication.nextOrdinal,
        },
      };
      patches[index] = taggedPatch;
      publication.nextOrdinal += 1;
    }
  }

  private recordParsedProgressPublication(publication: ProgressPublicationContext): void {
    if (!(typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__)) return;
    this.campaignCounters?.recordParsedPublication?.({
      generation: publication.generation,
      publicationId: publication.publicationId,
      sourceUnits: publication.sourceUnits,
      semanticPatchCount: publication.nextOrdinal,
    });
  }

  private async processMessage(msg: WorkerIn): Promise<void> {
    switch (msg.type) {
      case "INIT":
        if (msg.schemaVersion !== STREAM_MDX_SCHEMA_VERSION) {
          this.reportError(
            new Error(`Unsupported stream-mdx schema version: ${String(msg.schemaVersion)}`),
            "INIT",
            { expectedSchemaVersion: STREAM_MDX_SCHEMA_VERSION },
          );
          return;
        }
        await this.initialize(
          msg.initialContent,
          msg.prewarmLangs ?? [],
          msg.docPlugins,
          msg.mdx,
          msg.syntax,
          msg.html,
          msg.themes ?? msg.docPlugins?.themes,
        );
        return;
      case "APPEND":
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.campaignCounters?.isProgressTraceEnabled?.()) {
          this.campaignCounters.recordEngineEntered?.(this.documentGeneration, this.sourceDocument.length + msg.text.length);
        }
        await this.handleAppend(msg.text);
        return;
      case "FINALIZE":
        await this.finalizeAllBlocks();
        return;
      case "DEBUG_STATE": {
        const debugBlocks = this.materializeRootBlocks();
        const blockTypeCounts: Record<string, number> = {};
        for (const block of debugBlocks) {
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
        for (const block of debugBlocks) {
          if (seenBlockIds.has(block.id)) {
            if (duplicateBlockIds.length < 8) {
              duplicateBlockIds.push(block.id);
            }
          } else {
            seenBlockIds.add(block.id);
          }
        }
        if (debugBlocks.length > 0) {
          const lastBlock = debugBlocks[debugBlocks.length - 1];
          lastBlockType = lastBlock.type;
          const range = lastBlock.payload.range;
          if (range && typeof range.from === "number" && typeof range.to === "number") {
            lastBlockRange = { from: range.from, to: range.to };
          }
          const raw = typeof lastBlock.payload.raw === "string" ? lastBlock.payload.raw : "";
          lastBlockRawTail = raw ? raw.slice(Math.max(0, raw.length - 240)) : undefined;
          for (const block of debugBlocks) {
            if (block.type === "heading" && typeof block.payload.raw === "string") {
              headingTexts.push(block.payload.raw);
            }
          }
          const targets = ["HTML and MDX Testing", "Inline Code", "Code Blocks", "Media", "Tables", "Footnotes"];
          for (let i = 0; i < debugBlocks.length; i++) {
            const block = debugBlocks[i];
            if (block.type === "heading" && typeof block.payload.raw === "string") {
              if (targets.includes(block.payload.raw)) {
                headingIndices[block.payload.raw] = i;
              }
            }
          }
          const tailStart = Math.max(0, debugBlocks.length - 8);
          for (let i = tailStart; i < debugBlocks.length; i++) {
            const block = debugBlocks[i];
            const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
            tailBlocks.push({
              id: block.id,
              type: block.type,
              raw: raw.slice(0, 120),
            });
          }
          const headEnd = Math.min(8, debugBlocks.length);
          for (let i = 0; i < headEnd; i++) {
            const block = debugBlocks[i];
            const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
            headBlocks.push({
              id: block.id,
              type: block.type,
              raw: raw.slice(0, 120),
            });
          }
        }
        const debugContent = this.sourceDocument.snapshot().materialize();
        const contentTail = debugContent.slice(Math.max(0, debugContent.length - 500));
        this.post({
          type: "DEBUG_STATE",
          state: {
            contentLength: this.sourceDocument.length,
            contentTail,
            blockCount: debugBlocks.length,
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
            hasInlineCodeHeading: debugContent.includes("# Inline Code"),
            hasCodeBlocksHeading: debugContent.includes("# Code Blocks"),
            hasMediaHeading: debugContent.includes("# Media"),
          },
        } as WorkerOut);
        return;
      }
      case "DUMP_BLOCKS": {
        this.post({
          type: "DUMP_BLOCKS",
          blocks: this.materializeRootBlocks(),
          tocHeadings: this.tocHeadings,
        });
        return;
      }
      case "TOKENIZE_RANGE": {
        const rootOwner = this.rootCodeOwners.find((owner) => owner.id === msg.blockId);
        if (rootOwner) {
          const generation = this.documentGeneration;
          const configurationRevision = this.rootCodeConfigurationRevision;
          const decorations = await this.rootCodeHighlighter.tokenizeRange(
            rootOwner,
            msg.startLine,
            msg.endLine,
            this.rootCodeHighlightConfiguration(true),
            () => !this.disposed
              && generation === this.documentGeneration
              && configurationRevision === this.rootCodeConfigurationRevision
              && rootOwner.getMetadata().generation === generation,
          );
          const patch = rootCodeDecoratePatch(rootOwner, configurationRevision, decorations);
          const patches: Patch[] = [];
          const block = cloneBlock(rootOwner.materializeBlock());
          const blockMeta = { ...(block.payload.meta ?? {}) };
          if (blockMeta.lazyTokenization === true && decorations.length > 0) {
            const info = typeof blockMeta.info === "string" ? blockMeta.info : "";
            const { lang, meta } = parseCodeFenceInfo(info);
            const diffInfo = detectDiffLanguage(lang, meta);
            if (this.emitDiffBlocks && diffInfo.isDiff) {
              const code = typeof blockMeta.code === "string" ? blockMeta.code : "";
              const codeLines = code.split("\n");
              const cursor: DiffCursorState = { oldLine: null, newLine: null };
              const diffLines = codeLines.map((line) => parseUnifiedDiffLine(line, cursor));
              blockMeta.diffBlocks = buildDiffBlocksFromLines(
                diffLines,
                codeLines,
                Array.isArray(blockMeta.tokenLines) ? blockMeta.tokenLines as Array<TokenLineV1 | null> : null,
                diffInfo.baseLang ?? null,
              );
            }
            let tokenizedUntil = 0;
            for (let index = 0; index < rootOwner.getLines().length; index += 1) {
              const line = rootOwner.getLines().get(index);
              if (line?.decoration?.configurationRevision !== configurationRevision) break;
              tokenizedUntil += 1;
            }
            blockMeta.lazyTokenizedUntil = tokenizedUntil;
            block.payload.meta = blockMeta;
            rootOwner.setPresentation(block);
            patches.push({
              op: "setProps",
              at: { blockId: rootOwner.id },
              props: { block },
              meta: { kind: "enrichment" },
            });
          }
          if (patch) patches.push(patch);
          for (const decoration of decorations) {
            patches.push({
              op: "setProps",
              at: { blockId: `${rootOwner.id}::line:${decoration.index}` },
              props: { html: decoration.html },
              meta: { kind: "enrichment" },
            });
          }
          if (patches.length > 0) this.dispatchPatchBatch(patches);
          return;
        }
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
      themes?: CodeHighlightThemes;
    },
    mdxOptions?: { compileMode?: WorkerMdxMode },
    syntax?: SyntaxRuleSpec[],
    html?: HtmlOptions,
    themes?: CodeHighlightThemes,
  ): Promise<void> {
    this.documentGeneration += 1;
    let initialProgressPublication: ProgressPublicationContext | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.campaignCounters?.isProgressTraceEnabled?.()) {
      this.progressPublicationId = 0;
      this.campaignCounters.beginProgressDocument?.(this.documentGeneration);
    }
    this.performanceTimer = new PerformanceTimer();
    this.blocks = [];
    this.lastTree = null;
    this.treeFragments = [];
    this.rootNativeFragmentOffset = null;
    this.currentLinkReferences = new Map();
    this.currentLinkReferenceStarts = new Map();
    this.blockAttemptedReferences = new Map();
    for (const owner of this.rootParagraphOwners) releaseRootParagraphOwner(owner);
    this.sourceDocument = this.createSourceDocument();
    this.rootParagraphGeneration = this.documentGeneration;
    this.rootCodeOwners = [];
    this.rootCodeOwnersByStart.clear();
    this.emittedRootCodeIds.clear();
    this.rootTableOwners = [];
    this.rootTableOwnersByStart.clear();
    this.emittedRootTableIds.clear();
    this.pendingRootTablePatches = [];
    this.rootParagraphOwners = [];
    this.rootParagraphOwnersByStart.clear();
    this.emittedRootParagraphIds.clear();
    this.pendingRootParagraphPatches = [];
    this.rootCodeHighlighter.clear();
    this.rootCodeConfigurationRevision += 1;
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
      this.sourceDocument.append(initialContent);
      const result = await this.parseAll(initialContent, {
        admitRootCodeOwners: true,
        admitRootTableOwners: true,
        admitRootParagraphOwners: true,
      });
      this.lastTree = result.lastTree;
      const owners = this.rootCodeOwners;
      const tableOwners = this.rootTableOwners;
      const paragraphOwners = this.rootParagraphOwners;
      this.blocks = result.blocks.filter((block) => {
        const from = block.payload.range?.from;
        return !this.isRootOwnedBlock(block) && (
          typeof from !== "number" || (!this.rootCodeOwnersByStart.has(from)
            && !this.rootTableOwnersByStart.has(from)
            && !this.rootParagraphOwnersByStart.has(from))
        );
      });
      if (owners.length > 0 || tableOwners.length > 0 || paragraphOwners.length > 0) {
        await this.resetRootNativeTailFragments();
        for (const owner of owners) {
          await this.decorateRootCode(owner);
          this.emittedRootCodeIds.add(owner.id);
        }
        for (const owner of tableOwners) this.emittedRootTableIds.add(owner.id);
        for (const owner of paragraphOwners) this.emittedRootParagraphIds.add(owner.id);
      }
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.campaignCounters?.isProgressTraceEnabled?.()) {
        initialProgressPublication = this.createProgressPublication(initialContent.length);
      }
    }

    this.txCounter = 0;
    reportWorkerStructuralInvariantViolations("initialize", this.blocks, this.lastWorkerInvariantSignature);
    const snapshot = this.createRootSnapshot(this.blocks);
    snapshot.inputSource = {
      generation: this.documentGeneration,
      raw: initialContent ?? "",
    };
    const { patch: initialTocPatch, nextHeadings, nextSignature } = maybeBuildTocPatch(this.blocks, this.tocSignature);
    this.tocHeadings = nextHeadings;
    this.tocSignature = nextSignature;
    this.post({
      type: "INITIALIZED",
      schemaVersion: STREAM_MDX_SCHEMA_VERSION,
      generation: this.documentGeneration,
      snapshot,
    });
    if (initialTocPatch) this.dispatchPatchBatch([initialTocPatch]);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && initialProgressPublication) {
      this.recordParsedProgressPublication(initialProgressPublication);
    }
  }

  private async handleAppend(text: string): Promise<void> {
    let remaining = text;
    let batchStartedAt = now();

    while (remaining.length > 0) {
      const { chunk, rest } = sliceAppendChunk(remaining, DEFAULT_APPEND_CHUNK_SIZE);
      remaining = rest;

      this.dispatchPatchBatch([{
        op: "appendInputSource",
        at: { blockId: PATCH_ROOT_ID },
        generation: this.documentGeneration,
        from: this.sourceDocument.length,
        text: chunk,
        meta: { kind: "semantic" },
      }]);
      this.performanceTimer.mark("append-operation");

      const metricsCollector = new WorkerMetricsCollector(this.workerGrammarEngine);
      this.activeMetricsCollector = metricsCollector;

      const activeRootCode = this.rootCodeOwners.find((owner) => owner.getMetadata().state === "open");
      const activeRootTable = this.rootTableOwners.find((owner) => owner.getMetadata().state === "open");
      const lastRootParagraph = this.rootParagraphOwners[this.rootParagraphOwners.length - 1];
      const activeRootParagraph = lastRootParagraph?.getMetadata().state === "open" ? lastRootParagraph : undefined;
      if (activeRootCode) {
        await this.appendRootCode(activeRootCode, chunk, metricsCollector);
      } else if (activeRootTable) {
        await this.appendRootTable(activeRootTable, chunk, metricsCollector);
      } else if (activeRootParagraph) {
        await this.appendRootParagraph(activeRootParagraph, chunk, metricsCollector);
      } else {
        const finalizedParagraph = this.terminalFinalizedRootParagraph();
        if (finalizedParagraph) {
          await this.reopenFinalizedRootParagraph(finalizedParagraph, chunk, metricsCollector);
        } else if (this.rootCodeOwners.length > 0 || this.rootTableOwners.length > 0 || this.rootParagraphOwners.length > 0) {
          await this.appendRootNativeTail(chunk, metricsCollector);
        } else {
          await this.appendAndReparse(chunk, metricsCollector);
        }
      }
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
  private registerRootCodeOwners(owners: readonly RootCodeSourceOwner[]): void {
    for (const owner of owners) {
      const from = owner.getMetadata().sourceRange.from;
      if (this.rootCodeOwnersByStart.has(from)) continue;
      this.rootCodeOwnersByStart.set(from, owner);
      this.rootCodeOwners.push(owner);
    }
    this.rootCodeOwners.sort((a, b) => a.getMetadata().sourceRange.from - b.getMetadata().sourceRange.from);
  }

  private registerRootTableOwners(owners: readonly RootTableSourceOwner[]): void {
    for (const owner of owners) {
      const from = owner.getMetadata().sourceRange.from;
      if (this.rootTableOwnersByStart.has(from)) continue;
      this.rootTableOwnersByStart.set(from, owner);
      this.rootTableOwners.push(owner);
    }
    this.rootTableOwners.sort((a, b) => a.getMetadata().sourceRange.from - b.getMetadata().sourceRange.from);
  }
  private registerRootParagraphOwners(
    owners: readonly RootParagraphSourceOwner[],
  ): readonly RootParagraphSourceOwner[] {
    let registered: RootParagraphSourceOwner[] | undefined;
    for (const owner of owners) {
      const from = owner.getMetadata().sourceRange.from;
      const existing = this.rootParagraphOwnersByStart.get(from);
      if (existing) {
        releaseRootParagraphOwner(owner);
        continue;
      }
      this.rootParagraphOwnersByStart.set(from, owner);
      (registered ??= []).push(owner);
    }
    if (!registered) return NO_ROOT_PARAGRAPH_OWNERS;

    const last = this.rootParagraphOwners[this.rootParagraphOwners.length - 1];
    if (!last || last.getMetadata().sourceRange.from < registered[0].getMetadata().sourceRange.from) {
      for (const owner of registered) this.rootParagraphOwners.push(owner);
    } else {
      for (const owner of registered) {
        const from = owner.getMetadata().sourceRange.from;
        let low = 0;
        let high = this.rootParagraphOwners.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (this.rootParagraphOwners[middle].getMetadata().sourceRange.from < from) low = middle + 1;
          else high = middle;
        }
        this.rootParagraphOwners.splice(low, 0, owner);
      }
    }
    return registered;
  }

  private retireRootParagraphOwner(owner: RootParagraphSourceOwner): void {
    const from = owner.getMetadata().sourceRange.from;
    if (this.rootParagraphOwnersByStart.get(from) !== owner) return;
    this.rootParagraphOwnersByStart.delete(from);
    const index = this.rootParagraphOwners.indexOf(owner);
    if (index >= 0) this.rootParagraphOwners.splice(index, 1);
    this.emittedRootParagraphIds.delete(owner.id);
    releaseRootParagraphOwner(owner);
  }

  private rootParagraphInsertPatch(owner: RootParagraphSourceOwner): Patch {
    return {
      op: "insertChild",
      at: { blockId: PATCH_ROOT_ID },
      index: 0,
      node: rootParagraphNodeSnapshot(owner),
      meta: { kind: "semantic" },
    };
  }

  private rootParagraphFootnoteTargetDelta(
    owner: RootParagraphSourceOwner,
    spans: readonly ParagraphSpanRecord[],
  ): FootnoteParagraphTargetDelta {
    return {
      ownerId: owner.id,
      generation: owner.generation,
      spans: spans.map((span) => ({
        index: span.index,
        sourceRevision: span.sourceRevision,
        sourceRange: span.sourceRange,
        nodes: span.nodes,
        ...(span.children ? { children: span.children } : {}),
        attemptedReferences: span.attemptedReferences,
      })),
    };
  }

  private takePendingRootParagraphPatches(): Patch[] {
    const patches = this.pendingRootParagraphPatches;
    this.pendingRootParagraphPatches = [];
    return patches;
  }

  private terminalFinalizedRootParagraph(): RootParagraphSourceOwner | undefined {
    const candidate = this.rootParagraphOwners[this.rootParagraphOwners.length - 1];
    if (!candidate) return undefined;
    const metadata = candidate.getMetadata();
    if (
      metadata.state !== "finalized"
      || metadata.processedTo !== this.sourceDocument.length
      || !isFinalizedRootParagraphAppendCandidate(candidate)
    ) return undefined;
    return candidate;
  }

  private async reopenFinalizedRootParagraph(
    owner: RootParagraphSourceOwner,
    appendedText: string,
    metrics?: WorkerMetricsCollector,
  ): Promise<void> {
    const metadata = owner.getMetadata();
    const sourceStart = metadata.sourceRange.from;
    const previousEnd = metadata.sourceRange.to;
    const oldLength = this.sourceDocument.length;
    const tailOffset = this.rootNativeFragmentOffset ?? metadata.processedTo;
    this.sourceDocument.append(appendedText);
    const source = this.sourceDocument.snapshot();
    const nativeChange = probeFinalizedRootParagraphAppend(owner, source, appendedText);
    if (!nativeChange.requiresOwnerReplacement && nativeChange.ownerEnd === previousEnd) {
      await this.parseRootNativeTail(tailOffset, oldLength, source.length, metrics);
      return;
    }

    const previousOwners = this.rootParagraphOwners.slice();
    this.retireRootParagraphOwner(owner);
    if (!Number.isSafeInteger(this.rootParagraphGeneration + 1)) {
      throw new RangeError("Root paragraph owner generation exceeds the safe integer range");
    }
    this.rootParagraphGeneration += 1;
    this.rootNativeFragmentOffset = null;
    this.treeFragments = [];
    await this.parseRootNativeTail(
      sourceStart,
      oldLength,
      source.length,
      metrics,
      false,
      [],
      previousOwners,
      { removedOwnerIds: [owner.id], rebuild: true },
    );
  }

  private isRootOwnedBlock(block: Block): boolean {
    if (block.type === "code") {
      for (const owner of this.rootCodeOwnersByStart.values()) {
        if (owner.id === block.id) return true;
      }
    } else if (block.type === "table") {
      for (const owner of this.rootTableOwnersByStart.values()) {
        if (owner.id === block.id) return true;
      }
    } else if (block.type === "paragraph") {
      for (const owner of this.rootParagraphOwnersByStart.values()) {
        if (owner.id === block.id) return true;
      }
    }
    return false;
  }

  private rootTableExtensionContext(): "header-independent" | "source-dependent" {
    return this.extensions?.markdown && this.extensions.markdown.length > 0
      ? "source-dependent"
      : "header-independent";
  }

  private rootManagedTailOffset(): number | null {
    if (this.rootCodeOwners.length === 0
      && this.rootTableOwners.length === 0
      && this.rootParagraphOwners.length === 0) return null;
    let latestFrom = -1;
    let processedTo: number | null = null;
    for (const owner of this.rootCodeOwners) {
      const metadata = owner.getMetadata();
      if (metadata.state === "open") return null;
      if (metadata.sourceRange.from >= latestFrom) {
        latestFrom = metadata.sourceRange.from;
        processedTo = metadata.processedTo;
      }
    }
    for (const owner of this.rootTableOwners) {
      const metadata = owner.getMetadata();
      if (metadata.state === "open") return null;
      if (metadata.sourceRange.from >= latestFrom) {
        latestFrom = metadata.sourceRange.from;
        // A table may consume trailing source while classifying its interrupt; restart at its owned end.
        processedTo = metadata.sourceRange.to;
      }
    }
    for (const owner of this.rootParagraphOwners) {
      const metadata = owner.getMetadata();
      if (metadata.state === "open") return null;
      if (metadata.sourceRange.from >= latestFrom) {
        latestFrom = metadata.sourceRange.from;
        processedTo = metadata.processedTo;
        const pendingRootOffset = rootParagraphPendingRootOffset(owner);
        if (pendingRootOffset !== undefined) processedTo = pendingRootOffset;
      }
    }
    return processedTo;
  }

  private rootCodeHighlightConfiguration(finalizing = false): RootCodeHighlightConfiguration {
    const configuration = {
      highlighter: this.highlighter,
      themes: this.codeThemes,
      configurationRevision: this.rootCodeConfigurationRevision,
      enabled: this.emitHighlightTokens && Boolean(this.highlighter)
        && (finalizing || (this.codeHighlightingMode !== "final" && this.liveTokenizationEnabled)),
    };
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      return { ...configuration, counters: this.campaignCounters };
    }
    return configuration;
  }

  private async decorateRootCode(
    owner: RootCodeSourceOwner,
    finalizing = false,
  ): Promise<Extract<Patch, { op: "decorateCode" }> | null> {
    const generation = this.documentGeneration;
    const configurationRevision = this.rootCodeConfigurationRevision;
    const isFinalized = owner.getMetadata().state !== "open";
    const block = isFinalized ? owner.materializeBlock() : undefined;
    const info = typeof block?.payload.meta?.info === "string" ? block.payload.meta.info : "";
    const { lang, meta } = parseCodeFenceInfo(info);
    const isDiff = detectDiffLanguage(lang, meta).isDiff;
    const isLazy = isFinalized && shouldLazyTokenizeBlock(
      this.lazyTokenizationEnabled,
      owner.getLines().length,
      this.lazyTokenizationThresholdLines,
      Boolean(this.highlighter),
      owner.getLines().materialize().trim().length > 0,
    );
    const skipRootTokenization = isLazy || (isDiff && this.highlightOutputMode !== "html");
    const decorations = skipRootTokenization
      ? []
      : await this.rootCodeHighlighter.decorateAvailable(
          owner,
          this.rootCodeHighlightConfiguration(finalizing || isFinalized),
          () => !this.disposed
            && generation === this.documentGeneration
            && configurationRevision === this.rootCodeConfigurationRevision
            && owner.getMetadata().generation === generation,
        );

    let patch = rootCodeDecoratePatch(owner, configurationRevision, decorations);
    if (isFinalized && block) {
      await this.enrichCodeBlock(block);
      owner.setPresentation(block);
      const tokenLines = block.payload.meta?.tokenLines;
      if (!isLazy && Array.isArray(tokenLines)) {
        const rows = owner.getLines().readRange(0, owner.getLines().length);
        const tokenDecorations = rows.flatMap((row) => {
          const tokens = tokenLines[row.index];
          if (!tokens) return [];
          return [{
            index: row.index,
            lineId: row.id,
            sourceRevision: row.sourceRevision,
            configurationRevision,
            exactness: "exact" as const,
            tokens,
          }];
        });
        if (tokenDecorations.length > 0) {
          owner.decorateLines(tokenDecorations);
          patch = rootCodeDecoratePatch(owner, configurationRevision, tokenDecorations);
        }
      }
    }
    return patch;
  }

  private rootCodePresentationPatches(owner: RootCodeSourceOwner): Patch[] {
    const presentation = owner.getPresentation();
    if (!presentation) return [];

    const metadata = owner.getMetadata();
    const lines = owner.getLines();
    const meta = { ...(presentation.meta ?? {}) };
    delete meta.code;
    const presentationBlock: Block = {
      id: owner.id,
      type: "code",
      isFinalized: metadata.state !== "open",
      payload: {
        raw: "",
        meta,
        range: { ...metadata.sourceRange },
        inline: undefined,
        highlightedHtml: presentation.highlightedHtml,
        sanitizedHtml: undefined,
        compiledMdxRef: undefined,
        compiledMdxModule: undefined,
      },
    };
    const patches: Patch[] = [{
      op: "setProps",
      at: { blockId: owner.id },
      props: { block: presentationBlock },
      meta: { kind: "enrichment" },
    }];

    const highlightedLines = Array.isArray(meta.highlightedLines)
      ? meta.highlightedLines as Array<string | null>
      : extractHighlightedLines(presentation.highlightedHtml ?? "", lines.length);
    const tokenLines = Array.isArray(meta.tokenLines) ? meta.tokenLines as unknown[] : null;
    const diffKind = Array.isArray(meta.diffKind) ? meta.diffKind : null;
    const oldNo = Array.isArray(meta.oldNo) ? meta.oldNo : null;
    const newNo = Array.isArray(meta.newNo) ? meta.newNo : null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines.get(index);
      if (!line) continue;
      const props: Record<string, unknown> = {
        index,
        html: highlightedLines[index] ?? line.text,
      };
      if (tokenLines) props.tokens = tokenLines[index] ?? null;
      if (diffKind) props.diffKind = diffKind[index] ?? null;
      if (oldNo) props.oldNo = oldNo[index] ?? null;
      if (newNo) props.newNo = newNo[index] ?? null;
      patches.push({
        op: "setProps",
        at: { blockId: `${owner.id}::line:${index}` },
        props,
        meta: { kind: "enrichment" },
      });
    }
    return patches;
  }




  private rootCodeInsertPatch(owner: RootCodeSourceOwner): Patch {
    return {
      op: "insertChild",
      at: { blockId: PATCH_ROOT_ID },
      index: 0,
      node: rootCodeNodeSnapshot(owner, this.sourceDocument.snapshot(), this.rootCodeConfigurationRevision),
      meta: { kind: "semantic" },
    };
  }
  private rootTableInsertPatch(owner: RootTableSourceOwner): Patch {
    return {
      op: "insertChild",
      at: { blockId: PATCH_ROOT_ID },
      index: 0,
      node: rootTableNodeSnapshot(owner),
      meta: { kind: "semantic" },
    };
  }

  private takePendingRootTablePatches(): Patch[] {
    const patches = this.pendingRootTablePatches;
    this.pendingRootTablePatches = [];
    return patches;
  }


  private async appendRootCode(
    owner: RootCodeSourceOwner,
    appendedText: string,
    metrics?: WorkerMetricsCollector,
  ): Promise<void> {
    const oldLength = this.sourceDocument.length;
    const previous = owner.getMetadata();
    this.sourceDocument.append(appendedText);
    const source = this.sourceDocument.snapshot();
    const newLength = this.sourceDocument.length;
    const change = owner.accept(previous.processedTo, newLength);
    const appendChange = rootCodeAppendChange(owner, source, previous, change);
    const semanticPatch = rootCodeAppendPatch(owner, appendChange);

    if (change.state !== "open" || change.remainingTailFrom !== undefined) {
      this.rootNativeFragmentOffset = null;
      this.treeFragments = [];
      const tailOffset = change.remainingTailFrom ?? change.processedTo ?? owner.getMetadata().processedTo;
      await this.parseRootNativeTail(tailOffset, oldLength, newLength, metrics, false, [semanticPatch]);
    } else {
      this.dispatchPatchBatch([semanticPatch], metrics);
    }

    const decorationPatch = await this.decorateRootCode(owner);
    const patches: Patch[] = [];
    if (decorationPatch) patches.push(decorationPatch);
    if (owner.getMetadata().state !== "open") patches.push(...this.rootCodePresentationPatches(owner));
    if (patches.length > 0) this.dispatchPatchBatch(patches, metrics);
  }
  private async appendRootTable(
    owner: RootTableSourceOwner,
    appendedText: string,
    metrics?: WorkerMetricsCollector,
  ): Promise<void> {
    const oldLength = this.sourceDocument.length;
    const previousMetadata = owner.getMetadata();
    const stableBlocks = this.blocks.filter((block) => {
      const from = block.payload.range?.from;
      return !this.isRootOwnedBlock(block) && (
        typeof from !== "number" || (
          !this.rootTableOwnersByStart.has(from) &&
          !this.rootParagraphOwnersByStart.has(from)
        )
      );
    });
    const previousBlocks = stableBlocks.map((block) => cloneBlock(block));
    this.sourceDocument.append(appendedText);
    const source = this.sourceDocument.snapshot();
    const newLength = this.sourceDocument.length;
    const change = owner.accept(previousMetadata.processedTo, newLength);
    const appendChange = rootTableAppendChange(source, previousMetadata, change);
    const appendPatch = rootTableAppendPatch(owner, appendChange);
    if (change.table.state !== "open") {
      this.rootNativeFragmentOffset = null;
      this.treeFragments = [];
      const rootResumeFrom = appendChange.rootResumeFrom ?? change.table.processedTo;
      const tablePatches = this.emittedRootTableIds.has(owner.id) ? [appendPatch] : [];
      await this.parseRootNativeTail(rootResumeFrom, oldLength, newLength, metrics, false, tablePatches);
      return;
    }

    this.pendingRootTablePatches = [];
    this.pendingRootParagraphPatches = [];
    const changedBlocks = this.runDocumentPlugins(
      stableBlocks,
      source,
      this.rootParagraphOwners.length > 0 ? { rebuild: true } : undefined,
    );
    const paragraphPatches = this.takePendingRootParagraphPatches();
    const tablePatches = this.takePendingRootTablePatches();
    this.blocks = changedBlocks;
    const changeRanges: ContentChangeRange[] = newLength > oldLength
      ? [{ fromA: oldLength, toA: oldLength, fromB: oldLength, toB: newLength }]
      : [];
    metrics?.markParseEnd();
    metrics?.setBlocksProduced(this.blocks.length);
    await this.emitBlockDiffPatches(
      previousBlocks,
      changedBlocks,
      changeRanges,
      metrics,
      undefined,
      undefined,
      this.emittedRootTableIds.has(owner.id) ? [appendPatch, ...paragraphPatches, ...tablePatches] : [],
    );
  }


  private async appendRootParagraph(
    owner: RootParagraphSourceOwner,
    appendedText: string,
    metrics?: WorkerMetricsCollector,
  ): Promise<void> {
    const oldLength = this.sourceDocument.length;
    const previous = owner.getMetadata();
    this.sourceDocument.append(appendedText);
    const source = this.sourceDocument.snapshot();
    const newLength = this.sourceDocument.length;
    const change = advanceRootParagraphOwner(owner, source, appendedText);
    if (rootParagraphChangeNeedsReplacement(change)) {
      const previousOwners = this.rootParagraphOwners.slice();
      this.retireRootParagraphOwner(owner);
      this.rootNativeFragmentOffset = null;
      this.treeFragments = [];
      await this.parseRootNativeTail(
        previous.sourceRange.from,
        oldLength,
        newLength,
        metrics,
        false,
        [],
        previousOwners,
        { removedOwnerIds: [owner.id], rebuild: true },
      );
      return;
    }

    const appendChange = rootParagraphAppendChange(source, previous, change);
    const appendPatch = rootParagraphAppendPatch(owner, appendChange);
    const footnoteTargets = change.spans.length > 0
      ? { deltas: [this.rootParagraphFootnoteTargetDelta(owner, change.spans)], rebuild: false }
      : undefined;
    if (change.paragraph.state !== "open" || appendChange.rootResumeFrom !== undefined) {
      this.rootNativeFragmentOffset = null;
      this.treeFragments = [];
      const tailOffset = appendChange.rootResumeFrom ?? change.paragraph.processedTo;
      await this.parseRootNativeTail(
        tailOffset,
        oldLength,
        newLength,
        metrics,
        false,
        [appendPatch],
        undefined,
        footnoteTargets,
      );
      return;
    }

    this.pendingRootParagraphPatches = [];
    this.pendingRootTablePatches = [];
    if (footnoteTargets) this.blocks = this.runDocumentPlugins(this.blocks, source, footnoteTargets);
    const paragraphPatches = this.takePendingRootParagraphPatches();
    const tablePatches = this.takePendingRootTablePatches();
    this.dispatchPatchBatch([appendPatch, ...paragraphPatches, ...tablePatches], metrics);
  }

  private async appendRootNativeTail(
    appendedText: string,
    metrics?: WorkerMetricsCollector,
  ): Promise<void> {
    const tailOffset = this.rootNativeFragmentOffset ?? this.rootManagedTailOffset();
    if (tailOffset === null) throw new Error("Cannot parse a native tail while a root source owner is open");
    const oldLength = this.sourceDocument.length;
    this.sourceDocument.append(appendedText);
    await this.parseRootNativeTail(tailOffset, oldLength, this.sourceDocument.length, metrics);
  }

  private async parseRootNativeTail(
    tailOffset: number,
    oldLength: number,
    newLength: number,
    metrics?: WorkerMetricsCollector,
    forceFinalize = false,
    extraPatches: Patch[] = [],
    previousRootParagraphOwners: readonly RootParagraphSourceOwner[] = this.rootParagraphOwners,
    footnoteTargets: {
      readonly deltas?: readonly FootnoteParagraphTargetDelta[];
      readonly removedOwnerIds?: readonly string[];
      readonly rebuild?: boolean;
    } = {},
  ): Promise<void> {
    this.performanceTimer.mark("incremental-parse");
    metrics?.markParseStart();
    this.deferredPatchQueue = [];
    const previousBlocks = this.blocks;
    const source = this.sourceDocument.snapshot();
    const sourceInput = new SourceRangeInput(source, tailOffset, newLength);
    const input = new NativeMarkdownInput(sourceInput, forceFinalize);
    const oldTailLength = Math.max(0, oldLength - tailOffset);
    const newTailLength = Math.max(0, newLength - tailOffset);
    const updatedFragments = TreeFragment.applyChanges(this.treeFragments, [{
      fromA: oldTailLength,
      toA: oldTailLength,
      fromB: oldTailLength,
      toB: newTailLength,
    }]);
    const tree = input.parse(this.mdParser, updatedFragments);
    let createdOwners = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? createRootCodeOwners(tree, this.sourceDocument, this.documentGeneration, tailOffset, this.campaignCounters)
      : createRootCodeOwners(tree, this.sourceDocument, this.documentGeneration, tailOffset);
    createdOwners = excludeRootCodeOwnersInsideOpenHtml(createdOwners, tree, source, tailOffset, this.mdParser, this.mdxEnabled);

    const tailReferences = collectLinkReferences(tree, sourceInput);
    const tailReferenceStarts = collectLinkReferenceStarts(tree, sourceInput, tailOffset, tailReferences);
    const combinedReferences = new Map(this.currentLinkReferences);
    const combinedReferenceStarts = new Map(this.currentLinkReferenceStarts);
    for (const [label, reference] of tailReferences) {
      const tailStart = tailReferenceStarts.get(label);
      const currentStart = combinedReferenceStarts.get(label);
      if (!combinedReferences.has(label)) {
        combinedReferences.set(label, reference);
        if (tailStart !== undefined) combinedReferenceStarts.set(label, tailStart);
      } else if (tailStart !== undefined && currentStart === tailStart) {
        combinedReferences.set(label, reference);
      }
    }
    const changedLabels = diffLinkReferences(this.currentLinkReferences, combinedReferences);
    this.currentLinkReferences = combinedReferences;
    this.currentLinkReferenceStarts = combinedReferenceStarts;
    this.inlineParser.setReferences(combinedReferences);
    const existingRootTableCount = this.rootTableOwners.length;
    const createdTableOwners = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? createRootTableOwners(
        tree,
        this.sourceDocument,
        this.documentGeneration,
        this.mdParser,
        this.inlineParser,
        this.rootTableExtensionContext(),
        tailOffset,
        forceFinalize,
        this.campaignCounters,
      )
      : createRootTableOwners(
        tree,
        this.sourceDocument,
        this.documentGeneration,
        this.mdParser,
        this.inlineParser,
        this.rootTableExtensionContext(),
        tailOffset,
        forceFinalize,
      );
    this.registerRootTableOwners(createdTableOwners);
    const existingRootParagraphCount = this.rootParagraphOwners.length;
    const createdParagraphOwners = this.registerRootParagraphOwners(
      this.admitRootParagraphOwners(tree, tailOffset, forceFinalize),
    );
    const rootParagraphSemanticPatches: Patch[] = [];
    if (changedLabels.size > 0) {
      for (let index = 0; index < existingRootParagraphCount; index += 1) {
        const owner = this.rootParagraphOwners[index];
        if (!owner) continue;
        const patch = rootParagraphSemanticPatch(owner, owner.invalidateLinkReferences(changedLabels));
        if (patch && this.emittedRootParagraphIds.has(owner.id)) rootParagraphSemanticPatches.push(patch);
      }
    }
    const tableSemanticPatches: Patch[] = [];
    if (changedLabels.size > 0) {
      for (let index = 0; index < existingRootTableCount; index += 1) {
        const owner = this.rootTableOwners[index];
        if (!owner) continue;
        const patch = rootTableSemanticPatch(owner, owner.invalidateLinkReferences(changedLabels));
        if (patch && this.emittedRootTableIds.has(owner.id)) tableSemanticPatches.push(patch);
      }
    }

    const parsedTailBlocks = await this.extractBlocks(tree, sourceInput, {
      sourceOffset: tailOffset,
      ...(forceFinalize ? { forceFinalize: true } : {}),
    });
    const tailBlocks = parsedTailBlocks.filter((block) => {
      const from = block.payload.range?.from;
      return !this.isRootOwnedBlock(block) && (
        typeof from !== "number" || (
          !this.rootTableOwnersByStart.has(from) &&
          !this.rootParagraphOwnersByStart.has(from)
        )
      );
    });
    const stableBlocks = this.blocks
      .filter((block) => {
        const from = block.payload.range?.from;
        return !this.isRootOwnedBlock(block) && (
          typeof from !== "number" || (
            from < tailOffset &&
            !this.rootCodeOwnersByStart.has(from) &&
            !this.rootTableOwnersByStart.has(from) &&
            !this.rootParagraphOwnersByStart.has(from)
          )
        );
      })
      .map((block) => {
        const stable = cloneBlock(block);
        if (forceFinalize) stable.isFinalized = true;
        return stable;
      });
    const createdParagraphTargets = createdParagraphOwners.map((owner) =>
      this.rootParagraphFootnoteTargetDelta(owner, owner.getSpans().materialize()));
    const removedParagraphOwners = previousRootParagraphOwners
      .filter((owner) => !this.rootParagraphOwners.includes(owner))
      .map((owner) => owner.id);
    const removedOwnerIds = Array.from(new Set([
      ...(footnoteTargets.removedOwnerIds ?? []),
      ...removedParagraphOwners,
    ]));
    const nativeFootnotesChanged = tailBlocks.some((block) =>
      (block.payload.raw ?? "").includes("[^") || (block.payload.raw ?? "").includes("&"));
    const paragraphDeltas = [...(footnoteTargets.deltas ?? []), ...createdParagraphTargets];
    const rebuildParagraphTargets = Boolean(footnoteTargets.rebuild)
      || nativeFootnotesChanged
      || removedOwnerIds.length > 0
      || createdParagraphOwners.length > 0;
    const paragraphBridge = this.rootParagraphOwners.length > 0 || removedOwnerIds.length > 0
      ? {
          deltas: paragraphDeltas,
          ...(removedOwnerIds.length > 0 ? { removedOwnerIds } : {}),
          rebuild: rebuildParagraphTargets,
        }
      : undefined;
    this.pendingRootParagraphPatches = [];
    let changedBlocks = this.runDocumentPlugins(
      [...stableBlocks, ...tailBlocks],
      source,
      paragraphBridge,
    );
    rootParagraphSemanticPatches.push(...this.takePendingRootParagraphPatches());
    const nestedCodeIds = nestedCodeBlockIds(changedBlocks);
    createdOwners = createdOwners.filter((owner) => !nestedCodeIds.has(owner.id));
    this.registerRootCodeOwners(createdOwners);
    if (createdOwners.length > 0) {
      const rootCodeIds = new Set(createdOwners.map((owner) => owner.id));
      changedBlocks = changedBlocks.filter((block) => !rootCodeIds.has(block.id));
    }
    tableSemanticPatches.push(...this.takePendingRootTablePatches());
    if (changedLabels.size > 0) {
      for (let index = 0; index < changedBlocks.length; index += 1) {
        const block = changedBlocks[index];
        if (!block) continue;
        const attempted = this.blockAttemptedReferences.get(block.id);
        if (!attempted) continue;
        let matched = false;
        for (const label of changedLabels) {
          if (attempted.has(label)) {
            matched = true;
            break;
          }
        }
        if (!matched) continue;
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordInvalidation("link_reference_definition", block.id, ["props.inline"]);
        }
        const clone = cloneBlock(block);
        await this.enrichBlock(clone);
        changedBlocks[index] = clone;
      }
    }
    this.blocks = changedBlocks;
    this.treeFragments = TreeFragment.addTree(tree, updatedFragments);
    this.rootNativeFragmentOffset = tailOffset;
    this.lastTree = tree;
    if (createdOwners.length > 0 || createdTableOwners.length > 0 || createdParagraphOwners.length > 0) {
      await this.resetRootNativeTailFragments();
    }
    pruneLazyTokenizationStates(this.lazyTokenizationStates, this.blocks);

    const rootCodePatches: Patch[] = [];
    for (const owner of createdOwners) {
      await this.decorateRootCode(owner);
      if (!this.emittedRootCodeIds.has(owner.id)) {
        rootCodePatches.push(this.rootCodeInsertPatch(owner));
        this.emittedRootCodeIds.add(owner.id);
      }
    }
    for (const owner of createdTableOwners) {
      if (!this.emittedRootTableIds.has(owner.id)) {
        tableSemanticPatches.push(this.rootTableInsertPatch(owner));
        this.emittedRootTableIds.add(owner.id);
      }
    }
    const rootParagraphPatches: Patch[] = [];
    for (const owner of createdParagraphOwners) {
      if (!this.emittedRootParagraphIds.has(owner.id)) {
        rootParagraphPatches.push(this.rootParagraphInsertPatch(owner));
        this.emittedRootParagraphIds.add(owner.id);
      }
    }
    let progressPublication: ProgressPublicationContext | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.campaignCounters?.isProgressTraceEnabled?.()) {
      progressPublication = this.createProgressPublication(newLength);
    }
    const changeRanges: ContentChangeRange[] = newLength > oldLength
      ? [{ fromA: oldLength, toA: oldLength, fromB: oldLength, toB: newLength }]
      : [];
    metrics?.markParseEnd();
    metrics?.setBlocksProduced(this.blocks.length);
    await this.emitBlockDiffPatches(
      previousBlocks,
      changedBlocks,
      changeRanges,
      metrics,
      progressPublication,
      undefined,
      rootCodePatches.concat(rootParagraphPatches, extraPatches, rootParagraphSemanticPatches, tableSemanticPatches),
      previousRootParagraphOwners,
    );
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && progressPublication) {
      this.recordParsedProgressPublication(progressPublication);
    }
  }

  private async resetRootNativeTailFragments(): Promise<void> {
    const tailOffset = this.rootManagedTailOffset();
    this.treeFragments = [];
    this.rootNativeFragmentOffset = tailOffset;
    if (tailOffset === null || tailOffset >= this.sourceDocument.length) return;
    const input = new NativeMarkdownInput(new SourceRangeInput(this.sourceDocument.snapshot(), tailOffset));
    const tree = input.parse(this.mdParser);
    this.treeFragments = TreeFragment.addTree(tree);
    this.lastTree = tree;
  }

  private createRootSnapshot(blocks: readonly Block[]): NodeSnapshot {
    const children: Array<{ from: number; node: NodeSnapshot }> = [];
    for (const block of blocks) {
      const node = createBlockSnapshot(block);
      children.push({ from: block.payload.range?.from ?? Number.POSITIVE_INFINITY, node });
    }
    const source = this.sourceDocument.snapshot();
    for (const owner of this.rootCodeOwners) {
      const metadata = owner.getMetadata();
      children.push({
        from: metadata.sourceRange.from,
        node: rootCodeNodeSnapshot(owner, source, this.rootCodeConfigurationRevision),
      });
    }
    for (const owner of this.rootTableOwners) {
      children.push({
        from: owner.getMetadata().sourceRange.from,
        node: rootTableNodeSnapshot(owner),
      });
    }
    for (const owner of this.rootParagraphOwners) {
      const metadata = owner.getMetadata();
      children.push({
        from: metadata.sourceRange.from,
        node: rootParagraphNodeSnapshot(owner),
      });
    }
    children.sort((a, b) => a.from - b.from);
    return {
      id: PATCH_ROOT_ID,
      type: "__root__",
      range: { from: 0, to: this.sourceDocument.length },
      children: children.map((entry) => entry.node),
    };
  }

  private materializeRootBlocks(nativeBlocks: readonly Block[] = this.blocks): Block[] {
    const entries: Array<{ from: number; block: Block }> = nativeBlocks.map((block) => ({
      from: block.payload.range?.from ?? Number.POSITIVE_INFINITY,
      block,
    }));
    for (const owner of this.rootCodeOwners) {
      const block = owner.materializeBlock();
      entries.push({ from: block.payload.range?.from ?? Number.POSITIVE_INFINITY, block });
    }
    for (const owner of this.rootTableOwners) {
      const block = owner.materializeBlock();
      entries.push({ from: block.payload.range?.from ?? Number.POSITIVE_INFINITY, block });
    }
    for (const owner of this.rootParagraphOwners) {
      const block = owner.materializeBlock();
      entries.push({ from: block.payload.range?.from ?? Number.POSITIVE_INFINITY, block });
    }
    entries.sort((a, b) => a.from - b.from);
    return entries.map((entry) => entry.block);
  }


  private async parseAll(content: string, options: ParseOptions = {}): Promise<{ blocks: Block[]; lastTree: Tree }> {
    this.performanceTimer.mark("parse-all");
    const metrics = this.activeMetricsCollector;
    metrics?.markParseStart();

    const rawInput = new SourceRangeInput(this.sourceDocument.snapshot(), 0, content.length);
    const input = new NativeMarkdownInput(rawInput, options.forceFinalize);
    const tree = input.parse(this.mdParser);
    this.treeFragments = TreeFragment.addTree(tree);
    this.currentLinkReferences = collectLinkReferences(tree, rawInput);
    this.currentLinkReferenceStarts = collectLinkReferenceStarts(tree, rawInput, 0, this.currentLinkReferences);
    this.inlineParser.setReferences(this.currentLinkReferences);
    let createdRootCodeOwners = options.admitRootCodeOwners
      ? typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? createRootCodeOwners(tree, this.sourceDocument, this.documentGeneration, 0, this.campaignCounters)
        : createRootCodeOwners(tree, this.sourceDocument, this.documentGeneration)
      : [];
    createdRootCodeOwners = excludeRootCodeOwnersInsideOpenHtml(createdRootCodeOwners, tree, rawInput, 0, this.mdParser, this.mdxEnabled);
    if (options.admitRootTableOwners) {
      this.registerRootTableOwners(
        typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
          ? createRootTableOwners(
            tree,
            this.sourceDocument,
            this.documentGeneration,
            this.mdParser,
            this.inlineParser,
            this.rootTableExtensionContext(),
            0,
            Boolean(options.forceFinalize),
            this.campaignCounters,
          )
          : createRootTableOwners(
            tree,
            this.sourceDocument,
            this.documentGeneration,
            this.mdParser,
            this.inlineParser,
            this.rootTableExtensionContext(),
            0,
            Boolean(options.forceFinalize),
          ),
      );
    }
    const createdParagraphOwners = options.admitRootParagraphOwners
      ? this.registerRootParagraphOwners(this.admitRootParagraphOwners(tree, 0, Boolean(options.forceFinalize)))
      : [];
    let extractedBlocks = await this.extractBlocks(tree, rawInput, options);
    extractedBlocks = extractedBlocks.filter((block) => !this.isRootOwnedBlock(block));
    const paragraphTargets = createdParagraphOwners.map((owner) =>
      this.rootParagraphFootnoteTargetDelta(owner, owner.getSpans().materialize()));
    this.pendingRootParagraphPatches = [];
    extractedBlocks = this.runDocumentPlugins(
      extractedBlocks,
      this.sourceDocument.snapshot(),
      createdParagraphOwners.length > 0
        ? { deltas: paragraphTargets, rebuild: true }
        : undefined,
    );
    const nestedCodeIds = nestedCodeBlockIds(extractedBlocks);
    createdRootCodeOwners = createdRootCodeOwners.filter((owner) => !nestedCodeIds.has(owner.id));
    this.registerRootCodeOwners(createdRootCodeOwners);
    if (createdRootCodeOwners.length > 0) {
      const rootCodeIds = new Set(createdRootCodeOwners.map((owner) => owner.id));
      extractedBlocks = extractedBlocks.filter((block) => !rootCodeIds.has(block.id));
    }
    this.takePendingRootTablePatches();
    this.takePendingRootParagraphPatches();

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
    const previousRootParagraphOwners = this.rootParagraphOwners.slice();

    const oldLen = this.sourceDocument.length;
    this.sourceDocument.append(appendedText);
    const source = this.sourceDocument.snapshot();
    const newLen = this.sourceDocument.length;
    // Append-only: the single changed range is the appended tail (no document-wide diff needed).
    const changeRanges: ContentChangeRange[] = appendedText.length > 0 ? [{ fromA: oldLen, toA: oldLen, fromB: oldLen, toB: newLen }] : [];
    const updatedFragments = TreeFragment.applyChanges(this.treeFragments, [
      { fromA: oldLen, toA: oldLen, fromB: oldLen, toB: newLen },
    ]);
    const nativeInput = new NativeMarkdownInput(source);
    let newTree = nativeInput.parse(this.mdParser, updatedFragments);
    let createdRootCodeOwners = this.rootCodeOwners.length === 0
      ? typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? createRootCodeOwners(newTree, this.sourceDocument, this.documentGeneration, 0, this.campaignCounters)
        : createRootCodeOwners(newTree, this.sourceDocument, this.documentGeneration)
      : [];
    createdRootCodeOwners = excludeRootCodeOwnersInsideOpenHtml(createdRootCodeOwners, newTree, source, 0, this.mdParser, this.mdxEnabled);
    this.treeFragments = TreeFragment.addTree(newTree, updatedFragments);
    const newReferences = collectLinkReferences(newTree, source);
    const changedLabels = diffLinkReferences(this.currentLinkReferences, newReferences);
    this.currentLinkReferences = newReferences;
    this.currentLinkReferenceStarts = collectLinkReferenceStarts(newTree, source, 0, newReferences);
    this.inlineParser.setReferences(newReferences);
    const createdRootTableOwners = this.rootTableOwners.length === 0
      ? typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? createRootTableOwners(
          newTree,
          this.sourceDocument,
          this.documentGeneration,
          this.mdParser,
          this.inlineParser,
          this.rootTableExtensionContext(),
          0,
          false,
          this.campaignCounters,
        )
        : createRootTableOwners(
          newTree,
          this.sourceDocument,
          this.documentGeneration,
          this.mdParser,
          this.inlineParser,
          this.rootTableExtensionContext(),
        )
      : [];
    this.registerRootTableOwners(createdRootTableOwners);
    const createdRootParagraphOwners = this.rootParagraphOwners.length === 0
      ? this.registerRootParagraphOwners(this.admitRootParagraphOwners(newTree))
      : [];

    let changedBlocks = await this.extractBlocks(newTree, source, {
      firstChangedPos: oldLen,
      previousBlocks: this.blocks,
    });
    changedBlocks = changedBlocks.filter((block) => !this.isRootOwnedBlock(block));
    const paragraphTargets = createdRootParagraphOwners.map((owner) =>
      this.rootParagraphFootnoteTargetDelta(owner, owner.getSpans().materialize()));
    this.pendingRootParagraphPatches = [];
    changedBlocks = this.runDocumentPlugins(
      changedBlocks,
      source,
      createdRootParagraphOwners.length > 0
        ? { deltas: paragraphTargets, rebuild: true }
        : undefined,
    );
    const nestedCodeIds = nestedCodeBlockIds(changedBlocks);
    createdRootCodeOwners = createdRootCodeOwners.filter((owner) => !nestedCodeIds.has(owner.id));
    this.registerRootCodeOwners(createdRootCodeOwners);
    changedBlocks = changedBlocks.filter((block) => {
      const from = block.payload.range?.from;
      return !this.isRootOwnedBlock(block) && (
        typeof from !== "number" || (
          !this.rootTableOwnersByStart.has(from) &&
          !this.rootParagraphOwnersByStart.has(from)
        )
      );
    });
    const lastRange = changedBlocks.length > 0 ? changedBlocks[changedBlocks.length - 1]?.payload?.range : undefined;
    const lastTo = typeof lastRange?.to === "number" ? lastRange.to : 0;
    if (createdRootCodeOwners.length === 0
      && createdRootTableOwners.length === 0
      && createdRootParagraphOwners.length === 0
      && lastTo < newLen - 1
      && sourceRangeHasNonWhitespace(source, lastTo, newLen)) {
      const fullInput = new NativeMarkdownInput(source);
      const fullTree = fullInput.parse(this.mdParser);
      this.treeFragments = TreeFragment.addTree(fullTree);
      const fullRefs = collectLinkReferences(fullTree, source);
      const fullChangedLabels = diffLinkReferences(this.currentLinkReferences, fullRefs);
      for (const label of fullChangedLabels) changedLabels.add(label);
      this.currentLinkReferences = fullRefs;
      this.currentLinkReferenceStarts = collectLinkReferenceStarts(fullTree, source, 0, fullRefs);
      this.inlineParser.setReferences(fullRefs);
      let fullBlocks = await this.extractBlocks(fullTree, source);
      fullBlocks = fullBlocks.filter((block) => {
        const from = block.payload.range?.from;
        return !this.isRootOwnedBlock(block) && (
          typeof from !== "number" || (
            !this.rootTableOwnersByStart.has(from) &&
            !this.rootParagraphOwnersByStart.has(from)
          )
        );
      });
      fullBlocks = this.runDocumentPlugins(fullBlocks, source).filter((block) => {
        const from = block.payload.range?.from;
        return !this.isRootOwnedBlock(block) && (
          typeof from !== "number" || (
            !this.rootTableOwnersByStart.has(from) &&
            !this.rootParagraphOwnersByStart.has(from)
          )
        );
      });
      const fullLast = fullBlocks.length > 0 ? fullBlocks[fullBlocks.length - 1]?.payload?.range?.to ?? 0 : 0;
      if (fullLast >= newLen - 1 || fullBlocks.length >= changedBlocks.length) {
        newTree = fullTree;
        changedBlocks = fullBlocks;
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
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordInvalidation("link_reference_definition", block.id, ["props.inline"]);
          }
          const cloned = cloneBlock(block);
          await this.enrichBlock(cloned);
          changedBlocks[i] = cloned;
        }
      }
    }
    const paragraphSemanticPatches = this.takePendingRootParagraphPatches();
    const tableSemanticPatches = this.takePendingRootTablePatches();
    const prevBlocks = this.blocks;

    this.blocks = changedBlocks;
    this.lastTree = newTree;
    if (createdRootCodeOwners.length > 0 || createdRootTableOwners.length > 0 || createdRootParagraphOwners.length > 0) {
      await this.resetRootNativeTailFragments();
    }
    pruneLazyTokenizationStates(this.lazyTokenizationStates, this.blocks);
    let progressPublication: ProgressPublicationContext | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.campaignCounters?.isProgressTraceEnabled?.()) {
      progressPublication = this.createProgressPublication(newLen);
    }
    const rootCodePatches: Patch[] = [];
    for (const owner of createdRootCodeOwners) {
      await this.decorateRootCode(owner);
      if (!this.emittedRootCodeIds.has(owner.id)) {
        rootCodePatches.push(this.rootCodeInsertPatch(owner));
        this.emittedRootCodeIds.add(owner.id);
      }
    }
    for (const owner of createdRootTableOwners) {
      if (!this.emittedRootTableIds.has(owner.id)) {
        rootCodePatches.push(this.rootTableInsertPatch(owner));
        this.emittedRootTableIds.add(owner.id);
      }
    }
    const rootParagraphPatches: Patch[] = [];
    for (const owner of createdRootParagraphOwners) {
      if (!this.emittedRootParagraphIds.has(owner.id)) {
        rootParagraphPatches.push(this.rootParagraphInsertPatch(owner));
        this.emittedRootParagraphIds.add(owner.id);
      }
    }

    this.performanceTimer.measure("incremental-parse");
    metrics?.markParseEnd();
    metrics?.setBlocksProduced(this.blocks.length);

    await this.emitBlockDiffPatches(
      prevBlocks,
      changedBlocks,
      changeRanges,
      metrics,
      progressPublication,
      undefined,
      rootCodePatches.concat(rootParagraphPatches, paragraphSemanticPatches, tableSemanticPatches),
      previousRootParagraphOwners,
    );
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && progressPublication) {
      this.recordParsedProgressPublication(progressPublication);
    }
  }

  private async extractBlocks(tree: Tree, content: SourceText, options: ParseOptions = {}): Promise<Block[]> {
    try {
      this.headingIdCounts = new Map<string, number>();
      const sourceOffset = options.sourceOffset ?? 0;
      const extracted: Block[] = [];
      const cursor = tree.cursor();
      const footnotesEnabled = this.documentPluginRegistry.getAll().some((plugin) => plugin.name === "footnotes");
      let hasRecognizedNodes = false;
      const reusableBlockMap =
        options.firstChangedPos !== undefined && options.previousBlocks
          ? new Map(options.previousBlocks.map((block) => [`${block.payload.range?.from ?? -1}:${block.payload.range?.to ?? -1}`, block]))
          : null;

      if (cursor.firstChild()) {
        do {
          const nodeType = cursor.type.name;
          let from = cursor.from;
          const to = cursor.to;
          if (nodeType === "CodeBlock") from = sourceLineStart(content, from);
          const globalFrom = from + sourceOffset;
          const globalTo = to + sourceOffset;
          if (nodeType === "FencedCode" && this.rootCodeOwnersByStart.has(globalFrom)) {
            hasRecognizedNodes = true;
            continue;
          }
          if (nodeType === "Table" && this.rootTableOwnersByStart.has(globalFrom)) {
            hasRecognizedNodes = true;
            continue;
          }
          if (nodeType === "Paragraph" && this.rootParagraphOwnersByStart.has(globalFrom)) {
            hasRecognizedNodes = true;
            continue;
          }

          let raw: string | undefined;
          const footnoteDefinition = nodeType === "LinkReference"
            && footnotesEnabled
            && /^\[\^[A-Za-z0-9_-]+\]:/.test(raw = readSourceRange(content, from, to));
          if (nodeType === "LinkReference" && !footnoteDefinition) {
            hasRecognizedNodes = true;
            continue;
          }
          if (!isBlockLevelNode(nodeType) && !footnoteDefinition) continue;
          hasRecognizedNodes = true;
          const blockType = footnoteDefinition ? "paragraph" : mapLezerNodeToBlockType(nodeType);
          let block: Block | null = null;
          if (reusableBlockMap && globalTo <= options.firstChangedPos!) {
            const previous = reusableBlockMap.get(`${globalFrom}:${globalTo}`);
            if (previous && previous.isFinalized && previous.type === blockType) {
              block = previous;
              if (blockType === "heading") {
                const headingMeta = previous.payload.meta as { headingText?: string } | undefined;
                const headingText = headingMeta?.headingText ?? previous.payload.raw;
                const baseSlug = slugifyHeading(headingText);
                this.headingIdCounts.set(baseSlug, (this.headingIdCounts.get(baseSlug) ?? 0) + 1);
              }
            }
          }

          if (block) {
            extracted.push(block);
            continue;
          }
          raw ??= readSourceRange(content, from, to);
          if (!raw.trim()) continue;
          block = await this.createBlock(blockType, raw, globalFrom, globalTo, content, options, nodeType, cursor.node);
          if (block) extracted.push(block);
        } while (cursor.nextSibling());
      }

      if (extracted.length === 0 && !hasRecognizedNodes) {
        return await this.extractBlocksSimple(content, options);
      }

      const grouped = groupHtmlOwnership(extracted, this.mdParser, content, this.htmlConfig, sourceOffset, (text) => this.inlineParser.parse(text), { mdxComponents: this.mdxEnabled });
      return await this.refreshOwnedMdxRegions(grouped, options);
    } catch (error) {
      console.warn("Lezer parsing failed, falling back to simple parsing:", error);
      return await this.extractBlocksSimple(content, options);
    }
  }

  private async extractBlocksSimple(content: SourceText, options: ParseOptions = {}): Promise<Block[]> {
    const blocks: Block[] = [];
    const contentLength = sourceLength(content);
    let currentParagraph: string[] = [];
    let paragraphFrom = 0;
    let paragraphTo = 0;

    const finalizeParagraph = async () => {
      if (currentParagraph.length > 0) {
        const raw = currentParagraph.join("\n");
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

        const sourceOffset = options.sourceOffset ?? 0;
        const block = await this.createBlock(blockType, raw, paragraphFrom + sourceOffset, paragraphTo + sourceOffset, content, options);
        if (block) blocks.push(block);
        currentParagraph = [];
      }
    };

    let lineStart = 0;
    while (true) {
      let line: string;
      let lineEnd: number;
      let nextLineStart: number;
      if (lineStart === contentLength) {
        line = "";
        lineEnd = lineStart;
        nextLineStart = contentLength + 1;
      } else if (typeof content === "string") {
        const newline = content.indexOf("\n", lineStart);
        lineEnd = newline < 0 ? contentLength : newline;
        line = content.slice(lineStart, lineEnd);
        nextLineStart = newline < 0 ? contentLength + 1 : newline + 1;
      } else {
        const chunk = content.chunk(lineStart);
        if (chunk === "\n") {
          line = "";
          lineEnd = lineStart;
          nextLineStart = lineStart + 1;
        } else {
          line = chunk;
          lineEnd = lineStart + chunk.length;
          nextLineStart = sourceCharAt(content, lineEnd) === "\n" ? lineEnd + 1 : contentLength + 1;
        }
      }

      if (line.trim() === "") {
        await finalizeParagraph();
      } else if (line.trim().match(/^\[[^\]]+\]:\s*\S+/)) {
        await finalizeParagraph();
      } else {
        if (currentParagraph.length === 0) paragraphFrom = lineStart;
        currentParagraph.push(line);
        paragraphTo = lineEnd;
      }

      if (nextLineStart > contentLength) break;
      lineStart = nextLineStart;
    }

    await finalizeParagraph();
    return blocks;
  }

  private async createBlock(
    type: string,
    raw: string,
    from: number,
    to: number,
    fullContent: SourceText,
    options: ParseOptions = {},
    nodeType?: string,
    syntaxNode?: SyntaxNode,
  ): Promise<Block | null> {
    if (!raw.trim()) return null;

    const sourceOffset = options.sourceOffset ?? 0;
    const localTo = to - sourceOffset;
    const isFinalized = options.forceFinalize ? true : localTo < sourceLength(fullContent) - 1;
    const blockType = type;

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

    await this.enrichBlock(block, options, syntaxNode);
    return block;
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

  private parseInlineStreaming(
    content: string,
    context: LookaheadContainerContext,
    existingInline?: InlineNode[],
    onAttemptedReference?: (label: string) => void,
    recordSourceUnits = true,
  ): InlineStreamingParseResult {
    if (recordSourceUnits && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordInlineSourceUnits(content.length);
    }
    const regexEnabled = this.formatAnticipationConfig.regex || this.syntaxRules.some((rule) => rule.anticipation);
    const orchestration = prepareInlineStreamingLookahead(content, {
      formatAnticipation: { ...this.formatAnticipationConfig, regex: regexEnabled },
      math: this.enableMath,
      regexAppend: regexEnabled ? this.inlineParser.getRegexAnticipationAppend(content) : null,
      context,
    });
    const prepared = orchestration.prepared;
    const inline = existingInline ?? (prepared.kind === "raw"
      ? [{ kind: "text", text: content }]
      : this.inlineParser.parse(prepared.content, {
          cache: false,
          ...(onAttemptedReference ? { onAttemptedReference } : {}),
        }));
    return {
      inline,
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

  private async enrichBlock(block: Block, options?: ParseOptions, nativeNode?: SyntaxNode): Promise<void> {
    this.inlineParser.startCollectingAttemptedReferences();
    try {
      await this.enrichBlockContent(block, options, [], nativeNode);
    } finally {
      this.recordLinkReferences(block, this.inlineParser.stopCollectingAttemptedReferences());
    }
  }

  private engineMdxState(): EngineMdxState {
    return {
      cache: this.workerMdxCache,
      inflight: this.workerMdxInflight,
      compileMode: this.mdxCompileMode,
      debugMdx: false,
    };
  }

  /** Whether a raw fragment opens a container (`<div>`, `<SmokeBox>`) that never closes inside it. */
  private leavesOpenContainer(raw: string): boolean {
    if (!raw) return false;
    const stack: string[] = [];
    applyHtmlTagBalance(raw, this.mdParser, stack, this.mdxEnabled);
    return stack.length > 0;
  }

  /**
   * Native MDX eligibility for one block: a component open tag or JSX expression outside protected
   * ranges. Html blocks are additionally re-checked without their own html-block protection so a
   * complete `<Component>` region root is recognized even when its opening tag is the protected span.
   */
  private applyMdxDetection(block: Block, metrics?: WorkerMetricsCollector | null): boolean {
    if (!this.mdxEnabled || (block.type !== "paragraph" && block.type !== "html")) return false;
    const maybeMeta = block.payload.meta as Record<string, unknown> | undefined;
    if (block.type === "paragraph") {
      const segments = maybeMeta?.mixedSegments as MixedContentSegment[] | undefined;
      let owner: MixedContentSegment | undefined;
      let contentCount = 0;
      for (const segment of segments ?? []) {
        if (segment.kind === "text" && segment.value.trim().length === 0) continue;
        owner = segment;
        contentCount++;
      }
      const standalone = contentCount === 1 && owner?.kind === "mdx" &&
        owner.value.startsWith("<") && owner.value.trim() === block.payload.raw.trim();
      if (!standalone && (maybeMeta?.inlineComponentSource || maybeMeta?.htmlParagraphTree || segments?.length)) return false;
      if (standalone && maybeMeta) {
        // Coordinator mode keeps pending segments for its existing status/signature contract,
        // but a complete component still belongs to the block-module evaluator.
        maybeMeta.mdxStandalone = true;
        if (this.mdxCompileMode !== "server") delete maybeMeta.mixedSegments;
        delete maybeMeta.mixedHtmlTrees;
        delete maybeMeta.mixedLookahead;
        delete maybeMeta.allowMixedStreaming;
        delete maybeMeta.htmlParagraphTree;
        delete maybeMeta.inlineComponentSource;
      }
    }
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
      return true;
    }
    return false;
  }

  /**
   * Region grouping runs before MDX detection so a balanced component stays one owning root.
   * Deferred html blocks refresh here: region owners convert and compile, while an unclosed
   * container that is not finalized yet stays an html block pending its close or FINALIZE.
   */
  private async refreshOwnedMdxRegions(blocks: Block[], options: ParseOptions): Promise<Block[]> {
    if (!this.mdxEnabled) return blocks;
    for (const block of blocks) {
      if (block.type !== "html") continue;
      const owned = (block.payload.meta as { htmlOwnership?: unknown } | undefined)?.htmlOwnership === true;
      const raw = block.payload.raw ?? "";
      const open = this.leavesOpenContainer(raw);
      if (!open && !owned) continue;
      if (open && !options.forceFinalize) {
        if (owned || detectMDX(raw)) {
          block.isFinalized = false;
        }
        continue;
      }
      if (!this.applyMdxDetection(block, this.activeMetricsCollector)) continue;
      if ("sanitizedHtml" in block.payload) {
        block.payload.sanitizedHtml = undefined;
      }
      await updateMdxCompilationState(this.engineMdxState(), block);
    }
    return blocks;
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
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordBlockReprepared(undefined, undefined, undefined, "engine");
    }
    const metrics = this.activeMetricsCollector;
    metrics?.countBlockType(block.type);
    const rawLength = typeof block.payload.raw === "string" ? block.payload.raw.length : 0;
    metrics?.recordBlockSize(block.type, rawLength);
    const shouldTrackInline = this.tracksInlineStatus();
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
        block.payload.inline = block.isFinalized ? this.inlineParser.parse(rawParagraph) : streamingParsed?.inline ?? [{ kind: "text", text: rawParagraph }];

        const currentMeta = (block.payload.meta ?? {}) as Record<string, unknown>;
        const nextMeta: Record<string, unknown> = { ...currentMeta };
        let metaChanged = false;
        if (this.mdxEnabled) {
          const inline = preserveInlineComponentSource(block.payload.inline);
          if (inline !== block.payload.inline) nextMeta.inlineComponentSource = true;
          else delete nextMeta.inlineComponentSource;
          block.payload.inline = inline;
          metaChanged = true;
        }

        const baseOffset = block.payload.range?.from ?? 0;
        const protectedRanges = collectCodeProtectedRanges(rawParagraph);
        if (this.enableMath) {
          protectedRanges.push(...collectMathProtectedRanges(rawParagraph, protectedRanges));
        }
        const autolinkRanges = collectAutolinkProtectedRanges(rawParagraph);
        if (autolinkRanges.length > 0) {
          protectedRanges.push(...autolinkRanges);
        }

        const shouldExtractSegments = typeof rawParagraph === "string" && (rawParagraph.includes("<") || rawParagraph.includes("{"));
        if (shouldExtractSegments) {
          const mixedOptions =
            allowMixed
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
        await this.prepareNestedChildren(block, options, ancestorTypes, nativeNode);
        break;

      case "table": {
        const raw = block.payload.raw ?? "";
        let tableNode = nativeNode?.type.name === "Table" ? nativeNode : undefined;
        let tableOffset = options?.sourceOffset ?? 0;
        if (!tableNode) {
          const localTree = new NativeMarkdownInput(raw, true).parse(this.mdParser);
          const cursor = localTree.cursor();
          if (cursor.firstChild() && cursor.type.name === "Table") {
            tableNode = cursor.node;
            tableOffset = block.payload.range?.from ?? 0;
          }
        }
        const state = options?.forceFinalize ? "finalized" : block.isFinalized ? "closed" : "open";
        const tableData = tableNode
          ? typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
            ? parseGfmTableFromTree(
              tableNode,
              this.sourceDocument.snapshot(),
              tableOffset,
              block.id,
              this.documentGeneration,
              this.inlineParser,
              state,
              Boolean(options?.forceFinalize),
              (_cellId, _labels, sourceUnits) => this.campaignCounters?.recordInlineSourceUnits(sourceUnits, "engine"),
            )
            : parseGfmTableFromTree(
              tableNode,
              this.sourceDocument.snapshot(),
              tableOffset,
              block.id,
              this.documentGeneration,
              this.inlineParser,
              state,
              Boolean(options?.forceFinalize),
            )
          : null;
        if (tableData) {
          block.payload.inline = [];
          block.payload.meta = {
            ...(block.payload.meta ?? {}),
            header: tableData.header,
            align: tableData.align,
            rows: tableData.rows,
            table: tableData.table,
          };
        }
        break;
      }
    }
    if (!(this.mdxEnabled && block.type === "html" && this.leavesOpenContainer(block.payload.raw ?? ""))) {
      // An html block that leaves a container open is a region candidate: grouping must see its
      // native `html` identity before MDX detection can retag it, so detection is refreshed for
      // region-owned blocks after grouping instead.
      this.applyMdxDetection(block, metrics);
    }

    const mdxState = this.engineMdxState();
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

  private async prepareNestedChildren(block: Block, options?: ParseOptions, ancestorTypes: readonly string[] = [], nativeNode?: SyntaxNode): Promise<void> {
    block.payload.meta = { ...block.payload.meta, mathEnabled: this.enableMath, formatAnticipation: this.formatAnticipationConfig };
    const prepared = prepareNestedBlockSnapshot(block, this.inlineParser, this.mdParser, (text) => this.parseInlineStreaming(text, this.inlineContext(block, ancestorTypes)).inline);
    const listItemSources = collectNestedListItemInlineSources(block, this.mdParser, nativeNode);
    const groupChildren = async (children: NodeSnapshot[], ancestors: readonly string[]): Promise<NodeSnapshot[]> => {
      const grouped: NodeSnapshot[] = [];
      let sequence: NodeSnapshot[] = [];
      const flush = async () => {
        const blocks = sequence.map((child) => child.props?.block as Block);
        const owned = groupHtmlOwnership(blocks, this.mdParser, block.payload.raw, this.htmlConfig, block.payload.range?.from ?? 0, (text) => this.inlineParser.parse(text), { joinLeafRaws: true, forceFinalize: options?.forceFinalize, mdxComponents: this.mdxEnabled });
        const retained = new Set<Block>(owned);
        // Markdown leaves absorbed into an owner keep their consumer metadata (code highlighting,
        // inline segments): the owner owns their source, their tree slots still reference them.
        for (const leaf of blocks) {
          if (retained.has(leaf) || leaf.type === "html") continue;
          await this.enrichBlockContent(leaf, options, [...ancestors, "html"]);
        }
        for (const child of owned) {
          const original = sequence.find((candidate) => candidate.props?.block === child);
          if (!original) {
            await this.refreshOwnedMdxRegions([child], options ?? {});
          }
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
            const { text, from: baseOffset } = source;
            const codeRanges = collectCodeProtectedRanges(text).map((range) => ({
              ...range,
              from: baseOffset + range.from,
              to: baseOffset + range.to,
            }));
            const parsed = nested.isFinalized ? null : this.parseInlineStreaming(text, this.inlineContext(nested, ancestors), nested.payload.inline);
            this.updateInlineLookaheadMeta(nested, parsed, this.tracksInlineStatus());
            if (text.includes("<") || text.includes("{")) {
              const extraction = extractMixedContentSegmentsWithLookahead(text, baseOffset,
                (value) => {
                  const inline = nested.isFinalized ? this.inlineParser.parse(value) : this.parseInlineStreaming(value, this.inlineContext(nested, ancestors, "mixed-content")).inline;
                  return this.mdxEnabled ? preserveInlineComponentSource(inline) : inline;
                }, {
                  html: !nested.isFinalized && this.formatAnticipationConfig.html ? { autoClose: true, maxNewlines: MIXED_CONTENT_AUTOCLOSE_NEWLINES } : undefined,
                  mdx: { autoClose: !nested.isFinalized && this.formatAnticipationConfig.mdx, maxNewlines: MIXED_CONTENT_AUTOCLOSE_NEWLINES, componentAllowlist: this.mdxComponentAllowlist ?? undefined },
                  protectedRanges: codeRanges,
                  allowedTags: this.htmlConfig?.allowedTags,
                  literalTagContent: this.htmlConfig?.literalTagContent,
                  lookaheadContext: this.inlineContext(nested, ancestors, "mixed-content"),
                });
              if (!nested.isFinalized && extraction.lookahead.length > 0) {
                nested.payload.meta = { ...nested.payload.meta, mixedLookahead: extraction.lookahead };
              }
              const segmentPrefix = `${nested.id}::list-item:segment:`;
              const blockChildren = (snapshot.children ?? []).filter((child) => !child.id.startsWith(segmentPrefix));
              const segments = extraction.segments;
              const segmentChildren: NodeSnapshot[] = segments.some((segment) => segment.kind === "mdx") ? segments.map((segment, index) => ({
                id: `${segmentPrefix}${index}`,
                type: `list-item-${segment.kind}`,
                props: segment.kind === "text" ? { inline: segment.inline, text: segment.value }
                  : segment.kind === "html" ? {
                      raw: segment.value, html: segment.sanitized ?? segment.value,
                      htmlTree: sanitizeHtmlTreeInWorker(segment.value, this.mixedHtmlConfig, undefined, (value) => this.inlineParser.parse(value)),
                    }
                  : { raw: segment.value, status: segment.status ?? "pending", error: segment.error },
                children: [],
              })) : [];
              if (this.mdxEnabled) {
                nested.payload.inline = preserveInlineComponentSource(nested.payload.inline ?? []);
                snapshot.props = { ...snapshot.props, inline: nested.payload.inline };
              }
              snapshot.children = [...segmentChildren, ...blockChildren];
            }
          }
        }
        if (nested.type !== "list-item") this.updateContainerLookaheadMeta(nested, snapshot.children ?? [], ancestors);
        const { block: _block, ...props } = snapshot.props ?? {};
        nested.payload.meta = { ...nested.payload.meta, preparedNested: { props, children: snapshot.children ?? [] } };
      } else {
        await this.enrichBlockContent(nested, options, ancestors);
        await this.refreshOwnedMdxRegions([nested], options ?? {});
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
                const tokenInput = completeLines.join("\n");
                if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
                  this.campaignCounters?.recordTokenization(completeLines.length, tokenInput.length, "engine");
                }
                const tokens = this.highlighter?.codeToTokensWithThemes(tokenInput, {
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
            if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
              this.campaignCounters?.recordTokenization(codeLines.length, codeBody.length, "engine");
            }
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

  private runDocumentPlugins(
    inputBlocks: Block[],
    source: SourceSnapshot,
    footnoteTargets?: {
      readonly deltas?: readonly FootnoteParagraphTargetDelta[];
      readonly removedOwnerIds?: readonly string[];
      readonly rebuild?: boolean;
    },
  ): Block[] {
    const documentGeneration = this.documentGeneration;
    const tableProjections = new Map<string, { owner: RootTableSourceOwner; projection: RootTableFootnoteProjection }>();
    const tableBlocks: Block[] = [];
    for (const owner of this.rootTableOwners) {
      const projection = owner.getFootnoteProjection();
      if (!projection) continue;
      tableProjections.set(owner.id, { owner, projection });
      tableBlocks.push(projection.block);
    }
    const blocks = [...inputBlocks, ...tableBlocks].sort((left, right) =>
      (left.payload.range?.from ?? Number.POSITIVE_INFINITY) - (right.payload.range?.from ?? Number.POSITIVE_INFINITY));
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
    for (const owner of this.rootCodeOwners) {
      const range = owner.getMetadata().sourceRange;
      aggregatedProtected.push({ from: range.from, to: range.to, kind: "code-fence" });
    }

    let hasProvisionalTail = this.rootCodeOwners.some((owner) => owner.getMetadata().state === "open")
      || this.rootTableOwners.some((owner) => owner.getMetadata().state === "open")
      || this.rootParagraphOwners.some((owner) => owner.getMetadata().state === "open");
    if (!hasProvisionalTail) {
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index];
        if (block?.type === "footnotes") continue;
        hasProvisionalTail = Boolean(block && !block.isFinalized);
        break;
      }
    }

    const footnoteParagraphTargets = footnoteTargets || this.rootParagraphOwners.length > 0
      ? {
          deltas: footnoteTargets?.deltas ?? [],
          ...(footnoteTargets?.removedOwnerIds ? { removedOwnerIds: footnoteTargets.removedOwnerIds } : {}),
          ...(footnoteTargets?.rebuild === undefined ? {} : { rebuild: footnoteTargets.rebuild }),
          applyUpdates: (updates: readonly FootnoteParagraphTargetUpdate[]) => {
            if (documentGeneration !== this.documentGeneration || source !== this.sourceDocument.snapshot()) return;
            for (const update of updates) {
              const owner = this.rootParagraphOwners.find((candidate) =>
                candidate.id === update.ownerId && candidate.generation === update.generation);
              if (!owner) continue;
              const metadata = owner.getMetadata();
              if (metadata.generation !== update.generation
                || this.rootParagraphOwnersByStart.get(metadata.sourceRange.from) !== owner) continue;
              const change = owner.applyPreparedSpanUpdates(update.updates, "footnote_reference_numbering");
              const patch = rootParagraphSemanticPatch(owner, change);
              if (patch && this.emittedRootParagraphIds.has(owner.id)) this.pendingRootParagraphPatches.push(patch);
            }
          },
        }
      : undefined;
    const { syntheticBlocks } = this.documentPluginRegistry.run({
      source,
      blocks,
      readBlocks: () => this.materializeRootBlocks(inputBlocks),
      hasProvisionalTail,
      state: this.documentPluginState,
      protectedRanges: aggregatedProtected,
      footnoteParagraphTargets,
    });

    const updatedTableBlocks = new Map<string, Block>();
    for (const block of blocks) {
      if (tableProjections.has(block.id)) updatedTableBlocks.set(block.id, block);
    }
    for (const [tableId, entry] of tableProjections) {
      const pluginBlock = updatedTableBlocks.get(tableId);
      if (!pluginBlock) continue;
      const change = entry.owner.applyFootnoteProjection({ ...entry.projection, block: pluginBlock });
      const patch = rootTableSemanticPatch(entry.owner, change);
      if (patch && this.emittedRootTableIds.has(entry.owner.id)) this.pendingRootTablePatches.push(patch);
    }

    const filtered = blocks.filter((block) => block.type !== "footnotes" && !tableProjections.has(block.id));
    if (syntheticBlocks && syntheticBlocks.length > 0) {
      if (hasProvisionalTail) {
        return filtered;
      }
      filtered.push(...syntheticBlocks);
    }
    return filtered;
  }


  private async emitBlockDiffPatches(
    previousBlocks: Block[],
    nextBlocks: Block[],
    changedRanges: ContentChangeRange[],
    metrics?: WorkerMetricsCollector | null,
    progressPublication?: ProgressPublicationContext,
    parseEpoch?: number,
    extraPatches: Patch[] = [],
    previousRootParagraphOwners: readonly RootParagraphSourceOwner[] = this.rootParagraphOwners,
  ): Promise<void> {
    const patches: Patch[] = [];
    const { patch: tocPatch, nextHeadings, nextSignature } = maybeBuildTocPatch(nextBlocks, this.tocSignature);
    this.tocHeadings = nextHeadings;
    this.tocSignature = nextSignature;

    type RootChildEntry = {
      readonly id: string;
      readonly from: number;
      readonly block?: Block;
      readonly owner?: RootCodeSourceOwner;
      readonly tableOwner?: RootTableSourceOwner;
      readonly paragraphOwner?: RootParagraphSourceOwner;
    };
    const insertedRootCodeNodes = new Map<string, NodeSnapshot>();
    const insertedRootTableNodes = new Map<string, NodeSnapshot>();
    const insertedRootParagraphNodes = new Map<string, NodeSnapshot>();
    const additionalPatches: Patch[] = [];
    for (const patch of extraPatches) {
      if (patch.op === "insertChild" && patch.at.blockId === PATCH_ROOT_ID && patch.node.type === "code") {
        insertedRootCodeNodes.set(patch.node.id, patch.node);
      } else if (patch.op === "insertChild" && patch.at.blockId === PATCH_ROOT_ID && patch.node.type === "table") {
        insertedRootTableNodes.set(patch.node.id, patch.node);
      } else if (patch.op === "insertChild" && patch.at.blockId === PATCH_ROOT_ID
        && patch.node.type === "paragraph" && "paragraph" in patch.node) {
        insertedRootParagraphNodes.set(patch.node.id, patch.node);
      } else {
        additionalPatches.push(patch);
      }
    }

    const orderedChildren = (
      blocks: readonly Block[],
      owners: readonly RootCodeSourceOwner[],
      tableOwners: readonly RootTableSourceOwner[],
      paragraphOwners: readonly RootParagraphSourceOwner[],
    ): RootChildEntry[] => {
      const entries: RootChildEntry[] = blocks.map((block) => ({
        id: block.id,
        from: block.payload.range?.from ?? Number.POSITIVE_INFINITY,
        block,
      }));
      for (const owner of owners) {
        if (owners === this.rootCodeOwners && !this.emittedRootCodeIds.has(owner.id) && !insertedRootCodeNodes.has(owner.id)) continue;
        entries.push({
          id: owner.id,
          from: owner.getMetadata().sourceRange.from,
          owner,
        });
      }
      for (const owner of tableOwners) {
        if (tableOwners === this.rootTableOwners && !this.emittedRootTableIds.has(owner.id) && !insertedRootTableNodes.has(owner.id)) continue;
        entries.push({
          id: owner.id,
          from: owner.getMetadata().sourceRange.from,
          tableOwner: owner,
        });
      }
      for (const owner of paragraphOwners) {
        if (paragraphOwners === this.rootParagraphOwners
          && !this.emittedRootParagraphIds.has(owner.id)
          && !insertedRootParagraphNodes.has(owner.id)) continue;
        entries.push({
          id: owner.id,
          from: owner.getMetadata().sourceRange.from,
          paragraphOwner: owner,
        });
      }
      entries.sort((a, b) => a.from - b.from);
      return entries;
    };
    const previousOwners = this.rootCodeOwners.filter((owner) =>
      this.emittedRootCodeIds.has(owner.id) && !insertedRootCodeNodes.has(owner.id)
    );
    const previousTableOwners = this.rootTableOwners.filter((owner) =>
      this.emittedRootTableIds.has(owner.id) && !insertedRootTableNodes.has(owner.id)
    );
    const previousParagraphOwners = previousRootParagraphOwners.filter((owner) =>
      !insertedRootParagraphNodes.has(owner.id)
        || this.rootParagraphOwnersByStart.get(owner.getMetadata().sourceRange.from) !== owner
    );
    const previousChildren = orderedChildren(previousBlocks, previousOwners, previousTableOwners, previousParagraphOwners);
    const nextChildren = orderedChildren(nextBlocks, this.rootCodeOwners, this.rootTableOwners, this.rootParagraphOwners);
    if (previousBlocks === nextBlocks && extraPatches.length === 0) return;

    const snapshotFor = (entry: RootChildEntry, cloneNative: boolean): NodeSnapshot => {
      if (entry.tableOwner) {
        const pending = insertedRootTableNodes.get(entry.tableOwner.id);
        return pending ?? rootTableNodeSnapshot(entry.tableOwner);
      }
      if (entry.paragraphOwner) {
        const pending = insertedRootParagraphNodes.get(entry.paragraphOwner.id);
        return pending ?? rootParagraphNodeSnapshot(entry.paragraphOwner);
      }
      if (entry.owner) {
        const pending = insertedRootCodeNodes.get(entry.owner.id);
        return pending ?? rootCodeNodeSnapshot(entry.owner, this.sourceDocument.snapshot(), this.rootCodeConfigurationRevision);
      }
      const sourceBlock = entry.block;
      if (!sourceBlock) throw new Error("Native root child is missing its Block");
      const block = cloneNative ? cloneBlock(sourceBlock) : sourceBlock;
      if ((typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) && this.campaignCounters) {
        return (createBlockSnapshot as (value: Block, callback?: (node: NodeSnapshot) => void) => NodeSnapshot)(
          block,
          () => this.campaignCounters?.recordSnapshotNodes(1, "snapshot"),
        );
      }
      return createBlockSnapshot(block);
    };

    let prefix = 0;
    const maxPrefix = Math.min(previousChildren.length, nextChildren.length);
    while (prefix < maxPrefix) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordPrefixComparisons(1, "engine");
      }
      if (previousChildren[prefix]?.id !== nextChildren[prefix]?.id ||
        Boolean(previousChildren[prefix]?.owner) !== Boolean(nextChildren[prefix]?.owner) ||
        Boolean(previousChildren[prefix]?.tableOwner) !== Boolean(nextChildren[prefix]?.tableOwner) ||
        previousChildren[prefix]?.paragraphOwner !== nextChildren[prefix]?.paragraphOwner) break;
      prefix += 1;
    }


    const nextPositionById = new Map(nextChildren.map((entry, index) => [entry.id, index]));
    let lastNextPosition = -1;
    let commonOrderStable = true;
    for (const entry of previousChildren) {
      const nextPosition = nextPositionById.get(entry.id);
      if (nextPosition === undefined) continue;
      if (nextPosition <= lastNextPosition) {
        commonOrderStable = false;
        break;
      }
      lastNextPosition = nextPosition;
    }
    const hasRootOwner = previousChildren.some((entry) => entry.owner || entry.tableOwner || entry.paragraphOwner) ||
      nextChildren.some((entry) => entry.owner || entry.tableOwner || entry.paragraphOwner);
    let removeCount = 0;
    let addCount = 0;
    if (hasRootOwner && commonOrderStable) {
      const nextIds = new Set(nextChildren.map((entry) => entry.id));
      const currentChildren = previousChildren.slice();
      for (let index = currentChildren.length - 1; index >= 0; index -= 1) {
        if (nextIds.has(currentChildren[index]?.id ?? "")) continue;
        patches.push({
          op: "deleteChild",
          at: { blockId: PATCH_ROOT_ID },
          index,
        });
        currentChildren.splice(index, 1);
        removeCount += 1;
      }
      for (let index = 0; index < nextChildren.length; index += 1) {
        const entry = nextChildren[index];
        if (!entry) continue;
        const current = currentChildren[index];
        if (current?.id !== entry.id) {
          patches.push({
            op: "insertChild",
            at: { blockId: PATCH_ROOT_ID },
            index,
            node: snapshotFor(entry, true),
          });
          currentChildren.splice(index, 0, entry);
          addCount += 1;
        } else if (
          Boolean(current.owner) !== Boolean(entry.owner) ||
          Boolean(current.tableOwner) !== Boolean(entry.tableOwner) ||
          current.paragraphOwner !== entry.paragraphOwner
        ) {
          patches.push({
            op: "replaceChild",
            at: { blockId: PATCH_ROOT_ID },
            index,
            node: snapshotFor(entry, false),
          });
        }
      }
    } else {
      let prevTail = previousChildren.length - 1;
      let nextTail = nextChildren.length - 1;
      while (prevTail >= prefix && nextTail >= prefix) {
        if (previousChildren[prevTail]?.id !== nextChildren[nextTail]?.id ||
          Boolean(previousChildren[prevTail]?.owner) !== Boolean(nextChildren[nextTail]?.owner) ||
          Boolean(previousChildren[prevTail]?.tableOwner) !== Boolean(nextChildren[nextTail]?.tableOwner) ||
          previousChildren[prevTail]?.paragraphOwner !== nextChildren[nextTail]?.paragraphOwner) break;
        prevTail -= 1;
        nextTail -= 1;
      }
      removeCount = prevTail >= prefix ? prevTail - prefix + 1 : 0;
      addCount = nextTail >= prefix ? nextTail - prefix + 1 : 0;
      if (removeCount === addCount) {
        for (let offset = 0; offset < addCount; offset += 1) {
          const targetIndex = prefix + offset;
          const entry = nextChildren[targetIndex];
          if (!entry) continue;
          patches.push({
            op: "replaceChild",
            at: { blockId: PATCH_ROOT_ID },
            index: targetIndex,
            node: snapshotFor(entry, false),
          });
        }
      } else {
        for (let index = removeCount - 1; index >= 0; index -= 1) {
          patches.push({
            op: "deleteChild",
            at: { blockId: PATCH_ROOT_ID },
            index: prefix + index,
          });
        }
        for (let offset = 0; offset < addCount; offset += 1) {
          const insertIndex = prefix + offset;
          const entry = nextChildren[insertIndex];
          if (!entry) continue;
          patches.push({
            op: "insertChild",
            at: { blockId: PATCH_ROOT_ID },
            index: insertIndex,
            node: snapshotFor(entry, true),
          });
        }
      }
    }
    metrics?.markDiffStart();
    const { patches: contentPatches } = await this.diffBlockContent(previousBlocks, nextBlocks, changedRanges, metrics);
    metrics?.markDiffEnd();

    const combined = additionalPatches.concat(patches, contentPatches);
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

    let immediatePatches: Patch[];
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && progressPublication) {
      const deferredQueue = this.deferredPatchQueue;
      const currentPatchRefs = new Set(annotatedCombined);
      const combinedWithDeferred = deferredQueue.length > 0
        ? deferredQueue.concat(annotatedCombined)
        : annotatedCombined;
      const coalesced = dedupeSetPropsByTargetKeepingLatest(combinedWithDeferred);
      this.tagSemanticPatchesForProgress(coalesced, progressPublication, currentPatchRefs);
      deferredQueue.length = 0;
      immediatePatches = partitionPatchesForCredits(
        coalesced,
        this.workerCredits,
        deferredQueue,
        paragraphLimit === null ? undefined : paragraphLimit,
      );
    } else {
      immediatePatches = partitionPatchesForCredits(
        annotatedCombined,
        this.workerCredits,
        this.deferredPatchQueue,
        paragraphLimit === null ? undefined : paragraphLimit,
      );
    }
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

      const prevSnapshot = (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) && this.campaignCounters
        ? (createBlockSnapshot as (b: Block, cb?: (n: NodeSnapshot) => void) => NodeSnapshot)(
            prevBlock,
            () => this.campaignCounters?.recordSnapshotNodes(1, "snapshot"),
          )
        : createBlockSnapshot(prevBlock);
      const nextSnapshot = (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) && this.campaignCounters
        ? (createBlockSnapshot as (b: Block, cb?: (n: NodeSnapshot) => void) => NodeSnapshot)(
            nextBlock,
            () => this.campaignCounters?.recordSnapshotNodes(1, "snapshot"),
          )
        : createBlockSnapshot(nextBlock);

      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.campaignCounters) {
        diffNodeSnapshot(nextBlock.id, prevSnapshot, nextSnapshot, patches, metrics, this.campaignCounters);
      } else {
        diffNodeSnapshot(nextBlock.id, prevSnapshot, nextSnapshot, patches, metrics);
      }
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
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordPublication(tx, this.sourceDocument.length);
      this.campaignCounters?.recordPatchesEmitted(annotatedPatches.length, "patch");
    }
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
    let progressPublication: ProgressPublicationContext | undefined;
    const sourceLength = this.sourceDocument.length;

    if (this.rootCodeOwners.length > 0 || this.rootTableOwners.length > 0 || this.rootParagraphOwners.length > 0) {
      const source = this.sourceDocument.snapshot();
      const semanticPatches: Patch[] = [];
      const ownersToDecorate: RootCodeSourceOwner[] = [];
      for (const owner of this.rootCodeOwners) {
        const previous = owner.getMetadata();
        const change = owner.finalize();
        const next = owner.getMetadata();
        if (next.revision !== previous.revision) {
          semanticPatches.push(rootCodeAppendPatch(owner, rootCodeAppendChange(owner, source, previous, change)));
          ownersToDecorate.push(owner);
        }
      }
      let remainingRootFrom: number | undefined;
      let replacementRootFrom: number | undefined;
      const previousRootParagraphOwners = this.rootParagraphOwners.slice();
      const finalizedParagraphTargets: FootnoteParagraphTargetDelta[] = [];
      for (const owner of this.rootTableOwners) {
        const previous = owner.getMetadata();
        const change = owner.finalize();
        const next = owner.getMetadata();
        const appendChange = next.revision !== previous.revision
          ? rootTableAppendChange(source, previous, change)
          : undefined;
        if (!this.emittedRootTableIds.has(owner.id)) {
          semanticPatches.push(this.rootTableInsertPatch(owner));
          this.emittedRootTableIds.add(owner.id);
        } else if (appendChange) {
          semanticPatches.push(rootTableAppendPatch(owner, appendChange));
        }
        if (appendChange?.rootResumeFrom !== undefined) {
          remainingRootFrom = remainingRootFrom === undefined
            ? appendChange.rootResumeFrom
            : Math.min(remainingRootFrom, appendChange.rootResumeFrom);
        }
      }
      for (const owner of previousRootParagraphOwners) {
        const previous = owner.getMetadata();
        if (previous.state === "finalized") continue;
        const change = finalizeRootParagraphOwner(owner, source);
        if (rootParagraphChangeNeedsReplacement(change)) {
          replacementRootFrom = replacementRootFrom === undefined
            ? previous.sourceRange.from
            : Math.min(replacementRootFrom, previous.sourceRange.from);
          this.retireRootParagraphOwner(owner);
          continue;
        }
        const appendChange = rootParagraphAppendChange(source, previous, change);
        if (change.spans.length > 0) {
          finalizedParagraphTargets.push(this.rootParagraphFootnoteTargetDelta(owner, change.spans));
        }
        if (!this.emittedRootParagraphIds.has(owner.id)) {
          semanticPatches.push(this.rootParagraphInsertPatch(owner));
          this.emittedRootParagraphIds.add(owner.id);
        } else if (change.paragraph.revision !== previous.revision) {
          semanticPatches.push(rootParagraphAppendPatch(owner, appendChange));
        }
        const rootResumeFrom = appendChange.rootResumeFrom;
        if (rootResumeFrom !== undefined
          && !this.rootParagraphOwnersByStart.has(rootResumeFrom)
          && !this.rootCodeOwnersByStart.has(rootResumeFrom)
          && !this.rootTableOwnersByStart.has(rootResumeFrom)) {
          remainingRootFrom = remainingRootFrom === undefined
            ? rootResumeFrom
            : Math.min(remainingRootFrom, rootResumeFrom);
        }
      }

      const managedTailOffset = this.rootManagedTailOffset() ?? sourceLength;
      let tailOffset = Math.min(
        replacementRootFrom ?? sourceLength,
        remainingRootFrom ?? sourceLength,
        this.rootNativeFragmentOffset ?? sourceLength,
      );
      for (const block of this.blocks) {
        const from = block.payload.range?.from;
        if (!block.isFinalized && typeof from === "number" && from >= managedTailOffset) {
          tailOffset = Math.min(tailOffset, from);
        }
      }
      this.treeFragments = [];
      this.rootNativeFragmentOffset = tailOffset;
      for (const block of this.blocks) {
        const from = block.payload.range?.from;
        if (block.isFinalized || (typeof from === "number" && from >= tailOffset)) continue;
        semanticPatches.push({ op: "finalize", at: { blockId: block.id } });
      }
      await this.parseRootNativeTail(
        tailOffset,
        sourceLength,
        sourceLength,
        metricsCollector,
        true,
        semanticPatches,
        previousRootParagraphOwners,
        { deltas: finalizedParagraphTargets, rebuild: false },
      );
      for (const owner of ownersToDecorate) {
        const decorationPatch = await this.decorateRootCode(owner, true);
        const patches: Patch[] = [];
        if (decorationPatch) patches.push(decorationPatch);
        patches.push(...this.rootCodePresentationPatches(owner));
        this.dispatchPatchBatch(patches, metricsCollector);
      }
      metricsCollector.setBlocksProduced(this.blocks.length);
    } else {
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

      const source = this.sourceDocument.snapshot();
      const content = source.materialize();
      const { blocks: reparsedBlocks, lastTree: reparsedTree } = await this.parseAll(content, { forceFinalize: true, admitRootTableOwners: true });
      const mdxState = this.engineMdxState();
      for (const block of reparsedBlocks) {
        block.isFinalized = true;
        await updateMdxCompilationState(mdxState, block);
      }

      this.blocks = reparsedBlocks;
      this.lastTree = reparsedTree;
      this.treeFragments = TreeFragment.addTree(reparsedTree);
      metricsCollector.setBlocksProduced(this.blocks.length);
      for (const owner of this.rootTableOwners) {
        if (!this.emittedRootTableIds.has(owner.id)) {
          finalizePatches.push(this.rootTableInsertPatch(owner));
          this.emittedRootTableIds.add(owner.id);
        }
      }
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.campaignCounters?.isProgressTraceEnabled?.()) {
        progressPublication = this.createProgressPublication(sourceLength);
      }

      const fullRange = [
        {
          fromA: 0,
          toA: sourceLength,
          fromB: 0,
          toB: sourceLength,
        },
      ];
      this.parseEpochCounter += 1;
      const finalParseEpoch = this.parseEpochCounter;
      await this.emitBlockDiffPatches(
        prevBlocks,
        this.blocks,
        fullRange,
        metricsCollector,
        progressPublication,
        finalParseEpoch,
        finalizePatches,
      );
      if (finalizePatches.length > 0 && this.rootTableOwners.length === 0) {
        await this.dispatchFinalCanonicalSnapshot(this.blocks, progressPublication);
      }
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
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && progressPublication) {
      this.recordParsedProgressPublication(progressPublication);
    }

    reportWorkerStructuralInvariantViolations("finalizeAllBlocks", this.blocks, this.lastWorkerInvariantSignature);
    this.post({
      type: "FINALIZED",
      generation: this.documentGeneration,
    });

    if (this.activeMetricsCollector === metricsCollector) {
      this.activeMetricsCollector = null;
    }
  }

  private async dispatchFinalCanonicalSnapshot(
    finalBlocks: Block[],
    progressPublication?: ProgressPublicationContext,
  ): Promise<void> {
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
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && progressPublication) {
      this.tagSemanticPatchesForProgress(patches, progressPublication);
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
          const segmentText = segmentLines.join("\n");
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordTokenization(segmentLines.length, segmentText.length, "engine");
          }
          const tokens = this.highlighter.codeToTokensWithThemes(segmentText, {
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
    const prevSnapshot = (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) && this.campaignCounters
      ? (createBlockSnapshot as (b: Block, cb?: (n: NodeSnapshot) => void) => NodeSnapshot)(
          root,
          () => this.campaignCounters?.recordSnapshotNodes(1, "snapshot"),
        )
      : createBlockSnapshot(root);
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
    const nextSnapshot = (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) && this.campaignCounters
      ? (createBlockSnapshot as (b: Block, cb?: (n: NodeSnapshot) => void) => NodeSnapshot)(
          updatedRoot,
          () => this.campaignCounters?.recordSnapshotNodes(1, "snapshot"),
        )
      : createBlockSnapshot(updatedRoot);

    const patches: Patch[] = [];
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.campaignCounters) {
      diffNodeSnapshot(updatedRoot.id, prevSnapshot, nextSnapshot, patches, metricsCollector, this.campaignCounters);
    } else {
      diffNodeSnapshot(updatedRoot.id, prevSnapshot, nextSnapshot, patches, metricsCollector);
    }
    if (patches.length > 0) {
      this.dispatchPatchBatch(withPatchKindBatch(patches, "enrichment"), metricsCollector);
    } else {
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
