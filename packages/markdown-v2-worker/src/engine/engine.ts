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
  recordDocumentRecordsVisited(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
}

import { type Input, type SyntaxNode, type Tree, TreeFragment } from "@lezer/common";
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
  NativeSourceMapping,
  NativeNestedChildIdentityFactory,
  NativeNestedLeafFactory,
  NativeNestedLeafKind,
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
  TableBlockSnapshot,
  TableCellRecord,
  ContentPolicy,
  RestrictedComponentDescriptor,
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
  prepareNestedBlockSnapshotFromNative,
  createBlockCompatibilityExtension,
  collectLinkReferences,
  diffLinkReferences,
  extractMixedContentSegmentsWithLookahead,
  prepareTrustedMdxInlineNodes,
  generateBlockId,
  inlineNodesToPlainText,
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
  FootnotesPlugin,
  DocumentPluginRegistry,
  type DocumentPlugin,
  type DocumentState,
  type FootnoteParagraphTargetBridge,
  type FootnoteParagraphTargetDelta,
  type FootnoteParagraphTargetUpdate,
  HTMLBlockPlugin,
  MDXDetectionPlugin,
  TablesPlugin,
  registerFootnotesPlugin,
} from "@stream-mdx/plugins";
import { isBlockLevelNode, mapLezerNodeToBlockType } from "../parser/block-types";
import { HtmlContinuationExtension } from "../parser/html-extension";
import { FOOTNOTE_DEFINITION_START, FootnoteDefinitionInterruptExtension } from "../parser/footnote-definition-extension";
import {
  applyHtmlTagBalance,
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
  createTocPatch,
  getNativeHeadingContentRange,
  maybeBuildTocPatch,
  parseGfmTableFromTree,
  reportWorkerStructuralInvariantViolations,
  slugifyHeading,
  tocHeadingForBlock,
  tocSignatureFor,
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
import {
  NativeNestedCodeSourceOwner,
  type NativeNestedCodeSourceMapping,
} from "./native-nested-code-owner";
import {
  NATIVE_CONTAINER_TAIL_VANISHED,
  NativeContainerTailParser,
  type NativeContainerTailChange,
  type NativeContainerTailResult,
} from "./native-container-tail";
import {
  nativeParagraphSourceContext,
  nativeParagraphSpaceTabIndentationRangesFromInput,
  readNativeParagraphSourceTextReader,
  type NativeParagraphSourceContext,
  type NativeParagraphSourceTextReader,
} from "./native-paragraph-source";
import { NativeMarkdownInput } from "./native-markdown-input";
import {
  advanceNativeNestedTableOwner,
  createNativeNestedTableOwner,
  createRootTableOwners,
  rootTableAppendChange,
  rootTableAppendPatch,
  rootTableNodeSnapshot,
  rootTableSemanticPatch,
  type RootTablePatchChange,
} from "./root-table-pipeline";
import type { NativeTableExtensionContext } from "./native-table-row-classifier";
import { RootTableSourceOwner, type RootTableFootnoteProjection } from "./root-table-owner";
import { parseTableCellInline } from "./table-cell-inline";
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
  type RootParagraphPipelineOptions,
} from "./root-paragraph-pipeline";
import {
  attestNativeParagraphWindowGrammar,
  type NativeParagraphWindowAttestation,
} from "./native-paragraph-tail";
import {
  RootParagraphSourceOwner,
  type ParagraphInlineSettlementMode,
  type ParagraphSourceTransition,
  type PreparedParagraphSpanContent,
  type RootParagraphSourceChange,
} from "./root-paragraph-owner";
import {
  countChangedBlocksFromPatches,
  dedupeSetPropsByTargetKeepingLatest,
  diffNodeSnapshot,
  ensureAnnotatedPatchBatch,
  estimatePatchSize,
  partitionPatchesForCredits,
  syncEmittedBlockEpochsFromPatches,
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
  ParseOptions,
  ShikiThemedToken,
} from "./types";
type WorkerFootnoteParagraphTargetBridge = FootnoteParagraphTargetBridge & {
  readonly retainedGenericSourceBefore?: number;
  readonly noFootnoteArtifactsForSource?: SourceSnapshot;
  readonly hasNativeTargets?: boolean;
  readonly recordDocumentRecordsVisited?: (count: number) => void;
};

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
/** A CommonMark list item marker at the start of a line's content. */
const LIST_ITEM_START = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t\r\n]|$)/;
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

function rootBlockSourceFrom(block: Block): number {
  return block.payload.range?.from ?? Number.POSITIVE_INFINITY;
}

function addNativeOwnerIdToContainer(
  ownerIdsByContainer: Map<string, Set<string>>,
  ownerId: string,
  containerId: string,
  previousContainerId?: string,
): void {
  if (previousContainerId !== undefined && previousContainerId !== containerId) {
    removeNativeOwnerIdFromContainer(ownerIdsByContainer, ownerId, previousContainerId);
  }
  let ownerIds = ownerIdsByContainer.get(containerId);
  if (!ownerIds) {
    ownerIds = new Set();
    ownerIdsByContainer.set(containerId, ownerIds);
  }
  ownerIds.add(ownerId);
}

function removeNativeOwnerIdFromContainer(
  ownerIdsByContainer: Map<string, Set<string>>,
  ownerId: string,
  containerId: string,
): void {
  const ownerIds = ownerIdsByContainer.get(containerId);
  if (!ownerIds) return;
  ownerIds.delete(ownerId);
  if (ownerIds.size === 0) ownerIdsByContainer.delete(containerId);
}

function rootOwnerSourceFrom(owner: RootCodeSourceOwner | RootTableSourceOwner | RootParagraphSourceOwner): number {
  return owner.getMetadata().sourceRange.from;
}

/** Source-ordered root families retain their prefix when only the native tail is reparsed. */
function rootSourceBoundary<T>(
  entries: readonly T[],
  from: number,
  sourceFrom: (entry: T) => number,
  counters?: CampaignCounterSink,
  knownBoundary?: number,
): number {
  if (from <= 0) return 0;
  if (knownBoundary !== undefined && Number.isSafeInteger(knownBoundary)
    && knownBoundary >= 0 && knownBoundary <= entries.length) {
    let boundaryIsValid = true;
    if (knownBoundary > 0) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        counters?.recordPrefixComparisons(1, "engine");
        counters?.recordDocumentRecordsVisited(1, "engine");
      }
      if (sourceFrom(entries[knownBoundary - 1]) >= from) boundaryIsValid = false;
    }
    if (boundaryIsValid && knownBoundary < entries.length) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        counters?.recordPrefixComparisons(1, "engine");
        counters?.recordDocumentRecordsVisited(1, "engine");
      }
      if (sourceFrom(entries[knownBoundary]) < from) boundaryIsValid = false;
    }
    if (boundaryIsValid) return knownBoundary;
  }
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons(1, "engine");
    }
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordDocumentRecordsVisited(1, "engine");
    }
    if (sourceFrom(entries[middle]) < from) low = middle + 1;
    else high = middle;
  }
  return low;
}

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

function hasSourceAfterRange(source: SourceText, to: number): boolean {
  const remaining = sourceLength(source) - to;
  return remaining > 1
    && !(remaining === 2 && sourceCharAt(source, to) === "\r" && sourceCharAt(source, to + 1) === "\n");
}

/**
 * A table ends only at a complete following line. Until that line's ending arrives it may still become a row: a
 * bare `>` or indent reads as a blank line, `-` or `#` as a block start.
 */
function hasCompleteLineAfterRange(source: SourceText, to: number): boolean {
  const length = sourceLength(source);
  let cursor = to;
  while (cursor < length && sourceCharAt(source, cursor) !== "\n" && sourceCharAt(source, cursor) !== "\r") cursor += 1;
  if (cursor >= length) return false;
  cursor += sourceCharAt(source, cursor) === "\r" && sourceCharAt(source, cursor + 1) === "\n" ? 2 : 1;
  for (; cursor < length; cursor += 1) {
    const char = sourceCharAt(source, cursor);
    if (char === "\n" || char === "\r") return true;
  }
  return false;
}

function managedTableSourceFrontierChanged(previous: Block, next: Block): boolean {
  if (previous.id !== next.id || previous.type !== "table" || next.type !== "table") return false;
  const before = previous.payload.meta?.table as TableBlockSnapshot | undefined;
  const after = next.payload.meta?.table as TableBlockSnapshot | undefined;
  if (
    !before ||
    !after ||
    before.tableOwnerId !== previous.id ||
    after.tableOwnerId !== next.id ||
    before.generation !== after.generation ||
    before.revision !== after.revision ||
    before.rowCount !== 0 ||
    after.rowCount !== 0 ||
    before.completeRowCount !== 0 ||
    after.completeRowCount !== 0 ||
    before.rows.length !== 0 ||
    after.rows.length !== 0
  ) return false;
  return before.raw !== after.raw ||
    before.state !== after.state ||
    before.processedTo !== after.processedTo ||
    before.completeRowCount !== after.completeRowCount ||
    before.rowCount !== after.rowCount ||
    before.sourceRange.from !== after.sourceRange.from ||
    before.sourceRange.to !== after.sourceRange.to ||
    before.header.sourceRange.from !== after.header.sourceRange.from ||
    before.header.sourceRange.to !== after.header.sourceRange.to;
}

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

type RootHeadingFrontierEntry = {
  readonly sourceFrom: number;
  readonly baseSlug: string;
  readonly heading: TocHeading;
  readonly blockIndex: number;
};

type LookaheadContainerContext = InlineLookaheadPrepareResult["container"];
type LookaheadDecisionTrace = InlineLookaheadPrepareResult["trace"][number];

type InlineStreamingParseResult = {
  inline: InlineNode[];
  status: InlineStreamingInlineStatus;
  lookahead: LookaheadDecisionTrace[];
  containerSignature: string;
};

function nativeEmptyParagraphBoundary(
  source: SourceSnapshot,
  range: { readonly from: number; readonly to: number },
): { readonly from: number; readonly to: number } {
  if (range.from !== range.to) return range;
  let cursor = range.to;
  while (cursor < source.length) {
    const end = Math.min(source.length, cursor + 128);
    const text = source.read(cursor, end);
    for (let offset = 0; offset < text.length; offset += 1) {
      const unit = text.charCodeAt(offset);
      if (unit === 10 || unit === 13) {
        const boundary = cursor + offset;
        return { from: boundary, to: boundary };
      }
      if (unit !== 32 && unit !== 9) return range;
    }
    cursor = end;
  }
  return { from: cursor, to: cursor };
}
function nativeCodeEventsInTail(root: SyntaxNode, prefixLength: number): readonly SyntaxNode[] {
  const events: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.to >= prefixLength && (node.type.name === "CodeText" || node.type.name === "CodeMark")) {
      events.push(node);
    }
    for (let child = node.firstChild; child; child = child.nextSibling) stack.push(child);
  }
  return events;
}


function nativeCodeEventsAfter(
  node: SyntaxNode,
  mapping: NativeNestedCodeSourceMapping,
  sourceTo: number,
): SyntaxNode[] {
  const events: SyntaxNode[] = [];
  for (let child = node.lastChild; child; child = child.prevSibling) {
    if (child.type.name !== "CodeText" && child.type.name !== "CodeMark") continue;
    const range = mapping.mapRange?.(child.from, child.to)
      ?? { from: mapping.mapOffset(child.from), to: mapping.mapOffset(child.to) };
    if (range.to <= sourceTo) break;
    events.push(child);
  }
  events.reverse();
  return events;
}



interface NativeFenceHeaderFrontier {
  generation: number;
  document: AppendSourceDocument;
  markerFrom: number;
  scannedTo: number;
  complete: boolean;
}

function nativeFenceHeaderComplete(
  node: SyntaxNode,
  mapping: NativeSourceMapping,
  frontier: NativeFenceHeaderFrontier,
): boolean {
  const marker = node.getChild("CodeMark");
  if (!marker) return false;
  const markerFrom = mapping.mapOffset(marker.from);
  const info = node.getChild("CodeInfo");
  const infoEnd = mapping.mapOffset(info?.to ?? marker.to);
  if (frontier.markerFrom !== markerFrom) {
    frontier.markerFrom = markerFrom;
    frontier.scannedTo = infoEnd;
    frontier.complete = false;
  }
  if (frontier.complete) return true;
  let cursor = Math.max(frontier.scannedTo, infoEnd);
  while (cursor < mapping.source.length) {
    const end = Math.min(mapping.source.length, cursor + 256);
    const text = mapping.source.read(cursor, end);
    const ending = /[\r\n]/.exec(text);
    if (ending) {
      frontier.scannedTo = cursor + ending.index + 1;
      frontier.complete = true;
      return true;
    }
    cursor = end;
  }
  frontier.scannedTo = mapping.source.length;
  return false;
}


function sameNativeSyntaxNode(
  left: SyntaxNode,
  right: SyntaxNode,
  mapping: NativeSourceMapping,
): boolean {
  if (left.type.name !== right.type.name) return false;
  const leftRange = mapping.mapRange?.(left.from, left.to)
    ?? { from: mapping.mapOffset(left.from), to: mapping.mapOffset(left.to) };
  const rightRange = mapping.mapRange?.(right.from, right.to)
    ?? { from: mapping.mapOffset(right.from), to: mapping.mapOffset(right.to) };
  return leftRange.from === rightRange.from && leftRange.to === rightRange.to;
}


function stripNativeBlockProps(snapshot: NodeSnapshot): void {
  const props = snapshot.props;
  if (props && "block" in props) {
    const block = props.block as Block | undefined;
    // A closed code owner's presentation (diff blocks, lazy state) is consumer output; open code keeps its lines only.
    const ownsClosedCodePresentation = snapshot.type === "code" && block?.type === "code" && block.isFinalized;
    if (!ownsClosedCodePresentation) {
      const { block: _block, ...retained } = props;
      snapshot.props = Object.keys(retained).length > 0 ? retained : undefined;
    }
  }
  for (const child of snapshot.children ?? []) stripNativeBlockProps(child);
}


function cloneNativeSnapshot(snapshot: NodeSnapshot): NodeSnapshot {
  const cloneValue = <T>(value: T): T => {
    const clone = globalThis.structuredClone;
    if (typeof clone === "function") {
      try {
        return clone(value);
      } catch {
        // Match the core's JSON-safe transport fallback for public snapshots.
      }
    }
    return JSON.parse(JSON.stringify(value)) as T;
  };
  return {
    ...snapshot,
    ...(snapshot.props ? { props: cloneValue(snapshot.props) } : {}),
    ...(snapshot.children ? { children: snapshot.children.map(cloneNativeSnapshot) } : {}),
    ...(snapshot.range ? { range: { ...snapshot.range } } : {}),
    ...(snapshot.meta ? { meta: cloneValue(snapshot.meta) } : {}),
    ...(snapshot.code ? { code: cloneValue(snapshot.code) } : {}),
    ...(snapshot.table ? { table: cloneValue(snapshot.table) } : {}),
    ...(snapshot.paragraph ? { paragraph: cloneValue(snapshot.paragraph) } : {}),
    ...(snapshot.inputSource ? { inputSource: cloneValue(snapshot.inputSource) } : {}),
  };
}


function activeChildIndex(
  children: readonly NodeSnapshot[],
  frame: NativeContainerTailChange["frames"][number],
  counters?: CampaignCounterSink,
): number {
  const indexed = children[frame.fromChild];
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    counters?.recordPrefixComparisons(1, "engine");
  }
  if (indexed?.range?.from === frame.sourceFrontier) return frame.fromChild;
  return typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? childAtSourceStart(children, frame.sourceFrontier, counters)
    : childAtSourceStart(children, frame.sourceFrontier);
}


function mutableNativeOwnerSnapshot(snapshot: NodeSnapshot, range: { readonly from: number; readonly to: number }): NodeSnapshot {
  return {
    ...snapshot,
    ...(snapshot.props ? { props: { ...snapshot.props } } : {}),
    range: { ...range },
  };
}


function nativeNodePropsWithoutBlock(snapshot: NodeSnapshot): Record<string, unknown> | undefined {
  const props = snapshot.props;
  if (!props || !("block" in props)) return props;
  const { block: _block, ...retained } = props;
  return Object.keys(retained).length > 0 ? retained : undefined;
}


function nativePropsPatch(
  previous: Readonly<Record<string, unknown>> | undefined,
  next: Readonly<Record<string, unknown>> | undefined,
  range: { readonly from: number; readonly to: number } | undefined,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next ?? {})) props[key] = value;
  for (const key of Object.keys(previous ?? {})) {
    if (!(key in (next ?? {}))) props[key] = undefined;
  }
  if (range) props.range = { ...range };
  return props;
}


function sameNativeRangeStart(left: NodeSnapshot, right: NodeSnapshot): boolean {
  return left.range?.from !== undefined && left.range.from === right.range?.from;
}




function nativeSegmentIndex(id: string): number | undefined {
  const match = /::list-item:segment:(\d+)$/.exec(id);
  return match ? Number(match[1]) : undefined;
}




function updateNativeSnapshotFields(current: NodeSnapshot, incoming: NodeSnapshot): boolean {
  const nextProps = nativeNodePropsWithoutBlock(incoming);
  const propsChanged = !shallowRecordEqual(current.props, nextProps);
  const rangeChanged = current.range?.from !== incoming.range?.from
    || current.range?.to !== incoming.range?.to;
  const codeOwnershipChanged = Boolean(current.code) !== Boolean(incoming.code);
  const tableChanged = Boolean(current.table) !== Boolean(incoming.table);
  const paragraphChanged = Boolean(current.paragraph) !== Boolean(incoming.paragraph);
  if (propsChanged) current.props = nextProps ? { ...nextProps } : undefined;
  if (incoming.range) current.range = { ...incoming.range };
  else delete current.range;
  if (incoming.meta) current.meta = incoming.meta;
  else delete current.meta;
  if (incoming.code) current.code = incoming.code;
  else delete current.code;
  if (incoming.table) current.table = incoming.table;
  else delete current.table;
  if (incoming.paragraph) current.paragraph = incoming.paragraph;
  else delete current.paragraph;
  if (incoming.inputSource) current.inputSource = incoming.inputSource;
  else delete current.inputSource;
  return propsChanged || rangeChanged || codeOwnershipChanged || tableChanged || paragraphChanged;
}
function listItemPrimaryOwnerExtendsRange(previous: NodeSnapshot, next: NodeSnapshot): boolean {
  if (previous.type !== "list-item" || next.type !== "list-item") return false;
  const previousRange = previous.range;
  const nextRange = next.range;
  if (!previousRange || !nextRange
    || previousRange.from !== nextRange.from
    || previousRange.to >= nextRange.to) return false;
  const nextPrimary = next.children?.find((child) => child.props?.listItemPrimary === true);
  const previousPrimary = nextPrimary
    ? previous.children?.find((child) => child.id === nextPrimary.id)
    : undefined;
  const owner = nextPrimary?.paragraph;
  const previousOwner = previousPrimary?.paragraph;
  return owner !== undefined
    && previousOwner?.paragraphOwnerId === owner.paragraphOwnerId
    && previousOwner.generation === owner.generation
    && owner.sourceRange.from >= nextRange.from
    && owner.sourceRange.to === nextRange.to;
}





function preparedSnapshotAtId(children: readonly NodeSnapshot[], id: string): NodeSnapshot | undefined {
  for (const child of children) {
    if (child.id === id) return child;
    const nested = preparedSnapshotAtId(child.children ?? [], id);
    if (nested) return nested;
  }
  return undefined;
}


function replaceNativeSnapshotById(
  children: readonly NodeSnapshot[],
  targetId: string,
  replacement: NodeSnapshot,
): NodeSnapshot[] {
  let result = children as NodeSnapshot[];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    let next = child;
    if (child.id === targetId) {
      next = replacement;
    } else if (child.children) {
      const nested = replaceNativeSnapshotById(child.children, targetId, replacement);
      if (nested !== child.children) {
        let childTo = child.range?.to;
        if (child.range) {
          for (const nestedChild of nested) {
            if (nestedChild.range && nestedChild.range.from >= child.range.from) {
              childTo = Math.max(childTo ?? child.range.to, nestedChild.range.to);
            }
          }
        }
        const range = child.range && childTo !== undefined && childTo > child.range.to
          ? { ...child.range, to: childTo }
          : child.range;
        const nestedBlock = child.props?.block as Block | undefined;
        const nestedBlockRange = nestedBlock?.payload.range;
        const props = range && nestedBlock && nestedBlockRange && range.to > nestedBlockRange.to
          ? { ...child.props, block: { ...nestedBlock, payload: { ...nestedBlock.payload, range: { ...nestedBlockRange, to: range.to } } } }
          : child.props;
        next = {
          ...child,
          children: nested,
          ...(range !== child.range ? { range } : {}),
          ...(props !== child.props ? { props } : {}),
        };
      }
    }
    if (next !== child) {
      if (result === children) result = children.slice();
      result[index] = next;
    }
  }
  return result;
}





function childIndexFromSnapshotId(id: string): number | undefined {
  const match = /:(\d+)$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

function childAtSourceStart(
  children: readonly NodeSnapshot[],
  from: number,
  counters?: CampaignCounterSink,
): number {
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const start = children[middle]?.range?.from ?? Number.POSITIVE_INFINITY;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons(1, "engine");
    }
    if (start < from) low = middle + 1;
    else high = middle;
  }
  return low;
}
function nativeNestedSnapshotType(typeName: string): string {
  if (typeName === "BulletList" || typeName === "OrderedList") return "list";
  if (typeName === "Blockquote") return "blockquote";
  if (typeName === "Table") return "table";
  if (typeName === "FencedCode" || typeName === "CodeBlock" || typeName === "IndentedCode") return "code";
  if (typeName.startsWith("ATXHeading") || typeName.startsWith("SetextHeading")) return "heading";
  if (typeName === "HorizontalRule") return "hr";
  if (typeName === "HTMLBlock" || typeName === "CommentBlock" || typeName === "ProcessingInstructionBlock") {
    return "html";
  }
  return "paragraph";
}



function shallowRecordEqual(
  left: Readonly<Record<string, unknown>> | undefined,
  right: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

interface NativePreparedActivePath {
  readonly snapshots: readonly NodeSnapshot[];
  readonly pathNodes: readonly (Block | NodeSnapshot)[];
}

function shallowNativeSnapshot(snapshot: NodeSnapshot): NodeSnapshot {
  const { children: _children, ...active } = snapshot;
  return active;
}

function preparedNativeActivePath(
  prepared: PreparedNestedSnapshot,
  block: Block,
  frames: NativeContainerTailChange["frames"],
  counters?: CampaignCounterSink,
): NativePreparedActivePath {
  const snapshots: NodeSnapshot[] = [{
    id: block.id,
    type: block.type,
    props: prepared.props,
    ...(block.payload.range ? { range: { ...block.payload.range } } : {}),
  }];
  const pathNodes: (Block | NodeSnapshot)[] = [block];
  let children = prepared.children;
  for (const frame of frames) {
    const activeIndex = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? activeChildIndex(children, frame, counters)
      : activeChildIndex(children, frame);
    const active = children[activeIndex];
    if (!active || active.range?.from !== frame.sourceFrontier) break;
    snapshots.push(shallowNativeSnapshot(active));
    pathNodes.push(active);
    children = active.children ?? [];
  }
  return {
    snapshots: Object.freeze(snapshots),
    pathNodes: Object.freeze(pathNodes),
  };
}
type NativeListProperties = NativeContainerTailChange["listProperties"][number];
type NativeNestedContainerMapping = NativeNestedCodeSourceMapping & {
  knownListLoosenessForNode?(node: SyntaxNode): boolean | undefined;
};

function nativeListPropertiesRecord(
  previous: Readonly<Record<string, unknown>> | undefined,
  properties: NativeListProperties,
): Record<string, unknown> {
  const result = { ...(previous ?? {}) };
  result.ordered = properties.typeName === "OrderedList";
  result.loose = properties.loose;
  if (properties.orderedStart !== undefined && properties.orderedStart !== 1) {
    result.start = properties.orderedStart;
  } else {
    delete result.start;
  }
  return result;
}


function nativeListSnapshotAtPath(
  active: NativePreparedActivePath,
  block: Block,
  pathIndex: number,
): NodeSnapshot | undefined {
  if (pathIndex === 0 && block.type === "list") return active.snapshots[0];
  const target = active.pathNodes[pathIndex];
  return target && !("payload" in target) && target.type === "list" ? target : undefined;
}



function rootNativeOwnerStartsInsideOpenHtml(
  tree: Tree,
  source: SourceSnapshot,
  sourceOffset: number,
  parser: typeof mdParser,
  mdxComponents: boolean,
  nestedNativeContainerStarts: Set<number>,
  htmlDependentStarts: Set<number>,
  paragraphHasHtml: (raw: string) => boolean,
): void {
  const stack: string[] = [];
  const cursor = tree.cursor();
  if (!cursor.firstChild()) return;
  do {
    const globalFrom = cursor.from + sourceOffset;
    if (cursor.type.name === "FencedCode") {
      if (stack.length > 0) htmlDependentStarts.add(globalFrom);
    } else if (cursor.type.name === "HTMLBlock") {
      applyHtmlTagBalance(source.read(globalFrom, cursor.to + sourceOffset), parser, stack, mdxComponents);
    } else if (cursor.type.name === "Paragraph") {
      const raw = source.read(globalFrom, cursor.to + sourceOffset);
      if (stack.length > 0 || (raw.includes("<") && paragraphHasHtml(raw))) htmlDependentStarts.add(globalFrom);
      applyHtmlTagBalance(raw, parser, stack, mdxComponents);
    } else if (cursor.type.name === "Table") {
      if (stack.length > 0) htmlDependentStarts.add(globalFrom);
    } else if (mdxComponents && ["BulletList", "OrderedList", "Blockquote"].includes(cursor.type.name) && stack.length > 0) {
      if (/^[A-Z]/.test(stack[0] ?? "")) nestedNativeContainerStarts.add(globalFrom);
      applyHtmlTagBalance(source.read(globalFrom, cursor.to + sourceOffset), parser, stack, true);
    }
  } while (cursor.nextSibling());
}

function isSingleNativeContainerBridge(
  source: SourceSnapshot,
  from: number,
  to: number,
): boolean {
  if (to < from) return false;
  if (from === to) {
    const previousUnit = source.read(Math.max(0, from - 1), from);
    return previousUnit === "\r" || previousUnit === "\n";
  }
  let cursor = from;
  const first = source.read(cursor, Math.min(to, cursor + 2));
  if (first.startsWith("\r\n")) cursor += 2;
  else if (first.startsWith("\r") || first.startsWith("\n")) cursor += 1;
  else return false;
  let indentation = 0;
  while (cursor < to && indentation < 3 && source.read(cursor, cursor + 1) === " ") {
    cursor += 1;
    indentation += 1;
  }
  return cursor === to;
}

function appendFragmentChange(
  source: SourceSnapshot,
  inputOffset: number,
  oldLength: number,
  newLength: number,
  restartFrom = oldLength,
): { fromA: number; toA: number; fromB: number; toB: number } {
  let from = Math.max(inputOffset, Math.min(oldLength, restartFrom));
  if (oldLength > inputOffset
    && newLength > oldLength
    && source.read(oldLength - 1, oldLength) === "\r"
    && source.read(oldLength, oldLength + 1) === "\n") {
    from = Math.min(from, oldLength - 1);
  }
  return {
    fromA: from - inputOffset,
    toA: oldLength - inputOffset,
    fromB: from - inputOffset,
    toB: newLength - inputOffset,
  };
}

function nativeOwnerGeneration(root: NodeSnapshot): number | undefined {
  return root.code?.generation ?? root.table?.generation ?? root.paragraph?.generation;
}

function nativeOwnerType(root: NodeSnapshot): "code" | "table" | "paragraph" | undefined {
  if (root.code) return "code";
  if (root.table) return "table";
  if (root.paragraph) return "paragraph";
  return undefined;
}

function isCustomDocumentPlugin(plugin: DocumentPlugin): boolean {
  return plugin !== FootnotesPlugin
    && plugin !== TablesPlugin
    && plugin !== CalloutsPlugin
    && plugin !== HTMLBlockPlugin
    && plugin !== MDXDetectionPlugin;
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
  // Root owners still in flight or not yet represented in the public root store.
  private readonly pendingRootCodeOwners = new Set<RootCodeSourceOwner>();
  private readonly pendingRootTableOwners = new Set<RootTableSourceOwner>();
  private readonly pendingRootParagraphOwners = new Set<RootParagraphSourceOwner>();
  private readonly openRootCodeOwners = new Set<RootCodeSourceOwner>();
  private readonly openRootTableOwners = new Set<RootTableSourceOwner>();
  private readonly openRootParagraphOwners = new Set<RootParagraphSourceOwner>();
  private readonly rootParagraphOwnersById = new Map<string, RootParagraphSourceOwner>();
  private readonly rootParagraphOwnersByStart = new Map<number, RootParagraphSourceOwner>();
  private readonly emittedRootParagraphIds = new Set<string>();
  private pendingRootParagraphPatches: Patch[] = [];
  private readonly rootTableOwnersByStart = new Map<number, RootTableSourceOwner>();
  private readonly emittedRootTableIds = new Set<string>();
  private pendingRootTablePatches: Patch[] = [];
  private rootNativeFragmentOffset: number | null = null;
  private readonly rootCodeOwnersByStart = new Map<number, RootCodeSourceOwner>();
  private readonly emittedRootCodeIds = new Set<string>();
  private readonly nativeContainerTails = new Map<string, NativeContainerTailParser>();
  private readonly nativeContainerSourceStarts = new Map<string, number>();
  private readonly nestedCodeOwnerIdsByContainer = new Map<string, Set<string>>();
  private readonly unfinishedNestedCodeOwnerIds = new Set<string>();
  private readonly nestedTableOwnerIdsByContainer = new Map<string, Set<string>>();
  private readonly unfinishedNestedTableOwnerIds = new Set<string>();
  private readonly nestedParagraphOwnerIdsByContainer = new Map<string, Set<string>>();
  private readonly unfinishedNestedParagraphOwnerIds = new Set<string>();
  private readonly nativeContainerActiveSnapshots = new Map<string, NodeSnapshot>();
  private readonly nativeContainerActivePathSnapshots = new Map<string, readonly NodeSnapshot[]>();
  private readonly nativeContainerActivePathFrames = new Map<string, NativeContainerTailChange["frames"]>();
  private readonly nativeFenceHeaderFrontiers = new Map<string, NativeFenceHeaderFrontier>();
  private readonly nestedCodeOwners = new Map<string, NativeNestedCodeSourceOwner>();
  private readonly activeNestedCodeByContainer = new Map<string, string>();
  private readonly nestedTableOwners = new Map<string, RootTableSourceOwner>();
  private readonly nestedTableOwnerContainers = new Map<string, string>();
  private readonly activeNestedTableByContainer = new Map<string, string>();
  private readonly nestedParagraphOwners = new Map<string, RootParagraphSourceOwner>();
  private readonly nestedParagraphOwnerContainers = new Map<string, string>();
  private readonly pendingFootnoteParagraphOwnerRemovals = new Set<string>();
  private readonly nestedParagraphFootnoteTargetOwnerIds = new Set<string>();
  private readonly activeNestedParagraphByContainer = new Map<string, string>();
  private pendingNativeNestedPatches: Patch[] = [];
  private pendingNativeNestedOwnerPatches: Patch[] = [];
  private nestedLeaseGeneration = 0;
  private readonly rootCodeHighlighter = new RootCodeHighlighter();
  private rootCodeConfigurationRevision = 0;
  private rootNativeOwnerGeneration = 0;
  private documentGeneration = 0;
  private admittedSourceUnits = 0;

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
  private rootHeadingFrontier: RootHeadingFrontierEntry[] = [];
  private rootHeadingCountOffsets = new Map<string, number[]>();
  private rootHeadingFrontierGeneration = -1;
  private rootHeadingFrontierSourceLength = -1;
  private rootHeadingFrontierValid = false;
  private rootHeadingIdCountOverrides: Map<string, number> | null = null;
  private rootHeadingIdCountBoundary = 0;

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

    this.buildMarkdownParser(true, true);

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

  private getActiveContentComponents(): ReadonlyMap<string, RestrictedComponentDescriptor> | undefined {
    return this.mdxEnabled ? this.contentComponents : undefined;
  }

  /**
   * Trusted MDX and registered restricted components bind their regions to block-path source,
   * so native root and container owners decline and the base block path prepares the document.
   */
  /** Restricted mixed content admits only registered component names; trusted MDX admits any. */
  private rootMixedComponentAllowlist(): Iterable<string> | undefined {
    if (!this.mdxEnabled) return [];
    const components = this.getActiveContentComponents();
    return this.contentPolicy === "trusted-mdx" || !components || components.size === 0 ? undefined : components.keys();
  }

  private nativeOwnershipDeclinedByContentPolicy(): boolean {
    if (this.contentPolicy === "trusted-mdx") return true;
    const components = this.getActiveContentComponents();
    return this.contentPolicy === "restricted" && components !== undefined && components.size > 0;
  }

  private buildMarkdownParser(tables: boolean, footnotes: boolean): void {
    const gfm = tables ? GFM : GFM.filter((extension) => extension !== Table);
    this.mdParser = mdParser.configure([
      gfm,
      createBlockCompatibilityExtension(() => this.contentPolicy === "restricted" ? this.getActiveContentComponents() : undefined),
      HtmlContinuationExtension,
      ...(footnotes ? [FootnoteDefinitionInterruptExtension] : []),
      ...(this.extensions?.markdown ?? []),
    ]);
    const customMarkdownExtensions = this.extensions?.markdown ?? [];
    this.rootParagraphWindowAttestation = customMarkdownExtensions.length === 0
      ? attestNativeParagraphWindowGrammar(this.mdParser, {
          tablesEnabled: tables,
          blockCompatibility: true,
          htmlContinuation: true,
          footnoteDefinitionInterrupts: footnotes,
          customMarkdownExtensions,
        })
      : undefined;
  }

  private rootParagraphOwnershipSupported(): boolean {
    return Boolean(this.rootParagraphWindowAttestation)
      && (this.extensions?.documentPlugins?.length ?? 0) === 0
      && (this.extensions?.inline?.length ?? 0) === 0
      && this.syntaxRules.length === 0
      && !this.nativeOwnershipDeclinedByContentPolicy();
  }

  private rootParagraphInlineSettlement(): ParagraphInlineSettlementMode {
    return (this.extensions?.inline?.length ?? 0) > 0 || this.syntaxRules.length > 0
      ? "original-context"
      : "native-tail";
  }

  private rootParagraphPipelineOptions(
    sourceOffset = 0,
    finalized = false,
  ): RootParagraphPipelineOptions {
    return {
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
    };
  }

  private rootParagraphContainsInlineHtml(raw: string): boolean {
    if (!raw.includes("<")) return false;
    return this.rootParagraphNodesContainInlineHtml(this.inlineParser.parse(raw, { cache: false }));
  }

  private rootParagraphNodesContainInlineHtml(nodes: readonly InlineNode[]): boolean {
    for (const node of nodes) {
      if (node.kind === "html") {
        if (!this.mdxEnabled || !/^<\/?[A-Z]/.test(node.openingRaw ?? node.raw)) return true;
      } else if ("children" in node && node.children
        && this.rootParagraphNodesContainInlineHtml(node.children)) {
        return true;
      }
    }
    return false;
  }

  private rootParagraphChangeContainsInlineHtml(
    change: RootParagraphSourceChange,
    source: SourceSnapshot,
    appendedText?: string,
  ): boolean {
    if (rootParagraphChangeNeedsReplacement(change)) return false;
    if (change.spans.some((span) => span.children?.some((child) => child.type === "paragraph-html")
      || this.rootParagraphNodesContainInlineHtml(span.nodes))) {
      return true;
    }
    // Settled spans miss HTML still in the provisional tail. Every raw inline HTML construct
    // (tag, comment, processing instruction, declaration, CDATA) completes with `>`, so on append
    // only a `>` can make the paragraph HTML-bearing; finalize checks unconditionally.
    if (appendedText !== undefined && !appendedText.includes(">")) return false;
    const { from, to } = change.paragraph.sourceRange;
    return this.rootParagraphContainsInlineHtml(source.read(from, to));
  }

  private admitRootParagraphOwners(
    tree: Tree,
    sourceOffset = 0,
    finalized = false,
    htmlDependentStarts?: ReadonlySet<number>,
  ): readonly RootParagraphSourceOwner[] {
    if (!this.rootParagraphOwnershipSupported()) return [];
    return createRootParagraphOwners(
      tree,
      this.sourceDocument,
      this.rootNativeOwnerGeneration,
      this.rootParagraphPipelineOptions(sourceOffset, finalized),
      htmlDependentStarts,
      this.rootParagraphOwnersByStart,
    );
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
        componentAllowlist: this.rootMixedComponentAllowlist(),
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
        props = { raw: segment.value };
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

  private clearNativeContainerOwnership(): void {
    this.nativeContainerTails.clear();
    this.nativeContainerSourceStarts.clear();
    this.nativeContainerActiveSnapshots.clear();
    this.nativeContainerActivePathSnapshots.clear();
    this.nativeContainerActivePathFrames.clear();
    this.nativeFenceHeaderFrontiers.clear();
    this.nestedCodeOwners.clear();
    this.nestedCodeOwnerIdsByContainer.clear();
    this.unfinishedNestedCodeOwnerIds.clear();
    this.activeNestedCodeByContainer.clear();
    this.nestedTableOwners.clear();
    this.nestedTableOwnerContainers.clear();
    this.nestedTableOwnerIdsByContainer.clear();
    this.unfinishedNestedTableOwnerIds.clear();
    this.activeNestedTableByContainer.clear();
    this.nestedParagraphOwners.clear();
    this.nestedParagraphOwnerIdsByContainer.clear();
    this.unfinishedNestedParagraphOwnerIds.clear();
    this.nestedParagraphOwnerContainers.clear();
    this.nestedParagraphFootnoteTargetOwnerIds.clear();
    this.pendingFootnoteParagraphOwnerRemovals.clear();
    this.activeNestedParagraphByContainer.clear();
    this.pendingNativeNestedPatches = [];
    this.pendingNativeNestedOwnerPatches = [];
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
    for (const key of Object.keys(this.documentPluginState)) {
      delete this.documentPluginState[key];
    }
    this.blocks = [];
    this.lastTree = null;
    this.treeFragments = [];
    this.rootNativeFragmentOffset = null;
    this.clearNativeContainerOwnership();
    for (const owner of this.rootParagraphOwners) releaseRootParagraphOwner(owner);
    this.sourceDocument = this.createSourceDocument();
    this.rootCodeOwners = [];
    this.rootParagraphOwners = [];
    this.rootParagraphOwnersByStart.clear();
    this.rootParagraphOwnersById.clear();
    this.emittedRootParagraphIds.clear();
    this.pendingRootParagraphPatches = [];
    this.rootCodeOwnersByStart.clear();
    this.emittedRootCodeIds.clear();
    this.rootTableOwners = [];
    this.rootTableOwnersByStart.clear();
    this.emittedRootTableIds.clear();
    this.pendingRootTablePatches = [];
    this.pendingRootCodeOwners.clear();
    this.pendingRootTableOwners.clear();
    this.pendingRootParagraphOwners.clear();
    this.openRootCodeOwners.clear();
    this.openRootTableOwners.clear();
    this.openRootParagraphOwners.clear();
    this.rootCodeHighlighter.clear();
    this.currentLinkReferences.clear();
    this.currentLinkReferenceStarts.clear();
    this.blockAttemptedReferences.clear();
    this.emittedBlockEpochs.clear();
    this.tocHeadings = [];
    this.headingIdCounts.clear();
    this.clearRootHeadingFrontier();
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.reset();
    }
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
          // dispose() during an awaited message clears document state; the abandoned message has no consumer.
          if (this.disposed) return;
          console.error("Worker error:", error);
          this.reportError(error, message.type, { phase: message.type });
        }
      })
      .catch((error) => {
        if (this.disposed) return;
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
          msg.syntax,
          msg.html,
          msg.themes ?? msg.docPlugins?.themes,
          msg.contentPolicy,
          msg.contentComponents,
        );
        return;
      case "APPEND":
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.campaignCounters?.isProgressTraceEnabled?.()) {
          this.campaignCounters.recordEngineEntered?.(this.documentGeneration, this.sourceDocument.length + msg.text.length);
        }
        await this.handleAppend(msg.text);
        this.admittedSourceUnits += msg.text.length;
        this.post({
          type: "SOURCE_ADMITTED",
          generation: this.documentGeneration,
          admittedSourceUnits: this.admittedSourceUnits,
        });
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
              && this.isCurrentRootCodeOwner(rootOwner),
          );
          if (!this.isCurrentRootCodeOwner(rootOwner)) return;
          const patch = rootCodeDecoratePatch(rootOwner, configurationRevision, decorations);
          const patches: Patch[] = [];
          const presentationMeta = rootOwner.getPresentation()?.meta;
          if (presentationMeta?.lazyTokenization === true && decorations.length > 0) {
            const lines = rootOwner.getLines();
            let tokenizedUntil = 0;
            while (tokenizedUntil < lines.length) {
              const line = lines.get(tokenizedUntil);
              if (line?.decoration?.configurationRevision !== configurationRevision) break;
              tokenizedUntil += 1;
            }
            rootOwner.updateLazyTokenizationPresentation(tokenizedUntil, decorations);
            if (presentationMeta.lazyTokenizedUntil !== tokenizedUntil) {
              patches.push({
                op: "setProps",
                at: { blockId: rootOwner.id },
                props: { meta: { lazyTokenizedUntil: tokenizedUntil } },
                meta: { kind: "enrichment" },
              });
            }
          }
          if (patch) patches.push(patch);
          if (patches.length > 0) this.dispatchPatchBatch(patches);
          return;
        }
        const nestedOwner = this.nestedCodeOwners.get(msg.blockId);
        if (nestedOwner) {
          const generation = this.documentGeneration;
          const ownerGeneration = nestedOwner.generation;
          const configurationRevision = this.rootCodeConfigurationRevision;
          const decorations = await this.rootCodeHighlighter.tokenizeRange(
            nestedOwner,
            msg.startLine,
            msg.endLine,
            this.rootCodeHighlightConfiguration(true),
            () => !this.disposed
              && generation === this.documentGeneration
              && ownerGeneration === nestedOwner.generation
              && nestedOwner.inputGeneration === generation
              && configurationRevision === this.rootCodeConfigurationRevision
              && this.nestedCodeOwners.get(nestedOwner.id) === nestedOwner,
          );
          const patches: Patch[] = [];
          const block = decorations.length > 0 ? this.refreshNativeNestedCodePresentation(nestedOwner) : undefined;
          if (block) {
            patches.push({
              op: "setProps",
              at: { blockId: nestedOwner.containerId, nodeId: nestedOwner.id },
              props: { block },
              meta: { kind: "enrichment" },
            });
          }
          const patch = nestedOwner.decoratePatch(configurationRevision, decorations);
          if (patch) patches.push(patch);
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
    this.admittedSourceUnits = 0;
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
    this.clearNativeContainerOwnership();
    this.nestedLeaseGeneration = 0;
    this.sourceDocument = this.createSourceDocument();
    this.rootNativeOwnerGeneration = this.documentGeneration;
    this.rootCodeOwners = [];
    this.rootCodeOwnersByStart.clear();
    this.emittedRootCodeIds.clear();
    this.rootTableOwners = [];
    this.rootTableOwnersByStart.clear();
    this.emittedRootTableIds.clear();
    this.pendingRootTablePatches = [];
    this.rootParagraphOwners = [];
    this.rootParagraphOwnersByStart.clear();
    this.rootParagraphOwnersById.clear();
    this.emittedRootParagraphIds.clear();
    this.pendingRootParagraphPatches = [];
    this.pendingRootCodeOwners.clear();
    this.pendingRootTableOwners.clear();
    this.pendingRootParagraphOwners.clear();
    this.openRootCodeOwners.clear();
    this.openRootTableOwners.clear();
    this.openRootParagraphOwners.clear();
    this.rootCodeHighlighter.clear();
    this.rootCodeConfigurationRevision += 1;
    this.deferredPatchQueue = [];
    this.emittedBlockEpochs = new Map();
    this.parseEpochCounter = 0;
    this.patchStreamSeq = 0;
    this.tocHeadings = [];
    this.tocSignature = "";
    this.clearRootHeadingFrontier();

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
    this.buildMarkdownParser(enable.tables, enable.footnotes);

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
          this.markRootCodeOwnerEmitted(owner);
        }
        for (const owner of tableOwners) this.markRootTableOwnerEmitted(owner);
        for (const owner of paragraphOwners) this.markRootParagraphOwnerEmitted(owner);
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
    const { patch: initialTocPatch, nextHeadings, nextSignature } = this.maybeBuildTocPatchForBlocks(this.blocks);
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
        const activeNativeContainer = this.openNativeContainerTail();
        if (activeNativeContainer) {
          await this.appendNativeContainerTail(activeNativeContainer, chunk, metricsCollector);
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
  private openNativeContainerTail(): {
    readonly block: Block;
    readonly tail: NativeContainerTailParser;
  } | undefined {
    if (!this.rootParagraphOwnershipSupported()) return undefined;
    const block = this.blocks[this.blocks.length - 1];
    if (!block || block.isFinalized || (block.type !== "list" && block.type !== "blockquote")) return undefined;
    const tail = this.nativeContainerTails.get(block.id);
    if (!tail || tail.state.phase !== "open" || tail.state.sourceLength !== this.sourceDocument.length) return undefined;
    // A nested paragraph can close at a chunk boundary while its enclosing list/quote tail remains open.
    return { block, tail };
  }

  private async appendNativeContainerTail(
    active: { readonly block: Block; readonly tail: NativeContainerTailParser },
    appendedText: string,
    metrics?: WorkerMetricsCollector,
  ): Promise<void> {
    const { block, tail } = active;
    const oldLength = this.sourceDocument.length;
    this.performanceTimer.mark("incremental-parse");
    metrics?.markParseStart();
    this.sourceDocument.append(appendedText);
    const source = this.sourceDocument.snapshot();
    const tailResult = tail.append(source, appendedText, source.length);
    const vanished = tailResult === NATIVE_CONTAINER_TAIL_VANISHED;
    const change = vanished ? undefined : tailResult;
    const engine = this;
    const hasNewLinkReference = (candidate: NativeContainerTailChange): boolean => {
      let found = false;
      candidate.tree.iterate({
        enter(node) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            engine.campaignCounters?.recordPrefixComparisons(1, "engine");
          }
          if (node.name !== "LinkReference") return;
          const range = candidate.window.mapping.mapRange(node.from, node.to);
          if (range.to > oldLength) found = true;
          return false;
        },
      });
      return found;
    };
    const splitFootnoteMarker = oldLength > 0
      && appendedText.startsWith("^")
      && source.read(oldLength - 1, oldLength) === "[";
    const requiresCanonicalParse = vanished
      || !change
      || change.closure !== "open"
      || appendedText.includes("[^")
      || appendedText.includes("&")
      || splitFootnoteMarker
      || hasNewLinkReference(change)
      || (appendedText.includes(">")
        && this.nativeContainerSourceHasHtml(source.read(change.sourceRange.from, change.sourceRange.to)));
    if (requiresCanonicalParse) {
      this.nativeContainerTails.delete(block.id);
      tail.clear();
      this.treeFragments = [];
      await this.appendAndReparse(appendedText, metrics, true, true);
      return;
    }

    const previousBlocks = this.blocks.slice();
    const changedBlocks = this.blocks.slice();
    const blockIndex = changedBlocks.length - 1;
    if (blockIndex < 0 || changedBlocks[blockIndex]?.id !== block.id) {
      throw new Error(`Native container ${block.id} is missing from the current block list`);
    }
    const previousBlock = changedBlocks[blockIndex]!;
    const changedBlock: Block = {
      ...previousBlock,
      payload: {
        ...previousBlock.payload,
        range: { ...change.sourceRange },
        meta: previousBlock.payload.meta ? { ...previousBlock.payload.meta } : undefined,
      },
      isFinalized: false,
    };
    changedBlocks[blockIndex] = changedBlock;
    this.deferredPatchQueue = [];
    await this.prepareNativeNestedChildren(changedBlock, undefined, [], change.rootNode, change);
    this.blocks = changedBlocks;
    this.treeFragments = [];
    pruneLazyTokenizationStates(this.lazyTokenizationStates, this.blocks);
    let progressPublication: ProgressPublicationContext | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined"
      && __STREAM_MDX_COUNTERS__
      && this.campaignCounters?.isProgressTraceEnabled?.()) {
      progressPublication = this.createProgressPublication(source.length);
    }
    const changeRanges: ContentChangeRange[] = appendedText.length > 0
      ? [{ fromA: oldLength, toA: oldLength, fromB: oldLength, toB: source.length }]
      : [];
    this.performanceTimer.measure("incremental-parse");
    metrics?.markParseEnd();
    metrics?.setBlocksProduced(this.blocks.length);
    await this.emitBlockDiffPatches(previousBlocks, changedBlocks, changeRanges, metrics, progressPublication);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined"
      && __STREAM_MDX_COUNTERS__
      && progressPublication) {
      this.recordParsedProgressPublication(progressPublication);
    }
  }
  private registerRootCodeOwners(owners: readonly RootCodeSourceOwner[]): void {
    for (const owner of owners) {
      const from = owner.getMetadata().sourceRange.from;
      if (this.rootCodeOwnersByStart.has(from)) continue;
      this.rootCodeOwnersByStart.set(from, owner);
      const last = this.rootCodeOwners[this.rootCodeOwners.length - 1];
      if (!last || last.getMetadata().sourceRange.from < from) {
        this.rootCodeOwners.push(owner);
      } else {
        let low = 0;
        let high = this.rootCodeOwners.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          const middleFrom = this.rootCodeOwners[middle]?.getMetadata().sourceRange.from ?? Number.POSITIVE_INFINITY;
          if (middleFrom < from) low = middle + 1;
          else high = middle;
        }
        this.rootCodeOwners.splice(low, 0, owner);
      }
      this.refreshPendingRootCodeOwner(owner);
    }
  }

  private registerRootTableOwners(owners: readonly RootTableSourceOwner[]): void {
    for (const owner of owners) {
      const from = owner.getMetadata().sourceRange.from;
      if (this.rootTableOwnersByStart.has(from)) continue;
      this.rootTableOwnersByStart.set(from, owner);
      const last = this.rootTableOwners[this.rootTableOwners.length - 1];
      if (!last || last.getMetadata().sourceRange.from < from) {
        this.rootTableOwners.push(owner);
      } else {
        let low = 0;
        let high = this.rootTableOwners.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          const middleFrom = this.rootTableOwners[middle]?.getMetadata().sourceRange.from ?? Number.POSITIVE_INFINITY;
          if (middleFrom < from) low = middle + 1;
          else high = middle;
        }
        this.rootTableOwners.splice(low, 0, owner);
      }
      this.refreshPendingRootTableOwner(owner);
    }
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
      this.rootParagraphOwnersById.set(owner.id, owner);
      this.refreshPendingRootParagraphOwner(owner);
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
  private refreshPendingRootCodeOwner(owner: RootCodeSourceOwner): void {
    const metadata = owner.getMetadata();
    const current = this.rootCodeOwnersByStart.get(metadata.sourceRange.from) === owner;
    if (!current || metadata.state !== "open") this.openRootCodeOwners.delete(owner);
    else this.openRootCodeOwners.add(owner);
    if (!current) this.pendingRootCodeOwners.delete(owner);
    else if (metadata.state === "open" || !this.emittedRootCodeIds.has(owner.id)) {
      this.pendingRootCodeOwners.add(owner);
    } else {
      this.pendingRootCodeOwners.delete(owner);
    }
  }

  private refreshPendingRootTableOwner(owner: RootTableSourceOwner): void {
    const metadata = owner.getMetadata();
    const current = this.rootTableOwnersByStart.get(metadata.sourceRange.from) === owner;
    if (!current || metadata.state !== "open") this.openRootTableOwners.delete(owner);
    else this.openRootTableOwners.add(owner);
    if (!current) this.pendingRootTableOwners.delete(owner);
    else if (metadata.state === "open" || !this.emittedRootTableIds.has(owner.id)) {
      this.pendingRootTableOwners.add(owner);
    } else {
      this.pendingRootTableOwners.delete(owner);
    }
  }

  private refreshPendingRootParagraphOwner(owner: RootParagraphSourceOwner): void {
    const metadata = owner.getMetadata();
    const current = this.rootParagraphOwnersByStart.get(metadata.sourceRange.from) === owner;
    if (!current || metadata.state !== "open") this.openRootParagraphOwners.delete(owner);
    else this.openRootParagraphOwners.add(owner);
    if (!current) this.pendingRootParagraphOwners.delete(owner);
    else if (metadata.state !== "finalized" || !this.emittedRootParagraphIds.has(owner.id)) {
      this.pendingRootParagraphOwners.add(owner);
    } else {
      this.pendingRootParagraphOwners.delete(owner);
    }
  }

  private markRootCodeOwnerEmitted(owner: RootCodeSourceOwner): void {
    this.emittedRootCodeIds.add(owner.id);
    this.refreshPendingRootCodeOwner(owner);
  }

  private markRootTableOwnerEmitted(owner: RootTableSourceOwner): void {
    this.emittedRootTableIds.add(owner.id);
    this.refreshPendingRootTableOwner(owner);
  }

  private markRootParagraphOwnerEmitted(owner: RootParagraphSourceOwner): void {
    this.emittedRootParagraphIds.add(owner.id);
    this.refreshPendingRootParagraphOwner(owner);
  }

  private advanceRootNativeOwnerGeneration(): void {
    if (!Number.isSafeInteger(this.rootNativeOwnerGeneration + 1)) {
      throw new RangeError("Root native owner generation exceeds the safe integer range");
    }
    this.rootNativeOwnerGeneration += 1;
  }


  private isCurrentRootCodeOwner(owner: RootCodeSourceOwner): boolean {
    return this.rootCodeOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner;
  }

  private retireRootCodeOwner(owner: RootCodeSourceOwner): void {
    const from = owner.getMetadata().sourceRange.from;
    if (this.rootCodeOwnersByStart.get(from) !== owner) return;
    this.advanceRootNativeOwnerGeneration();
    this.rootCodeOwnersByStart.delete(from);
    const index = this.rootCodeOwners.indexOf(owner);
    if (index >= 0) this.rootCodeOwners.splice(index, 1);
    this.emittedRootCodeIds.delete(owner.id);
    this.pendingRootCodeOwners.delete(owner);
    this.openRootCodeOwners.delete(owner);
  }

  private retireRootTableOwner(owner: RootTableSourceOwner): void {
    const from = owner.getMetadata().sourceRange.from;
    if (this.rootTableOwnersByStart.get(from) !== owner) return;
    const generation = owner.getMetadata().generation;
    this.advanceRootNativeOwnerGeneration();
    this.rootTableOwnersByStart.delete(from);
    const index = this.rootTableOwners.indexOf(owner);
    if (index >= 0) this.rootTableOwners.splice(index, 1);
    this.emittedRootTableIds.delete(owner.id);
    this.pendingRootTableOwners.delete(owner);
    this.openRootTableOwners.delete(owner);
    this.pendingRootTablePatches = this.pendingRootTablePatches.filter((patch) => {
      if (patch.op === "appendTableRows") {
        return patch.table.tableOwnerId !== owner.id || patch.table.generation !== generation;
      }
      return patch.op !== "updateTableRows"
        || patch.tableOwnerId !== owner.id
        || patch.generation !== generation;
    });
  }

  private retireRootParagraphOwner(owner: RootParagraphSourceOwner): void {
    const from = owner.getMetadata().sourceRange.from;
    if (this.rootParagraphOwnersByStart.get(from) !== owner) return;
    this.advanceRootNativeOwnerGeneration();
    this.rootParagraphOwnersByStart.delete(from);
    const index = this.rootParagraphOwners.indexOf(owner);
    if (index >= 0) this.rootParagraphOwners.splice(index, 1);
    this.emittedRootParagraphIds.delete(owner.id);
    this.pendingRootParagraphOwners.delete(owner);
    this.rootParagraphOwnersById.delete(owner.id);
    this.openRootParagraphOwners.delete(owner);
    this.pendingRootParagraphPatches = this.pendingRootParagraphPatches.filter((patch) =>
      !((patch.op === "appendParagraph" || patch.op === "updateParagraphSpans")
        && patch.paragraphOwnerId === owner.id
        && patch.generation === owner.generation)
    );
    releaseRootParagraphOwner(owner);
  }

  private rootBlockAtSourceStart(sourceOffset: number): Block | undefined {
    const blocks = this.blocks;
    let low = 0;
    let high = blocks.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const from = blocks[middle]?.payload.range?.from ?? Number.POSITIVE_INFINITY;
      if (from < sourceOffset) low = middle + 1;
      else high = middle;
    }
    const block = blocks[low];
    return block?.payload.range?.from === sourceOffset ? block : undefined;
  }
  private rootBlockBeforeSourceOffset(sourceOffset: number): Block | undefined {
    const blocks = this.blocks;
    let low = 0;
    let high = blocks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const block = blocks[middle];
      const from = block ? rootBlockSourceFrom(block) : Number.POSITIVE_INFINITY;
      if (from < sourceOffset) low = middle + 1;
      else high = middle;
    }
    return blocks[low - 1];
  }
  private nativeContainerBlockAtSourceStart(containerId: string): Block | undefined {
    const sourceStart = this.nativeContainerSourceStarts.get(containerId);
    if (sourceStart === undefined) return undefined;
    const block = this.rootBlockAtSourceStart(sourceStart);
    return block?.id === containerId
      && (block.type === "list" || block.type === "blockquote")
      ? block
      : undefined;
  }
  private syncNestedCodeOwnerLedger(owner: NativeNestedCodeSourceOwner): void {
    if (owner.state === "finalized") this.unfinishedNestedCodeOwnerIds.delete(owner.id);
    else this.unfinishedNestedCodeOwnerIds.add(owner.id);
  }

  private syncNestedTableOwnerLedger(owner: RootTableSourceOwner): void {
    if (owner.getMetadata().state === "finalized") this.unfinishedNestedTableOwnerIds.delete(owner.id);
    else this.unfinishedNestedTableOwnerIds.add(owner.id);
  }

  private syncNestedParagraphOwnerLedger(owner: RootParagraphSourceOwner): void {
    if (owner.getMetadata().state === "finalized") this.unfinishedNestedParagraphOwnerIds.delete(owner.id);
    else this.unfinishedNestedParagraphOwnerIds.add(owner.id);
  }

  private retireRootOwnersInHtmlRegions(htmlDependentStarts: ReadonlySet<number>): void {
    if (htmlDependentStarts.size === 0) return;
    for (let index = this.rootCodeOwners.length - 1; index >= 0; index -= 1) {
      const owner = this.rootCodeOwners[index];
      if (owner && htmlDependentStarts.has(owner.getMetadata().sourceRange.from)) this.retireRootCodeOwner(owner);
    }
    for (let index = this.rootTableOwners.length - 1; index >= 0; index -= 1) {
      const owner = this.rootTableOwners[index];
      if (owner && htmlDependentStarts.has(owner.getMetadata().sourceRange.from)) this.retireRootTableOwner(owner);
    }
    for (let index = this.rootParagraphOwners.length - 1; index >= 0; index -= 1) {
      const owner = this.rootParagraphOwners[index];
      if (owner && htmlDependentStarts.has(owner.getMetadata().sourceRange.from)) this.retireRootParagraphOwner(owner);
    }
  }
  private retireRootOwnersReclassifiedBy(tree: Tree, sourceOffset: number): void {
    const parsedTypes = new Map<number, string>();
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
      parsedTypes.set(sourceOffset + node.from, node.type.name);
    }
    const shouldRetire = (
      id: string,
      from: number,
      type: "code" | "table" | "paragraph",
      isRegisteredRootOwner: boolean,
      syntaxType: string,
    ): boolean => {
      const canonicalBlock = this.rootBlockAtSourceStart(from);
      const isCanonicalOwner = isRegisteredRootOwner
        || (canonicalBlock?.id === id && canonicalBlock.type === type);
      return !isCanonicalOwner
        || (from >= sourceOffset && parsedTypes.get(from) !== syntaxType);
    };

    for (let index = this.rootCodeOwners.length - 1; index >= 0; index -= 1) {
      const owner = this.rootCodeOwners[index];
      if (!owner) continue;
      const metadata = owner.getMetadata();
      const from = metadata.sourceRange.from;
      if (shouldRetire(owner.id, from, "code", this.rootCodeOwnersByStart.get(from) === owner, "FencedCode")) {
        this.retireRootCodeOwner(owner);
      }
    }
    for (let index = this.rootTableOwners.length - 1; index >= 0; index -= 1) {
      const owner = this.rootTableOwners[index];
      if (!owner) continue;
      const from = owner.getMetadata().sourceRange.from;
      if (shouldRetire(owner.id, from, "table", this.rootTableOwnersByStart.get(from) === owner, "Table")) {
        this.retireRootTableOwner(owner);
      }
    }
    for (let index = this.rootParagraphOwners.length - 1; index >= 0; index -= 1) {
      const owner = this.rootParagraphOwners[index];
      if (!owner) continue;
      const from = owner.getMetadata().sourceRange.from;
      if (shouldRetire(owner.id, from, "paragraph", this.rootParagraphOwnersByStart.get(from) === owner, "Paragraph")) {
        this.retireRootParagraphOwner(owner);
      }
    }
  }
  // HTML-bearing containers decline native ownership and use the base nested preparation.
  private nativeContainerSourceHasHtml(raw: string): boolean {
    return raw.includes("<") && this.rootParagraphContainsInlineHtml(raw);
  }
  // Retires a list/blockquote's nested native leases, tail and pending native patches.
  private retireNativeContainer(block: Block): void {
    if (block.type !== "list" && block.type !== "blockquote") return;
    const sourceStart = block.payload.range?.from ?? this.nativeContainerSourceStarts.get(block.id);
    const canonicalBlock = typeof sourceStart === "number" ? this.rootBlockAtSourceStart(sourceStart) : undefined;
    const prepared = (block.payload.meta?.preparedNested
      ?? (canonicalBlock?.id === block.id && canonicalBlock.type === block.type
        ? canonicalBlock.payload.meta?.preparedNested
        : undefined)) as PreparedNestedSnapshot | undefined;
    for (const child of prepared?.children ?? []) this.retireNativeOwnersInSnapshot(block.id, child);
    const active = this.nativeContainerActiveSnapshots.get(block.id);
    if (active) this.retireNativeOwnersInSnapshot(block.id, active);
    const activePath = this.nativeContainerActivePathSnapshots.get(block.id);
    if (activePath) {
      for (const snapshot of activePath) this.retireNativeOwnersInSnapshot(block.id, snapshot);
    }

    const paragraphOwnerIds = this.nestedParagraphOwnerIdsByContainer.get(block.id);
    if (paragraphOwnerIds) {
      for (const ownerId of paragraphOwnerIds) {
        const owner = this.nestedParagraphOwners.get(ownerId);
        if (owner) this.retireNestedParagraphOwner(block.id, ownerId, owner);
        else {
          this.pendingFootnoteParagraphOwnerRemovals.add(ownerId);
          if (this.nestedParagraphOwnerContainers.get(ownerId) === block.id) {
            this.nestedParagraphOwnerContainers.delete(ownerId);
          }
          this.unfinishedNestedParagraphOwnerIds.delete(ownerId);
          this.nestedParagraphFootnoteTargetOwnerIds.delete(ownerId);
          removeNativeOwnerIdFromContainer(this.nestedParagraphOwnerIdsByContainer, ownerId, block.id);
        }
      }
    }
    const codeOwnerIds = this.nestedCodeOwnerIdsByContainer.get(block.id);
    if (codeOwnerIds) {
      for (const ownerId of codeOwnerIds) {
        const owner = this.nestedCodeOwners.get(ownerId);
        if (owner) this.retireNestedCodeOwner(block.id, ownerId, owner);
        else {
          this.unfinishedNestedCodeOwnerIds.delete(ownerId);
          removeNativeOwnerIdFromContainer(this.nestedCodeOwnerIdsByContainer, ownerId, block.id);
        }
      }
    }
    const tableOwnerIds = this.nestedTableOwnerIdsByContainer.get(block.id);
    if (tableOwnerIds) {
      for (const ownerId of tableOwnerIds) {
        const owner = this.nestedTableOwners.get(ownerId);
        if (owner) this.retireNestedTableOwner(block.id, ownerId, owner);
        else {
          if (this.nestedTableOwnerContainers.get(ownerId) === block.id) {
            this.nestedTableOwnerContainers.delete(ownerId);
          }
          this.unfinishedNestedTableOwnerIds.delete(ownerId);
          removeNativeOwnerIdFromContainer(this.nestedTableOwnerIdsByContainer, ownerId, block.id);
        }
      }
    }

    this.nativeContainerTails.get(block.id)?.clear();
    this.nativeContainerTails.delete(block.id);
    this.nativeContainerActiveSnapshots.delete(block.id);
    this.nativeContainerActivePathSnapshots.delete(block.id);
    this.nativeContainerActivePathFrames.delete(block.id);
    this.nativeFenceHeaderFrontiers.delete(block.id);
    this.nativeContainerSourceStarts.delete(block.id);
    this.activeNestedCodeByContainer.delete(block.id);
    this.activeNestedTableByContainer.delete(block.id);
    this.activeNestedParagraphByContainer.delete(block.id);
    const retired = new Set([block.id]);
    this.pendingNativeNestedPatches = this.retainPatchesOutsideRetiredContainers(this.pendingNativeNestedPatches, retired);
    this.pendingNativeNestedOwnerPatches = this.retainPatchesOutsideRetiredContainers(this.pendingNativeNestedOwnerPatches, retired);
  }
  private retireDisplacedNativeContainers(
    previousBlocks: readonly Block[],
    nextBlocks: readonly Block[],
    tailOffset: number,
  ): void {
    const nextTailStart = rootSourceBoundary(
      nextBlocks,
      tailOffset,
      rootBlockSourceFrom,
      typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? this.campaignCounters
        : undefined,
    );
    const nextTailContainerIds = new Set<string>();
    for (let index = nextTailStart; index < nextBlocks.length; index += 1) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      const block = nextBlocks[index];
      if (block && (block.type === "list" || block.type === "blockquote")) {
        nextTailContainerIds.add(block.id);
      }
    }
    const previousTailStart = rootSourceBoundary(
      previousBlocks,
      tailOffset,
      rootBlockSourceFrom,
      typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? this.campaignCounters
        : undefined,
    );
    for (let index = previousTailStart; index < previousBlocks.length; index += 1) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      const block = previousBlocks[index];
      if (!block
        || (block.type !== "list" && block.type !== "blockquote")
        || nextTailContainerIds.has(block.id)) continue;
      this.retireNativeContainer(block);
    }
  }
  // MDX grouping absorbs these containers, so retire their nested leases before rebuilding the region.
  private retireNativeOwnersInMdxContainers(nestedContainerStarts: ReadonlySet<number>): void {
    for (const from of nestedContainerStarts) {
      const block = this.rootBlockAtSourceStart(from);
      if (block) this.retireNativeContainer(block);
    }
  }
  private retainPatchesOutsideRetiredContainers(
    patches: readonly Patch[],
    retiredContainerIds: ReadonlySet<string>,
  ): Patch[] {
    const retained: Patch[] = [];
    for (const patch of patches) {
      if (patch.op === "setPropsBatch") {
        const entries = patch.entries.filter((entry) => !retiredContainerIds.has(entry.at.blockId));
        if (entries.length === patch.entries.length) retained.push(patch);
        else if (entries.length > 0) retained.push({ ...patch, entries });
        continue;
      }
      if (!retiredContainerIds.has(patch.at.blockId)) retained.push(patch);
    }
    return retained;
  }


  private isCurrentRootNativeOwnerPatch(patch: Patch): boolean {
    if (patch.op === "appendParagraph" || patch.op === "updateParagraphSpans") {
      if (patch.at.nodeId !== undefined) {
        return this.nestedParagraphOwners.get(patch.paragraphOwnerId)?.generation === patch.generation;
      }
      const owner = this.rootParagraphOwners.find((candidate) =>
        candidate.id === patch.paragraphOwnerId && candidate.generation === patch.generation);
      return owner !== undefined
        && this.rootParagraphOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner;
    }
    if (patch.op === "appendCode" || patch.op === "decorateCode") {
      const id = patch.op === "appendCode" ? patch.code.codeOwnerId : patch.codeOwnerId;
      const generation = patch.op === "appendCode" ? patch.code.generation : patch.generation;
      if (patch.at.nodeId !== undefined) {
        return this.nestedCodeOwners.get(id)?.generation === generation;
      }
      const owner = this.rootCodeOwners.find((candidate) =>
        candidate.id === id && candidate.generation === generation);
      return owner !== undefined
        && this.rootCodeOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner;
    }
    if (patch.op === "appendTableRows" || patch.op === "updateTableRows") {
      const id = patch.op === "appendTableRows" ? patch.table.tableOwnerId : patch.tableOwnerId;
      const generation = patch.op === "appendTableRows" ? patch.table.generation : patch.generation;
      if (patch.at.nodeId !== undefined) {
        return this.nestedTableOwners.get(id)?.getMetadata().generation === generation;
      }
      const owner = this.rootTableOwners.find((candidate) =>
        candidate.id === id && candidate.getMetadata().generation === generation);
      return owner !== undefined
        && this.rootTableOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner;
    }
    if (patch.op === "insertChild" && patch.at.blockId === PATCH_ROOT_ID) {
      const node = patch.node;
      const generation = nativeOwnerGeneration(node);
      const type = nativeOwnerType(node);
      if (generation === undefined || type === undefined) return true;
      if (type === "code") {
        const owner = this.rootCodeOwners.find((candidate) => candidate.id === node.id);
        return owner?.generation === generation
          && this.rootCodeOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner;
      }
      if (type === "table") {
        const owner = this.rootTableOwners.find((candidate) => candidate.id === node.id);
        return owner?.getMetadata().generation === generation
          && this.rootTableOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner;
      }
      const owner = this.rootParagraphOwners.find((candidate) => candidate.id === node.id);
      return owner?.generation === generation
        && this.rootParagraphOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner;
    }
    return true;
  }

  private rootParagraphInsertCoversPatch(
    node: NodeSnapshot | undefined,
    patch: Extract<Patch, { op: "appendParagraph" }> | Extract<Patch, { op: "updateParagraphSpans" }>,
  ): boolean {
    const inserted = node?.paragraph;
    if (!node || node.type !== "paragraph" || !inserted) return false;
    const changed = patch.paragraph;
    if (patch.op === "appendParagraph" && patch.sourceAppend.length > 0) {
      const appendedSourceOffset = changed.sourceRange.to
        - patch.sourceAppend.length
        - inserted.sourceRange.from;
      if (appendedSourceOffset < 0 || !inserted.raw.startsWith(patch.sourceAppend, appendedSourceOffset)) return false;
    }
    return node.id === patch.paragraphOwnerId
      && inserted.paragraphOwnerId === patch.paragraphOwnerId
      && inserted.generation === patch.generation
      && changed.paragraphOwnerId === patch.paragraphOwnerId
      && changed.generation === patch.generation
      && patch.revision > patch.expectedRevision
      && changed.revision === patch.revision
      && inserted.revision >= patch.revision
      && inserted.processedTo >= changed.processedTo
      && inserted.sourceRange.from === changed.sourceRange.from
      && inserted.sourceRange.to >= changed.sourceRange.to
      && inserted.completeSpanCount >= changed.completeSpanCount
      && inserted.spanCount >= changed.spanCount
      && inserted.spans.length >= changed.spanCount
      && inserted.raw.length === inserted.sourceRange.to - inserted.sourceRange.from;
  }

  private rootParagraphInsertPatch(owner: RootParagraphSourceOwner): Patch {
    this.publishParagraphLinkReferences(owner);
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

  private syncNestedParagraphFootnoteTargetOwner(owner: RootParagraphSourceOwner): void {
    if (owner.hasFootnoteReferences()) this.nestedParagraphFootnoteTargetOwnerIds.add(owner.id);
    else this.nestedParagraphFootnoteTargetOwnerIds.delete(owner.id);
  }

  private nestedParagraphFootnoteTargetDeltas(
    blocks: readonly Block[] = this.blocks,
    ownerIds: Iterable<string> = this.nestedParagraphFootnoteTargetOwnerIds,
  ): FootnoteParagraphTargetDelta[] {
    const deltas: FootnoteParagraphTargetDelta[] = [];
    if (this.nestedParagraphOwners.size === 0) return deltas;
    let blockIds: Set<string> | undefined;
    for (const ownerId of ownerIds) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      const owner = this.nestedParagraphOwners.get(ownerId);
      const containerId = this.nestedParagraphOwnerContainers.get(ownerId);
      if (!owner || !containerId) continue;
      if (!blockIds) {
        blockIds = new Set<string>();
        for (const block of blocks) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          blockIds.add(block.id);
        }
      }
      if (!blockIds.has(containerId)) continue;
      deltas.push(this.rootParagraphFootnoteTargetDelta(owner, owner.getSpans().materialize()));
    }
    return deltas;
  }

  // Changed spans also go back to the footnote bridge: its targets hold the pre-invalidation nodes, so numbering would
  // otherwise be dropped from the new nodes or republished over them from the stale ones.
  private invalidateLinkReferenceOwners(
    labels: ReadonlySet<string>,
    rootParagraphCount = this.rootParagraphOwners.length,
    rootTableCount = this.rootTableOwners.length,
  ): {
    readonly paragraphPatches: Patch[];
    readonly tablePatches: Patch[];
    readonly paragraphTargets: FootnoteParagraphTargetDelta[];
  } {
    const paragraphPatches: Patch[] = [];
    const tablePatches: Patch[] = [];
    const paragraphTargets: FootnoteParagraphTargetDelta[] = [];
    if (labels.size === 0) return { paragraphPatches, tablePatches, paragraphTargets };
    const nestedContainerIds = this.nestedParagraphOwners.size > 0 || this.nestedTableOwners.size > 0
      ? new Set<string>()
      : undefined;
    if (nestedContainerIds) {
      for (const block of this.blocks) nestedContainerIds.add(block.id);
    }

    for (let index = 0; index < rootParagraphCount; index += 1) {
      const owner = this.rootParagraphOwners[index];
      if (!owner) continue;
      this.publishParagraphLinkReferences(owner);
      const change = owner.invalidateLinkReferences(labels);
      if (change) paragraphTargets.push(this.rootParagraphFootnoteTargetDelta(owner, change.updates.map((update) => update.span)));
      const patch = rootParagraphSemanticPatch(owner, change);
      if (patch && this.emittedRootParagraphIds.has(owner.id)) paragraphPatches.push(patch);
    }
    for (const owner of this.nestedParagraphOwners.values()) {
      const blockId = this.nestedParagraphOwnerContainers.get(owner.id);
      if (!blockId || !nestedContainerIds?.has(blockId)) continue;
      this.publishParagraphLinkReferences(owner);
      const change = owner.invalidateLinkReferences(labels);
      if (change) paragraphTargets.push(this.rootParagraphFootnoteTargetDelta(owner, change.updates.map((update) => update.span)));
      const patch = rootParagraphSemanticPatch(owner, change);
      if (patch) paragraphPatches.push({ ...patch, at: { blockId, nodeId: owner.id } });
    }
    for (let index = 0; index < rootTableCount; index += 1) {
      const owner = this.rootTableOwners[index];
      if (!owner) continue;
      const patch = rootTableSemanticPatch(owner, owner.invalidateLinkReferences(labels));
      if (patch && this.emittedRootTableIds.has(owner.id)) tablePatches.push(patch);
    }
    for (const owner of this.nestedTableOwners.values()) {
      const blockId = this.nestedTableOwnerContainers.get(owner.id);
      if (!blockId || !nestedContainerIds?.has(blockId)) continue;
      const patch = rootTableSemanticPatch(owner, owner.invalidateLinkReferences(labels));
      if (patch) tablePatches.push({ ...patch, at: { blockId, nodeId: owner.id } });
    }
    return { paragraphPatches, tablePatches, paragraphTargets };
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
    for (const start of this.currentLinkReferenceStarts.values()) {
      if (start >= metadata.sourceRange.to) return undefined;
    }
    return candidate;
  }

  private trailingLinkReferenceContinuationStart(source: SourceSnapshot, oldLength: number): number | undefined {
    let lastDefinitionStart = -1;
    for (const start of this.currentLinkReferenceStarts.values()) {
      if (start < oldLength && start > lastDefinitionStart) lastDefinitionStart = start;
    }
    if (lastDefinitionStart < 0) return undefined;

    const definitionTail = source.read(lastDefinitionStart, oldLength);
    const firstNewline = definitionTail.indexOf("\n");
    if (firstNewline < 0) return sourceLineStart(source, lastDefinitionStart);
    const continuation = definitionTail.slice(firstNewline + 1);
    if (continuation.length === 0 || /^[ \t]+["'(][^\r\n]*(?:\r?\n)?$/.test(continuation)) {
      return sourceLineStart(source, lastDefinitionStart);
    }
    return undefined;
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
    this.rootNativeFragmentOffset = null;
    this.treeFragments = [];
    await this.parseRootNativeTail(
      this.rootParagraphReplacementFrom(source, sourceStart),
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
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        if (owner.id === block.id) return true;
      }
    } else if (block.type === "table") {
      for (const owner of this.rootTableOwnersByStart.values()) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        if (owner.id === block.id) return true;
      }
    } else if (block.type === "paragraph") {
      for (const owner of this.rootParagraphOwnersByStart.values()) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        if (owner.id === block.id) return true;
      }
    }
    return false;
  }
  private excludeRootCodeBlocksFromDocumentContext(
    blocks: Block[],
    candidates: readonly RootCodeSourceOwner[],
  ): Block[] {
    if (candidates.length > 0
      && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(candidates.length, "engine");
    }
    const candidateIds = candidates.length > 0
      ? new Set(candidates.map((owner) => owner.id))
      : undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(blocks.length, "engine");
    }
    return blocks.filter((block) => block.type !== "code" || (
      !this.isRootOwnedBlock(block) && !candidateIds?.has(block.id)
    ));
  }


  private rootTableExtensionContext(): "header-independent" | "source-dependent" {
    return this.extensions?.markdown && this.extensions.markdown.length > 0
      ? "source-dependent"
      : "header-independent";
  }

  private rootManagedTailOffset(): number | null {
    for (const owner of this.pendingRootCodeOwners) {
      if (owner.getMetadata().state === "open") return null;
    }
    for (const owner of this.pendingRootTableOwners) {
      if (owner.getMetadata().state === "open") return null;
    }
    for (const owner of this.pendingRootParagraphOwners) {
      if (owner.getMetadata().state === "open") return null;
    }

    let latestFrom = -1;
    let processedTo: number | null = null;
    let latestParagraph: RootParagraphSourceOwner | undefined;
    const latestCode = this.rootCodeOwners[this.rootCodeOwners.length - 1];
    if (latestCode) {
      const metadata = latestCode.getMetadata();
      if (metadata.state === "open") return null;
      latestFrom = metadata.sourceRange.from;
      processedTo = metadata.processedTo;
    }
    const latestTable = this.rootTableOwners[this.rootTableOwners.length - 1];
    if (latestTable) {
      const metadata = latestTable.getMetadata();
      if (metadata.state === "open") return null;
      if (metadata.sourceRange.from >= latestFrom) {
        latestFrom = metadata.sourceRange.from;
        // A table may consume trailing source while classifying its interrupt; restart at its owned end.
        processedTo = metadata.sourceRange.to;
        latestParagraph = undefined;
      }
    }
    const latestRootParagraph = this.rootParagraphOwners[this.rootParagraphOwners.length - 1];
    if (latestRootParagraph) {
      const metadata = latestRootParagraph.getMetadata();
      if (metadata.state === "open") return null;
      if (metadata.sourceRange.from >= latestFrom) {
        latestFrom = metadata.sourceRange.from;
        processedTo = metadata.processedTo;
        latestParagraph = latestRootParagraph;
      }
    }
    const pendingRootOffset = latestParagraph ? rootParagraphPendingRootOffset(latestParagraph) : undefined;
    if (pendingRootOffset !== undefined) {
      // Native block node offsets can omit indentation needed when reparsing a continuation.
      processedTo = sourceLineStart(this.sourceDocument.snapshot(), pendingRootOffset);
    }
    return processedTo;
  }

  private forEachUnfinishedRootBlock(visitor: (block: Block) => void): void {
    const blocks = this.blocks;
    if ((this.extensions?.documentPlugins?.length ?? 0) > 0) {
      for (const block of blocks) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        if (!block.isFinalized) visitor(block);
      }
      return;
    }

    // applyUpdate enforces that only the trailing real root can remain dirty; synthetic
    // footnotes are finalized and may trail that root, so they are skipped while walking back.
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      if (!block) continue;
      if (block.type === "footnotes") {
        if (!block.isFinalized) visitor(block);
        continue;
      }
      if (block.isFinalized) break;
      visitor(block);
    }
  }


  private rootOwnerSnapshotFrom(fallback: number): number {
    const source = this.sourceDocument.snapshot();
    let from = this.rootManagedTailOffset() ?? fallback;
    const includeOwnerStart = (
      owner: RootCodeSourceOwner | RootTableSourceOwner,
    ): void => {
      from = Math.min(from, sourceLineStart(source, owner.getMetadata().sourceRange.from));
    };
    for (const owner of this.pendingRootCodeOwners) includeOwnerStart(owner);
    for (const owner of this.pendingRootTableOwners) includeOwnerStart(owner);
    for (const owner of this.pendingRootParagraphOwners) {
      const paragraphFrom = owner.getMetadata().sourceRange.from;
      from = Math.min(
        from,
        sourceLineStart(source, paragraphFrom),
        this.rootParagraphReplacementFrom(source, paragraphFrom),
      );
    }
    this.forEachUnfinishedRootBlock((block) => {
      const blockFrom = block.payload.range?.from;
      if (typeof blockFrom === "number") from = Math.min(from, blockFrom);
    });
    return from;
  }

  // Root registration keeps all three owner families source-ordered for bounded EOF windows.
  private rootOwnerSnapshotWindow(from: number): {
    readonly from: number;
    readonly codeOwners: RootCodeSourceOwner[];
    readonly tableOwners: RootTableSourceOwner[];
    readonly paragraphOwners: RootParagraphSourceOwner[];
    readonly prefixCounts: {
      readonly code: number;
      readonly table: number;
      readonly paragraph: number;
    };
  } {
    const codeStart = rootSourceBoundary(
      this.rootCodeOwners,
      from,
      rootOwnerSourceFrom,
      typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ ? this.campaignCounters : undefined,
    );
    const tableStart = rootSourceBoundary(
      this.rootTableOwners,
      from,
      rootOwnerSourceFrom,
      typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ ? this.campaignCounters : undefined,
    );
    const paragraphStart = rootSourceBoundary(
      this.rootParagraphOwners,
      from,
      rootOwnerSourceFrom,
      typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ ? this.campaignCounters : undefined,
    );
    const codeOwners: RootCodeSourceOwner[] = [];
    const tableOwners: RootTableSourceOwner[] = [];
    const paragraphOwners: RootParagraphSourceOwner[] = [];
    for (let index = codeStart; index < this.rootCodeOwners.length; index += 1) {
      const owner = this.rootCodeOwners[index];
      if (owner && this.emittedRootCodeIds.has(owner.id)) codeOwners.push(owner);
    }
    for (let index = tableStart; index < this.rootTableOwners.length; index += 1) {
      const owner = this.rootTableOwners[index];
      if (owner && this.emittedRootTableIds.has(owner.id)) tableOwners.push(owner);
    }
    for (let index = paragraphStart; index < this.rootParagraphOwners.length; index += 1) {
      const owner = this.rootParagraphOwners[index];
      if (owner) paragraphOwners.push(owner);
    }
    return {
      from,
      codeOwners,
      tableOwners,
      paragraphOwners,
      prefixCounts: { code: codeStart, table: tableStart, paragraph: paragraphStart },
    };
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
  private shouldDeferNativeNestedCodeHighlight(owner: NativeNestedCodeSourceOwner): boolean {
    const metadata = owner.getMetadata();
    return shouldLazyTokenizeBlock(
      this.lazyTokenizationEnabled,
      metadata.lineCount,
      this.lazyTokenizationThresholdLines,
      Boolean(this.highlighter),
      owner.hasHighlightableContent,
    );
  }

  /** Closed nested code presentation, derived from the owner's current lines so lazy and eager highlighting converge. */
  private refreshNativeNestedCodePresentation(owner: NativeNestedCodeSourceOwner): Block | undefined {
    if (owner.state === "open") return undefined;
    const wantsHtml = this.highlightOutputMode === "html" || this.highlightOutputMode === "both";
    const wantsTokens = (this.highlightOutputMode === "tokens" || this.highlightOutputMode === "both") && this.emitHighlightTokens;
    const lazy = (wantsHtml || wantsTokens) && this.shouldDeferNativeNestedCodeHighlight(owner);
    const code = owner.snapshot(this.rootCodeConfigurationRevision).code;
    if (!code) return undefined;
    const { lang, meta: fenceMeta } = parseCodeFenceInfo(code.info);
    const diffInfo = detectDiffLanguage(lang, fenceMeta);
    const diff = this.emitDiffBlocks && diffInfo.isDiff;
    const presentation = owner.getPresentation();
    if (!presentation && !lazy && !diff) return undefined;

    const rows = owner.getLines().readRange(0, owner.getLines().length);
    const meta: NonNullable<Block["payload"]["meta"]> = {
      ...(presentation?.meta ?? {}),
      code: owner.getLines().materialize().replace(/\r\n?/g, "\n").replace(/\n$/, ""),
      info: code.info,
      ...(code.language ? { lang: code.language } : {}),
    };
    if (lazy) {
      let tokenizedUntil = 0;
      while (rows[tokenizedUntil]?.decoration?.configurationRevision === this.rootCodeConfigurationRevision) tokenizedUntil += 1;
      meta.lazyTokenization = true;
      meta.lazyTokenizedUntil = tokenizedUntil;
    }
    if (diff) {
      const codeLines = rows.map((row) => row.text);
      const cursor: DiffCursorState = { oldLine: null, newLine: null };
      meta.diffBlocks = buildDiffBlocksFromLines(
        codeLines.map((line) => parseUnifiedDiffLine(line, cursor)),
        codeLines,
        wantsTokens ? rows.map((row) => (row.decoration?.tokens ?? null) as TokenLineV1 | null) : null,
        diffInfo.baseLang ?? null,
      );
    }
    const block: Block = {
      id: owner.id,
      type: "code",
      isFinalized: true,
      payload: {
        raw: code.raw,
        meta,
        range: { ...code.sourceRange },
        inline: undefined,
        highlightedHtml: presentation?.highlightedHtml,
        sanitizedHtml: undefined,
      },
    };
    owner.setPresentation(block);
    return block;
  }

  private async decorateRootCode(
    owner: RootCodeSourceOwner,
    finalizing = false,
  ): Promise<Extract<Patch, { op: "decorateCode" }> | null> {
    const generation = this.documentGeneration;
    const configurationRevision = this.rootCodeConfigurationRevision;
    if (!this.isCurrentRootCodeOwner(owner)) return null;
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
            && this.isCurrentRootCodeOwner(owner),
        );
    if (!this.isCurrentRootCodeOwner(owner)) return null;

    let patch = rootCodeDecoratePatch(owner, configurationRevision, decorations);
    if (isFinalized && block) {
      await this.enrichCodeBlock(block);
      if (!this.isCurrentRootCodeOwner(owner)) return null;
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
    this.refreshPendingRootCodeOwner(owner);
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

    if (!this.isCurrentRootCodeOwner(owner)) return;
    const decorationPatch = await this.decorateRootCode(owner);
    if (!this.isCurrentRootCodeOwner(owner)) return;
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
    this.refreshPendingRootTableOwner(owner);
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
    const hasParagraphOwners = this.rootParagraphOwners.length > 0
      || this.nestedParagraphOwners.size > 0
      || this.nestedTableOwners.size > 0;
    const footnoteTargets = hasParagraphOwners
      ? { rebuild: appendedText.includes("[^") || appendedText.includes("&") }
      : undefined;
    const changedBlocks = this.runDocumentPlugins(stableBlocks, source, footnoteTargets);
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
    this.refreshPendingRootParagraphOwner(owner);
    if (rootParagraphChangeNeedsReplacement(change) || this.rootParagraphChangeContainsInlineHtml(change, source, appendedText)) {
      const previousOwners = this.rootParagraphOwners.slice();
      this.retireRootParagraphOwner(owner);
      this.rootNativeFragmentOffset = null;
      this.treeFragments = [];
      await this.parseRootNativeTail(
        this.rootParagraphReplacementFrom(source, previous.sourceRange.from),
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

    this.publishParagraphLinkReferences(owner);
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
    const previousBlocks = this.blocks;
    if (footnoteTargets) this.blocks = this.runDocumentPlugins(this.blocks, source, footnoteTargets);
    const paragraphPatches = this.takePendingRootParagraphPatches();
    const tablePatches = this.takePendingRootTablePatches();
    // Document plugins may replace other root blocks (footnote numbering, quote inline); those need a root diff.
    const pluginReplacedBlocks = this.blocks !== previousBlocks
      && (this.blocks.length !== previousBlocks.length || this.blocks.some((block, index) => block !== previousBlocks[index]));
    if (!pluginReplacedBlocks) {
      this.dispatchPatchBatch([appendPatch, ...paragraphPatches, ...tablePatches], metrics);
      return;
    }
    await this.emitBlockDiffPatches(
      previousBlocks,
      this.blocks,
      [{ fromA: oldLength, toA: oldLength, fromB: oldLength, toB: newLength }],
      metrics,
      undefined,
      undefined,
      [appendPatch, ...paragraphPatches, ...tablePatches],
    );
  }

  private async appendRootNativeTail(
    appendedText: string,
    metrics?: WorkerMetricsCollector,
  ): Promise<void> {
    let tailOffset = this.rootNativeFragmentOffset ?? this.rootManagedTailOffset();
    if (tailOffset === null) throw new Error("Cannot parse a native tail while a root source owner is open");
    const oldLength = this.sourceDocument.length;
    const hasCustomDocumentPlugins = (this.extensions?.documentPlugins?.length ?? 0) > 0
      || this.documentPluginRegistry.getAll().some((plugin) => plugin !== FootnotesPlugin
        && plugin !== TablesPlugin
        && plugin !== CalloutsPlugin
        && plugin !== HTMLBlockPlugin
        && plugin !== MDXDetectionPlugin);
    if (!hasCustomDocumentPlugins) {
      const boundaryIndex = rootSourceBoundary(
        this.blocks,
        tailOffset,
        rootBlockSourceFrom,
        typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
          ? this.campaignCounters
          : undefined,
      );
      const previousRootBlock = boundaryIndex > 0 ? this.blocks[boundaryIndex - 1] : undefined;
      const previousRange = previousRootBlock?.payload.range;
      if (previousRootBlock?.isFinalized
        && typeof previousRange?.from === "number"
        && Number.isSafeInteger(previousRange.from)
        && previousRange.from >= 0
        && typeof previousRange.to === "number"
        && Number.isSafeInteger(previousRange.to)
        && previousRange.to > previousRange.from
        && previousRange.to <= oldLength
        && previousRange.from < tailOffset
        && tailOffset < previousRange.to) {
        tailOffset = previousRange.to;
      }
    }
    this.sourceDocument.append(appendedText);
    const source = this.sourceDocument.snapshot();
    const referenceContinuationStart = this.trailingLinkReferenceContinuationStart(source, oldLength);
    if (referenceContinuationStart !== undefined) tailOffset = Math.min(tailOffset, referenceContinuationStart);
    await this.parseRootNativeTail(tailOffset, oldLength, source.length, metrics);
  }
  /**
   * Where to reparse a replaced root paragraph: its line start, so indentation before the paragraph text still counts,
   * or the root list right before it when the paragraph now starts a list item that may join that list.
   */
  private rootParagraphReplacementFrom(source: SourceSnapshot, paragraphFrom: number): number {
    const lineFrom = sourceLineStart(source, paragraphFrom);
    if (!LIST_ITEM_START.test(source.read(paragraphFrom, Math.min(source.length, paragraphFrom + 12)))) return lineFrom;
    const previous = this.rootBlockBeforeSourceOffset(lineFrom);
    return previous?.type === "list" ? previous.payload.range?.from ?? lineFrom : lineFrom;
  }
  private rootQuoteContinuationStart(
    source: SourceSnapshot,
    oldLength: number,
    newLength: number,
    previousBlocks: readonly Block[],
  ): number | undefined {
    if (newLength <= oldLength) return undefined;
    const previous = previousBlocks[previousBlocks.length - 1];
    const previousRange = previous?.type === "blockquote" ? previous.payload.range : undefined;
    if (!previousRange || previousRange.to > oldLength) return undefined;
    let markerFrom = oldLength;
    const first = source.read(markerFrom, Math.min(newLength, markerFrom + 2));
    if (first.startsWith("\r\n")) markerFrom += 2;
    else if (first.startsWith("\r") || first.startsWith("\n")) markerFrom += 1;
    let indentation = 0;
    while (markerFrom < newLength && indentation < 3 && source.read(markerFrom, markerFrom + 1) === " ") {
      markerFrom += 1;
      indentation += 1;
    }
    if (source.read(markerFrom, markerFrom + 1) !== ">") return undefined;

    const appendedTree = new NativeMarkdownInput(new SourceRangeInput(source, oldLength, newLength)).parse(this.mdParser);
    for (let node = appendedTree.topNode.firstChild; node; node = node.nextSibling) {
      if (node.type.name !== "Blockquote") continue;
      if (isSingleNativeContainerBridge(source, previousRange.to, oldLength + node.from)) {
        const activeTailFrom = previous
          ? this.nativeContainerTails.get(previous.id)?.state.tailFrom
          : undefined;
        const continuationFrom = typeof activeTailFrom === "number"
          && activeTailFrom >= previousRange.from
          && activeTailFrom <= oldLength
          ? activeTailFrom
          : sourceLineStart(source, previousRange.to);
        return Math.max(previousRange.from, continuationFrom);
      }
    }
    return undefined;
  }


  private clearRootHeadingFrontier(): void {
    this.rootHeadingFrontier = [];
    this.rootHeadingCountOffsets.clear();
    this.rootHeadingFrontierGeneration = -1;
    this.rootHeadingFrontierSourceLength = -1;
    this.rootHeadingFrontierValid = false;
    this.rootHeadingIdCountOverrides = null;
    this.rootHeadingIdCountBoundary = 0;
  }

  private hasKnownRootHeadingDocumentPlugins(): boolean {
    if ((this.extensions?.documentPlugins?.length ?? 0) > 0) return false;
    return this.documentPluginRegistry.getAll().every((plugin) =>
      plugin === FootnotesPlugin
      || plugin === TablesPlugin
      || plugin === CalloutsPlugin
      || plugin === HTMLBlockPlugin
      || plugin === MDXDetectionPlugin,
    );
  }

  private canSeedRootHeadingCounts(oldLength: number): boolean {
    return this.rootHeadingFrontierValid
      && this.rootHeadingFrontierGeneration === this.documentGeneration
      && this.rootHeadingFrontierSourceLength <= oldLength
      && this.hasKnownRootHeadingDocumentPlugins();
  }

  private rootHeadingBaseSlug(block: Block): string {
    const headingMeta = block.payload.meta as { headingText?: string } | undefined;
    return slugifyHeading(headingMeta?.headingText ?? block.payload.raw) || "heading";
  }

  private rootHeadingFrontierEntry(
    block: Block,
    heading: TocHeading,
    blockIndex: number,
  ): RootHeadingFrontierEntry | null {
    const sourceFrom = block.payload.range?.from;
    if (typeof sourceFrom !== "number" || !Number.isSafeInteger(sourceFrom)
      || sourceFrom < 0 || sourceFrom > this.sourceDocument.length) {
      return null;
    }
    return {
      sourceFrom,
      baseSlug: this.rootHeadingBaseSlug(block),
      heading,
      blockIndex,
    };
  }

  private replaceRootHeadingFrontier(
    entries: RootHeadingFrontierEntry[],
    headingCount: number,
    sourceQualified: boolean,
  ): void {
    const offsetsBySlug = new Map<string, number[]>();
    let valid = sourceQualified && entries.length === headingCount;
    let previousFrom = -1;
    let previousBlockIndex = -1;
    for (const entry of entries) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      if (entry.sourceFrom < previousFrom || entry.blockIndex <= previousBlockIndex) {
        valid = false;
      }
      previousFrom = entry.sourceFrom;
      previousBlockIndex = entry.blockIndex;
      let offsets = offsetsBySlug.get(entry.baseSlug);
      if (!offsets) {
        offsets = [];
        offsetsBySlug.set(entry.baseSlug, offsets);
      }
      offsets.push(entry.sourceFrom);
    }
    this.rootHeadingFrontier = valid ? entries : [];
    this.rootHeadingCountOffsets = valid ? offsetsBySlug : new Map<string, number[]>();
    this.rootHeadingFrontierGeneration = this.documentGeneration;
    this.rootHeadingFrontierSourceLength = this.sourceDocument.length;
    this.rootHeadingFrontierValid = valid;
  }

  private maybeBuildTocPatchForBlocks(
    blocks: Block[],
  ): { patch: Patch | null; nextHeadings: TocHeading[]; nextSignature: string } {
    const entries: RootHeadingFrontierEntry[] = [];
    let sourceQualified = true;
    const result = maybeBuildTocPatch(blocks, this.tocSignature, (block, heading, blockIndex) => {
      const entry = this.rootHeadingFrontierEntry(block, heading, blockIndex);
      if (!entry) {
        sourceQualified = false;
        return;
      }
      entries.push(entry);
    });
    this.replaceRootHeadingFrontier(entries, result.nextHeadings.length, sourceQualified);
    return result;
  }

  private rootHeadingCountBefore(baseSlug: string, sourceBefore: number): number {
    const offsets = this.rootHeadingCountOffsets.get(baseSlug);
    if (!offsets) return 0;
    let low = 0;
    let high = offsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      if (offsets[middle]! < sourceBefore) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private nextHeadingIdCount(baseSlug: string): number {
    const overrides = this.rootHeadingIdCountOverrides;
    if (!overrides) {
      const count = (this.headingIdCounts.get(baseSlug) ?? 0) + 1;
      this.headingIdCounts.set(baseSlug, count);
      return count;
    }
    const count = (overrides.get(baseSlug) ?? this.rootHeadingCountBefore(baseSlug, this.rootHeadingIdCountBoundary)) + 1;
    overrides.set(baseSlug, count);
    return count;
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
      readonly inlineRefreshes?: readonly { readonly previous: Block; readonly current: Block }[];
      readonly rebuild?: boolean;
    } = {},
    previousRootOwnerWindow?: {
      readonly codeOwners: readonly RootCodeSourceOwner[];
      readonly tableOwners: readonly RootTableSourceOwner[];
      readonly prefixCounts: {
        readonly code: number;
        readonly table: number;
        readonly paragraph: number;
      };
    },
  ): Promise<void> {
    this.performanceTimer.mark("incremental-parse");
    metrics?.markParseStart();
    this.deferredPatchQueue = [];
    const previousBlocks = this.blocks;
    if (previousRootParagraphOwners === this.rootParagraphOwners
      && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(this.rootParagraphOwners.length, "engine");
    }
    const previousRootParagraphOwnerSnapshot = previousRootParagraphOwners === this.rootParagraphOwners
      ? this.rootParagraphOwners.slice()
      : previousRootParagraphOwners;
    if (!previousRootOwnerWindow?.codeOwners
      && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(this.rootCodeOwners.length, "engine");
    }
    const previousRootCodeOwnerSnapshot = previousRootOwnerWindow?.codeOwners
      ?? this.rootCodeOwners.filter((owner) => this.emittedRootCodeIds.has(owner.id));
    if (!previousRootOwnerWindow?.tableOwners
      && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(this.rootTableOwners.length, "engine");
    }
    const previousRootTableOwnerSnapshot = previousRootOwnerWindow?.tableOwners
      ?? this.rootTableOwners.filter((owner) => this.emittedRootTableIds.has(owner.id));
    const source = this.sourceDocument.snapshot();
    if (oldLength > 0
      && newLength > oldLength
      && source.read(oldLength - 1, oldLength) === "\r"
      && source.read(oldLength, oldLength + 1) === "\n") {
      tailOffset = Math.min(tailOffset, oldLength - 1);
    }
    const continuationStart = this.rootQuoteContinuationStart(source, oldLength, newLength, previousBlocks);
    if (continuationStart !== undefined) tailOffset = Math.min(tailOffset, continuationStart);
    if (this.rootNativeFragmentOffset !== tailOffset) this.treeFragments = [];
    let fragmentRestartFrom = continuationStart ?? oldLength;
    if (continuationStart === undefined && this.treeFragments.length > 0) {
      // Root-tail fragments must reopen the trailing unfinished generic root on append.
      if ((this.extensions?.documentPlugins?.length ?? 0) > 0) {
        this.forEachUnfinishedRootBlock((block) => {
          const from = block.payload.range?.from;
          if (typeof from !== "number" || !Number.isSafeInteger(from) || from < 0 || from > oldLength) return;
          if (from < tailOffset) {
            tailOffset = from;
            this.treeFragments = [];
          } else {
            fragmentRestartFrom = Math.min(fragmentRestartFrom, from);
          }
        });
      } else {
        const previousRootIndex = rootSourceBoundary(
          this.blocks,
          oldLength,
          rootBlockSourceFrom,
          typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
            ? this.campaignCounters
            : undefined,
        );
        const previousRootBlock = previousRootIndex > 0 ? this.blocks[previousRootIndex - 1] : undefined;
        const from = previousRootBlock?.payload.range?.from;
        if (previousRootBlock && !previousRootBlock.isFinalized
          && typeof from === "number"
          && Number.isSafeInteger(from)
          && from >= 0
          && from <= oldLength) {
          if (from < tailOffset) {
            tailOffset = from;
            this.treeFragments = [];
          } else {
            fragmentRestartFrom = Math.min(fragmentRestartFrom, from);
          }
        }
      }
    }
    const sourceInput = new SourceRangeInput(source, tailOffset, newLength);
    const input = new NativeMarkdownInput(sourceInput);
    const updatedFragments = TreeFragment.applyChanges(
      this.treeFragments,
      [appendFragmentChange(source, tailOffset, oldLength, newLength, fragmentRestartFrom)],
      continuationStart === undefined && fragmentRestartFrom === oldLength ? 128 : 0,
    );
    const tree = input.parse(this.mdParser, updatedFragments);
    const nestedNativeContainerStarts = new Set<number>();
    const htmlDependentStarts = new Set<number>();
    rootNativeOwnerStartsInsideOpenHtml(
      tree,
      source,
      tailOffset,
      this.mdParser,
      this.mdxEnabled,
      nestedNativeContainerStarts,
      htmlDependentStarts,
      (raw) => this.rootParagraphContainsInlineHtml(raw),
    );
    this.retireRootOwnersReclassifiedBy(tree, tailOffset);
    this.retireRootOwnersInHtmlRegions(htmlDependentStarts);
    this.retireNativeOwnersInMdxContainers(nestedNativeContainerStarts);
    let createdOwners = this.nativeOwnershipDeclinedByContentPolicy()
      ? []
      : typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? createRootCodeOwners(tree, this.sourceDocument, this.rootNativeOwnerGeneration, tailOffset, this.campaignCounters, htmlDependentStarts, this.rootCodeOwnersByStart)
      : createRootCodeOwners(tree, this.sourceDocument, this.rootNativeOwnerGeneration, tailOffset, undefined, htmlDependentStarts, this.rootCodeOwnersByStart);

    const tailReferences = collectLinkReferences(tree, sourceInput);
    const tailReferenceStarts = collectLinkReferenceStarts(tree, sourceInput, tailOffset, tailReferences);
    const combinedReferences = new Map(this.currentLinkReferences);
    const combinedReferenceStarts = new Map(this.currentLinkReferenceStarts);
    // The reparsed suffix owns definitions at/after its start, including ones now incomplete.
    for (const [label, start] of combinedReferenceStarts) {
      if (start < tailOffset) continue;
      combinedReferenceStarts.delete(label);
      combinedReferences.delete(label);
    }
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
    const createdTableOwners = this.nativeOwnershipDeclinedByContentPolicy()
      ? []
      : typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? createRootTableOwners(
        tree,
        this.sourceDocument,
        this.rootNativeOwnerGeneration,
        this.mdParser,
        this.inlineParser,
        this.rootTableExtensionContext(),
        tailOffset,
        forceFinalize,
        this.campaignCounters,
        htmlDependentStarts,
      )
      : createRootTableOwners(
        tree,
        this.sourceDocument,
        this.rootNativeOwnerGeneration,
        this.mdParser,
        this.inlineParser,
        this.rootTableExtensionContext(),
        tailOffset,
        forceFinalize,
        undefined,
        htmlDependentStarts,
      );
    this.registerRootTableOwners(createdTableOwners);

    const existingRootParagraphCount = this.rootParagraphOwners.length;
    const createdParagraphOwners = this.registerRootParagraphOwners(
      this.admitRootParagraphOwners(tree, tailOffset, forceFinalize, htmlDependentStarts),
    );
    const rootParagraphSemanticPatches: Patch[] = [];
    const tableSemanticPatches: Patch[] = [];
    const linkReferenceTargets: FootnoteParagraphTargetDelta[] = [];
    if (changedLabels.size > 0) {
      const linkReferencePatches = this.invalidateLinkReferenceOwners(
        changedLabels,
        existingRootParagraphCount,
        existingRootTableCount,
      );
      rootParagraphSemanticPatches.push(...linkReferencePatches.paragraphPatches);
      tableSemanticPatches.push(...linkReferencePatches.tablePatches);
      linkReferenceTargets.push(...linkReferencePatches.paragraphTargets);
    }

    // This source-qualified frontier contains only top-level generic headings retained in the current generation.
    const reuseRootHeadingFrontier = this.canSeedRootHeadingCounts(oldLength);
    this.headingIdCounts = new Map<string, number>();
    if (reuseRootHeadingFrontier) {
      this.rootHeadingIdCountOverrides = new Map<string, number>();
      this.rootHeadingIdCountBoundary = tailOffset;
    } else {
      this.rootHeadingIdCountOverrides = null;
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(previousBlocks.length, "engine");
      }
      for (const block of previousBlocks) {
        if (block.type !== "heading" || (block.payload.range?.from ?? tailOffset) >= tailOffset) continue;
        const headingText = (block.payload.meta as { headingText?: string } | undefined)?.headingText ?? block.payload.raw;
        const baseSlug = slugifyHeading(headingText) || "heading";
        this.headingIdCounts.set(baseSlug, (this.headingIdCounts.get(baseSlug) ?? 0) + 1);
      }
    }
    let parsedTailBlocks: Block[];
    try {
      parsedTailBlocks = await this.extractBlocks(
        tree,
        sourceInput,
        {
          sourceOffset: tailOffset,
          continueHeadingIds: true,
          ...(forceFinalize ? { forceFinalize: true } : {}),
        },
        nestedNativeContainerStarts,
      );
    } finally {
      this.rootHeadingIdCountOverrides = null;
      this.rootHeadingIdCountBoundary = 0;
    }
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(parsedTailBlocks.length, "engine");
    }
    const tailBlocks = parsedTailBlocks.filter((block) => {
      const from = block.payload.range?.from;
      return !this.isRootOwnedBlock(block) && (
        typeof from !== "number" || (
          !this.rootTableOwnersByStart.has(from) &&
          !this.rootParagraphOwnersByStart.has(from)
        )
      );
    });
    const documentContextTailBlocks = this.excludeRootCodeBlocksFromDocumentContext(tailBlocks, createdOwners);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(createdTableOwners.length, "engine");
    }
    const activeCreatedTableOwners = createdTableOwners.filter((owner) =>
      this.rootTableOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(createdParagraphOwners.length, "engine");
    }
    const activeCreatedParagraphOwners = createdParagraphOwners.filter((owner) =>
      this.rootParagraphOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner);

    // Root-tail parsing can leave the just-closed container in the stable prefix; finalize only that predecessor.
    let closedStableNativePredecessorId: string | undefined;
    if (this.nativeContainerActivePathSnapshots.size > 0) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(this.blocks.length, "engine");
      }
      for (const block of this.blocks) {
        const range = block.payload.range;
        if (!block.isFinalized
          && (block.type === "list" || block.type === "blockquote")
          && this.nativeContainerActivePathSnapshots.has(block.id)
          && !this.nativeContainerTails.has(block.id)
          && typeof range?.from === "number"
          && range.from < tailOffset
          && typeof range.to === "number"
          && range.to <= tailOffset
          && hasSourceAfterRange(source, range.to)) {
          closedStableNativePredecessorId = block.id;
        }
      }
    }
    const hasCustomDocumentPlugins = (this.extensions?.documentPlugins?.length ?? 0) > 0
      || this.documentPluginRegistry.some(isCustomDocumentPlugin);
    let stableBlocks: Block[];
    const createdParagraphTargets = activeCreatedParagraphOwners
      .map((owner) => this.rootParagraphFootnoteTargetDelta(owner, owner.getSpans().materialize()));
    const removedParagraphOwners = previousRootParagraphOwnerSnapshot
      .filter((owner) => {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        return this.rootParagraphOwnersByStart.get(owner.getMetadata().sourceRange.from) !== owner;
      })
      .map((owner) => {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        return owner.id;
      });
    const removedOwnerIds = Array.from(new Set([
      ...(footnoteTargets.removedOwnerIds ?? []),
      ...removedParagraphOwners,
    ]));
    let previousBlockPrefixCount: number | undefined;
    let previousGenericSuffix: Block[] | undefined;
    // Finalized snapshots remain for diffing; tails, frontiers, and owner ledgers track unfinished work.
    const nativeContainerActiveStateEmpty = this.nativeContainerTails.size === 0
      && this.nativeFenceHeaderFrontiers.size === 0
      && this.unfinishedNestedCodeOwnerIds.size === 0
      && this.unfinishedNestedTableOwnerIds.size === 0
      && this.unfinishedNestedParagraphOwnerIds.size === 0;
    const nativeParagraphTargetsAreBounded = this.nestedParagraphFootnoteTargetOwnerIds.size === 0
      && (previousRootOwnerWindow !== undefined
        || (this.rootParagraphOwners.length === 0
          && previousRootParagraphOwnerSnapshot.length === 0
          && activeCreatedParagraphOwners.length === 0
          && removedOwnerIds.length === 0));
    const rootInsertBeforeTail = extraPatches.some((patch) =>
      patch.op === "insertChild"
      && patch.at.blockId === PATCH_ROOT_ID
      && (patch.node.range?.from ?? 0) < tailOffset);
    if (forceFinalize
      && changedLabels.size === 0
      && nativeContainerActiveStateEmpty
      && nativeParagraphTargetsAreBounded
      && this.openRootCodeOwners.size === 0
      && this.openRootTableOwners.size === 0
      && this.openRootParagraphOwners.size === 0
      && this.activeNestedCodeByContainer.size === 0
      && this.activeNestedParagraphByContainer.size === 0
      && this.activeNestedTableByContainer.size === 0
      && !rootInsertBeforeTail
      && Number.isSafeInteger(tailOffset)
      && tailOffset >= 0
      && tailOffset <= source.length
      && this.hasNoFootnoteArtifactsForSource(source, false, tailOffset, footnoteTargets)) {
      let unfinishedTailIsReparsed = true;
      this.forEachUnfinishedRootBlock((block) => {
        const from = block.payload.range?.from;
        if (typeof from !== "number" || from < tailOffset) unfinishedTailIsReparsed = false;
      });
      const counters = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? this.campaignCounters
        : undefined;
      const retainedPrefixCount = rootSourceBoundary(
        previousBlocks,
        tailOffset,
        rootBlockSourceFrom,
        counters,
      );
      const retainedPrefixTail = retainedPrefixCount > 0 ? previousBlocks[retainedPrefixCount - 1] : undefined;
      if (unfinishedTailIsReparsed && (!retainedPrefixTail || retainedPrefixTail.isFinalized)) {
        previousBlockPrefixCount = retainedPrefixCount;
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(previousBlocks.length - retainedPrefixCount, "engine");
        }
        previousGenericSuffix = previousBlocks.slice(retainedPrefixCount);
      }
    }
    stableBlocks = [];
    if (previousBlockPrefixCount === undefined) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(this.blocks.length, "engine");
      }
      stableBlocks = this.blocks
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
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          const finalized = forceFinalize || block.id === closedStableNativePredecessorId;
          if (hasCustomDocumentPlugins) {
            const stable = cloneBlock(block);
            if (finalized) stable.isFinalized = true;
            return stable;
          }
          return finalized && !block.isFinalized ? { ...block, isFinalized: true } : block;
        });
    }
    if (previousBlockPrefixCount === undefined
      && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(this.blocks.length, "engine");
    }
    const previouslyProvisionalIds = previousBlockPrefixCount === undefined
      ? new Set(this.blocks
        .filter((block) => !block.isFinalized)
        .map((block) => {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          return block.id;
        }))
      : new Set<string>();
    const inlineRefreshes: { previous: Block; current: Block }[] = [];
    let nativeFootnotesChanged = false;
    if (previousBlockPrefixCount === undefined) {
      for (const block of tailBlocks) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        if (this.footnoteSourceNeedsNumbering(block, oldLength, previouslyProvisionalIds)) {
          nativeFootnotesChanged = true;
          break;
        }
        const sourceStart = block.payload.range?.from;
        if (typeof sourceStart !== "number" || (!block.payload.raw.includes("[^") && !block.payload.raw.includes("&"))) continue;
        let low = 0;
        let high = previousBlocks.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          const previousStart = previousBlocks[middle]?.payload.range?.from ?? Number.POSITIVE_INFINITY;
          if (previousStart < sourceStart) low = middle + 1;
          else high = middle;
        }
        for (let index = low; index < previousBlocks.length; index += 1) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          const previous = previousBlocks[index];
          if (!previous || previous.payload.range?.from !== sourceStart) break;
          if (previous.type === block.type && previous.payload.raw === block.payload.raw) {
            inlineRefreshes.push({ previous, current: block });
            break;
          }
        }
      }
    }
    if (nativeFootnotesChanged) inlineRefreshes.length = 0;
    // Invalidated spans follow the caller's append deltas, which can predate them.
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(
        (footnoteTargets.deltas?.length ?? 0) + linkReferenceTargets.length + createdParagraphTargets.length,
        "engine",
      );
    }
    const paragraphDeltas = [...(footnoteTargets.deltas ?? []), ...linkReferenceTargets, ...createdParagraphTargets];
    const rebuildParagraphTargets = Boolean(footnoteTargets.rebuild)
      || nativeFootnotesChanged
      || removedOwnerIds.length > 0
      || forceFinalize;
    const paragraphBridge = this.rootParagraphOwners.length > 0
      || this.nestedParagraphOwners.size > 0
      || this.nestedTableOwners.size > 0
      || removedOwnerIds.length > 0
      || inlineRefreshes.length > 0
      ? {
          deltas: paragraphDeltas,
          ...(removedOwnerIds.length > 0 ? { removedOwnerIds } : {}),
          ...(inlineRefreshes.length > 0 ? { inlineRefreshes } : {}),
          rebuild: rebuildParagraphTargets,
        }
      : undefined;
    await this.prepareTrustedMdxFlowChildrenForBlocks(
      tailBlocks,
      previousGenericSuffix ?? this.blocks,
      changedLabels,
    );
    let documentBlocks: Block[];
    if (previousBlockPrefixCount !== undefined) {
      // `blocks` is private worker state; only snapshots/materializations escape this engine.
      this.blocks.length = previousBlockPrefixCount;
      for (const block of documentContextTailBlocks) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        this.blocks.push(block);
      }
      documentBlocks = this.blocks;
    } else {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(stableBlocks.length + documentContextTailBlocks.length, "engine");
      }
      documentBlocks = [...stableBlocks, ...documentContextTailBlocks];
    }
    if (changedLabels.size > 0
      && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(documentBlocks.length, "engine");
    }
    if (changedLabels.size > 0 && await this.refreshLinkReferenceDependents(documentBlocks, changedLabels) && paragraphBridge) {
      paragraphBridge.rebuild = true;
    }
    this.pendingRootParagraphPatches = [];
    let changedBlocks = this.runDocumentPlugins(
      documentBlocks,
      source,
      paragraphBridge,
      previousBlockPrefixCount === undefined ? undefined : tailOffset,
      previousBlockPrefixCount !== undefined,
      previousBlockPrefixCount,
      previousRootOwnerWindow?.prefixCounts.code,
    );
    rootParagraphSemanticPatches.push(...this.takePendingRootParagraphPatches());
    this.registerRootCodeOwners(createdOwners);
    if (createdOwners.length > 0 && previousBlockPrefixCount === undefined) {
      const rootCodeIds = new Set(createdOwners.map((owner) => owner.id));
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(changedBlocks.length, "engine");
      }
      changedBlocks = changedBlocks.filter((block) => !rootCodeIds.has(block.id));
    }
    tableSemanticPatches.push(...this.takePendingRootTablePatches());
    if (previousBlockPrefixCount === undefined) {
      this.retireDisplacedNativeContainers(previousBlocks, changedBlocks, tailOffset);
    }
    this.blocks = changedBlocks;
    this.treeFragments = TreeFragment.addTree(tree, updatedFragments);
    this.rootNativeFragmentOffset = tailOffset;
    this.lastTree = tree;
    if (this.lazyTokenizationStates.size > 0
      && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(this.blocks.length, "engine");
    }
    pruneLazyTokenizationStates(this.lazyTokenizationStates, this.blocks);

    const rootCodePatches: Patch[] = [];
    for (const owner of createdOwners) {
      await this.decorateRootCode(owner);
      if (!this.emittedRootCodeIds.has(owner.id)) {
        rootCodePatches.push(this.rootCodeInsertPatch(owner));
        this.markRootCodeOwnerEmitted(owner);
      }
    }
    for (const owner of activeCreatedTableOwners) {
      if (!this.emittedRootTableIds.has(owner.id)) {
        tableSemanticPatches.push(this.rootTableInsertPatch(owner));
        this.markRootTableOwnerEmitted(owner);
      }
    }
    const rootParagraphPatches: Patch[] = [];
    for (const owner of activeCreatedParagraphOwners) {
      if (!this.emittedRootParagraphIds.has(owner.id)) {
        rootParagraphPatches.push(this.rootParagraphInsertPatch(owner));
        this.markRootParagraphOwnerEmitted(owner);
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
      previousGenericSuffix ?? previousBlocks,
      changedBlocks,
      changeRanges,
      metrics,
      progressPublication,
      undefined,
      rootCodePatches.concat(rootParagraphPatches, extraPatches, rootParagraphSemanticPatches, tableSemanticPatches),
      previousRootParagraphOwnerSnapshot,
      previousRootCodeOwnerSnapshot,
      previousRootTableOwnerSnapshot,
      forceFinalize && (this.extensions?.documentPlugins?.length ?? 0) === 0 ? tailOffset : undefined,
      previousRootOwnerWindow?.prefixCounts,
      previousBlockPrefixCount,
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

  private projectNativeContainerBlockForExport(block: Block): Block {
    const projected = cloneBlock(block);
    const meta = projected.payload.meta;
    const prepared = meta?.preparedNested as PreparedNestedSnapshot | undefined;
    if (!meta || !prepared) return projected;
    const refresh = (snapshots: NodeSnapshot[]): NodeSnapshot[] => {
      let refreshed: NodeSnapshot[] | undefined;
      for (let index = 0; index < snapshots.length; index += 1) {
        const snapshot = snapshots[index];
        const codeOwner = this.nestedCodeOwners.get(snapshot.id);
        const paragraphOwner = this.nestedParagraphOwners.get(snapshot.id);
        const tableOwner = this.nestedTableOwners.get(snapshot.id);
        let next = snapshot;
        if (codeOwner) {
          next = cloneNativeSnapshot(mutableNativeOwnerSnapshot(
            codeOwner.snapshot(this.rootCodeConfigurationRevision),
            codeOwner.getMetadata().sourceRange,
          ));
        } else if (paragraphOwner) {
          const metadata = paragraphOwner.getMetadata();
          if (snapshot.paragraph?.revision !== metadata.revision
            || snapshot.range?.from !== metadata.sourceRange.from
            || snapshot.range?.to !== metadata.sourceRange.to) {
            next = {
              ...snapshot,
              range: { ...metadata.sourceRange },
              paragraph: paragraphOwner.createSnapshot(),
            };
          }
        } else if (tableOwner) {
          const metadata = tableOwner.getMetadata();
          if (snapshot.table?.revision !== metadata.revision
            || snapshot.range?.from !== metadata.sourceRange.from
            || snapshot.range?.to !== metadata.sourceRange.to) {
            next = cloneNativeSnapshot(mutableNativeOwnerSnapshot(
              rootTableNodeSnapshot(tableOwner),
              metadata.sourceRange,
            ));
          }
        } else if (snapshot.children) {
          const children = refresh(snapshot.children);
          if (children !== snapshot.children) next = { ...snapshot, children };
        }
        if (next !== snapshot) {
          refreshed ??= snapshots.slice();
          refreshed[index] = next;
        }
      }
      return refreshed ?? snapshots;
    };
    const children = refresh(prepared.children);
    if (children !== prepared.children) {
      projected.payload.meta = { ...meta, preparedNested: { ...prepared, children } };
    }
    return projected;
  }

  private createRootSnapshot(blocks: readonly Block[]): NodeSnapshot {
    const children: Array<{ from: number; node: NodeSnapshot }> = [];
    for (const block of blocks) {
      const node = createBlockSnapshot(this.projectNativeContainerBlockForExport(block));
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
      this.publishParagraphLinkReferences(owner);
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

  private materializeRootBlocks(nativeBlocks: readonly Block[] = this.blocks, refreshNativeOwners = true): Block[] {
    const entries: Array<{ from: number; block: Block }> = nativeBlocks.map((block) => ({
      from: block.payload.range?.from ?? Number.POSITIVE_INFINITY,
      block: refreshNativeOwners ? this.projectNativeContainerBlockForExport(block) : block,
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
    const input = new NativeMarkdownInput(rawInput);
    const tree = input.parse(this.mdParser);
    this.treeFragments = TreeFragment.addTree(tree);
    this.currentLinkReferences = collectLinkReferences(tree, rawInput);
    this.currentLinkReferenceStarts = collectLinkReferenceStarts(tree, rawInput, 0, this.currentLinkReferences);
    this.inlineParser.setReferences(this.currentLinkReferences);
    const previousRootParagraphOwners = this.rootParagraphOwners.slice();
    const nestedNativeContainerStarts = new Set<number>();
    const htmlDependentStarts = new Set<number>();
    rootNativeOwnerStartsInsideOpenHtml(
      tree,
      rawInput,
      0,
      this.mdParser,
      this.mdxEnabled,
      nestedNativeContainerStarts,
      htmlDependentStarts,
      (raw) => this.rootParagraphContainsInlineHtml(raw),
    );
    this.retireRootOwnersReclassifiedBy(tree, 0);
    this.retireRootOwnersInHtmlRegions(htmlDependentStarts);
    this.retireNativeOwnersInMdxContainers(nestedNativeContainerStarts);
    let createdRootCodeOwners = options.admitRootCodeOwners && !this.nativeOwnershipDeclinedByContentPolicy()
      ? typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? createRootCodeOwners(tree, this.sourceDocument, this.rootNativeOwnerGeneration, 0, this.campaignCounters, htmlDependentStarts, this.rootCodeOwnersByStart)
        : createRootCodeOwners(tree, this.sourceDocument, this.rootNativeOwnerGeneration, 0, undefined, htmlDependentStarts, this.rootCodeOwnersByStart)
      : [];
    if (options.admitRootTableOwners && !this.nativeOwnershipDeclinedByContentPolicy()) {
      this.registerRootTableOwners(
        typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
          ? createRootTableOwners(
            tree,
            this.sourceDocument,
            this.rootNativeOwnerGeneration,
            this.mdParser,
            this.inlineParser,
            this.rootTableExtensionContext(),
            0,
            Boolean(options.forceFinalize),
            this.campaignCounters,
            htmlDependentStarts,
          )
          : createRootTableOwners(
            tree,
            this.sourceDocument,
            this.rootNativeOwnerGeneration,
            this.mdParser,
            this.inlineParser,
            this.rootTableExtensionContext(),
            0,
            Boolean(options.forceFinalize),
            undefined,
            htmlDependentStarts,
          ),
      );
    }
    const createdParagraphOwners = options.admitRootParagraphOwners
      ? this.registerRootParagraphOwners(
          this.admitRootParagraphOwners(tree, 0, Boolean(options.forceFinalize), htmlDependentStarts),
        )
      : [];
    let extractedBlocks = await this.extractBlocks(
      tree,
      rawInput,
      options,
      nestedNativeContainerStarts,
    );
    extractedBlocks = this.excludeRootCodeBlocksFromDocumentContext(
      extractedBlocks,
      createdRootCodeOwners,
    ).filter((block) => !this.isRootOwnedBlock(block));
    const source = this.sourceDocument.snapshot();
    const paragraphTargets = createdParagraphOwners
      .filter((owner) => this.rootParagraphOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner)
      .map((owner) => this.rootParagraphFootnoteTargetDelta(owner, owner.getSpans().materialize()));
    const removedParagraphOwnerIds = previousRootParagraphOwners
      .filter((owner) => !this.rootParagraphOwners.includes(owner))
      .map((owner) => owner.id);
    this.pendingRootParagraphPatches = [];
    await this.prepareTrustedMdxFlowChildrenForBlocks(extractedBlocks, this.blocks);
    extractedBlocks = this.runDocumentPlugins(
      extractedBlocks,
      source,
      createdParagraphOwners.length > 0
      || removedParagraphOwnerIds.length > 0
      || this.nestedParagraphOwners.size > 0
      || this.nestedTableOwners.size > 0
        ? {
            deltas: paragraphTargets,
            ...(removedParagraphOwnerIds.length > 0 ? { removedOwnerIds: removedParagraphOwnerIds } : {}),
            rebuild: true,
          }
        : undefined,
    );
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

  private async appendAndReparse(
    appendedText: string,
    metrics?: WorkerMetricsCollector,
    sourceAlreadyAppended = false,
    parseAlreadyMarked = false,
  ): Promise<void> {
    if (!parseAlreadyMarked) {
      this.performanceTimer.mark("incremental-parse");
      metrics?.markParseStart();
    }
    this.deferredPatchQueue = [];
    const previousRootParagraphOwners = this.rootParagraphOwners.slice();
    const previousRootCodeOwners = this.rootCodeOwners.filter((owner) => this.emittedRootCodeIds.has(owner.id));
    const previousRootTableOwners = this.rootTableOwners.filter((owner) => this.emittedRootTableIds.has(owner.id));

    const oldLen = sourceAlreadyAppended
      ? this.sourceDocument.length - appendedText.length
      : this.sourceDocument.length;
    if (!sourceAlreadyAppended) this.sourceDocument.append(appendedText);
    const source = this.sourceDocument.snapshot();
    const newLen = this.sourceDocument.length;
    const continuationStart = this.rootQuoteContinuationStart(source, oldLen, newLen, this.blocks);
    // Semantic source remains append-only even when fragment reuse restarts at an open root.
    const changeRanges: ContentChangeRange[] = appendedText.length > 0 ? [{ fromA: oldLen, toA: oldLen, fromB: oldLen, toB: newLen }] : [];
    // Root native tail parses leave fragments positioned relative to their tail window; a document-rooted
    // parse cannot reuse them. The fragments stored below are document-rooted, so no tail window applies.
    if (this.rootNativeFragmentOffset !== null && this.rootNativeFragmentOffset !== 0) this.treeFragments = [];
    this.rootNativeFragmentOffset = null;
    let fragmentRestartFrom = continuationStart ?? oldLen;
    if (continuationStart === undefined && this.treeFragments.length > 0) {
      // Later lines can reclassify the trailing unfinished root, so don't reuse its old tree node.
      if ((this.extensions?.documentPlugins?.length ?? 0) > 0) {
        this.forEachUnfinishedRootBlock((block) => {
          const from = block.payload.range?.from;
          if (typeof from === "number"
            && Number.isSafeInteger(from)
            && from >= 0
            && from <= oldLen) {
            fragmentRestartFrom = Math.min(fragmentRestartFrom, from);
          }
        });
      } else {
        const previousRootIndex = rootSourceBoundary(
          this.blocks,
          oldLen,
          rootBlockSourceFrom,
          typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
            ? this.campaignCounters
            : undefined,
        );
        const previousRootBlock = previousRootIndex > 0 ? this.blocks[previousRootIndex - 1] : undefined;
        const from = previousRootBlock?.payload.range?.from;
        if (previousRootBlock && !previousRootBlock.isFinalized
          && typeof from === "number"
          && Number.isSafeInteger(from)
          && from >= 0
          && from <= oldLen) {
          fragmentRestartFrom = Math.min(fragmentRestartFrom, from);
        }
      }
    }
    const updatedFragments = TreeFragment.applyChanges(
      this.treeFragments,
      [appendFragmentChange(source, 0, oldLen, newLen, fragmentRestartFrom)],
      continuationStart === undefined && fragmentRestartFrom === oldLen ? 128 : 0,
    );
    const nativeInput = new NativeMarkdownInput(source);
    let newTree = nativeInput.parse(this.mdParser, updatedFragments);
    const nestedNativeContainerStarts = new Set<number>();
    const htmlDependentStarts = new Set<number>();
    rootNativeOwnerStartsInsideOpenHtml(
      newTree,
      source,
      0,
      this.mdParser,
      this.mdxEnabled,
      nestedNativeContainerStarts,
      htmlDependentStarts,
      (raw) => this.rootParagraphContainsInlineHtml(raw),
    );
    this.retireRootOwnersReclassifiedBy(newTree, 0);
    this.retireRootOwnersInHtmlRegions(htmlDependentStarts);
    this.retireNativeOwnersInMdxContainers(nestedNativeContainerStarts);
    let createdRootCodeOwners = !this.nativeOwnershipDeclinedByContentPolicy()
      ? typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? createRootCodeOwners(newTree, this.sourceDocument, this.rootNativeOwnerGeneration, 0, this.campaignCounters, htmlDependentStarts, this.rootCodeOwnersByStart, fragmentRestartFrom)
        : createRootCodeOwners(newTree, this.sourceDocument, this.rootNativeOwnerGeneration, 0, undefined, htmlDependentStarts, this.rootCodeOwnersByStart, fragmentRestartFrom)
      : [];
    this.treeFragments = TreeFragment.addTree(newTree, updatedFragments);
    const newReferences = collectLinkReferences(newTree, source);
    const changedLabels = diffLinkReferences(this.currentLinkReferences, newReferences);
    this.currentLinkReferences = newReferences;
    this.currentLinkReferenceStarts = collectLinkReferenceStarts(newTree, source, 0, newReferences);
    this.inlineParser.setReferences(newReferences);
    const linkReferencePatches = changedLabels.size > 0
      ? this.invalidateLinkReferenceOwners(changedLabels)
      : undefined;
    let fallbackLinkReferencePatches: typeof linkReferencePatches = undefined;
    let createdRootTableOwners = this.rootTableOwners.length === 0 && !this.nativeOwnershipDeclinedByContentPolicy()
      ? typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? createRootTableOwners(
          newTree,
          this.sourceDocument,
          this.rootNativeOwnerGeneration,
          this.mdParser,
          this.inlineParser,
          this.rootTableExtensionContext(),
          0,
          false,
          this.campaignCounters,
          htmlDependentStarts,
        )
        : createRootTableOwners(
          newTree,
          this.sourceDocument,
          this.rootNativeOwnerGeneration,
          this.mdParser,
          this.inlineParser,
          this.rootTableExtensionContext(),
          0,
          false,
          undefined,
          htmlDependentStarts,
        )
      : [];
    this.registerRootTableOwners(createdRootTableOwners);
    const createdRootParagraphOwners = this.registerRootParagraphOwners(
      this.admitRootParagraphOwners(newTree, 0, false, htmlDependentStarts),
    );

    let changedBlocks = await this.extractBlocks(
      newTree,
      source,
      {
        firstChangedPos: oldLen,
        previousBlocks: this.blocks,
      },
      nestedNativeContainerStarts,
    );
    await this.prepareTrustedMdxFlowChildrenForBlocks(changedBlocks, this.blocks, changedLabels);
    const previouslyProvisionalIds = new Set(this.blocks.filter((block) => !block.isFinalized).map((block) => block.id));
    const appendedFootnotesChanged = appendedText.includes("[^") || appendedText.includes("&")
      || changedBlocks.some((block) => this.footnoteSourceNeedsNumbering(block, oldLen, previouslyProvisionalIds));
    const documentContextBlocks = this.excludeRootCodeBlocksFromDocumentContext(changedBlocks, createdRootCodeOwners);
    const removedParagraphOwnerIds = previousRootParagraphOwners
      .filter((owner) => !this.rootParagraphOwners.includes(owner))
      .map((owner) => owner.id);
    let activeCreatedRootTableOwners = createdRootTableOwners.filter((owner) =>
      this.rootTableOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner);
    let activeCreatedRootParagraphOwners = createdRootParagraphOwners.filter((owner) =>
      this.rootParagraphOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner);
    const paragraphTargets = [
      ...(linkReferencePatches?.paragraphTargets ?? []),
      ...activeCreatedRootParagraphOwners
        .map((owner) => this.rootParagraphFootnoteTargetDelta(owner, owner.getSpans().materialize())),
    ];
    const linkReferencesRefreshed = changedLabels.size > 0
      && await this.refreshLinkReferenceDependents(documentContextBlocks, changedLabels);
    this.pendingRootParagraphPatches = [];
    changedBlocks = this.runDocumentPlugins(
      documentContextBlocks,
      source,
      paragraphTargets.length > 0
      || removedParagraphOwnerIds.length > 0
      || this.nestedParagraphOwners.size > 0
      || this.nestedTableOwners.size > 0
        ? {
            deltas: paragraphTargets,
            ...(removedParagraphOwnerIds.length > 0 ? { removedOwnerIds: removedParagraphOwnerIds } : {}),
            rebuild: appendedFootnotesChanged || removedParagraphOwnerIds.length > 0 || linkReferencesRefreshed,
          }
        : undefined,
    );
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
    let lastTo = 0;
    for (let index = changedBlocks.length - 1; index >= 0; index -= 1) {
      const to = changedBlocks[index]?.payload?.range?.to;
      if (typeof to !== "number") continue;
      lastTo = to;
      break;
    }
    if (createdRootCodeOwners.length === 0
      && activeCreatedRootTableOwners.length === 0
      && activeCreatedRootParagraphOwners.length === 0
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
      fallbackLinkReferencePatches = fullChangedLabels.size > 0
        ? this.invalidateLinkReferenceOwners(fullChangedLabels)
        : undefined;
      const fullHtmlDependentStarts = new Set<number>();
      rootNativeOwnerStartsInsideOpenHtml(
        fullTree,
        source,
        0,
        this.mdParser,
        this.mdxEnabled,
        nestedNativeContainerStarts,
        fullHtmlDependentStarts,
        (raw) => this.rootParagraphContainsInlineHtml(raw),
      );
      this.retireRootOwnersReclassifiedBy(fullTree, 0);
      this.retireRootOwnersInHtmlRegions(fullHtmlDependentStarts);
      createdRootCodeOwners = createdRootCodeOwners.filter((owner) =>
        !fullHtmlDependentStarts.has(owner.getMetadata().sourceRange.from));
      let fullBlocks = await this.extractBlocks(
        fullTree,
        source,
        {},
        nestedNativeContainerStarts,
      );
      fullBlocks = this.excludeRootCodeBlocksFromDocumentContext(fullBlocks, createdRootCodeOwners);
      fullBlocks = fullBlocks.filter((block) => {
        const from = block.payload.range?.from;
        return !this.isRootOwnedBlock(block) && (
          typeof from !== "number" || (
            !this.rootTableOwnersByStart.has(from) &&
            !this.rootParagraphOwnersByStart.has(from)
          )
        );
      });
      const fullRemovedParagraphOwnerIds = previousRootParagraphOwners
        .filter((owner) => !this.rootParagraphOwners.includes(owner))
        .map((owner) => owner.id);
      await this.prepareTrustedMdxFlowChildrenForBlocks(fullBlocks, this.blocks, changedLabels);
      fullBlocks = this.runDocumentPlugins(
        fullBlocks,
        source,
        this.rootParagraphOwners.length > 0
        || fullRemovedParagraphOwnerIds.length > 0
        || this.nestedParagraphOwners.size > 0
        || this.nestedTableOwners.size > 0
          ? {
              deltas: this.rootParagraphOwners.map((owner) =>
                this.rootParagraphFootnoteTargetDelta(owner, owner.getSpans().materialize())),
              ...(fullRemovedParagraphOwnerIds.length > 0 ? { removedOwnerIds: fullRemovedParagraphOwnerIds } : {}),
              rebuild: true,
            }
          : undefined,
      ).filter((block) => {
        const from = block.payload.range?.from;
        return !this.isRootOwnedBlock(block) && (
          typeof from !== "number" || (
            !this.rootTableOwnersByStart.has(from) &&
            !this.rootParagraphOwnersByStart.has(from)
          )
        );
      });
      activeCreatedRootTableOwners = createdRootTableOwners.filter((owner) =>
        this.rootTableOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner);
      activeCreatedRootParagraphOwners = createdRootParagraphOwners.filter((owner) =>
        this.rootParagraphOwnersByStart.get(owner.getMetadata().sourceRange.from) === owner);
      const fullLast = fullBlocks.length > 0 ? fullBlocks[fullBlocks.length - 1]?.payload?.range?.to ?? 0 : 0;
      if (fullLast >= newLen - 1 || fullBlocks.length >= changedBlocks.length) {
        newTree = fullTree;
        changedBlocks = fullBlocks;
      }
    }
    const paragraphSemanticPatches = [
      ...(linkReferencePatches?.paragraphPatches ?? []),
      ...(fallbackLinkReferencePatches?.paragraphPatches ?? []),
      ...this.takePendingRootParagraphPatches(),
    ];
    const tableSemanticPatches = [
      ...(linkReferencePatches?.tablePatches ?? []),
      ...(fallbackLinkReferencePatches?.tablePatches ?? []),
      ...this.takePendingRootTablePatches(),
    ];
    const prevBlocks = this.blocks;

    this.blocks = changedBlocks;
    this.lastTree = newTree;
    if (createdRootCodeOwners.length > 0
      || activeCreatedRootTableOwners.length > 0
      || activeCreatedRootParagraphOwners.length > 0) {
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
        this.markRootCodeOwnerEmitted(owner);
      }
    }
    for (const owner of activeCreatedRootTableOwners) {
      if (!this.emittedRootTableIds.has(owner.id)) {
        rootCodePatches.push(this.rootTableInsertPatch(owner));
        this.markRootTableOwnerEmitted(owner);
      }
    }
    const rootParagraphPatches: Patch[] = [];
    for (const owner of activeCreatedRootParagraphOwners) {
      if (!this.emittedRootParagraphIds.has(owner.id)) {
        rootParagraphPatches.push(this.rootParagraphInsertPatch(owner));
        this.markRootParagraphOwnerEmitted(owner);
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
      previousRootCodeOwners,
      previousRootTableOwners,
    );
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && progressPublication) {
      this.recordParsedProgressPublication(progressPublication);
    }
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
    content: SourceText,
    options: ParseOptions = {},
    nestedNativeContainerStarts?: ReadonlySet<number>,
  ): Promise<Block[]> {
    let nativeContainerPreparationFailed = false;
    try {
      const sourceOffset = options.sourceOffset ?? 0;
      if (!options.continueHeadingIds) this.headingIdCounts = new Map<string, number>();
      const extracted: Block[] = [];
      const cursor = tree.cursor();
      const footnotesEnabled = this.documentPluginRegistry.getAll().some((plugin) => plugin.name === "footnotes");
      let hasRecognizedNodes = false;
      const reusableBlockMap =
        options.firstChangedPos !== undefined && options.previousBlocks
          ? new Map(options.previousBlocks.map((block) => [`${block.payload.range?.from ?? -1}:${block.payload.range?.to ?? -1}`, block]))
          : null;
      const cloneReusableBlocks = reusableBlockMap !== null
        && ((this.extensions?.documentPlugins?.length ?? 0) > 0
          || this.documentPluginRegistry.some(isCustomDocumentPlugin));

      if (cursor.firstChild()) {
        do {
          const nodeType = cursor.type.name;
          let from = cursor.from;
          const to = cursor.to;
          if (nodeType === "CodeBlock") from = sourceLineStart(content, from);
          const globalFrom = from + sourceOffset;
          const globalTo = to + sourceOffset;
          if (nodeType === "FencedCode") {
            const owner = this.rootCodeOwnersByStart.get(globalFrom);
            if (owner) {
              hasRecognizedNodes = true;
              continue;
            }
          }
          const tableOwner = this.rootTableOwnersByStart.get(globalFrom);
          if (nodeType === "Table" && tableOwner) {
            hasRecognizedNodes = true;
            continue;
          }
          const paragraphOwner = this.rootParagraphOwnersByStart.get(globalFrom);
          if (nodeType === "Paragraph" && paragraphOwner) {
            hasRecognizedNodes = true;
            continue;
          }

          let raw: string | undefined;
          const footnoteDefinition = nodeType === "LinkReference"
            && footnotesEnabled
            && FOOTNOTE_DEFINITION_START.test(raw = readSourceRange(content, from, to));
          if (nodeType === "LinkReference" && !footnoteDefinition) {
            hasRecognizedNodes = true;
            continue;
          }
          if (!isBlockLevelNode(nodeType) && !footnoteDefinition) continue;
          hasRecognizedNodes = true;
          const blockType = footnoteDefinition ? "paragraph" : mapLezerNodeToBlockType(nodeType);
          const flowRootEnd = blockType === "html"
            ? this.findTrustedMdxFlowRootEnd(raw ??= readSourceRange(content, from, to))
            : null;
          if (flowRootEnd !== null && raw !== undefined) {
            hasRecognizedNodes = true;
            // Lezer can extend an HTML block across a following fence; reparse after the exact authored JSX root.
            const prefix = raw.slice(0, flowRootEnd);
            const suffix = raw.slice(flowRootEnd);
            const childOptions: ParseOptions = { ...options, firstChangedPos: undefined, previousBlocks: undefined, continueHeadingIds: true };
            extracted.push(
              ...await this.extractBlocks(this.mdParser.parse(prefix), prefix, { ...childOptions, forceFinalize: true, sourceOffset: globalFrom }),
              ...await this.extractBlocks(this.mdParser.parse(suffix), suffix, { ...childOptions, sourceOffset: globalFrom + flowRootEnd }),
            );
            continue;
          }
          let block: Block | null = null;
          if (reusableBlockMap && globalTo <= options.firstChangedPos!) {
            const previous = reusableBlockMap.get(`${globalFrom}:${globalTo}`);
            if (previous && previous.isFinalized && previous.type === blockType
              && !nestedNativeContainerStarts?.has(globalFrom)) {
              block = cloneReusableBlocks ? cloneBlock(previous) : previous;
              if (blockType === "heading") {
                const headingMeta = previous.payload.meta as { headingText?: string } | undefined;
                const headingText = headingMeta?.headingText ?? previous.payload.raw;
                const baseSlug = slugifyHeading(headingText);
                this.nextHeadingIdCount(baseSlug);
              }
            }
          }

          if (block) {
            extracted.push(block);
            continue;
          }
          const nativeContainerRoot = nodeType === "BulletList" || nodeType === "OrderedList" || nodeType === "Blockquote";
          // MDX grouping absorbs these source blocks, so native child-owner patches target a discarded parent.
          const skipNativeContainerOwners = nativeContainerRoot && nestedNativeContainerStarts?.has(globalFrom) === true;
          raw ??= nativeContainerRoot && !skipNativeContainerOwners ? "" : readSourceRange(content, from, to);
          if (!nativeContainerRoot && !raw.trim()) continue;
          try {
            block = await this.createBlock(
              blockType,
              raw,
              globalFrom,
              globalTo,
              content,
              options,
              nodeType,
              skipNativeContainerOwners ? undefined : cursor.node,
            );
          } catch (error) {
            if (nativeContainerRoot) nativeContainerPreparationFailed = true;
            throw error;
          }
          if (block) extracted.push(block);
        } while (cursor.nextSibling());
      }

      if (extracted.length === 0 && !hasRecognizedNodes) {
        return await this.extractBlocksSimple(content, options);
      }

      return groupHtmlOwnership(extracted, this.mdParser, content, this.htmlConfig, sourceOffset, (text) => this.inlineParser.parse(text), {
        forceFinalize: options.forceFinalize,
        mdxComponents: this.mdxEnabled && this.contentPolicy === "trusted-mdx",
        contentPolicy: this.contentPolicy,
        contentComponents: this.getActiveContentComponents(),
      });
    } catch (error) {
      if (nativeContainerPreparationFailed) throw error;
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
    if (!raw.trim() && type !== "list" && type !== "blockquote") return null;

    const sourceOffset = options.sourceOffset ?? 0;
    const localTo = to - sourceOffset;
    const isFinalized = options.forceFinalize ? true : hasSourceAfterRange(fullContent, localTo);
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
      Array.isArray(block.payload.meta?.trustedMdxNativeChildren) ||
      (block.type !== "paragraph" && block.type !== "html" && block.type !== "mdx")
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
      appendPreparedNativeBlocksInRange(activeTree, childFrom, childTo, exact, mdxOnly, childBlocks, seenOwners);
      if (childBlocks.length === 0) {
        const parsedChildBlocks = child.kind === "inline"
          ? [await this.prepareTrustedMdxInlineChild(childSource, childFrom, childTo)]
          : await this.extractBlocks(
            this.mdParser.parse(childSource),
            childSource,
            { forceFinalize: true, sourceOffset: childFrom, continueHeadingIds: true },
          );
        if ((child.kind === "markdown" || child.kind === "inline") && parsedChildBlocks.length === 0) {
          throw new Error("A compiler-authored Markdown child in an MDX flow root has no native block owner.");
        }
        if (parsedChildBlocks.length === 0) continue;
        mdxDetection?.process({
          source: this.sourceDocument.snapshot(),
          blocks: parsedChildBlocks,
          readBlocks: () => parsedChildBlocks,
          hasProvisionalTail: false,
          state: this.documentPluginState,
        });
        for (const parsedChildBlock of parsedChildBlocks) {
          await this.prepareTrustedMdxFlowChildren(parsedChildBlock);
        }
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
  private async prepareTrustedMdxFlowChildrenForBlocks(
    blocks: Block[],
    previousBlocks: readonly Block[],
    changedLabels?: ReadonlySet<string>,
  ): Promise<void> {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(previousBlocks.length, "engine");
    }
    const previousById = new Map(previousBlocks.map((block) => [block.id, block]));
    for (const block of blocks) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      const previous = previousById.get(block.id);
      const previousRange = previous?.payload.range;
      const currentRange = block.payload.range;
      const previousChildren = previous?.payload.meta?.trustedMdxNativeChildren;
      const sameFlowRootType = previous?.type === block.type ||
        (previous?.type === "mdx" && (block.type === "html" || block.type === "paragraph"));
      if (
        previous &&
        previous.isFinalized &&
        sameFlowRootType &&
        block.isFinalized &&
        previous.payload.raw === block.payload.raw &&
        previousRange?.from === currentRange?.from &&
        previousRange?.to === currentRange?.to &&
        Array.isArray(previousChildren) &&
        (changedLabels === undefined || changedLabels.size === 0)
      ) {
        block.payload.meta = {
          ...block.payload.meta,
          trustedMdxNativeChildren: previousChildren,
        };
      }
      await this.prepareTrustedMdxFlowChildren(block);
    }
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
    recordSourceUnits?: boolean,
  ): InlineStreamingParseResult {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && recordSourceUnits !== false) {
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
    if (status === "complete" && mixedLookahead.length === 0
      && lookahead.every((decision) => decision.decision === "accept-as-is" && decision.safety === "safe" && !decision.ops?.length && !decision.appended)) {
      this.updateInlineLookaheadMeta(block, null, false);
      return;
    }
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
    const resolved = this.resolveLinkReferences(attempted);
    const meta = block.payload.meta;
    if (resolved.length > 0) {
      block.payload.meta = { ...meta, linkReferences: resolved };
    } else if (meta && "linkReferences" in meta) {
      const { linkReferences: _stale, ...rest } = meta;
      block.payload.meta = rest;
    }
  }

  /**
   * Footnote numbering lives on the inline the document plugins annotated. A block reaching the append, or a
   * base-path block re-extracted from the provisional tail, carries fresh inline that needs a full rebuild.
   */
  private footnoteSourceNeedsNumbering(
    block: Block,
    oldLength: number,
    previouslyProvisionalIds: ReadonlySet<string>,
  ): boolean {
    const raw = block.payload.raw ?? "";
    if (!raw.includes("[^") && !raw.includes("&")) return false;
    if (!(typeof block.payload.range?.to === "number" && block.payload.range.to < oldLength)) return true;
    return !this.isRootOwnedBlock(block) && previouslyProvisionalIds.has(block.id);
  }

  /**
   * Re-resolves blocks whose attempted link references changed, in place. Document plugins number the
   * re-parsed inline, so this runs before them; a refreshed block needs their full rebuild.
   */
  private async refreshLinkReferenceDependents(blocks: Block[], changedLabels: ReadonlySet<string>): Promise<boolean> {
    let refreshed = false;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
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
      await this.refreshChangedLinkReferences(clone, changedLabels, attempted);
      blocks[index] = clone;
      refreshed = true;
    }
    return refreshed;
  }
  private resolveLinkReferences(attempted: Iterable<string>): BlockResolvedLinkReference[] {
    const resolved: BlockResolvedLinkReference[] = [];
    for (const key of attempted) {
      const def = this.currentLinkReferences.get(key);
      if (def) {
        resolved.push(def.title !== undefined ? { label: def.label ?? key, href: def.href, title: def.title } : { label: def.label ?? key, href: def.href });
      }
    }
    return resolved;
  }

  private publishParagraphLinkReferences(owner: RootParagraphSourceOwner): void {
    const attempted = new Set<string>();
    const spans = owner.getSpans();
    for (let index = 0; index < spans.length; index += 1) {
      const span = spans.get(index);
      if (!span) continue;
      for (const label of span.attemptedReferences) attempted.add(label);
    }
    owner.setLinkReferences(this.resolveLinkReferences(attempted));
  }

  private async refreshChangedLinkReferences(
    block: Block,
    changedLabels: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
  ): Promise<void> {
    const prepared = block.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
    if (!prepared) {
      await this.enrichBlock(block);
      return;
    }

    this.recordLinkReferences(block, new Set(attempted));
    const hasChangedReference = (references: ReadonlySet<string>): boolean => {
      for (const label of changedLabels) if (references.has(label)) return true;
      return false;
    };
    const parseInline = (text: string): { inline: InlineNode[]; attempted: Set<string> } => {
      const attempted = new Set<string>();
      const inline = this.inlineParser.parse(text, {
        onAttemptedReference: (label) => attempted.add(label),
      });
      return { inline, attempted };
    };
    const queueSnapshotPropsPatch = (
      snapshot: NodeSnapshot,
      props: Readonly<Record<string, unknown>>,
    ): void => {
      const nextProps = nativePropsPatch(snapshot.props, props, snapshot.range);
      const patchProps = cloneNativeSnapshot({
        id: snapshot.id,
        type: snapshot.type,
        props: nextProps,
      }).props ?? {};
      this.pendingNativeNestedPatches.push({
        op: "setProps",
        at: { blockId: block.id, nodeId: snapshot.id },
        props: patchProps,
        meta: { kind: "semantic" },
      });
    };
    const refreshSnapshots = async (
      snapshots: NodeSnapshot[],
      ancestors: readonly string[],
    ): Promise<NodeSnapshot[]> => {
      let refreshed: NodeSnapshot[] | undefined;
      for (let index = 0; index < snapshots.length; index += 1) {
        const snapshot = snapshots[index]!;
        const childAncestors = [...ancestors, snapshot.type];
        let next = snapshot;
        if (snapshot.children) {
          const children = await refreshSnapshots(snapshot.children, childAncestors);
          if (children !== snapshot.children) next = { ...next, children };
        }

        const nested = snapshot.props?.block as Block | undefined;
        if (nested && !snapshot.paragraph && !snapshot.table && !snapshot.code) {
          if (nested.type === "list-item") {
            const props = snapshot.props;
            const text = typeof props?.text === "string" ? props.text : "";
            if (text.includes("[") && Array.isArray(props?.inline)) {
              const parsed = parseInline(text);
              if (hasChangedReference(parsed.attempted)) {
                const updatedBlock = cloneBlock(nested);
                updatedBlock.payload.inline = parsed.inline;
                this.recordLinkReferences(updatedBlock, parsed.attempted);
                const nextProps: Record<string, unknown> = {
                  ...(props ?? {}),
                  inline: parsed.inline,
                  text: inlineNodesToPlainText(parsed.inline),
                  block: updatedBlock,
                };
                queueSnapshotPropsPatch(snapshot, nextProps);
                next = { ...next, props: nextProps };
              }
            }
          } else if (
            !["list", "blockquote"].includes(nested.type)
            && !nested.payload.meta?.preparedNested
            && (snapshot.children?.length ?? 0) === 0
          ) {
            const raw = nested.payload.raw ?? "";
            if (raw.includes("[")) {
              const sourceText = nested.type === "heading" ? removeHeadingMarkers(raw) : raw;
              const parsed = parseInline(sourceText);
              if (hasChangedReference(parsed.attempted)) {
                const updatedBlock = cloneBlock(nested);
                const meta = updatedBlock.payload.meta as Record<string, unknown> | undefined;
                const simpleParagraph = nested.type === "paragraph"
                  && nested.isFinalized
                  && !meta?.mixedSegments
                  && !meta?.htmlParagraphTree
                  && !meta?.inlineComponentSource;
                if (nested.type === "heading" || simpleParagraph) {
                  updatedBlock.payload.inline = parsed.inline;
                  this.recordLinkReferences(updatedBlock, parsed.attempted);
                } else {
                  this.inlineParser.startCollectingAttemptedReferences();
                  try {
                    await this.enrichBlockContent(updatedBlock, undefined, childAncestors);
                  } finally {
                    this.recordLinkReferences(
                      updatedBlock,
                      this.inlineParser.stopCollectingAttemptedReferences(),
                    );
                  }
                }
                const refreshedSnapshot = createBlockSnapshot(updatedBlock);
                const { block: _block, ...props } = refreshedSnapshot.props ?? {};
                const nextProps: Record<string, unknown> = {
                  ...(next.props ?? {}),
                  ...props,
                  block: updatedBlock,
                };
                queueSnapshotPropsPatch(snapshot, nextProps);
                next = {
                  ...next,
                  type: refreshedSnapshot.type,
                  props: nextProps,
                  meta: refreshedSnapshot.meta,
                  range: snapshot.range,
                };
              }
            }
          }
        } else if (!nested && Array.isArray(snapshot.props?.inline)) {
          const text = typeof snapshot.meta?.headingText === "string"
            ? snapshot.meta.headingText
            : typeof snapshot.props?.text === "string"
              ? snapshot.props.text
              : typeof snapshot.props?.raw === "string"
                ? snapshot.props.raw
                : "";
          if (text.includes("[")) {
            const parsed = parseInline(text);
            if (hasChangedReference(parsed.attempted)) {
              const props: Record<string, unknown> = { ...(next.props ?? {}), inline: parsed.inline };
              if (typeof props.text === "string") props.text = inlineNodesToPlainText(parsed.inline);
              queueSnapshotPropsPatch(snapshot, props);
              next = { ...next, props };
            }
          }
        }

        if (next !== snapshot) {
          refreshed ??= snapshots.slice();
          refreshed[index] = next;
        }
      }
      return refreshed ?? snapshots;
    };

    const children = await refreshSnapshots(prepared.children, [block.type]);
    if (children !== prepared.children) {
      const meta: NonNullable<Block["payload"]["meta"]> = { ...(block.payload.meta ?? {}), preparedNested: { ...prepared, children } };
      if (block.type === "list") {
        meta.items = children.map((child) => child.props?.inline ?? []);
      }
      block.payload.meta = meta;
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
    const contentComponents = this.getActiveContentComponents();
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
        const nextCount = this.nextHeadingIdCount(baseSlug);
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
                          this.contentPolicy === "trusted-mdx" || !contentComponents || contentComponents.size === 0
                            ? undefined
                            : contentComponents.keys(),
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
        const raw = block.payload.raw ?? "";
        let tableNode = nativeNode?.type.name === "Table" ? nativeNode : undefined;
        let tableOffset = options?.sourceOffset ?? 0;
        if (!tableNode) {
          const localTree = new NativeMarkdownInput(raw).parse(this.mdParser);
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
          // Trusted MDX cells bind compiler regions to authored cell ranges, so they publish the
          // legacy header/rows projection instead of the managed table record.
          const trustedTable = trustedNativePath;
          const trustedCellInline = (cell: TableCellRecord, ownerIdPrefix: string) =>
            this.prepareTrustedNativeInline(
              parseTableCellInline(this.inlineParser, cell.raw, { sourceOffset: cell.sourceRange.from }),
              cell.raw,
              ownerIdPrefix,
              cell.sourceRange.from,
            );
          const header = tableData.header.map((inline, column) => {
            const cell = tableData.table.header.cells[column];
            return trustedTable && cell ? trustedCellInline(cell, `${block.id}::th:${column}`) : inline;
          });
          const rows = tableData.rows.map((row, rowIndex) => row.map((inline, column) => {
            const cell = tableData.table.rows[rowIndex]?.cells[column];
            return trustedTable && cell ? trustedCellInline(cell, `${block.id}::td:${rowIndex}:${column}`) : inline;
          }));
          block.payload.inline = [];
          block.payload.meta = {
            ...(block.payload.meta ?? {}),
            header,
            align: tableData.align,
            rows,
            ...(trustedTable ? {} : { table: tableData.table }),
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

  private async enrichNativeNestedSnapshots(
    children: NodeSnapshot[],
    options: ParseOptions | undefined,
    ancestorTypes: readonly string[],
    changedFrom: number,
  ): Promise<void> {
    for (const snapshot of children) {
      if (snapshot.range && snapshot.range.to <= changedFrom) continue;
      const nested = snapshot.props?.block as Block | undefined;
      const childAncestors = [...ancestorTypes, snapshot.type];
      if (snapshot.children) {
        await this.enrichNativeNestedSnapshots(snapshot.children, options, childAncestors, changedFrom);
      }
      if (!nested) continue;
      if (nested.type === "list" || nested.type === "blockquote" || nested.type === "list-item") {
        if (nested.type !== "list-item") {
          this.updateContainerLookaheadMeta(nested, snapshot.children ?? [], childAncestors);
        }
        continue;
      }
      await this.enrichBlockContent(nested, options, childAncestors);
      if (nested.type === "code") this.nestedCodeOwners.get(snapshot.id)?.setPresentation(nested);
      const updated = createBlockSnapshot(nested);
      const { block: _block, ...props } = updated.props ?? {};
      snapshot.type = updated.type;
      snapshot.props = { ...(snapshot.props ?? {}), ...props, inline: nested.payload.inline, block: nested };
      snapshot.range = updated.range ?? snapshot.range;
      snapshot.meta = updated.meta;
      snapshot.children = updated.children ?? [];
    }
  }


  private async prepareNativeNestedChildren(
    block: Block,
    options: ParseOptions | undefined,
    ancestorTypes: readonly string[],
    nativeNode: SyntaxNode,
    precomputedChange?: NativeContainerTailChange,
  ): Promise<void> {

    const name = nativeNode.type.name;
    if (!["BulletList", "OrderedList", "Blockquote"].includes(name)) return;
    const rootRange = block.payload.range;
    const previousSourceStart = this.nativeContainerSourceStarts.get(block.id) ?? rootRange?.from;
    const previousCandidate = typeof previousSourceStart === "number"
      ? this.rootBlockAtSourceStart(previousSourceStart)
      : undefined;
    const previousBlock = previousCandidate?.id === block.id && previousCandidate.type === block.type
      ? previousCandidate
      : undefined;
    if (!previousBlock && previousCandidate
      && (previousCandidate.type === "list" || previousCandidate.type === "blockquote")) {
      this.retireNativeContainer(previousCandidate);
    }
    const previousPrepared = previousBlock?.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
    if (previousPrepared) block.payload.meta = { ...block.payload.meta, preparedNested: previousPrepared };
    if (typeof rootRange?.from === "number") this.nativeContainerSourceStarts.set(block.id, rootRange.from);
    const sourceOffset = options?.sourceOffset ?? 0;
    const source = this.sourceDocument.snapshot();
    const input: Input = new SourceRangeInput(source, sourceOffset);
    const baseMapping: NativeNestedCodeSourceMapping = {
      input,
      source,
      mapOffset: (offset) => sourceOffset + offset,
      mapRange: (from, to) => ({ from: sourceOffset + from, to: sourceOffset + to }),
    };
    const tailTo = rootRange?.to ?? source.length;
    let tail = this.nativeContainerTails.get(block.id);
    let result: NativeContainerTailResult = undefined;
    if (!precomputedChange && !options?.forceFinalize && tail && tail.state.tailFrom > tailTo) {
      // This tail belongs to a suffix that the canonical parse moved outside the container.
      this.nativeContainerTails.delete(block.id);
      tail.clear();
      tail = undefined;
    }
    let previousPath = this.nativeContainerActivePathSnapshots.get(block.id) ?? [];
    let admittedOpenList = false;
    if (precomputedChange) {
      if (!tail) throw new Error(`Native container ${block.id} lost its active tail before applying the parsed window`);
      result = precomputedChange;
    } else if (!tail) {
      const paragraphOwnerSupported = this.rootParagraphOwnershipSupported();
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        tail = NativeContainerTailParser.admit(
          this.mdParser,
          this.sourceDocument,
          this.documentGeneration,
          source,
          nativeNode,
          sourceOffset,
          paragraphOwnerSupported,
          this.campaignCounters,
        );
      } else {
        tail = NativeContainerTailParser.admit(
          this.mdParser,
          this.sourceDocument,
          this.documentGeneration,
          source,
          nativeNode,
          sourceOffset,
          paragraphOwnerSupported,
        );
      }
      // Blank lines do not close a list, so its tail parser rather than trailing-source extraction decides closure.
      admittedOpenList = (name === "BulletList" || name === "OrderedList") && tail.state.phase === "open";
      if (!options?.forceFinalize && (admittedOpenList || !block.isFinalized) && tail.state.phase === "open") {
        this.nativeContainerTails.set(block.id, tail);
      }
    } else {
      const priorState = tail.state;
      result = options?.forceFinalize
        ? tail.finalize(source, tailTo)
        : tail.append(source, source.read(priorState.sourceLength, source.length), tailTo);
    }
    if (result === NATIVE_CONTAINER_TAIL_VANISHED) {
      // No reachable input in the scan produced this; never silently reuse stale state if one does.
      throw new Error(`Native container ${block.id} (${tail.state.ownerType}) vanished from its bounded window`);
    }
    const change = result;

    const frames = change?.frames ?? tail.state.frames;
    const activeLeaf = change?.leafNode ?? tail.activeLeafNode;
    const activeChange = change;
    const mapping: NativeNestedContainerMapping = activeChange
      ? {
          input: activeChange.window.input,
          source,
          mapOffset: activeChange.window.mapping.mapOffset,
          mapRange: activeChange.window.mapping.mapRange,
          knownListLoosenessForNode: (node) => {
            const range = activeChange.window.mapping.mapRange?.(node.from, node.to)
              ?? {
                from: activeChange.window.mapping.mapOffset(node.from),
                to: activeChange.window.mapping.mapOffset(node.to),
              };
            for (const property of activeChange.listProperties) {
              if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
                this.campaignCounters?.recordPrefixComparisons(1, "engine");
              }
              const frame = activeChange.frames[property.pathIndex];
              if (frame?.kind === "list"
                && frame.typeName === node.type.name
                && frame.parentFrom === range.from
                && frame.parentTo === range.to) return property.loose;
            }
            return undefined;
          },
        }
      : baseMapping;
    const tailClosure = change?.closure ?? tail.state.phase;
    const closure = options?.forceFinalize || (block.isFinalized && tailClosure !== "open")
      ? "finalized"
      : tailClosure;
    const codeEvents = change
      ? nativeCodeEventsInTail(change.rootNode, change.window.prefixLength)
      : [];
    const inlineContextFor = (id: string, range: { readonly from: number; readonly to: number }) => {
      const paragraphBlock: Block = {
        id,
        type: "paragraph",
        isFinalized: false,
        payload: { raw: "", range: { ...range }, meta: {} },
      };
      const nestedAncestors = [
        ...ancestorTypes,
        ...frames.map((frame) => frame.kind === "list" ? "list" : frame.kind === "item" ? "list-item" : "blockquote"),
      ];
      return this.inlineContext(paragraphBlock, nestedAncestors);
    };
    const activeInlineRange = mapping.mapRange?.(activeLeaf.from, activeLeaf.to)
      ?? { from: mapping.mapOffset(activeLeaf.from), to: mapping.mapOffset(activeLeaf.to) };
    const activeInlineContext = inlineContextFor(block.id, activeInlineRange);
    let nativeParagraphSourceCounters: CampaignCounterSink | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      nativeParagraphSourceCounters = this.campaignCounters;
    }
    const nativeTailParagraphMarkers = change?.window.anchors ?? [];
    const paragraphSourceContext = (
      node: SyntaxNode,
      range: { readonly from: number; readonly to: number },
      inputFrom = node.from,
      useTailMarkerFrontier = false,
    ): NativeParagraphSourceContext => {
      const mapRange = (from: number, to: number) =>
        mapping.mapRange?.(from, to)
          ?? { from: mapping.mapOffset(from), to: mapping.mapOffset(to) };
      const mapMarker = (marker: Pick<SyntaxNode, "from" | "to">) => mapRange(marker.from, marker.to);
      const markersFrom = mapRange(inputFrom, inputFrom).from;
      const extraMarkers = useTailMarkerFrontier ? nativeTailParagraphMarkers : [];
      const first = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? nativeParagraphSourceContext(
            node,
            range,
            range,
            mapMarker,
            extraMarkers,
            [],
            markersFrom,
            useTailMarkerFrontier,
            nativeParagraphSourceCounters,
          )
        : nativeParagraphSourceContext(
            node,
            range,
            range,
            mapMarker,
            extraMarkers,
            [],
            markersFrom,
            useTailMarkerFrontier,
          );
      const indentation = inputFrom < node.to
        ? typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
          ? nativeParagraphSpaceTabIndentationRangesFromInput(
              mapping.input,
              { from: inputFrom, to: node.to },
              mapRange,
              first.markers,
              nativeParagraphSourceCounters,
            )
          : nativeParagraphSpaceTabIndentationRangesFromInput(
              mapping.input,
              { from: inputFrom, to: node.to },
              mapRange,
              first.markers,
            )
        : [];
      return Object.freeze({ ...first, indentationRanges: Object.freeze(Array.from(indentation)) });
    };
    const paragraphSourceInputFrom = (node: SyntaxNode, hasPriorReader: boolean): number => {
      if (!hasPriorReader || !change) return node.from;
      let from = Math.min(node.to, Math.max(node.from, change.window.prefixLength));
      if (from === node.to) return from;
      while (from > node.from) {
        const previous = mapping.input.read(from - 1, from);
        if (previous === "\n") break;
        if (previous === "\r") {
          if (from < node.to && mapping.input.read(from, from + 1) === "\n") from += 1;
          break;
        }
        from -= 1;
      }
      return Math.min(from, node.to);
    };
    const nestedCodeOwnersToDecorate = new Set<NativeNestedCodeSourceOwner>();
    const nativeLeafFactory = (
      node: SyntaxNode,
      id: string,
      kind: NativeNestedLeafKind,
      range: { readonly from: number; readonly to: number },
    ): NodeSnapshot | undefined => {
      const isActive = sameNativeSyntaxNode(node, activeLeaf, mapping);
      // A bare opening fence is the block's only CodeMark; only a second one closes it.
      const codeHasClosingFence = kind === "code"
        && node.type.name === "FencedCode"
        && node.getChildren("CodeMark").length >= 2;
      let nextSibling = node.nextSibling;
      if (kind === "code") {
        while (nextSibling && (nextSibling.type.name === "QuoteMark" || nextSibling.type.name === "ListMark")) {
          nextSibling = nextSibling.nextSibling;
        }
      }
      const nodeEnded = kind === "table"
        ? hasCompleteLineAfterRange(source, range.to)
        : nextSibling !== null || (kind !== "code" && hasSourceAfterRange(source, range.to)) || codeHasClosingFence;
      const nodeClosure = options?.forceFinalize
        ? "finalized"
        : closure === "finalized"
          ? "finalized"
          : isActive && closure === "open" && !nodeEnded
            ? "open"
            : "closed";
      if (kind === "code" && node.type.name === "FencedCode" && isActive) {
        const marker = node.getChild("CodeMark");
        if (marker) {
          const markerFrom = mapping.mapOffset(marker.from);
          let frontier = this.nativeFenceHeaderFrontiers.get(block.id);
          if (!frontier
            || frontier.document !== this.sourceDocument
            || frontier.generation !== this.documentGeneration
            || frontier.markerFrom !== markerFrom) {
            const info = node.getChild("CodeInfo");
            frontier = {
              document: this.sourceDocument,
              generation: this.documentGeneration,
              markerFrom,
              scannedTo: mapping.mapOffset(info?.to ?? marker.to),
              complete: false,
            };
            this.nativeFenceHeaderFrontiers.set(block.id, frontier);
          }
          if (!nativeFenceHeaderComplete(node, mapping, frontier)) {
            return { id, type: "code", props: {}, range: { ...range }, children: [] };
          }
        }
      }
      if (kind === "code") {
        let owner = this.nestedCodeOwners.get(id);
        if (owner?.state === "open") {
          const ownedEvents = codeEvents.filter((event) => {
            for (let parent = event.parent; parent; parent = parent.parent) {
              if (sameNativeSyntaxNode(parent, node, mapping)) return true;
            }
            return false;
          });
          const previousRange = owner.getMetadata().sourceRange;
          const update = owner.acceptNativeTail({
            nodes: ownedEvents,
            mapping,
            inputGeneration: this.documentGeneration,
            sourceDocument: this.sourceDocument,
            closure: nodeClosure,
            sourceRange: { from: previousRange.from, to: Math.max(previousRange.to, range.to) },
          });
          this.syncNestedCodeOwnerLedger(owner);
          if (update.revision !== update.expectedRevision || update.sourceAppend.length > 0) {
            this.pendingNativeNestedOwnerPatches.push(owner.appendPatch(update));
          }
          if (owner.state !== "open") this.activeNestedCodeByContainer.delete(block.id);
        }
        if (owner?.state === "closed" && nodeClosure === "finalized") {
          const update = owner.finalize(mapping);
          this.syncNestedCodeOwnerLedger(owner);
          if (update.revision !== update.expectedRevision) {
            this.pendingNativeNestedOwnerPatches.push(owner.appendPatch(update));
          }
        }
        if (!owner) {
          owner = NativeNestedCodeSourceOwner.admit({
            id,
            containerId: block.id,
            generation: ++this.nestedLeaseGeneration,
            inputGeneration: this.documentGeneration,
            source: this.sourceDocument,
            node,
            mapping,
            closure: nodeClosure,
            range,
          });
          this.nestedCodeOwners.set(id, owner);
          addNativeOwnerIdToContainer(this.nestedCodeOwnerIdsByContainer, id, block.id);
          this.syncNestedCodeOwnerLedger(owner);
          this.refreshNativeNestedCodePresentation(owner);
          if (owner.state !== "open" && !this.shouldDeferNativeNestedCodeHighlight(owner)) {
            nestedCodeOwnersToDecorate.add(owner);
          }
          const snapshot = mutableNativeOwnerSnapshot(owner.snapshot(this.rootCodeConfigurationRevision), range);
          if (isActive) this.nativeContainerActiveSnapshots.set(block.id, snapshot);
          return snapshot;
        }
        this.refreshNativeNestedCodePresentation(owner);
        if (owner.state !== "open" && !this.shouldDeferNativeNestedCodeHighlight(owner)) {
          nestedCodeOwnersToDecorate.add(owner);
        }
        const current = this.nativeContainerActiveSnapshots.get(block.id);
        if (current?.id === id) {
          const sourceRange = owner.getMetadata().sourceRange;
          current.range = { from: sourceRange.from, to: Math.max(sourceRange.to, range.to) };
          return current;
        }
        const previousSnapshot = previousPrepared
          ? preparedSnapshotAtId(previousPrepared.children, id)
          : undefined;
        if (previousSnapshot) return previousSnapshot;
        const snapshot = mutableNativeOwnerSnapshot(owner.snapshot(this.rootCodeConfigurationRevision), range);
        if (isActive) this.nativeContainerActiveSnapshots.set(block.id, snapshot);
        return snapshot;
      }
      if (kind === "table") {
        let owner = this.nestedTableOwners.get(id);
        if (owner) {
          const previousContainerId = this.nestedTableOwnerContainers.get(id);
          addNativeOwnerIdToContainer(this.nestedTableOwnerIdsByContainer, id, block.id, previousContainerId);
          this.nestedTableOwnerContainers.set(id, block.id);
        }
        if (owner?.getMetadata().state === "open") {
          const before = owner.getMetadata();
          const state = isActive && nodeClosure === "open" ? "open" : nodeClosure === "finalized" ? "finalized" : "closed";
          const advanced = advanceNativeNestedTableOwner(owner, node, this.sourceDocument, mapping, state);
          this.syncNestedTableOwnerLedger(owner);
          if (advanced) {
            this.pendingNativeNestedOwnerPatches.push(rootTableAppendPatch(owner, rootTableAppendChange(source, before, advanced)));
          }
        }
        if (!owner) {
          owner = createNativeNestedTableOwner({
            id,
            containerId: block.id,
            node,
            source: this.sourceDocument,
            generation: ++this.nestedLeaseGeneration,
            parser: this.mdParser,
            inlineParser: this.inlineParser,
            mapping,
            extensionContext: this.rootTableExtensionContext() as NativeTableExtensionContext,
            state: nodeClosure,
            ...(typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.campaignCounters
              ? { counters: this.campaignCounters }
              : {}),
          });
          if (!owner) return undefined;
          this.nestedTableOwners.set(id, owner);
          this.nestedTableOwnerContainers.set(id, block.id);
          addNativeOwnerIdToContainer(this.nestedTableOwnerIdsByContainer, id, block.id);
          this.syncNestedTableOwnerLedger(owner);
          if (owner.getMetadata().state === "open") this.activeNestedTableByContainer.set(block.id, id);
          const snapshot = mutableNativeOwnerSnapshot(rootTableNodeSnapshot(owner), range);
          if (isActive) this.nativeContainerActiveSnapshots.set(block.id, snapshot);
          return snapshot;
        }
        const state = owner.getMetadata().state;
        if (state === "open") {
          this.activeNestedTableByContainer.set(block.id, id);
          const current = this.nativeContainerActiveSnapshots.get(block.id);
          if (current?.id !== id) return undefined;
          current.range = { ...range };
          return current;
        }
        if (this.activeNestedTableByContainer.get(block.id) === id) {
          this.activeNestedTableByContainer.delete(block.id);
        }
        const current = this.nativeContainerActiveSnapshots.get(block.id);
        if (current?.id === id) {
          current.range = { ...range };
          return current;
        }
        const previousSnapshot = previousPrepared
          ? preparedSnapshotAtId(previousPrepared.children, id)
          : undefined;
        if (previousSnapshot) return previousSnapshot;
        const snapshot = mutableNativeOwnerSnapshot(rootTableNodeSnapshot(owner), range);
        if (isActive) this.nativeContainerActiveSnapshots.set(block.id, snapshot);
        return snapshot;
      }
      if (!this.rootParagraphOwnershipSupported()) return undefined;
      let owner = this.nestedParagraphOwners.get(id);
      if (owner) {
        const previousContainerId = this.nestedParagraphOwnerContainers.get(id);
        addNativeOwnerIdToContainer(this.nestedParagraphOwnerIdsByContainer, id, block.id, previousContainerId);
        this.nestedParagraphOwnerContainers.set(id, block.id);
      }
      const previousParagraphId = node.type.name === "Task"
        ? id.replace(/::task:(\d+)$/, "::paragraph:$1")
        : id;
      const previousOwnerForReader = owner
        ?? (previousParagraphId === id ? undefined : this.nestedParagraphOwners.get(previousParagraphId));
      let previousOwnerReleased = false;
      const paragraphRange = nativeEmptyParagraphBoundary(source, range);
      // Lezer gives a quote of blank lines an empty Paragraph; core lowering drops empty paragraphs, so no owner does.
      if (paragraphRange.from === paragraphRange.to) {
        if (owner) this.retireNestedParagraphOwner(block.id, id, owner);
        return undefined;
      }
      const ownerMetadata = owner?.getMetadata();
      const contextSourceFrontier = change
        ? mapping.mapOffset(change.window.prefixLength)
        : undefined;
      const preservesCompletedParagraphContext = ownerMetadata !== undefined
        && !isActive
        && ownerMetadata.state !== "open"
        && ownerMetadata.sourceRange.from === paragraphRange.from
        && paragraphRange.to < ownerMetadata.sourceRange.to
        && contextSourceFrontier !== undefined
        && paragraphRange.to <= contextSourceFrontier;
      if (owner && (ownerMetadata?.sourceRange.from !== paragraphRange.from
        || (ownerMetadata?.state !== "open"
          && ownerMetadata?.sourceRange.to !== paragraphRange.to
          && !preservesCompletedParagraphContext))) {
        this.retireNestedParagraphOwner(block.id, id, owner);
        owner = undefined;
        previousOwnerReleased = true;
      }
      const sourceInputFrom = paragraphSourceInputFrom(node, previousOwnerForReader !== undefined);
      const sourceContext = paragraphSourceContext(
        node,
        paragraphRange,
        sourceInputFrom,
        isActive && change !== undefined,
      );
      const sourceContextFrom = mapping.mapRange?.(sourceInputFrom, sourceInputFrom).from
        ?? mapping.mapOffset(sourceInputFrom);
      const context = inlineContextFor(id, paragraphRange);
      if (owner?.getMetadata().state === "open") {
        const previous = owner.getMetadata();
        const reader = owner.getSourceTextReader() as NativeParagraphSourceTextReader;
        reader.appendContext(sourceContext, sourceContextFrom);
        const transition: ParagraphSourceTransition = {
          ownerStart: paragraphRange.from,
          ownerEnd: paragraphRange.to,
          processedTo: source.length,
          mode: "bounded-physical-tail",
          closure: nodeClosure === "open" ? "open" : nodeClosure === "finalized" ? "finalized" : "following-root",
          requiresOwnerReplacement: false,
        };
        const accepted = owner.accept(previous.processedTo, source.length, transition, source, reader);
        this.syncNestedParagraphOwnerLedger(owner);
        if (accepted.requiresOwnerReplacement) {
          this.retireNestedParagraphOwner(block.id, id, owner);
          owner = undefined;
          previousOwnerReleased = true;
        } else {
          this.syncNestedParagraphFootnoteTargetOwner(owner);
          this.publishParagraphLinkReferences(owner);
          const appendChange = rootParagraphAppendChange(source, previous, accepted);
          const appendPatch = rootParagraphAppendPatch(owner, appendChange);
          this.pendingNativeNestedOwnerPatches.push({
            ...appendPatch,
            at: { blockId: block.id, nodeId: id },
          });
          if (owner.getMetadata().state !== "open") this.activeNestedParagraphByContainer.delete(block.id);
        }
      }
      if (owner?.getMetadata().state === "closed" && nodeClosure === "finalized") {
        const previous = owner.getMetadata();
        const reader = owner.getSourceTextReader() as NativeParagraphSourceTextReader;
        if (isActive) reader.appendContext(sourceContext, sourceContextFrom);
        const finalized = owner.finalize({
          ownerStart: previous.sourceRange.from,
          ownerEnd: preservesCompletedParagraphContext
            ? previous.sourceRange.to
            : paragraphRange.to,
          processedTo: previous.processedTo,
          mode: "bounded-physical-tail",
          closure: "finalized",
          requiresOwnerReplacement: false,
        }, source, reader);
        this.syncNestedParagraphOwnerLedger(owner);
        if (finalized.requiresOwnerReplacement) {
          this.retireNestedParagraphOwner(block.id, id, owner);
          owner = undefined;
          previousOwnerReleased = true;
        } else {
          this.syncNestedParagraphFootnoteTargetOwner(owner);
          this.publishParagraphLinkReferences(owner);
          const appendChange = rootParagraphAppendChange(source, previous, finalized);
          const appendPatch = rootParagraphAppendPatch(owner, appendChange);
          this.pendingNativeNestedOwnerPatches.push({
            ...appendPatch,
            at: { blockId: block.id, nodeId: id },
          });
        }
      }
      const current = this.nativeContainerActiveSnapshots.get(block.id);
      if (owner && (!isActive || nodeClosure !== "open")) {
        const snapshotRange = preservesCompletedParagraphContext
          ? owner.getMetadata().sourceRange
          : paragraphRange;
        if (current?.id === id) {
          current.range = { ...snapshotRange };
          if (current.paragraph?.revision !== owner.getMetadata().revision) {
            current.paragraph = owner.createSnapshot();
          }
          return current;
        }
        const previousSnapshot = previousPrepared
          ? preparedSnapshotAtId(previousPrepared.children, id)
          : undefined;
        if (previousSnapshot) {
          previousSnapshot.range = { ...snapshotRange };
          if (previousSnapshot.paragraph?.revision !== owner.getMetadata().revision) {
            previousSnapshot.paragraph = owner.createSnapshot();
          }
          return previousSnapshot;
        }
        return mutableNativeOwnerSnapshot(rootParagraphNodeSnapshot(owner), snapshotRange);
      }
      if (owner?.getMetadata().state === "open") {
        if (current?.id !== id) return undefined;
        current.range = { ...paragraphRange };
        return current;
      }
      const reader = previousOwnerForReader
        ? (previousOwnerForReader.getSourceTextReader() as NativeParagraphSourceTextReader).fork(sourceContext, sourceContextFrom)
        : typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
          ? readNativeParagraphSourceTextReader(sourceContext, nativeParagraphSourceCounters)
          : readNativeParagraphSourceTextReader(sourceContext);
      owner = new RootParagraphSourceOwner({
        id,
        generation: ++this.nestedLeaseGeneration,
        source: this.sourceDocument,
        inlineParser: this.inlineParser,
        opening: {
          from: paragraphRange.from,
          to: paragraphRange.to,
          state: nodeClosure,
        },
        inlineSettlement: this.rootParagraphInlineSettlement(),
        sourceTextReader: reader,
        prepareProvisionalInline: (text, onAttemptedReference) => this.parseInlineStreaming(
          text,
          context,
          undefined,
          onAttemptedReference,
          false,
        ).inline,
        prepareSpanChildren: (text, baseOffset, provisional, ownerId, generation, spanIndex) =>
          this.rootParagraphSpanChildren(text, baseOffset, provisional, ownerId, generation, spanIndex),
        ...(typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.campaignCounters
          ? { counters: this.campaignCounters }
          : {}),
      });
      if (previousOwnerForReader && !previousOwnerReleased) {
        this.retireNestedParagraphOwner(block.id, previousOwnerForReader.id, previousOwnerForReader);
      }
      this.nestedParagraphOwners.set(id, owner);
      const previousContainerId = this.nestedParagraphOwnerContainers.get(id);
      addNativeOwnerIdToContainer(this.nestedParagraphOwnerIdsByContainer, id, block.id, previousContainerId);
      this.nestedParagraphOwnerContainers.set(id, block.id);
      this.syncNestedParagraphOwnerLedger(owner);
      this.syncNestedParagraphFootnoteTargetOwner(owner);
      if (owner.getMetadata().state === "open") this.activeNestedParagraphByContainer.set(block.id, id);
      this.publishParagraphLinkReferences(owner);
      const snapshot = mutableNativeOwnerSnapshot(rootParagraphNodeSnapshot(owner), paragraphRange);
      if (isActive) this.nativeContainerActiveSnapshots.set(block.id, snapshot);
      return snapshot;
    };
    const previousChildrenByParentId = new Map<string, readonly NodeSnapshot[]>();
    if (previousPrepared) previousChildrenByParentId.set(block.id, previousPrepared.children);
    const idForChild: NativeNestedChildIdentityFactory = (parentId, parentNode, childNode, semanticChildIndex, role) => {
      const mappedChildRange = mapping.mapRange?.(childNode.from, childNode.to)
        ?? { from: mapping.mapOffset(childNode.from), to: mapping.mapOffset(childNode.to) };
      const childRange = childNode.type.name === "Paragraph" || childNode.type.name === "Task"
        ? nativeEmptyParagraphBoundary(source, mappedChildRange)
        : mappedChildRange;
      const previousChildren = previousChildrenByParentId.get(parentId);
      const expectedType = role === "item" ? "list-item" : nativeNestedSnapshotType(childNode.type.name);
      if (previousChildren) {
        const startCount = mappedChildRange.from === childRange.from ? 1 : 2;
        for (let pass = 0; pass < startCount; pass += 1) {
          const previousStart = pass === 0 ? mappedChildRange.from : childRange.from;
          const firstAtSourceStart = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
            ? childAtSourceStart(previousChildren, previousStart, nativeParagraphSourceCounters)
            : childAtSourceStart(previousChildren, previousStart);
          for (let index = firstAtSourceStart; index < previousChildren.length; index += 1) {
            const previousChild = previousChildren[index]!;
            if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
              nativeParagraphSourceCounters?.recordPrefixComparisons(1, "engine");
            }
            if (previousChild.range?.from !== previousStart) break;
            if (previousChild.type !== expectedType) continue;
            previousChildrenByParentId.set(previousChild.id, previousChild.children ?? []);
            return { id: previousChild.id, semanticChildIndex: index };
          }
        }
      }
      const parentRange = mapping.mapRange?.(parentNode.from, parentNode.to)
        ?? { from: mapping.mapOffset(parentNode.from), to: mapping.mapOffset(parentNode.to) };
      let activeFrame: NativeContainerTailChange["frames"][number] | undefined;
      for (const candidate of frames) {
        if (candidate.parentFrom === parentRange.from
          && candidate.parentTo === parentRange.to
          && candidate.typeName === parentNode.type.name) {
          activeFrame = candidate;
          break;
        }
      }
      if (activeFrame) {
        let activeNativeChildIndex = 0;
        for (let child = parentNode.firstChild; child; child = child.nextSibling) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            nativeParagraphSourceCounters?.recordPrefixComparisons(1, "engine");
          }
          const semantic = role === "item"
            ? child.type.name === "ListItem" || child.type.name === "EmptyListItem"
            : child.type.name !== "ListMark" && child.type.name !== "QuoteMark" && child.type.name !== "LinkReference";
          if (!semantic) continue;
          const range = mapping.mapRange?.(child.from, child.to)
            ?? { from: mapping.mapOffset(child.from), to: mapping.mapOffset(child.to) };
          if (range.from >= activeFrame.sourceFrontier) break;
          activeNativeChildIndex += 1;
        }
        const ordinal = Math.max(0, activeFrame.fromChild + semanticChildIndex - activeNativeChildIndex);
        const id = role === "item"
          ? `${parentId}::item:${ordinal}`
          : `${parentId}::${childNode.type.name.toLowerCase()}:${ordinal}`;
        return { id, semanticChildIndex: ordinal };
      }
      let firstCurrentChild: SyntaxNode | undefined;
      for (let child = parentNode.firstChild; child; child = child.nextSibling) {
        const semantic = role === "item"
          ? child.type.name === "ListItem" || child.type.name === "EmptyListItem"
          : child.type.name !== "ListMark" && child.type.name !== "QuoteMark" && child.type.name !== "LinkReference";
        if (semantic) {
          firstCurrentChild = child;
          break;
        }
      }
      const firstCurrentRange = firstCurrentChild
        ? mapping.mapRange?.(firstCurrentChild.from, firstCurrentChild.to)
          ?? { from: mapping.mapOffset(firstCurrentChild.from), to: mapping.mapOffset(firstCurrentChild.to) }
        : undefined;
      const firstCurrentBoundary = firstCurrentChild
        && (firstCurrentChild.type.name === "Paragraph" || firstCurrentChild.type.name === "Task")
        && firstCurrentRange
        ? nativeEmptyParagraphBoundary(source, firstCurrentRange)
        : firstCurrentRange;
      let sourcePrefixCount = 0;
      if (previousChildren && firstCurrentBoundary) {
        sourcePrefixCount = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
          ? childAtSourceStart(previousChildren, firstCurrentBoundary.from, nativeParagraphSourceCounters)
          : childAtSourceStart(previousChildren, firstCurrentBoundary.from);
      }
      const ordinal = sourcePrefixCount + semanticChildIndex;
      const id = role === "item"
        ? `${parentId}::item:${ordinal}`
        : `${parentId}::${childNode.type.name.toLowerCase()}:${ordinal}`;
      return { id, semanticChildIndex: ordinal };
    };
    const lower = (
      root: SyntaxNode,
      sourceMapping: NativeSourceMapping,
      leafFactory?: NativeNestedLeafFactory,
      childIdFactory?: NativeNestedChildIdentityFactory,
    ): PreparedNestedSnapshot => {
      const snapshot = prepareNestedBlockSnapshotFromNative(
        block,
        root,
        sourceMapping,
        this.inlineParser,
        this.mdParser,
        (text: string) => this.parseInlineStreaming(text, activeInlineContext).inline,
        leafFactory,
        childIdFactory,
      );
      return { props: { ...snapshot.props }, children: snapshot.children };
    };
    const preparedRoot = change?.rootNode ?? nativeNode;
    const preparedMapping = mapping;
    let rawPrepared = lower(preparedRoot, preparedMapping, nativeLeafFactory, idForChild);
    if (options?.forceFinalize) {
      // Finalize closed siblings before the terminal highlight pass, even when they precede the bounded tail.
      const ownerIds = this.nestedCodeOwnerIdsByContainer.get(block.id);
      for (const ownerId of ownerIds ?? []) {
        const owner = this.nestedCodeOwners.get(ownerId);
        if (!owner || owner.containerId !== block.id) continue;
        if (owner.state === "open") {
          throw new Error(`Native code owner ${owner.id} is still open outside the finalized container tail`);
        }
        if (owner.state === "closed") {
          const finalized = owner.finalize(mapping);
          this.syncNestedCodeOwnerLedger(owner);
          if (finalized.revision !== finalized.expectedRevision) {
            this.pendingNativeNestedOwnerPatches.push(owner.appendPatch(finalized));
          }
        }
        this.refreshNativeNestedCodePresentation(owner);
        if (!this.shouldDeferNativeNestedCodeHighlight(owner)) nestedCodeOwnersToDecorate.add(owner);
      }
    }
    const codeOwnerId = this.activeNestedCodeByContainer.get(block.id);
    const codeOwner = codeOwnerId ? this.nestedCodeOwners.get(codeOwnerId) : undefined;
    if (codeOwner?.state === "open") {
      const decorations = await this.rootCodeHighlighter.decorateAvailable(
        codeOwner,
        this.rootCodeHighlightConfiguration(false),
        () => !this.disposed,
      );
      if (decorations.length > 0) {
        const previousCode = previousPrepared
          ? preparedSnapshotAtId(previousPrepared.children, codeOwner.id)?.code
          : undefined;
        if (previousCode?.codeOwnerId === codeOwner.id
          && previousCode.generation === codeOwner.generation) {
          const patch = codeOwner.decoratePatch(this.rootCodeConfigurationRevision, decorations);
          if (patch) this.pendingNativeNestedOwnerPatches.push(patch);
        } else {
          const snapshot = mutableNativeOwnerSnapshot(
            codeOwner.snapshot(this.rootCodeConfigurationRevision),
            codeOwner.getMetadata().sourceRange,
          );
          this.nativeContainerActiveSnapshots.set(block.id, snapshot);
          rawPrepared = {
            ...rawPrepared,
            children: replaceNativeSnapshotById(rawPrepared.children, codeOwner.id, snapshot),
          };
        }
      }
    }
    for (const owner of nestedCodeOwnersToDecorate) {
      // Closed diff fences use the diff-aware range tokenizer, matching root code and lazy completion.
      const decorations = owner.isDiff && owner.state !== "open" && this.highlightOutputMode !== "html"
        ? await this.rootCodeHighlighter.tokenizeRange(
            owner,
            0,
            owner.getLines().length,
            this.rootCodeHighlightConfiguration(true),
            () => !this.disposed,
          )
        : await this.rootCodeHighlighter.decorateAvailable(
            owner,
            this.rootCodeHighlightConfiguration(owner.state !== "open"),
            () => !this.disposed,
          );
      if (decorations.length === 0) continue;
      const presentation = this.refreshNativeNestedCodePresentation(owner);
      const previousCode = previousPrepared
        ? preparedSnapshotAtId(previousPrepared.children, owner.id)?.code
        : undefined;
      if (previousCode?.codeOwnerId === owner.id && previousCode.generation === owner.generation) {
        const patch = owner.decoratePatch(this.rootCodeConfigurationRevision, decorations);
        if (patch) this.pendingNativeNestedOwnerPatches.push(patch);
        if (presentation) {
          this.pendingNativeNestedOwnerPatches.push({
            op: "setProps",
            at: { blockId: owner.containerId, nodeId: owner.id },
            props: { block: presentation },
            meta: { kind: "enrichment" },
          });
        }
      } else {
        const snapshot = mutableNativeOwnerSnapshot(
          owner.snapshot(this.rootCodeConfigurationRevision),
          owner.getMetadata().sourceRange,
        );
        rawPrepared = {
          ...rawPrepared,
          children: replaceNativeSnapshotById(rawPrepared.children, owner.id, snapshot),
        };
      }
    }
    const changedFrom = change
      ? change.window.mapping.mapRange(change.window.prefixLength, change.window.input.length).from
      : sourceOffset;
    await this.enrichNativeNestedSnapshots(
      rawPrepared.children,
      options,
      [...ancestorTypes, block.type],
      changedFrom,
    );
    if (!previousPath.length) this.updateContainerLookaheadMeta(block, rawPrepared.children, ancestorTypes);

    const prepared = previousPrepared ?? {
      props: rawPrepared.props,
      children: rawPrepared.children,
    };
    const rawActivePath = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? preparedNativeActivePath(rawPrepared, block, frames, nativeParagraphSourceCounters)
      : preparedNativeActivePath(rawPrepared, block, frames);
    const listProperties = change?.listProperties ?? tail.state.listProperties;
    for (const property of listProperties) {
      const rawList = nativeListSnapshotAtPath(rawActivePath, block, property.pathIndex);
      if (!rawList) continue;
      if (property.pathIndex === 0 && block.type === "list") {
        rawPrepared.props = nativeListPropertiesRecord(rawPrepared.props, property);
      } else {
        rawList.props = nativeListPropertiesRecord(rawList.props, property);
      }
    }
    // EOF finalization still uses a bounded native window; only reconcile its authored suffix.
    const windowFrom = changedFrom;
    const windowTo = change ? mapping.mapOffset(change.window.input.length) : source.length;
    if (previousPrepared) {
      prepared.props = rawPrepared.props;
      this.mergeNativeContainerChildren(
        block.id,
        block.id,
        prepared.children,
        rawPrepared.children,
        windowFrom,
        windowTo,
      );
    } else {
      for (const child of rawPrepared.children) stripNativeBlockProps(child);
    }
    if (options?.forceFinalize) {
      const syncNativeCodeSnapshots = (snapshots: NodeSnapshot[]): void => {
        for (const snapshot of snapshots) {
          const owner = this.nestedCodeOwners.get(snapshot.id);
          if (owner?.containerId === block.id) {
            if (owner.state !== "finalized") {
              throw new Error(`Native code owner ${owner.id} was not finalized with its container`);
            }
            const finalizedSnapshot = mutableNativeOwnerSnapshot(
              owner.snapshot(this.rootCodeConfigurationRevision),
              owner.getMetadata().sourceRange,
            );
            snapshot.props = finalizedSnapshot.props;
            snapshot.range = finalizedSnapshot.range;
            snapshot.code = finalizedSnapshot.code;
          }
          if (snapshot.children) syncNativeCodeSnapshots(snapshot.children);
        }
      };
      syncNativeCodeSnapshots(prepared.children);
    }
    block.payload.meta = {
      ...block.payload.meta,
      ...prepared.props,
      preparedNested: prepared,
    };
    const active = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? preparedNativeActivePath(prepared, block, frames, nativeParagraphSourceCounters)
      : preparedNativeActivePath(prepared, block, frames);
    if (previousPath.length > 0) {
      this.emitNativeContainerPathChanges(block.id, previousPath, active);
    }
    this.nativeContainerActivePathSnapshots.set(block.id, active.snapshots);
    this.nativeContainerActivePathFrames.set(block.id, frames);
    if (closure === "open") {
      if (name === "BulletList" || name === "OrderedList") block.isFinalized = false;
    } else {
      block.isFinalized = true;
      this.nativeContainerTails.delete(block.id);
      this.nativeFenceHeaderFrontiers.delete(block.id);
      // Keep the path through diffBlockContent to suppress child rediscovery; lifecycle patches are emitted independently.
      if (!previousBlock) {
        this.nativeContainerActivePathSnapshots.delete(block.id);
        this.nativeContainerActivePathFrames.delete(block.id);
      }
      tail.clear();
    }
  }

  private mergeNativeContainerChildren(
    blockId: string,
    parentId: string,
    current: NodeSnapshot[],
    incoming: NodeSnapshot[],
    windowFrom: number,
    windowTo: number,
  ): void {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.reconcileNativeActiveChildren(blockId, parentId, current, incoming, windowFrom, windowTo, this.campaignCounters);
    } else {
      this.reconcileNativeActiveChildren(blockId, parentId, current, incoming, windowFrom, windowTo);
    }
    for (const next of incoming) {
      stripNativeBlockProps(next);
      const encodedIndex = nativeSegmentIndex(next.id) ?? childIndexFromSnapshotId(next.id);
      let index: number;
      if (next.range) {
        const rangeIndex = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
          ? childAtSourceStart(current, next.range.from, this.campaignCounters)
          : childAtSourceStart(current, next.range.from);
        index = current[rangeIndex]?.range?.from === next.range.from
          ? encodedIndex !== undefined && current[encodedIndex]?.range?.from === next.range.from
            ? encodedIndex
            : rangeIndex
          : encodedIndex !== undefined && current[encodedIndex]?.id === next.id
            ? encodedIndex
            : rangeIndex;
      } else {
        const encodedMatch = encodedIndex !== undefined && current[encodedIndex]?.id === next.id
          ? encodedIndex
          : -1;
        index = encodedMatch >= 0 ? encodedMatch : current.findIndex((child) => child.id === next.id);
        if (index < 0) index = current.length;
      }
      const existing = current[index];
      if (!existing) {
        current.splice(index, 0, next);
        this.pendingNativeNestedPatches.push({
          op: "insertChild",
          at: { blockId, nodeId: parentId },
          index,
          node: cloneNativeSnapshot(next),
          meta: { kind: "semantic" },
        });
        continue;
      }
      const paragraphOwnerOmittedWhileLive = existing.id === next.id && existing.type === next.type
        && existing.paragraph !== undefined && next.paragraph === undefined
        && this.nestedParagraphOwners.get(existing.id)?.id === existing.paragraph.paragraphOwnerId
        && this.nestedParagraphOwners.get(existing.id)?.getMetadata().generation === existing.paragraph.generation;
      const codeOwnerOmittedWhileLive = existing.id === next.id && existing.type === next.type
        && existing.code !== undefined && next.code === undefined
        && this.nestedCodeOwners.get(existing.id)?.id === existing.code.codeOwnerId
        && this.nestedCodeOwners.get(existing.id)?.generation === existing.code.generation;
      const tableOwnerOmittedWhileLive = existing.id === next.id && existing.type === next.type
        && existing.table !== undefined && next.table === undefined
        && this.nestedTableOwners.get(existing.id)?.id === existing.table.tableOwnerId
        && this.nestedTableOwners.get(existing.id)?.getMetadata().generation === existing.table.generation;
      if (paragraphOwnerOmittedWhileLive || codeOwnerOmittedWhileLive || tableOwnerOmittedWhileLive) {
        if (next.range && (existing.range?.from !== next.range.from || existing.range.to !== next.range.to)) {
          existing.range = { ...next.range };
          this.pendingNativeNestedPatches.push({
            op: "setProps",
            at: { blockId, nodeId: existing.id },
            props: { range: { ...next.range } },
            meta: { kind: "semantic" },
          });
        }
        continue;
      }
      const paragraphOwnerChanged =
        existing.paragraph?.paragraphOwnerId !== next.paragraph?.paragraphOwnerId
        || existing.paragraph?.generation !== next.paragraph?.generation;
      const codeOwnerChanged =
        existing.code?.codeOwnerId !== next.code?.codeOwnerId
        || existing.code?.generation !== next.code?.generation;
      const tableOwnerChanged =
        existing.table?.tableOwnerId !== next.table?.tableOwnerId
        || existing.table?.generation !== next.table?.generation;
      const nativeOwnerChanged = paragraphOwnerChanged || codeOwnerChanged || tableOwnerChanged;
      if (existing.id !== next.id || existing.type !== next.type || Boolean(existing.code) !== Boolean(next.code)
        || Boolean(existing.table) !== Boolean(next.table) || Boolean(existing.paragraph) !== Boolean(next.paragraph)
        || nativeOwnerChanged) {
        if (existing.id !== next.id || existing.type !== next.type || nativeOwnerChanged) {
          this.retireNativeOwnersInSnapshot(blockId, existing);
        }
        current[index] = next;
        this.pendingNativeNestedPatches.push({
          op: "replaceChild",
          at: { blockId, nodeId: parentId },
          index,
          node: cloneNativeSnapshot(next),
          meta: { kind: "semantic" },
        });
        continue;
      }
      const completedBeforeWindow = existing.range !== undefined
        && next.range !== undefined
        && existing.range.to <= windowFrom
        && next.range.to <= windowFrom;
      if (completedBeforeWindow && !listItemPrimaryOwnerExtendsRange(existing, next)) continue;
      const previousProps = existing.props;
      const changed = updateNativeSnapshotFields(existing, next);
      if (changed) {
        const props = nativePropsPatch(previousProps, existing.props, existing.range);
        const clonedProps = cloneNativeSnapshot({ id: existing.id, type: existing.type, props }).props ?? {};
        this.pendingNativeNestedPatches.push({
          op: "setProps",
          at: { blockId, nodeId: existing.id },
          props: clonedProps,
          meta: { kind: "semantic" },
        });
      }
      if (next.children) {
        existing.children ??= [];
        this.mergeNativeContainerChildren(
          blockId,
          existing.id,
          existing.children,
          next.children,
          windowFrom,
          windowTo,
        );
      } else if (existing.children?.length) {
        for (let childIndex = existing.children.length - 1; childIndex >= 0; childIndex -= 1) {
          const child = existing.children[childIndex]!;
          this.retireNativeOwnersInSnapshot(blockId, child);
          existing.children.splice(childIndex, 1);
          this.pendingNativeNestedPatches.push({
            op: "deleteChild",
            at: { blockId, nodeId: existing.id },
            index: childIndex,
            meta: { kind: "semantic" },
          });
        }
      }
    }
  }
  private retireNestedParagraphOwner(
    blockId: string,
    ownerId: string,
    expectedOwner?: RootParagraphSourceOwner,
  ): void {
    const owner = this.nestedParagraphOwners.get(ownerId);
    const containerId = this.nestedParagraphOwnerContainers.get(ownerId);
    if (!owner || (expectedOwner && owner !== expectedOwner)
      || (containerId !== undefined && containerId !== blockId)) return;
    const generation = owner.getMetadata().generation;
    this.pendingFootnoteParagraphOwnerRemovals.add(owner.id);
    this.pendingNativeNestedOwnerPatches = this.pendingNativeNestedOwnerPatches.filter((patch) =>
      !((patch.op === "appendParagraph" || patch.op === "updateParagraphSpans")
        && patch.paragraphOwnerId === owner.id
        && patch.generation === generation)
    );
    this.nestedParagraphOwners.delete(ownerId);
    this.unfinishedNestedParagraphOwnerIds.delete(ownerId);
    removeNativeOwnerIdFromContainer(this.nestedParagraphOwnerIdsByContainer, ownerId, blockId);
    this.nestedParagraphOwnerContainers.delete(ownerId);
    this.nestedParagraphFootnoteTargetOwnerIds.delete(ownerId);
    if (this.activeNestedParagraphByContainer.get(blockId) === ownerId) {
      this.activeNestedParagraphByContainer.delete(blockId);
    }
    releaseRootParagraphOwner(owner);
  }

  private retireNestedCodeOwner(
    blockId: string,
    ownerId: string,
    expectedOwner?: NativeNestedCodeSourceOwner,
  ): void {
    const owner = this.nestedCodeOwners.get(ownerId);
    if (!owner || (expectedOwner && owner !== expectedOwner) || owner.containerId !== blockId) return;
    const generation = owner.generation;
    this.pendingNativeNestedOwnerPatches = this.pendingNativeNestedOwnerPatches.filter((patch) => {
      if (patch.op === "appendCode") {
        return patch.code.codeOwnerId !== owner.id || patch.code.generation !== generation;
      }
      return patch.op !== "decorateCode"
        || patch.codeOwnerId !== owner.id
        || patch.generation !== generation;
    });
    this.nestedCodeOwners.delete(ownerId);
    this.unfinishedNestedCodeOwnerIds.delete(ownerId);
    removeNativeOwnerIdFromContainer(this.nestedCodeOwnerIdsByContainer, ownerId, blockId);
    if (this.activeNestedCodeByContainer.get(blockId) === ownerId) {
      this.activeNestedCodeByContainer.delete(blockId);
    }
  }

  private retireNestedTableOwner(
    blockId: string,
    ownerId: string,
    expectedOwner?: RootTableSourceOwner,
  ): void {
    const owner = this.nestedTableOwners.get(ownerId);
    const containerId = this.nestedTableOwnerContainers.get(ownerId);
    if (!owner || (expectedOwner && owner !== expectedOwner)
      || (containerId !== undefined && containerId !== blockId)) return;
    const generation = owner.getMetadata().generation;
    this.pendingRootTablePatches = this.pendingRootTablePatches.filter((patch) => {
      if (patch.op === "appendTableRows") {
        return patch.table.tableOwnerId !== owner.id || patch.table.generation !== generation;
      }
      return patch.op !== "updateTableRows"
        || patch.tableOwnerId !== owner.id
        || patch.generation !== generation;
    });
    this.pendingNativeNestedOwnerPatches = this.pendingNativeNestedOwnerPatches.filter((patch) => {
      if (patch.op === "appendTableRows") {
        return patch.table.tableOwnerId !== owner.id || patch.table.generation !== generation;
      }
      return patch.op !== "updateTableRows"
        || patch.tableOwnerId !== owner.id
        || patch.generation !== generation;
    });
    this.nestedTableOwners.delete(ownerId);
    this.nestedTableOwnerContainers.delete(ownerId);
    this.unfinishedNestedTableOwnerIds.delete(ownerId);
    removeNativeOwnerIdFromContainer(this.nestedTableOwnerIdsByContainer, ownerId, blockId);
    if (this.activeNestedTableByContainer.get(blockId) === ownerId) {
      this.activeNestedTableByContainer.delete(blockId);
    }
  }

  private retireNativeOwnersInSnapshot(blockId: string, snapshot: NodeSnapshot): void {
    for (const child of snapshot.children ?? []) this.retireNativeOwnersInSnapshot(blockId, child);
    const paragraphOwner = this.nestedParagraphOwners.get(snapshot.id);

    if (paragraphOwner
      && this.nestedParagraphOwnerContainers.get(snapshot.id) === blockId
      && snapshot.paragraph?.paragraphOwnerId === paragraphOwner.id
      && snapshot.paragraph.generation === paragraphOwner.getMetadata().generation) {
      this.retireNestedParagraphOwner(blockId, snapshot.id, paragraphOwner);
    }
    const codeOwner = this.nestedCodeOwners.get(snapshot.id);
    if (codeOwner
      && codeOwner.containerId === blockId
      && snapshot.code?.codeOwnerId === codeOwner.id
      && snapshot.code.generation === codeOwner.generation) {
      this.retireNestedCodeOwner(blockId, snapshot.id, codeOwner);
    }
    const tableOwner = this.nestedTableOwners.get(snapshot.id);
    if (tableOwner
      && this.nestedTableOwnerContainers.get(snapshot.id) === blockId
      && snapshot.table?.tableOwnerId === tableOwner.id
      && snapshot.table.generation === tableOwner.getMetadata().generation) {
      this.retireNestedTableOwner(blockId, snapshot.id, tableOwner);
    }
    const activeSnapshot = this.nativeContainerActiveSnapshots.get(blockId);
    if (activeSnapshot?.id === snapshot.id) {
      const activeHasNativeOwner = Boolean(
        activeSnapshot.paragraph || activeSnapshot.code || activeSnapshot.table,
      );
      const sameOwner =
        (snapshot.paragraph !== undefined
          && activeSnapshot.paragraph?.paragraphOwnerId === snapshot.paragraph.paragraphOwnerId
          && activeSnapshot.paragraph.generation === snapshot.paragraph.generation)
        || (snapshot.code !== undefined
          && activeSnapshot.code?.codeOwnerId === snapshot.code.codeOwnerId
          && activeSnapshot.code.generation === snapshot.code.generation)
        || (snapshot.table !== undefined
          && activeSnapshot.table?.tableOwnerId === snapshot.table.tableOwnerId
          && activeSnapshot.table.generation === snapshot.table.generation);
      if (!activeHasNativeOwner || sameOwner) this.nativeContainerActiveSnapshots.delete(blockId);
    }
  }

  private reconcileNativeActiveChildren(
    blockId: string,
    parentId: string,
    current: NodeSnapshot[],
    incoming: NodeSnapshot[],
    windowFrom: number,
    windowTo: number,
    counters?: CampaignCounterSink,
  ): void {
    if (windowTo <= windowFrom) return;
    const incomingStarts = new Set<number>();
    for (const child of incoming) {
      const from = child.range?.from;
      if (from !== undefined && from >= windowFrom && from < windowTo) incomingStarts.add(from);
    }
    const start = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? childAtSourceStart(current, windowFrom, counters)
      : childAtSourceStart(current, windowFrom);
    const end = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? childAtSourceStart(current, windowTo, counters)
      : childAtSourceStart(current, windowTo);
    for (let index = end - 1; index >= start; index -= 1) {
      const child = current[index];
      if (!child || child.range?.from === undefined || incomingStarts.has(child.range.from)) continue;
      this.retireNativeOwnersInSnapshot(blockId, child);
      current.splice(index, 1);
      this.pendingNativeNestedPatches.push({
        op: "deleteChild",
        at: { blockId, nodeId: parentId },
        index,
        meta: { kind: "semantic" },
      });
    }
  }

  private emitNativeContainerPathChanges(
    blockId: string,
    previousPath: readonly NodeSnapshot[],
    active: NativePreparedActivePath,
  ): void {
    const previous = previousPath[0];
    const current = active.snapshots[0];
    if (!previous || !current || previous.id !== current.id) return;
    const propsChanged = !shallowRecordEqual(previous.props, current.props);
    const rangeChanged = previous.range?.from !== current.range?.from || previous.range?.to !== current.range?.to;
    if (propsChanged || rangeChanged) {
      const props = nativePropsPatch(previous.props, current.props, current.range);
      const clonedProps = cloneNativeSnapshot({ id: current.id, type: current.type, props }).props ?? {};
      this.pendingNativeNestedPatches.push({
        op: "setProps",
        at: { blockId, nodeId: current.id },
        props: clonedProps,
        meta: { kind: "semantic" },
      });
    }
  }
  private async prepareNestedChildren(block: Block, options?: ParseOptions, ancestorTypes: readonly string[] = [], nativeNode?: SyntaxNode): Promise<void> {
    const contentComponents = this.getActiveContentComponents();
    const trustedNativeSource = this.hasTrustedNativeSource(block, nativeNode);
    const containerMeta: NonNullable<Block["payload"]["meta"]> = { ...block.payload.meta, mathEnabled: this.enableMath, formatAnticipation: this.formatAnticipationConfig };
    if (trustedNativeSource) containerMeta.trustedMdxSource = true;
    else delete containerMeta.trustedMdxSource;
    block.payload.meta = containerMeta;
    if (nativeNode && ["BulletList", "OrderedList", "Blockquote"].includes(nativeNode.type.name)) {
      // Native containers carry no materialized raw; read their authored source from canonical input.
      const range = block.payload.range;
      const containerSource = range ? this.sourceDocument.snapshot().read(range.from, range.to) : block.payload.raw;
      if (!trustedNativeSource && !this.nativeOwnershipDeclinedByContentPolicy() && !this.nativeContainerSourceHasHtml(containerSource)) {
        await this.prepareNativeNestedChildren(block, options, ancestorTypes, nativeNode);
        return;
      }
      // HTML-bearing and policy-declined containers keep the base nested preparation, which reads the block raw.
      this.retireNativeContainer(block);
      block.payload.raw = containerSource;
    }
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
          contentComponents,
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
                if (this.contentPolicy === "restricted" && contentComponents && text.includes("<")) {
                  const protectedRanges = localCodeRanges;
                  if (this.enableMath) protectedRanges.push(...collectMathProtectedRanges(text, protectedRanges));
                  protectedRanges.push(...collectAutolinkProtectedRanges(text));
                  restrictedInlineTree = buildRestrictedComponentInlineTree(text, contentComponents, {
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
                            this.contentPolicy === "trusted-mdx" || !contentComponents || contentComponents.size === 0
                              ? undefined
                              : contentComponents.keys(),
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
                      const restrictedTree = segment.kind === "mdx" && this.contentPolicy === "restricted" && contentComponents
                        ? buildRestrictedComponentTree(segment.value, contentComponents, {
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
    const rawCodeBody = typeof preparedCode === "string" ? block.isFinalized ? preparedCode : trimProvisionalNativeCode(raw, preparedCode)
      : extracted.hadFence ? dedentFencedCodeByClosingIndent(raw, extracted.code) : dedentIndentedCode(raw);
    const codeBody = rawCodeBody.includes("\r") ? rawCodeBody.replace(/\r\n?/g, "\n") : rawCodeBody;
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

  private hasNoFootnoteArtifactsForSource(
    source: SourceSnapshot,
    hasProvisionalTail: boolean,
    retainedGenericSourceBefore: number | undefined,
    footnoteTargets?: {
      readonly deltas?: readonly FootnoteParagraphTargetDelta[];
      readonly removedOwnerIds?: readonly string[];
      readonly inlineRefreshes?: readonly { readonly previous: Block; readonly current: Block }[];
      readonly rebuild?: boolean;
    },
  ): boolean {
    const plugins = this.documentPluginRegistry.getAll();
    const hasFootnotesPlugin = plugins.some((plugin) => plugin.name === FootnotesPlugin.name);
    const hasCustomDocumentPlugins = (this.extensions?.documentPlugins?.length ?? 0) > 0
      || plugins.some((plugin) => plugin !== FootnotesPlugin
        && plugin !== TablesPlugin
        && plugin !== CalloutsPlugin
        && plugin !== HTMLBlockPlugin
        && plugin !== MDXDetectionPlugin);
    if (hasProvisionalTail || !hasFootnotesPlugin || hasCustomDocumentPlugins) return false;
    const previousFootnoteState = this.documentPluginState.footnotes as {
      hasProvisionalTail?: boolean;
      noFootnoteArtifactsSource?: SourceSnapshot;
      labelToNumber?: ReadonlyMap<string, number>;
      definitions?: ReadonlyMap<string, string>;
      definitionOrigins?: ReadonlyMap<string, number>;
      referenceCounts?: ReadonlyMap<string, number>;
      definitionInlines?: ReadonlyMap<string, readonly InlineNode[]>;
      publishedNumbers?: ReadonlyMap<string, number>;
      paragraphTargetEvents?: readonly unknown[];
      paragraphDependents?: ReadonlyMap<string, unknown>;
    } | undefined;
    const emptyFootnoteSource = previousFootnoteState?.noFootnoteArtifactsSource;
    if (!emptyFootnoteSource
      || (previousFootnoteState?.labelToNumber?.size ?? 0) > 0
      || (previousFootnoteState?.definitions?.size ?? 0) > 0
      || (previousFootnoteState?.definitionOrigins?.size ?? 0) > 0
      || (previousFootnoteState?.referenceCounts?.size ?? 0) > 0
      || (previousFootnoteState?.definitionInlines?.size ?? 0) > 0
      || (previousFootnoteState?.publishedNumbers?.size ?? 0) > 0
      || (previousFootnoteState?.paragraphTargetEvents?.length ?? 0) > 0
      || (previousFootnoteState?.paragraphDependents?.size ?? 0) > 0
      || retainedGenericSourceBefore === undefined
      || !Number.isSafeInteger(retainedGenericSourceBefore)
      || retainedGenericSourceBefore < 0
      || retainedGenericSourceBefore > source.length) {
      return false;
    }
    const sourceChanged = emptyFootnoteSource !== source || previousFootnoteState?.hasProvisionalTail === true;
    if (sourceChanged && (
      emptyFootnoteSource.length > source.length
      || retainedGenericSourceBefore > emptyFootnoteSource.length
    )) {
      return false;
    }
    const hasMarkers = (from: number, to: number): boolean => {
      if (!Number.isSafeInteger(from)
        || !Number.isSafeInteger(to)
        || from < 0
        || to < from
        || to > source.length) return true;
      const raw = source.read(from, to);
      return raw.includes("[^") || raw.includes("&");
    };
    if (sourceChanged && hasMarkers(Math.max(0, retainedGenericSourceBefore - 1), source.length)) return false;
    const changedRangeHasMarkers = (from: number, to: number): boolean => {
      if (!Number.isSafeInteger(from)
        || !Number.isSafeInteger(to)
        || from < 0
        || to < from
        || to > source.length) return true;
      const scanFrom = Math.max(0, from - 1);
      if (sourceChanged && scanFrom >= retainedGenericSourceBefore - 1) return false;
      return hasMarkers(scanFrom, to);
    };
    for (const delta of footnoteTargets?.deltas ?? []) {
      for (const span of delta.spans) {
        if (changedRangeHasMarkers(span.sourceRange.from, span.sourceRange.to)) return false;
      }
    }
    for (const refresh of footnoteTargets?.inlineRefreshes ?? []) {
      const range = refresh.current.payload.range;
      if (!range || changedRangeHasMarkers(range.from, range.to)) return false;
    }
    return true;
  }

  private runDocumentPlugins(
    inputBlocks: Block[],
    source: SourceSnapshot,
    footnoteTargets?: {
      readonly deltas?: readonly FootnoteParagraphTargetDelta[];
      readonly removedOwnerIds?: readonly string[];
      readonly inlineRefreshes?: readonly { readonly previous: Block; readonly current: Block }[];
      readonly rebuild?: boolean;
    },
    retainedGenericSourceBefore?: number,
    reuseInputArrayForNoFootnoteArtifacts = false,
    knownRetainedBlockStart?: number,
    knownRetainedCodeStart?: number,
  ): Block[] {
    const documentGeneration = this.documentGeneration;
    let targetUpdates = footnoteTargets;
    if (this.pendingFootnoteParagraphOwnerRemovals.size > 0) {
      const removedOwnerIds = new Set(footnoteTargets?.removedOwnerIds ?? []);
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(
          (footnoteTargets?.removedOwnerIds?.length ?? 0) + this.pendingFootnoteParagraphOwnerRemovals.size,
          "engine",
        );
      }
      for (const ownerId of this.pendingFootnoteParagraphOwnerRemovals) removedOwnerIds.add(ownerId);
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(removedOwnerIds.size, "engine");
      }
      targetUpdates = {
        ...(footnoteTargets ?? {}),
        removedOwnerIds: Array.from(removedOwnerIds),
      };
    }
    const tableProjections = new Map<string, { owner: RootTableSourceOwner; projection: RootTableFootnoteProjection }>();
    const tableBlocks: Block[] = [];
    const changedNestedContainerIds = new Set<string>();
    const withFootnoteSource = (projection: RootTableFootnoteProjection): RootTableFootnoteProjection => {
      const range = projection.block.payload.range;
      if (!range) return projection;
      const raw = source.read(range.from, range.to);
      return raw === projection.block.payload.raw
        ? projection
        : {
            ...projection,
            block: {
              ...projection.block,
              payload: { ...projection.block.payload, raw },
            },
          };
    };
    let hasProvisionalTail = this.openRootCodeOwners.size > 0
      || this.openRootTableOwners.size > 0
      || this.openRootParagraphOwners.size > 0
      || this.activeNestedCodeByContainer.size > 0
      || this.activeNestedParagraphByContainer.size > 0
      || this.activeNestedTableByContainer.size > 0;
    if (!hasProvisionalTail) {
      for (let index = inputBlocks.length - 1; index >= 0; index -= 1) {
        const block = inputBlocks[index];
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        if (block?.type === "footnotes") continue;
        hasProvisionalTail = Boolean(block && !block.isFinalized);
        break;
      }
    }
    const previousFootnoteState = this.documentPluginState.footnotes as {
      hasProvisionalTail?: boolean;
      labelToNumber?: ReadonlyMap<string, number>;
      noFootnoteArtifactsSource?: SourceSnapshot;
    } | undefined;
    const plugins = this.documentPluginRegistry.getAll();
    const hasFootnotesPlugin = plugins.some((plugin) => plugin.name === FootnotesPlugin.name);
    const hasCustomDocumentPlugins = (this.extensions?.documentPlugins?.length ?? 0) > 0
      || plugins.some((plugin) => plugin !== FootnotesPlugin
        && plugin !== TablesPlugin
        && plugin !== CalloutsPlugin
        && plugin !== HTMLBlockPlugin
        && plugin !== MDXDetectionPlugin);
    const hasTrackedFootnoteReferences = (previousFootnoteState?.labelToNumber?.size ?? 0) > 0;
    const noFootnoteArtifactsForSource = this.hasNoFootnoteArtifactsForSource(
      source,
      hasProvisionalTail,
      retainedGenericSourceBefore,
      targetUpdates,
    );
    const projectsFootnoteTables = !noFootnoteArtifactsForSource
      && hasFootnotesPlugin
      && (
        !previousFootnoteState
        || (hasTrackedFootnoteReferences && previousFootnoteState.hasProvisionalTail !== hasProvisionalTail)
        || Boolean(targetUpdates?.rebuild)
        || (targetUpdates?.removedOwnerIds?.length ?? 0) > 0
        || Boolean(targetUpdates?.deltas?.some((delta) => {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          return delta.spans.some((span) => {
            if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
              this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
            }
            return source.read(span.sourceRange.from, span.sourceRange.to).includes("[^");
          });
        }))
      );
    if (projectsFootnoteTables) {
      for (const owner of this.rootTableOwners) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        const projection = owner.getFootnoteProjection();
        if (!projection) continue;
        const footnoteProjection = withFootnoteSource(projection);
        tableProjections.set(owner.id, { owner, projection: footnoteProjection });
        tableBlocks.push(footnoteProjection.block);
      }
    }
    let blocks: Block[];
    let retainedBlockStart = 0;
    if (noFootnoteArtifactsForSource) {
      retainedBlockStart = rootSourceBoundary(
        inputBlocks,
        retainedGenericSourceBefore!,
        rootBlockSourceFrom,
        typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
          ? this.campaignCounters
          : undefined,
        knownRetainedBlockStart,
      );
      blocks = [];
      for (let index = retainedBlockStart; index < inputBlocks.length; index += 1) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        blocks.push(inputBlocks[index]!);
      }
    } else {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(inputBlocks.length + tableBlocks.length, "engine");
      }
      blocks = [...inputBlocks, ...tableBlocks].sort((left, right) => {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(2, "engine");
        }
        return (left.payload.range?.from ?? Number.POSITIVE_INFINITY) - (right.payload.range?.from ?? Number.POSITIVE_INFINITY);
      });
    }
    const aggregatedProtected: ProtectedRange[] = [];
    if (noFootnoteArtifactsForSource) {
      for (const block of blocks) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        const meta = block.payload.meta as Record<string, unknown> | undefined;
        const rawRanges = Array.isArray(meta?.protectedRanges) ? (meta.protectedRanges as ProtectedRange[]) : undefined;
        const base = typeof block.payload.range?.from === "number" ? block.payload.range.from : null;
        if (!rawRanges || base === null) continue;
        for (const range of rawRanges) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          if (typeof range.from !== "number" || typeof range.to !== "number") continue;
          aggregatedProtected.push({
            ...range,
            from: base + range.from,
            to: base + range.to,
          });
        }
      }
      const codeStart = rootSourceBoundary(
        this.rootCodeOwners,
        retainedGenericSourceBefore!,
        rootOwnerSourceFrom,
        typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
          ? this.campaignCounters
          : undefined,
        knownRetainedCodeStart,
      );
      const precedingCodeOwner = codeStart > 0 ? this.rootCodeOwners[codeStart - 1] : undefined;
      if (precedingCodeOwner) {
        const range = precedingCodeOwner.getMetadata().sourceRange;
        if (range.to > retainedGenericSourceBefore!) {
          aggregatedProtected.push({ from: range.from, to: range.to, kind: "code-fence" });
        }
      }
      for (let index = codeStart; index < this.rootCodeOwners.length; index += 1) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        const range = this.rootCodeOwners[index]!.getMetadata().sourceRange;
        aggregatedProtected.push({ from: range.from, to: range.to, kind: "code-fence" });
      }
    } else {
      for (const block of blocks) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        const meta = block.payload.meta as Record<string, unknown> | undefined;
        const rawRanges = Array.isArray(meta?.protectedRanges) ? (meta.protectedRanges as ProtectedRange[]) : undefined;
        if (!rawRanges || rawRanges.length === 0) continue;
        const base = typeof block.payload.range?.from === "number" ? block.payload.range.from : null;
        if (base === null) continue;
        for (const range of rawRanges) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          if (typeof range.from !== "number" || typeof range.to !== "number") continue;
          aggregatedProtected.push({
            ...range,
            from: base + range.from,
            to: base + range.to,
          });
        }
      }
      for (const owner of this.rootCodeOwners) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        const range = owner.getMetadata().sourceRange;
        aggregatedProtected.push({ from: range.from, to: range.to, kind: "code-fence" });
      }
    }

    if (projectsFootnoteTables) {
      for (const owner of this.nestedTableOwners.values()) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        if (!this.nestedTableOwnerContainers.has(owner.id)) continue;
        const projection = owner.getFootnoteProjection();
        if (!projection) continue;
        const footnoteProjection = withFootnoteSource(projection);
        tableProjections.set(owner.id, { owner, projection: footnoteProjection });
        tableBlocks.push(footnoteProjection.block);
      }
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(inputBlocks.length + tableBlocks.length, "engine");
      }
      blocks = [...inputBlocks, ...tableBlocks].sort((left, right) => {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(2, "engine");
        }
        return (left.payload.range?.from ?? Number.POSITIVE_INFINITY) - (right.payload.range?.from ?? Number.POSITIVE_INFINITY);
      });
    }
    const nestedParagraphDeltas = !noFootnoteArtifactsForSource && targetUpdates?.rebuild
      ? this.nestedParagraphFootnoteTargetDeltas(inputBlocks)
      : [];
    const paragraphDeltas = noFootnoteArtifactsForSource
      ? targetUpdates?.deltas ?? []
      : nestedParagraphDeltas.length === 0
        ? targetUpdates?.deltas ?? []
        : [...(targetUpdates?.deltas ?? []), ...nestedParagraphDeltas];

    const hasNativeFootnoteTargets = !noFootnoteArtifactsForSource && Boolean(
      targetUpdates
      || this.rootParagraphOwners.length > 0
      || this.nestedParagraphOwners.size > 0
      || this.nestedTableOwners.size > 0,
    );
    const applyFootnoteTargetUpdates = (updates: readonly FootnoteParagraphTargetUpdate[]) => {
      if (documentGeneration !== this.documentGeneration || source !== this.sourceDocument.snapshot()) return;
      for (const update of updates) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        const candidateRootOwner = this.rootParagraphOwnersById.get(update.ownerId);
        const rootOwner = candidateRootOwner?.generation === update.generation ? candidateRootOwner : undefined;
        const nestedOwner = rootOwner ? undefined : this.nestedParagraphOwners.get(update.ownerId);
        const owner = rootOwner ?? nestedOwner;
        if (!owner) continue;
        const metadata = owner.getMetadata();
        if (metadata.generation !== update.generation) continue;
        if (rootOwner) {
          if (this.rootParagraphOwnersByStart.get(metadata.sourceRange.from) !== owner) continue;
        } else if (this.nestedParagraphOwners.get(owner.id) !== owner) {
          continue;
        }
        const change = owner.applyPreparedSpanUpdates(update.updates, "footnote_reference_numbering");
        const patch = rootParagraphSemanticPatch(owner, change);
        if (!patch) continue;
        if (rootOwner) {
          if (this.emittedRootParagraphIds.has(owner.id)) this.pendingRootParagraphPatches.push(patch);
        } else {
          const blockId = this.nestedParagraphOwnerContainers.get(owner.id);
          if (!blockId) continue;
          changedNestedContainerIds.add(blockId);
          this.pendingRootParagraphPatches.push({
            ...patch,
            at: { blockId, nodeId: owner.id },
          });
        }
      }
    };
    const footnoteParagraphTargets: WorkerFootnoteParagraphTargetBridge | undefined = noFootnoteArtifactsForSource
      ? {
          deltas: paragraphDeltas,
          ...(targetUpdates?.removedOwnerIds ? { removedOwnerIds: targetUpdates.removedOwnerIds } : {}),
          retainedGenericSourceBefore: retainedGenericSourceBefore!,
          noFootnoteArtifactsForSource: source,
          ...(typeof __STREAM_MDX_COUNTERS__ !== "undefined"
            && __STREAM_MDX_COUNTERS__
            && this.campaignCounters !== undefined
            && hasFootnotesPlugin ? {
            hasNativeTargets: false,
            recordDocumentRecordsVisited: (count: number) => {
              this.campaignCounters?.recordDocumentRecordsVisited(count, "engine");
            },
          } : {}),
          applyUpdates: applyFootnoteTargetUpdates,
        }
      : hasNativeFootnoteTargets
        || (typeof __STREAM_MDX_COUNTERS__ !== "undefined"
          && __STREAM_MDX_COUNTERS__
          && this.campaignCounters !== undefined
          && hasFootnotesPlugin)
        ? {
            deltas: paragraphDeltas,
            ...(retainedGenericSourceBefore === undefined ? {} : { retainedGenericSourceBefore }),
            ...(targetUpdates?.removedOwnerIds ? { removedOwnerIds: targetUpdates.removedOwnerIds } : {}),
            ...(targetUpdates?.inlineRefreshes ? { inlineRefreshes: targetUpdates.inlineRefreshes } : {}),
            ...(targetUpdates?.rebuild === undefined ? {} : { rebuild: targetUpdates.rebuild }),
            ...(typeof __STREAM_MDX_COUNTERS__ !== "undefined"
              && __STREAM_MDX_COUNTERS__
              && this.campaignCounters !== undefined
              && hasFootnotesPlugin ? {
              hasNativeTargets: hasNativeFootnoteTargets,
              recordDocumentRecordsVisited: (count: number) => {
                this.campaignCounters?.recordDocumentRecordsVisited(count, "engine");
              },
            } : {}),
            applyUpdates: applyFootnoteTargetUpdates,
          }
        : undefined;
    if (noFootnoteArtifactsForSource && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      for (const plugin of plugins) {
        if (plugin === CalloutsPlugin || plugin === HTMLBlockPlugin || plugin === MDXDetectionPlugin) {
          this.campaignCounters?.recordDocumentRecordsVisited(blocks.length, "engine");
        }
      }
    }
    const { syntheticBlocks } = this.documentPluginRegistry.run({
      source,
      blocks,
      readBlocks: () => this.materializeRootBlocks(inputBlocks, false),
      hasProvisionalTail,
      state: this.documentPluginState,
      protectedRanges: aggregatedProtected,
      footnoteParagraphTargets,
    });
    this.pendingFootnoteParagraphOwnerRemovals.clear();

    if (noFootnoteArtifactsForSource && tableProjections.size === 0) {
      if (syntheticBlocks?.length) {
        if (reuseInputArrayForNoFootnoteArtifacts) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(syntheticBlocks.length, "engine");
          }
          inputBlocks.push(...syntheticBlocks);
          return inputBlocks;
        }
        return [...inputBlocks, ...syntheticBlocks];
      }
      return inputBlocks;
    }

    const updatedTableBlocks = new Map<string, Block>();
    for (const block of blocks) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      if (tableProjections.has(block.id)) updatedTableBlocks.set(block.id, block);
    }
    for (const [tableId, entry] of tableProjections) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      const pluginBlock = updatedTableBlocks.get(tableId);
      if (!pluginBlock) continue;
      const change = entry.owner.applyFootnoteProjection({ ...entry.projection, block: pluginBlock });
      const patch = rootTableSemanticPatch(entry.owner, change);
      if (!patch) continue;
      if (this.emittedRootTableIds.has(entry.owner.id)) {
        this.pendingRootTablePatches.push(patch);
      } else if (this.nestedTableOwners.get(entry.owner.id) === entry.owner) {
        const blockId = this.nestedTableOwnerContainers.get(entry.owner.id);
        if (!blockId) continue;
        changedNestedContainerIds.add(blockId);
        this.pendingRootTablePatches.push({
          ...patch,
          at: { blockId, nodeId: entry.owner.id },
        });
      }
    }

    const filtered = blocks.filter((block) => {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      return block.type !== "footnotes" && !tableProjections.has(block.id);
    });
    for (let index = 0; index < filtered.length; index += 1) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      const block = filtered[index]!;
      if (changedNestedContainerIds.has(block.id)) {
        filtered[index] = this.projectNativeContainerBlockForExport(block);
      }
    }
    if (syntheticBlocks && syntheticBlocks.length > 0) {
      if (hasProvisionalTail) {
        return filtered;
      }
      filtered.push(...syntheticBlocks);
    }
    return filtered;
  }


  private reconcileRootHeadingSuffixToc(
    blocks: Block[],
    stableBlockPrefixCount: number,
    sourceBefore: number,
  ): { patch: Patch | null; nextHeadings: TocHeading[]; nextSignature: string } | null {
    const sourceLength = this.sourceDocument.length;
    if (!this.canSeedRootHeadingCounts(sourceLength)
      || this.rootHeadingFrontier.length !== this.tocHeadings.length
      || !Number.isSafeInteger(stableBlockPrefixCount)
      || stableBlockPrefixCount < 0
      || stableBlockPrefixCount > blocks.length
      || !Number.isSafeInteger(sourceBefore)
      || sourceBefore < 0
      || sourceBefore > sourceLength) {
      return null;
    }

    // parseRootNativeTail supplies its source-qualified stable block prefix. Within this document generation,
    // append-only source changes and the known built-in plugins keep entries before this boundary unchanged.
    let low = 0;
    let high = this.rootHeadingFrontier.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      if (this.rootHeadingFrontier[middle]!.sourceFrom < sourceBefore) low = middle + 1;
      else high = middle;
    }
    const prefixHeadingCount = low;
    const retainedHeading = this.rootHeadingFrontier[prefixHeadingCount - 1];
    const changedHeading = this.rootHeadingFrontier[prefixHeadingCount];
    if ((retainedHeading && retainedHeading.blockIndex >= stableBlockPrefixCount)
      || (changedHeading && changedHeading.blockIndex < stableBlockPrefixCount)) {
      return null;
    }

    const suffixEntries: RootHeadingFrontierEntry[] = [];
    let oldSuffixIndex = prefixHeadingCount;
    let unchanged = true;
    let previousSourceFrom = sourceBefore;
    for (let blockIndex = stableBlockPrefixCount; blockIndex < blocks.length; blockIndex += 1) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      const block = blocks[blockIndex]!;
      const heading = tocHeadingForBlock(block);
      if (!heading) continue;
      const sourceFrom = block.payload.range?.from;
      if (typeof sourceFrom !== "number" || !Number.isSafeInteger(sourceFrom)
        || sourceFrom < sourceBefore || sourceFrom < previousSourceFrom || sourceFrom > sourceLength) {
        return null;
      }
      previousSourceFrom = sourceFrom;
      const entry = this.rootHeadingFrontierEntry(block, heading, blockIndex);
      if (!entry) return null;
      suffixEntries.push(entry);
      if (this.rootHeadingFrontier[oldSuffixIndex] && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      const previous = this.rootHeadingFrontier[oldSuffixIndex];
      if (!previous
        || previous.heading.blockId !== heading.blockId
        || previous.heading.id !== heading.id
        || previous.heading.level !== heading.level
        || previous.heading.text !== heading.text) {
        unchanged = false;
      }
      oldSuffixIndex += 1;
    }
    if (oldSuffixIndex !== this.rootHeadingFrontier.length) unchanged = false;

    let tocResult: { patch: Patch | null; nextHeadings: TocHeading[]; nextSignature: string };
    if (unchanged) {
      tocResult = {
        patch: null,
        nextHeadings: this.tocHeadings,
        nextSignature: this.tocSignature,
      };
    } else {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(prefixHeadingCount, "engine");
      }
      const nextHeadings = this.tocHeadings.slice(0, prefixHeadingCount);
      for (const entry of suffixEntries) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        nextHeadings.push(entry.heading);
      }
      tocResult = {
        patch: createTocPatch(nextHeadings),
        nextHeadings,
        nextSignature: tocSignatureFor(nextHeadings),
      };
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(nextHeadings.length, "engine");
      }
    }

    for (let index = this.rootHeadingFrontier.length - 1; index >= prefixHeadingCount; index -= 1) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      const entry = this.rootHeadingFrontier[index]!;
      const offsets = this.rootHeadingCountOffsets.get(entry.baseSlug)!;
      offsets.pop();
      if (offsets.length === 0) this.rootHeadingCountOffsets.delete(entry.baseSlug);
    }
    this.rootHeadingFrontier.length = prefixHeadingCount;
    for (const entry of suffixEntries) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      this.rootHeadingFrontier.push(entry);
      let offsets = this.rootHeadingCountOffsets.get(entry.baseSlug);
      if (!offsets) {
        offsets = [];
        this.rootHeadingCountOffsets.set(entry.baseSlug, offsets);
      }
      offsets.push(entry.sourceFrom);
    }
    this.rootHeadingFrontierSourceLength = sourceLength;
    return tocResult;
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
    previousRootCodeOwners: readonly RootCodeSourceOwner[] = this.rootCodeOwners.filter((owner) => this.emittedRootCodeIds.has(owner.id)),
    previousRootTableOwners: readonly RootTableSourceOwner[] = this.rootTableOwners.filter((owner) => this.emittedRootTableIds.has(owner.id)),
    retainedRootSourceBefore?: number,
    previousRootOwnerPrefixCounts?: {
      readonly code: number;
      readonly table: number;
      readonly paragraph: number;
    },
    previousBlockPrefixCount?: number,
  ): Promise<void> {
    const patches: Patch[] = [];
    let tocResult = previousBlockPrefixCount !== undefined && retainedRootSourceBefore !== undefined
      ? this.reconcileRootHeadingSuffixToc(nextBlocks, previousBlockPrefixCount, retainedRootSourceBefore)
      : null;
    if (!tocResult) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(nextBlocks.length, "engine");
      }
      tocResult = this.maybeBuildTocPatchForBlocks(nextBlocks);
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(tocResult.nextHeadings.length, "engine");
      }
    }
    const { patch: tocPatch, nextHeadings, nextSignature } = tocResult;
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
    // Plugin revisions of nested owners are computed from current owner state, so they follow this batch's owner patches.
    const nestedOwnerRevisionPatches: Patch[] = [];
    for (const patch of extraPatches) {
      if (!this.isCurrentRootNativeOwnerPatch(patch)) continue;
      if (patch.op === "insertChild" && patch.at.blockId === PATCH_ROOT_ID && patch.node.type === "code") {
        insertedRootCodeNodes.set(patch.node.id, patch.node);
      } else if (patch.op === "insertChild" && patch.at.blockId === PATCH_ROOT_ID && patch.node.type === "table") {
        insertedRootTableNodes.set(patch.node.id, patch.node);
      } else if (patch.op === "insertChild" && patch.at.blockId === PATCH_ROOT_ID
        && patch.node.type === "paragraph" && "paragraph" in patch.node) {
        insertedRootParagraphNodes.set(patch.node.id, patch.node);
      } else if (
        (patch.op === "appendParagraph" || patch.op === "updateParagraphSpans")
        && patch.at.nodeId === undefined
        && this.rootParagraphInsertCoversPatch(
          insertedRootParagraphNodes.get(patch.paragraphOwnerId),
          patch,
        )
      ) {
        continue;
      } else if ((patch.op === "updateParagraphSpans" || patch.op === "updateTableRows") && patch.at.nodeId !== undefined) {
        nestedOwnerRevisionPatches.push(patch);
      } else {
        additionalPatches.push(patch);
      }
    }

    const orderedChildren = (
      blocks: readonly Block[],
      owners: readonly RootCodeSourceOwner[],
      tableOwners: readonly RootTableSourceOwner[],
      paragraphOwners: readonly RootParagraphSourceOwner[],
      retainedBefore: number,
      ownerPrefixCounts?: {
        readonly code: number;
        readonly table: number;
        readonly paragraph: number;
      },
      retainedBlockPrefixCount = 0,
      retainedPrefixIsInArrays = false,
    ): { readonly entries: RootChildEntry[]; readonly retainedCount: number } => {
      const counters = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? this.campaignCounters
        : undefined;
      const blockStart = rootSourceBoundary(
        blocks,
        retainedBefore,
        rootBlockSourceFrom,
        counters,
        retainedPrefixIsInArrays ? retainedBlockPrefixCount : undefined,
      );
      const codeStart = rootSourceBoundary(
        owners,
        retainedBefore,
        rootOwnerSourceFrom,
        counters,
        retainedPrefixIsInArrays ? ownerPrefixCounts?.code : undefined,
      );
      const tableStart = rootSourceBoundary(
        tableOwners,
        retainedBefore,
        rootOwnerSourceFrom,
        counters,
        retainedPrefixIsInArrays ? ownerPrefixCounts?.table : undefined,
      );
      const paragraphStart = rootSourceBoundary(
        paragraphOwners,
        retainedBefore,
        rootOwnerSourceFrom,
        counters,
        retainedPrefixIsInArrays ? ownerPrefixCounts?.paragraph : undefined,
      );
      const entries: RootChildEntry[] = [];
      let blockIndex = blockStart;
      let codeIndex = codeStart;
      let tableIndex = tableStart;
      let paragraphIndex = paragraphStart;
      let block = blocks[blockIndex];
      const nextRootCodeOwner = (): RootCodeSourceOwner | undefined => {
        while (codeIndex < owners.length) {
          const owner = owners[codeIndex];
          if (!owner || (owners === this.rootCodeOwners
            && !this.emittedRootCodeIds.has(owner.id)
            && !insertedRootCodeNodes.has(owner.id))) {
            if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
              this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
            }
            codeIndex += 1;
            continue;
          }
          return owner;
        }
        return undefined;
      };
      const nextRootTableOwner = (): RootTableSourceOwner | undefined => {
        while (tableIndex < tableOwners.length) {
          const owner = tableOwners[tableIndex];
          if (!owner || (tableOwners === this.rootTableOwners
            && !this.emittedRootTableIds.has(owner.id)
            && !insertedRootTableNodes.has(owner.id))) {
            if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
              this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
            }
            tableIndex += 1;
            continue;
          }
          return owner;
        }
        return undefined;
      };
      const nextRootParagraphOwner = (): RootParagraphSourceOwner | undefined => {
        while (paragraphIndex < paragraphOwners.length) {
          const owner = paragraphOwners[paragraphIndex];
          if (!owner || (paragraphOwners === this.rootParagraphOwners
            && !this.emittedRootParagraphIds.has(owner.id)
            && !insertedRootParagraphNodes.has(owner.id))) {
            if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
              this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
            }
            paragraphIndex += 1;
            continue;
          }
          return owner;
        }
        return undefined;
      };
      let codeOwner = nextRootCodeOwner();
      let codeFrom = codeOwner ? rootOwnerSourceFrom(codeOwner) : undefined;
      let tableOwner = nextRootTableOwner();
      let tableFrom = tableOwner ? rootOwnerSourceFrom(tableOwner) : undefined;
      let paragraphOwner = nextRootParagraphOwner();
      let paragraphFrom = paragraphOwner ? rootOwnerSourceFrom(paragraphOwner) : undefined;
      while (block !== undefined || codeOwner !== undefined || tableOwner !== undefined || paragraphOwner !== undefined) {
        let nextKind: "block" | "code" | "table" | "paragraph" | undefined;
        let nextFrom = Number.POSITIVE_INFINITY;
        if (block !== undefined) {
          nextKind = "block";
          nextFrom = rootBlockSourceFrom(block);
        }
        if (codeOwner !== undefined && codeFrom !== undefined
          && (nextKind === undefined || codeFrom < nextFrom)) {
          nextKind = "code";
          nextFrom = codeFrom;
        }
        if (tableOwner !== undefined && tableFrom !== undefined
          && (nextKind === undefined || tableFrom < nextFrom)) {
          nextKind = "table";
          nextFrom = tableFrom;
        }
        if (paragraphOwner !== undefined && paragraphFrom !== undefined
          && (nextKind === undefined || paragraphFrom < nextFrom)) {
          nextKind = "paragraph";
          nextFrom = paragraphFrom;
        }
        if (nextKind === "block" && block !== undefined) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          entries.push({ id: block.id, from: nextFrom, block });
          blockIndex += 1;
          block = blocks[blockIndex];
        } else if (nextKind === "code" && codeOwner !== undefined) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          entries.push({ id: codeOwner.id, from: nextFrom, owner: codeOwner });
          codeIndex += 1;
          codeOwner = nextRootCodeOwner();
          codeFrom = codeOwner ? rootOwnerSourceFrom(codeOwner) : undefined;
        } else if (nextKind === "table" && tableOwner !== undefined) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          entries.push({ id: tableOwner.id, from: nextFrom, tableOwner });
          tableIndex += 1;
          tableOwner = nextRootTableOwner();
          tableFrom = tableOwner ? rootOwnerSourceFrom(tableOwner) : undefined;
        } else if (nextKind === "paragraph" && paragraphOwner !== undefined) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          entries.push({ id: paragraphOwner.id, from: nextFrom, paragraphOwner });
          paragraphIndex += 1;
          paragraphOwner = nextRootParagraphOwner();
          paragraphFrom = paragraphOwner ? rootOwnerSourceFrom(paragraphOwner) : undefined;
        } else {
          break;
        }
      }
      const ownerPrefixCount = ownerPrefixCounts
        ? ownerPrefixCounts.code + ownerPrefixCounts.table + ownerPrefixCounts.paragraph
        : 0;
      return {
        entries,
        retainedCount: retainedPrefixIsInArrays
          ? blockStart + codeStart + tableStart + paragraphStart
          : retainedBlockPrefixCount + blockStart + codeStart + tableStart + paragraphStart + ownerPrefixCount,
      };
    };
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(
        previousRootCodeOwners.length + previousRootTableOwners.length + previousRootParagraphOwners.length,
        "engine",
      );
    }
    const previousOwners = previousRootCodeOwners.filter((owner) => !insertedRootCodeNodes.has(owner.id));
    const previousTableOwners = previousRootTableOwners.filter((owner) => !insertedRootTableNodes.has(owner.id));
    const previousParagraphOwners = previousRootParagraphOwners.filter((owner) =>
      !insertedRootParagraphNodes.has(owner.id)
        || this.rootParagraphOwnersByStart.get(owner.getMetadata().sourceRange.from) !== owner
    );
    // An explicit earlier root insertion invalidates the retained-prefix promise.
    let retainedBefore = retainedRootSourceBefore ?? 0;
    for (const patch of extraPatches) {
      if (patch.op !== "insertChild" || patch.at.blockId !== PATCH_ROOT_ID) continue;
      retainedBefore = Math.min(retainedBefore, patch.node.range?.from ?? 0);
    }
    let previousBlocksForDiff = previousBlocks;
    let previousBlockPrefixForDiff = previousBlockPrefixCount;
    let previousRoot = orderedChildren(
      previousBlocks,
      previousOwners,
      previousTableOwners,
      previousParagraphOwners,
      retainedBefore,
      previousRootOwnerPrefixCounts,
      previousBlockPrefixCount,
    );
    const reuseRetainedPrefixStarts = retainedRootSourceBefore !== undefined
      && retainedBefore === retainedRootSourceBefore
      && previousRootOwnerPrefixCounts !== undefined
      && previousBlockPrefixCount !== undefined;
    let nextRoot = orderedChildren(
      nextBlocks,
      this.rootCodeOwners,
      this.rootTableOwners,
      this.rootParagraphOwners,
      retainedBefore,
      reuseRetainedPrefixStarts ? previousRootOwnerPrefixCounts : undefined,
      reuseRetainedPrefixStarts ? previousBlockPrefixCount : 0,
      reuseRetainedPrefixStarts,
    );
    if (previousRoot.retainedCount !== nextRoot.retainedCount
      && (!previousRootOwnerPrefixCounts || previousBlockPrefixCount !== undefined)) {
      if (previousBlockPrefixCount !== undefined) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(
            previousBlockPrefixCount * 2 + previousBlocks.length,
            "engine",
          );
        }
        previousBlocksForDiff = nextBlocks.slice(0, previousBlockPrefixCount).concat(previousBlocks);
        previousBlockPrefixForDiff = undefined;
      }
      previousRoot = orderedChildren(previousBlocksForDiff, previousOwners, previousTableOwners, previousParagraphOwners, 0);
      nextRoot = orderedChildren(nextBlocks, this.rootCodeOwners, this.rootTableOwners, this.rootParagraphOwners, 0);
    }
    const rootIndexOffset = previousRoot.retainedCount;
    const previousChildren = previousRoot.entries;
    const nextChildren = nextRoot.entries;
    const lifecyclePatches: Patch[] = [];
    const lifecycleStart = previousBlockPrefixForDiff ?? 0;
    let hasFinalizedNativeContainer = false;
    for (let index = lifecycleStart; index < nextBlocks.length; index += 1) {
      const block = nextBlocks[index]!;
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      if ((block.type === "list" || block.type === "blockquote")
        && block.isFinalized
        && this.nativeContainerActivePathSnapshots.has(block.id)) {
        hasFinalizedNativeContainer = true;
        break;
      }
    }
    if (hasFinalizedNativeContainer) {
      const explicitlyFinalizedBlockIds = new Set<string>();
      for (const patch of extraPatches) {
        if (patch.op === "finalize") explicitlyFinalizedBlockIds.add(patch.at.blockId);
      }
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(previousBlocks.length, "engine");
      }
      const previousBlocksById = new Map(previousBlocks.map((block) => [block.id, block]));
      for (let index = lifecycleStart; index < nextBlocks.length; index += 1) {
        const nextBlock = nextBlocks[index]!;
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        if ((nextBlock.type !== "list" && nextBlock.type !== "blockquote")
          || !nextBlock.isFinalized
          || !this.nativeContainerActivePathSnapshots.has(nextBlock.id)) continue;
        const previousBlock = previousBlocksById.get(nextBlock.id);
        if (!previousBlock || previousBlock.isFinalized || explicitlyFinalizedBlockIds.has(nextBlock.id)) continue;
        lifecyclePatches.push({ op: "finalize", at: { blockId: nextBlock.id } });
      }
    }
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
      const block = cloneNative || sourceBlock.payload.meta?.preparedNested
        ? this.projectNativeContainerBlockForExport(sourceBlock)
        : sourceBlock;
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
        this.campaignCounters?.recordDocumentRecordsVisited(2, "engine");
      }
      if (previousChildren[prefix]?.id !== nextChildren[prefix]?.id ||
        Boolean(previousChildren[prefix]?.owner) !== Boolean(nextChildren[prefix]?.owner) ||
        Boolean(previousChildren[prefix]?.tableOwner) !== Boolean(nextChildren[prefix]?.tableOwner) ||
        previousChildren[prefix]?.paragraphOwner !== nextChildren[prefix]?.paragraphOwner) break;
      prefix += 1;
    }


    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(nextChildren.length, "engine");
    }
    const nextPositionById = new Map(nextChildren.map((entry, index) => [entry.id, index]));
    let lastNextPosition = -1;
    let commonOrderStable = true;
    for (const entry of previousChildren) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      const nextPosition = nextPositionById.get(entry.id);
      if (nextPosition === undefined) continue;
      if (nextPosition <= lastNextPosition) {
        commonOrderStable = false;
        break;
      }
      lastNextPosition = nextPosition;
    }
    const hasRootOwner = previousChildren.some((entry) => {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      return Boolean(entry.owner || entry.tableOwner || entry.paragraphOwner);
    }) || nextChildren.some((entry) => {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      return Boolean(entry.owner || entry.tableOwner || entry.paragraphOwner);
    });
    let removeCount = 0;
    let addCount = 0;
    if (hasRootOwner && commonOrderStable) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(nextChildren.length + previousChildren.length, "engine");
      }
      const nextIds = new Set(nextChildren.map((entry) => entry.id));
      const currentChildren = previousChildren.slice();
      for (let index = currentChildren.length - 1; index >= 0; index -= 1) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        if (nextIds.has(currentChildren[index]?.id ?? "")) continue;
        patches.push({
          op: "deleteChild",
          at: { blockId: PATCH_ROOT_ID },
          index: rootIndexOffset + index,
        });
        currentChildren.splice(index, 1);
        removeCount += 1;
      }
      for (let index = 0; index < nextChildren.length; index += 1) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        const entry = nextChildren[index];
        if (!entry) continue;
        const current = currentChildren[index];
        if (current?.id !== entry.id) {
          patches.push({
            op: "insertChild",
            at: { blockId: PATCH_ROOT_ID },
            index: rootIndexOffset + index,
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
            index: rootIndexOffset + index,
            node: snapshotFor(entry, false),
          });
        }
      }
    } else {
      let prevTail = previousChildren.length - 1;
      let nextTail = nextChildren.length - 1;
      while (prevTail >= prefix && nextTail >= prefix) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(2, "engine");
        }
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
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          const targetIndex = prefix + offset;
          const entry = nextChildren[targetIndex];
          if (!entry) continue;
          patches.push({
            op: "replaceChild",
            at: { blockId: PATCH_ROOT_ID },
            index: rootIndexOffset + targetIndex,
            node: snapshotFor(entry, false),
          });
        }
      } else {
        for (let index = removeCount - 1; index >= 0; index -= 1) {
          patches.push({
            op: "deleteChild",
            at: { blockId: PATCH_ROOT_ID },
            index: rootIndexOffset + prefix + index,
          });
        }
        for (let offset = 0; offset < addCount; offset += 1) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          const insertIndex = prefix + offset;
          const entry = nextChildren[insertIndex];
          if (!entry) continue;
          patches.push({
            op: "insertChild",
            at: { blockId: PATCH_ROOT_ID },
            index: rootIndexOffset + insertIndex,
            node: snapshotFor(entry, true),
          });
        }
      }
    }
    let replacedRootTableIds: Set<string> | undefined;
    // Before RootTableSourceOwner admission, no typed patch carries delimiter-frontier growth.
    for (let index = 0; index < nextChildren.length; index += 1) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      const entry = nextChildren[index];
      if (!entry || entry.owner || entry.tableOwner || entry.paragraphOwner || !entry.block) continue;
      const previous = previousChildren[index]?.id === entry.id
        ? previousChildren[index]
        : previousChildren.find((candidate) => {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
          }
          return candidate.id === entry.id;
        });
      if (!previous || previous.owner || previous.tableOwner || previous.paragraphOwner || !previous.block) continue;
      if (!managedTableSourceFrontierChanged(previous.block, entry.block)) continue;
      const alreadyReplaced = patches.some((patch) =>
        patch.op === "replaceChild" &&
        patch.at.blockId === PATCH_ROOT_ID &&
        patch.index === rootIndexOffset + index &&
        patch.node.id === entry.id &&
        patch.node.type === "table"
      );
      if (alreadyReplaced) {
        (replacedRootTableIds ??= new Set()).add(entry.id);
        continue;
      }
      patches.push({
        op: "replaceChild",
        at: { blockId: PATCH_ROOT_ID },
        index: rootIndexOffset + index,
        node: snapshotFor(entry, false),
      });
      (replacedRootTableIds ??= new Set()).add(entry.id);
    }
    metrics?.markDiffStart();
    const { patches: contentPatches } = await this.diffBlockContent(
      previousBlocksForDiff,
      nextBlocks,
      changedRanges,
      metrics,
      replacedRootTableIds,
      previousBlockPrefixForDiff,
    );
    metrics?.markDiffEnd();
    if (previousBlockPrefixForDiff === undefined) {
      for (const block of nextBlocks) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
        }
        if (!block.isFinalized || (block.type !== "list" && block.type !== "blockquote")) continue;
        const tail = this.nativeContainerTails.get(block.id);
        if (tail) {
          this.nativeContainerTails.delete(block.id);
          tail.clear();
        }
        this.nativeFenceHeaderFrontiers.delete(block.id);
        this.nativeContainerActivePathSnapshots.delete(block.id);
        this.nativeContainerActivePathFrames.delete(block.id);
      }
    }

    const nativeStructuralPatches = this.pendingNativeNestedPatches;
    const nativeOwnerPatches = this.pendingNativeNestedOwnerPatches;
    this.pendingNativeNestedPatches = [];
    this.pendingNativeNestedOwnerPatches = [];
    const combined = additionalPatches.concat(
      lifecyclePatches,
      patches,
      nativeStructuralPatches,
      nativeOwnerPatches,
      nestedOwnerRevisionPatches,
      contentPatches,
    );
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
      prevCount: previousBlockPrefixForDiff === undefined
        ? previousBlocksForDiff.length
        : previousBlockPrefixForDiff + previousBlocksForDiff.length,
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
    rootReplacedTableIds?: ReadonlySet<string>,
    nextBlockStart?: number,
  ): Promise<{ patches: Patch[]; changedBlockCount: number }> {
    const patches: Patch[] = [];
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(previousBlocks.length, "engine");
    }
    const prevMap = new Map(previousBlocks.map((block) => [block.id, block]));
    const lightweightForDiff = (block: Block): Block =>
      this.nativeContainerActivePathSnapshots.has(block.id) && (block.type === "list" || block.type === "blockquote")
        ? { ...block, payload: { ...block.payload, meta: {} } }
        : block;
    let changedBlockIds = new Set<string>();
    if (changedRanges.length > 0) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(previousBlocks.length + nextBlocks.length, "engine");
      }
      changedBlockIds = collectChangedBlockIds(
        previousBlocks.map(lightweightForDiff),
        nextBlocks.map(lightweightForDiff),
        changedRanges,
      );
    }
    for (let index = nextBlockStart ?? 0; index < nextBlocks.length; index += 1) {
      const nextBlock = nextBlocks[index]!;
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(1, "engine");
      }
      if (rootReplacedTableIds?.has(nextBlock.id)) continue;
      const prevBlock = prevMap.get(nextBlock.id);
      if (!prevBlock) continue;
      if (this.nativeContainerActivePathSnapshots.has(nextBlock.id)
        && (nextBlock.type === "list" || nextBlock.type === "blockquote")) {
        const previousRange = prevBlock.payload.range;
        const nextRange = nextBlock.payload.range;
        const rangeChanged = Boolean(previousRange && nextRange
          && (previousRange.from !== nextRange.from || previousRange.to !== nextRange.to));
        const props: Record<string, unknown> = {};
        if (changedBlockIds.has(nextBlock.id) && prevBlock.isFinalized && !nextBlock.isFinalized) {
          props.isFinalized = false;
        }
        if (rangeChanged && nextRange) props.range = { ...nextRange };
        const previousMeta = prevBlock.payload.meta;
        const nextMeta = nextBlock.payload.meta;
        if (nextMeta?.loose !== undefined
          && (rangeChanged || previousMeta?.loose !== nextMeta.loose)) {
          props.loose = nextMeta.loose;
        }
        // Nested children travel as structural patches; other meta (document plugin output included) is published whole.
        const { preparedNested: _previousNested, ...previousConsumerMeta } = previousMeta ?? {};
        const { preparedNested: _nextNested, ...nextConsumerMeta } = nextMeta ?? {};
        if (JSON.stringify(previousConsumerMeta) !== JSON.stringify(nextConsumerMeta)) {
          props.meta = nextConsumerMeta;
        }
        if (Object.keys(props).length > 0) {
          patches.push({
            op: "setProps",
            at: { blockId: nextBlock.id },
            props,
            meta: { kind: "semantic" },
          });
        }
        continue;
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
            op: "setProps",
            at: { blockId: nextBlock.id },
            props: {
              block: cloned,
              ...(cloned.payload.range ? { range: { ...cloned.payload.range } } : {}),
              ...(cloned.payload.meta ? { meta: { ...cloned.payload.meta } } : {}),
            },
            meta: { kind: "semantic" },
          });
          patches.push({
            op: "setHTML",
            at: { blockId: nextBlock.id },
            html: nextSanitized,
            policy: "markdown-renderer-v2",
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
      generation: this.documentGeneration,
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


  /**
   * The last tree may cover only the root native tail, so a container is reparsed from its own source lines.
   * Node offsets are relative to the returned `sourceOffset` (the container's line start).
   */
  private nativeContainerNodeForBlock(block: Block): { node: SyntaxNode; sourceOffset: number } | undefined {
    const range = block.payload.range;
    if (typeof range?.from !== "number" || typeof range.to !== "number") return undefined;
    const source = this.sourceDocument.snapshot();
    let lineStart = range.from;
    while (lineStart > 0 && range.from - lineStart < 4) {
      const previous = source.read(lineStart - 1, lineStart);
      if (previous === "\n" || previous === "\r") break;
      lineStart -= 1;
    }
    const tree = new NativeMarkdownInput(new SourceRangeInput(source, lineStart, range.to)).parse(this.mdParser);
    const cursor = tree.cursor();
    if (!cursor.firstChild()) return undefined;
    do {
      const type = cursor.type.name;
      const nativeContainer = type === "BulletList" || type === "OrderedList" || type === "Blockquote";
      if (nativeContainer && cursor.from + lineStart === range.from && cursor.to + lineStart === range.to) {
        return { node: cursor.node, sourceOffset: lineStart };
      }
    } while (cursor.nextSibling());
    return undefined;
  }

  private finalizeClosedNestedParagraphOwner(
    owner: RootParagraphSourceOwner,
    blockId: string,
    source: SourceSnapshot,
  ): void {
    if (this.nestedParagraphOwners.get(owner.id) !== owner
      || this.nestedParagraphOwnerContainers.get(owner.id) !== blockId) return;
    const previous = owner.getMetadata();
    if (previous.state !== "closed") return;
    const finalized = owner.finalize({
      ownerStart: previous.sourceRange.from,
      ownerEnd: previous.sourceRange.to,
      processedTo: previous.processedTo,
      mode: "bounded-physical-tail",
      closure: "finalized",
      requiresOwnerReplacement: false,
    }, source, owner.getSourceTextReader());
    this.syncNestedParagraphOwnerLedger(owner);
    if (finalized.requiresOwnerReplacement) {
      throw new Error(`Native paragraph owner ${owner.id} could not finalize its closed source lease`);
    }
    this.syncNestedParagraphFootnoteTargetOwner(owner);
    this.publishParagraphLinkReferences(owner);
    const appendChange = rootParagraphAppendChange(source, previous, finalized);
    const appendPatch = rootParagraphAppendPatch(owner, appendChange);
    this.pendingNativeNestedOwnerPatches.push({
      ...appendPatch,
      at: { blockId, nodeId: owner.id },
    });
  }

  private async finalizeClosedNestedCodeOwner(owner: NativeNestedCodeSourceOwner): Promise<void> {
    if (this.nestedCodeOwners.get(owner.id) !== owner || owner.state !== "closed") return;
    const change = owner.finalizeClosed();
    this.syncNestedCodeOwnerLedger(owner);
    if (change.revision !== change.expectedRevision) {
      this.pendingNativeNestedOwnerPatches.push(owner.appendPatch(change));
    }
    let presentation = this.refreshNativeNestedCodePresentation(owner);
    if (presentation) {
      this.pendingNativeNestedOwnerPatches.push({
        op: "setProps",
        at: { blockId: owner.containerId, nodeId: owner.id },
        props: { block: presentation },
        meta: { kind: "enrichment" },
      });
    }
    if (this.shouldDeferNativeNestedCodeHighlight(owner)) return;
    const decorations = owner.isDiff && this.highlightOutputMode !== "html"
      ? await this.rootCodeHighlighter.tokenizeRange(
          owner,
          0,
          owner.getLines().length,
          this.rootCodeHighlightConfiguration(true),
          () => !this.disposed,
        )
      : await this.rootCodeHighlighter.decorateAvailable(
          owner,
          this.rootCodeHighlightConfiguration(true),
          () => !this.disposed,
        );
    if (decorations.length === 0) return;
    const patch = owner.decoratePatch(this.rootCodeConfigurationRevision, decorations);
    if (patch) this.pendingNativeNestedOwnerPatches.push(patch);
    presentation = this.refreshNativeNestedCodePresentation(owner);
    if (presentation) {
      this.pendingNativeNestedOwnerPatches.push({
        op: "setProps",
        at: { blockId: owner.containerId, nodeId: owner.id },
        props: { block: presentation },
        meta: { kind: "enrichment" },
      });
    }
  }

  private async finalizeNestedParagraphs(metricsCollector: WorkerMetricsCollector): Promise<void> {
    const source = this.sourceDocument.snapshot();
    const containersToFinalize = new Set(this.nativeContainerTails.keys());
    const closedParagraphOwners: Array<{ readonly owner: RootParagraphSourceOwner; readonly blockId: string }> = [];
    const closedCodeOwners: NativeNestedCodeSourceOwner[] = [];
    for (const containerId of this.activeNestedParagraphByContainer.keys()) {
      containersToFinalize.add(containerId);
    }
    for (const containerId of this.activeNestedCodeByContainer.keys()) {
      containersToFinalize.add(containerId);
    }
    for (const containerId of this.activeNestedTableByContainer.keys()) {
      containersToFinalize.add(containerId);
    }
    for (const ownerId of this.unfinishedNestedParagraphOwnerIds) {
      const owner = this.nestedParagraphOwners.get(ownerId);
      if (!owner) throw new Error(`Native paragraph owner ${ownerId} is missing from its current owner registry`);
      const metadata = owner.getMetadata();
      if (metadata.state === "finalized") {
        this.syncNestedParagraphOwnerLedger(owner);
        continue;
      }
      const blockId = this.nestedParagraphOwnerContainers.get(ownerId);
      if (!blockId || !this.nativeContainerBlockAtSourceStart(blockId)) {
        throw new Error(`Native paragraph owner ${owner.id} is missing from the current container tree`);
      }
      if (metadata.state === "open") containersToFinalize.add(blockId);
      else closedParagraphOwners.push({ owner, blockId });
    }
    for (const ownerId of this.unfinishedNestedCodeOwnerIds) {
      const owner = this.nestedCodeOwners.get(ownerId);
      if (!owner) throw new Error(`Native code owner ${ownerId} is missing from its current owner registry`);
      if (owner.state === "finalized") {
        this.syncNestedCodeOwnerLedger(owner);
        continue;
      }
      if (!this.nativeContainerBlockAtSourceStart(owner.containerId)) {
        throw new Error(`Native code owner ${owner.id} is missing from the current container tree`);
      }
      if (owner.state === "open") containersToFinalize.add(owner.containerId);
      else closedCodeOwners.push(owner);
    }
    for (const ownerId of this.unfinishedNestedTableOwnerIds) {
      const owner = this.nestedTableOwners.get(ownerId);
      if (!owner) throw new Error(`Native table owner ${ownerId} is missing from its current owner registry`);
      const metadata = owner.getMetadata();
      if (metadata.state === "finalized") {
        this.syncNestedTableOwnerLedger(owner);
        continue;
      }
      const blockId = this.nestedTableOwnerContainers.get(ownerId);
      if (!blockId || !this.nativeContainerBlockAtSourceStart(blockId)) {
        throw new Error(`Native table owner ${owner.id} is missing from the current container tree`);
      }
      if (metadata.state === "open") containersToFinalize.add(blockId);
    }
    const hasCustomDocumentPlugins = (this.extensions?.documentPlugins?.length ?? 0) > 0
      || this.documentPluginRegistry.getAll().some((plugin) => plugin !== FootnotesPlugin
        && plugin !== TablesPlugin
        && plugin !== CalloutsPlugin
        && plugin !== HTMLBlockPlugin
        && plugin !== MDXDetectionPlugin);
    const containersToFinalizeInSourceOrder: Array<{ readonly id: string; readonly sourceStart: number }> = [];
    let retainedGenericSourceBefore = source.length;
    for (const containerId of containersToFinalize) {
      const sourceStart = this.nativeContainerSourceStarts.get(containerId);
      if (sourceStart === undefined) {
        throw new Error(`Native container ${containerId} is missing from the current container tree`);
      }
      containersToFinalizeInSourceOrder.push({ id: containerId, sourceStart });
      retainedGenericSourceBefore = Math.min(retainedGenericSourceBefore, sourceStart);
    }
    for (const { blockId } of closedParagraphOwners) {
      const containerSourceStart = this.nativeContainerSourceStarts.get(blockId);
      if (containerSourceStart !== undefined) {
        retainedGenericSourceBefore = Math.min(retainedGenericSourceBefore, containerSourceStart);
      }
    }
    containersToFinalizeInSourceOrder.sort((left, right) => left.sourceStart - right.sourceStart);
    let retainedRootSourceBefore = source.length;
    this.forEachUnfinishedRootBlock((block) => {
      const blockSourceFrom = block.payload.range?.from ?? 0;
      retainedRootSourceBefore = Math.min(retainedRootSourceBefore, blockSourceFrom);
      retainedGenericSourceBefore = Math.min(retainedGenericSourceBefore, blockSourceFrom);
    });
    let previousBlockPrefixCount: number | undefined;
    if (!hasCustomDocumentPlugins
      && this.nestedParagraphFootnoteTargetOwnerIds.size === 0
      && this.hasNoFootnoteArtifactsForSource(source, false, retainedGenericSourceBefore)) {
      const prefixCount = rootSourceBoundary(
        this.blocks,
        retainedGenericSourceBefore,
        rootBlockSourceFrom,
        typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
          ? this.campaignCounters
          : undefined,
      );
      const prefixTail = prefixCount > 0 ? this.blocks[prefixCount - 1] : undefined;
      if (prefixCount > 0 && prefixTail?.isFinalized) previousBlockPrefixCount = prefixCount;
    }
    const firstPreviousBlock = previousBlockPrefixCount ?? 0;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.campaignCounters?.recordDocumentRecordsVisited(this.blocks.length - firstPreviousBlock, "engine");
    }
    let previousBlocks: Block[] = [];
    for (let index = firstPreviousBlock; index < this.blocks.length; index += 1) {
      const block = this.blocks[index]!;
      previousBlocks.push(
        hasCustomDocumentPlugins || !block.isFinalized || containersToFinalize.has(block.id)
          ? cloneBlock(block)
          : block,
      );
    }
    for (const { id: containerId, sourceStart } of containersToFinalizeInSourceOrder) {
      const block = this.rootBlockAtSourceStart(sourceStart);
      if (!block
        || block.id !== containerId
        || (block.type !== "list" && block.type !== "blockquote")) {
        throw new Error(`Native container ${containerId} is missing from the current container tree`);
      }
      const tail = this.nativeContainerTails.get(block.id);
      if (tail) {
        const tailChange = tail.finalize(source, block.payload.range?.to ?? source.length);
        if (tailChange === NATIVE_CONTAINER_TAIL_VANISHED) {
          throw new Error(`Native container ${block.id} (${tail.state.ownerType}) vanished from its bounded window`);
        }
        if (!tailChange) throw new Error(`Native container ${block.id} could not finalize its active tail`);
        await this.prepareNativeNestedChildren(block, { forceFinalize: true }, [], tailChange.rootNode, tailChange);
      } else {
        const native = this.nativeContainerNodeForBlock(block);
        if (!native) throw new Error(`Native container ${block.id} is missing from its source`);
        await this.prepareNativeNestedChildren(block, { forceFinalize: true, sourceOffset: native.sourceOffset }, [], native.node);
      }
    }

    // Closed leaves only need lifecycle patches; completed containers stay out of the parse path.
    for (const { owner, blockId } of closedParagraphOwners) {
      if (!containersToFinalize.has(blockId)) {
        this.finalizeClosedNestedParagraphOwner(owner, blockId, source);
      }
    }
    for (const owner of closedCodeOwners) {
      if (!containersToFinalize.has(owner.containerId)) await this.finalizeClosedNestedCodeOwner(owner);
    }

    const finalizePatches: Patch[] = [];
    this.forEachUnfinishedRootBlock((block) => {
      block.isFinalized = true;
      finalizePatches.push({ op: "finalize", at: { blockId: block.id } });
    });
    const nestedFootnoteTargets = this.nestedParagraphFootnoteTargetOwnerIds.size > 0
      ? { rebuild: true }
      : undefined;
    // Retain finalized-path snapshots until diffBlockContent consumes them; they are not unfinished owners.
    if (previousBlockPrefixCount !== undefined
      && (this.nativeContainerTails.size > 0
        || this.nativeFenceHeaderFrontiers.size > 0
        || this.unfinishedNestedCodeOwnerIds.size > 0
        || this.unfinishedNestedTableOwnerIds.size > 0
        || this.unfinishedNestedParagraphOwnerIds.size > 0
        || this.activeNestedCodeByContainer.size > 0
        || this.activeNestedParagraphByContainer.size > 0
        || this.activeNestedTableByContainer.size > 0
        || this.openRootCodeOwners.size > 0
        || this.openRootTableOwners.size > 0
        || this.openRootParagraphOwners.size > 0
        || nestedFootnoteTargets
        || !this.hasNoFootnoteArtifactsForSource(source, false, retainedGenericSourceBefore))) {
      const previousBlockSuffix = previousBlocks;
      previousBlocks = [];
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.campaignCounters?.recordDocumentRecordsVisited(this.blocks.length, "engine");
      }
      for (let index = 0; index < this.blocks.length; index += 1) {
        previousBlocks.push(index < previousBlockPrefixCount
          ? this.blocks[index]!
          : previousBlockSuffix[index - previousBlockPrefixCount]!);
      }
      previousBlockPrefixCount = undefined;
    }
    this.pendingRootParagraphPatches = [];
    this.pendingRootTablePatches = [];
    this.blocks = this.runDocumentPlugins(
      this.blocks,
      source,
      nestedFootnoteTargets,
      !hasCustomDocumentPlugins ? retainedGenericSourceBefore : undefined,
    );
    finalizePatches.push(...this.takePendingRootParagraphPatches(), ...this.takePendingRootTablePatches());
    this.forEachUnfinishedRootBlock((block) => {
      block.isFinalized = true;
      finalizePatches.push({ op: "finalize", at: { blockId: block.id } });
    });

    metricsCollector.setBlocksProduced(this.blocks.length);
    let progressPublication: ProgressPublicationContext | undefined;
    if (
      typeof __STREAM_MDX_COUNTERS__ !== "undefined"
      && __STREAM_MDX_COUNTERS__
      && this.campaignCounters?.isProgressTraceEnabled?.()
    ) {
      progressPublication = this.createProgressPublication(this.sourceDocument.length);
    }
    this.parseEpochCounter += 1;
    await this.emitBlockDiffPatches(
      previousBlocks,
      this.blocks,
      [],
      metricsCollector,
      progressPublication,
      this.parseEpochCounter,
      finalizePatches,
      undefined,
      undefined,
      undefined,
      !hasCustomDocumentPlugins
        ? (previousBlockPrefixCount !== undefined
          ? retainedGenericSourceBefore
          : retainedRootSourceBefore)
        : undefined,
      undefined,
      previousBlockPrefixCount,
    );
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && progressPublication) {
      this.recordParsedProgressPublication(progressPublication);
    }
  }

  private async finalizeAllBlocks(): Promise<void> {
    const metricsCollector = new WorkerMetricsCollector(this.workerGrammarEngine);
    this.activeMetricsCollector = metricsCollector;
    this.deferredPatchQueue = [];
    this.lazyTokenizationQueue.clear();
    let progressPublication: ProgressPublicationContext | undefined;
    const sourceLength = this.sourceDocument.length;

    if (this.pendingRootCodeOwners.size > 0 || this.pendingRootTableOwners.size > 0 || this.pendingRootParagraphOwners.size > 0) {
      const source = this.sourceDocument.snapshot();
      const semanticPatches: Patch[] = [];
      const ownersToDecorate: RootCodeSourceOwner[] = [];
      const hasCustomDocumentPlugins = (this.extensions?.documentPlugins?.length ?? 0) > 0
        || this.documentPluginRegistry.getAll().some((plugin) => plugin !== FootnotesPlugin
          && plugin !== TablesPlugin
          && plugin !== CalloutsPlugin
          && plugin !== HTMLBlockPlugin
          && plugin !== MDXDetectionPlugin);
      const previousRootOwnerWindow = hasCustomDocumentPlugins
        ? undefined
        : this.rootOwnerSnapshotWindow(this.rootOwnerSnapshotFrom(sourceLength));
      const previousRootParagraphOwners = previousRootOwnerWindow?.paragraphOwners ?? this.rootParagraphOwners.slice();
      let previousRootParagraphTargets: FootnoteParagraphTargetDelta[];

      for (const owner of this.pendingRootCodeOwners) {
        const previous = owner.getMetadata();
        const change = owner.finalize();
        const next = owner.getMetadata();
        const wasEmitted = this.emittedRootCodeIds.has(owner.id);
        if (!wasEmitted) {
          semanticPatches.push(this.rootCodeInsertPatch(owner));
          ownersToDecorate.push(owner);
          this.markRootCodeOwnerEmitted(owner);
        } else if (next.revision !== previous.revision) {
          semanticPatches.push(rootCodeAppendPatch(owner, rootCodeAppendChange(owner, source, previous, change)));
          ownersToDecorate.push(owner);
          this.refreshPendingRootCodeOwner(owner);
        } else {
          this.refreshPendingRootCodeOwner(owner);
        }
      }
      let remainingRootFrom: number | undefined;
      let replacementRootFrom: number | undefined;
      for (const owner of this.pendingRootTableOwners) {
        const previous = owner.getMetadata();
        let appendChange: RootTablePatchChange | undefined;
        if (previous.state !== "closed") {
          const change = owner.finalize();
          const next = owner.getMetadata();
          if (next.revision !== previous.revision) {
            appendChange = rootTableAppendChange(source, previous, change);
          }
        }
        this.refreshPendingRootTableOwner(owner);
        if (!this.emittedRootTableIds.has(owner.id)) {
          semanticPatches.push(this.rootTableInsertPatch(owner));
          this.markRootTableOwnerEmitted(owner);
        } else if (appendChange) {
          semanticPatches.push(rootTableAppendPatch(owner, appendChange));
        }
        if (appendChange?.rootResumeFrom !== undefined) {
          remainingRootFrom = remainingRootFrom === undefined
            ? appendChange.rootResumeFrom
            : Math.min(remainingRootFrom, appendChange.rootResumeFrom);
        }
      }
      for (const owner of this.pendingRootParagraphOwners) {
        const previous = owner.getMetadata();
        if (previous.state === "finalized") {
          // A settled owner can still be pending if its store insertion was not emitted yet.
          if (!this.emittedRootParagraphIds.has(owner.id)) {
            this.publishParagraphLinkReferences(owner);
            semanticPatches.push(this.rootParagraphInsertPatch(owner));
            this.markRootParagraphOwnerEmitted(owner);
          }
          continue;
        }
        const change = finalizeRootParagraphOwner(owner, source);
        if (rootParagraphChangeNeedsReplacement(change) || this.rootParagraphChangeContainsInlineHtml(change, source)) {
          const replacementFrom = this.rootParagraphReplacementFrom(source, previous.sourceRange.from);
          replacementRootFrom = replacementRootFrom === undefined
            ? replacementFrom
            : Math.min(replacementRootFrom, replacementFrom);
          this.retireRootParagraphOwner(owner);
          continue;
        }
        this.publishParagraphLinkReferences(owner);
        const appendChange = rootParagraphAppendChange(source, previous, change);
        if (!this.emittedRootParagraphIds.has(owner.id)) {
          semanticPatches.push(this.rootParagraphInsertPatch(owner));
          this.markRootParagraphOwnerEmitted(owner);
        } else if (change.paragraph.revision !== previous.revision) {
          semanticPatches.push(rootParagraphAppendPatch(owner, appendChange));
          this.refreshPendingRootParagraphOwner(owner);
        } else {
          this.refreshPendingRootParagraphOwner(owner);
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
      previousRootParagraphTargets = previousRootParagraphOwners.flatMap((owner) => {
        const from = owner.getMetadata().sourceRange.from;
        return this.rootParagraphOwnersByStart.get(from) === owner
          ? [this.rootParagraphFootnoteTargetDelta(owner, owner.getSpans().materialize())]
          : [];
      });


      const managedTailOffset = this.rootManagedTailOffset() ?? sourceLength;
      let tailOffset = Math.min(
        replacementRootFrom ?? sourceLength,
        remainingRootFrom ?? sourceLength,
        // A fragment can retain already-owned roots; EOF must not re-admit that completed prefix.
        Math.max(this.rootNativeFragmentOffset ?? 0, managedTailOffset),
      );
      // processedTo includes lookahead; an unfinished semantic root can begin before it.
      this.forEachUnfinishedRootBlock((block) => {
        const from = block.payload.range?.from;
        if (typeof from === "number" && Number.isSafeInteger(from) && from >= 0) {
          tailOffset = Math.min(tailOffset, from);
        }
      });
      if (!hasCustomDocumentPlugins) {
        const boundaryIndex = rootSourceBoundary(
          this.blocks,
          tailOffset,
          rootBlockSourceFrom,
          typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
            ? this.campaignCounters
            : undefined,
        );
        const previousRootBlock = boundaryIndex > 0 ? this.blocks[boundaryIndex - 1] : undefined;
        const previousRange = previousRootBlock?.payload.range;
        if (previousRootBlock?.isFinalized
          && typeof previousRange?.from === "number"
          && Number.isSafeInteger(previousRange.from)
          && previousRange.from >= 0
          && typeof previousRange.to === "number"
          && Number.isSafeInteger(previousRange.to)
          && previousRange.to > previousRange.from
          && previousRange.to <= sourceLength
          && previousRange.from < tailOffset
          && tailOffset < previousRange.to) {
          const pendingBoundaryInsidePreviousRoot =
            (replacementRootFrom !== undefined
              && replacementRootFrom >= previousRange.from
              && replacementRootFrom < previousRange.to)
            || (remainingRootFrom !== undefined
              && remainingRootFrom >= previousRange.from
              && remainingRootFrom < previousRange.to);
          tailOffset = pendingBoundaryInsidePreviousRoot ? previousRange.from : previousRange.to;
        }
      }
      this.treeFragments = [];
      this.rootNativeFragmentOffset = tailOffset;
      this.forEachUnfinishedRootBlock((block) => {
        const from = block.payload.range?.from;
        if (typeof from === "number" && from >= tailOffset) return;
        semanticPatches.push({ op: "finalize", at: { blockId: block.id } });
      });
      await this.parseRootNativeTail(
        tailOffset,
        sourceLength,
        sourceLength,
        metricsCollector,
        true,
        semanticPatches,
        previousRootParagraphOwners,
        { deltas: previousRootParagraphTargets },
        previousRootOwnerWindow,
      );
      for (const owner of ownersToDecorate) {
        const decorationPatch = await this.decorateRootCode(owner, true);
        const patches: Patch[] = [];
        if (decorationPatch) patches.push(decorationPatch);
        patches.push(...this.rootCodePresentationPatches(owner));
        this.dispatchPatchBatch(patches, metricsCollector);
      }
      metricsCollector.setBlocksProduced(this.blocks.length);
    } else if (this.nestedParagraphOwners.size > 0) {
      await this.finalizeNestedParagraphs(metricsCollector);
    } else {
      const source = this.sourceDocument.snapshot();
      let tailOffset = sourceLength;
      this.forEachUnfinishedRootBlock((block) => {
        if (tailOffset === 0) return;
        const from = block.payload.range?.from;
        if (typeof from !== "number") return;
        if (!Number.isInteger(from) || from < 0 || from > sourceLength) {
          tailOffset = 0;
          return;
        }
        tailOffset = Math.min(tailOffset, sourceLineStart(source, from));
      });


      // parseRootNativeTail invalidates fragments when this source boundary differs from their stored window.
      await this.parseRootNativeTail(
        tailOffset,
        sourceLength,
        sourceLength,
        metricsCollector,
        true,
      );
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
      admittedSourceUnits: this.admittedSourceUnits,
    });

    if (this.activeMetricsCollector === metricsCollector) {
      this.activeMetricsCollector = null;
    }
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
