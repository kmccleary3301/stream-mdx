import type { RestrictedComponentDescriptor } from "./admission";

import type { CodeLineDecorationUpdate, CodeLineRecord } from "./code-records";
import type { TableBlockSnapshot, TableBlockSourceMetadata, TableHeaderRecord, TableRowRecord } from "./table-records";
import type { ParagraphBlockSnapshot, ParagraphBlockSourceMetadata, ParagraphSpanRecord, ParagraphSpanUpdate } from "./paragraph-records";
import type { TableRowIndexUpdate } from "./table-row-index";

/** Matching worker, renderer and NDJSON schema identity; protocol re-exports this value. */
export const STREAM_MDX_SCHEMA_VERSION = "2.0";

// Core contracts (public types) - V2 Markdown Renderer
// Based on final_spec.md architecture

export interface BlockResolvedLinkReference {
  label: string;
  href: string;
  title?: string;
}

export interface BlockMeta {
  /**
   * Link reference definitions resolved and referenced by this block's inline content.
   * Omitted when no reference definitions were used.
   */
  linkReferences?: BlockResolvedLinkReference[];
  /** Sanitized HTML ownership with inline text prepared by the owning engine parser. */
  htmlTree?: HtmlTreeNode[];
  htmlParagraphTree?: HtmlTreeNode[];
  /** Engine-prepared Markdown owners for compiler-authored trusted MDX flow children. */
  trustedMdxNativeChildren?: HtmlTreeNode[];
  [key: string]: unknown;
}

/**
 * Core Block representation for streaming markdown
 */
export interface Block {
  id: string; // stable content hash
  type: "paragraph" | "heading" | "code" | "list" | "blockquote" | "mdx" | "html" | "table" | "footnote-def" | "footnotes" | string;
  isFinalized: boolean;
  payload: {
    raw: string;
    inline?: InlineNode[]; // serialized inline tree
    highlightedHtml?: string; // safe HTML (code only)
    sanitizedHtml?: string; // sanitized HTML (html blocks)
    meta?: BlockMeta; // e.g., code fence info, table align, linkReferences
    range?: { from: number; to: number }; // original source offsets
  };
}

export type ContentPolicy = "markdown" | "restricted" | "trusted-mdx";

/** Sanitized HTML and restricted component ownership tree. Block leaves retain the engine's prepared markdown. */
export type HtmlTreeNode =
  | { kind: "text"; text: string; inline?: InlineNode[]; diagnostic?: string; rawSource?: string }
  | {
      kind: "element";
      tagName: string;
      attributes: Record<string, string>;
      children: HtmlTreeNode[];
      inlineNode?: InlineNode;
      paragraphRoot?: boolean;
    }
  | {
      kind: "component";
      name: string;
      props: Readonly<Record<string, unknown>>;
      status: "open" | "closed" | "incomplete";
      children: HtmlTreeNode[];
      rawSource?: string;
      diagnostic?: string;
    }
  | { kind: "block"; block: Block };


export interface MixedContentSegment {
  kind: "text" | "html" | "mdx";
  value: string;
  range?: { from: number; to: number };
  inline?: InlineNode[];
  sanitized?: string;
  lookahead?: unknown[];
}

export type FormatAnticipationConfig =
  | boolean
  | {
      inline?: boolean;
      mathInline?: boolean;
      mathBlock?: boolean;
      html?: boolean;
      mdx?: boolean;
      regex?: boolean;
    };

export type CodeHighlightingMode = "final" | "incremental" | "live";
export type CodeHighlightOutputMode = "html" | "tokens" | "both";

export interface CodeHighlightThemes {
  light: string;
  dark: string;
}

export interface InlineHtmlDescriptor {
  tagName: string;
  attributes: Record<string, string>;
  raw: string;
  sanitized: string;
  rawInner: string;
  sanitizedInner: string;
  text: string;
}

export type ProtectedRangeKind = "math-inline" | "math-display" | "code-inline" | "code-block" | "code-fence" | "html-inline" | "html-block" | "autolink";

export interface ProtectedRange {
  from: number;
  to: number;
  kind: ProtectedRangeKind;
}

/**
 * Inline node types for rich text rendering
 */
export type InlineNode = (
  | { kind: "text"; text: string }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "em"; children: InlineNode[] }
  | { kind: "strike"; children: InlineNode[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href?: string; title?: string; children: InlineNode[]; autolink?: boolean }
  | { kind: "image"; src: string; alt?: string; title?: string }
  | { kind: "br" }
  | {
      kind: "html";
      raw: string;
      openingRaw?: string;
      closingRaw?: string;
      sanitized?: string;
      tagName?: string;
      isClose?: boolean;
      isSelfClosing?: boolean;
      attributes?: Record<string, string>;
      children?: InlineNode[];
    }
  // extensible:
  | { kind: "mention"; handle: string }
  | { kind: "citation"; id: string }
  | { kind: "math-inline"; tex: string }
  | { kind: "math-display"; tex: string }
  | { kind: "footnote-ref"; label: string; number?: number; occurrence?: number; defined?: boolean }
  | { kind: "trusted-mdx-inline"; raw: string; ownerId: string }
  | {
      kind: "plugin";
      name: string;
      attrs: Record<string, string>;
      children?: InlineNode[];
      raw: string;
    }
) & {
  /** Authored UTF-16 offsets; absent when exact source provenance is unavailable. */
  sourceRange?: { from: number; to: number };
};

export interface FootnoteItem {
  number: number;
  label: string;
  inlines: InlineNode[];
  refCount?: number;
}

export interface SyntaxRuleSpec {
  name: string;
  pattern: { source: string; flags?: string };
  trigger?: string /* first char(s) for fast dispatch */;
  before?: string /* Lezer inline parser to precede, e.g. 'Emphasis' */;
  attrs?: Record<string, number | string> /* capture group index or literal */;
  content?: number /* capture group parsed as inline children */;
  anticipation?: { open: string; close: string };
}

export interface HtmlOptions {
  allowedTags?: Record<string, string[]>;
  literalTagContent?: string[];
}

export type TokenStyle = {
  fg?: string;
  bg?: string;
  fs?: number;
};

export type TokenSpan = {
  t: string;
  v?: { dark?: TokenStyle; light?: TokenStyle };
  s?: TokenStyle;
};

export type TokenLineV1 = {
  spans: TokenSpan[];
};

export type DiffKind = "add" | "remove" | "context" | "hunk" | "meta";
export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context";

export type ThemedToken = {
  content: string;
  color?: string | null;
  fontStyle?: number | null;
};

export type ThemedLine = ThemedToken[];

export type DiffLine = {
  kind: DiffLineKind;
  oldNo?: number | null;
  newNo?: number | null;
  raw: string;
  tokens?: ThemedLine | null;
};

export type DiffBlock = {
  kind: "diff";
  filePath?: string | null;
  language?: string | null;
  lines: DiffLine[];
  additions?: number | null;
  deletions?: number | null;
  unified?: string | null;
};

export type LazyTokenizationPriority = "visible" | "prefetch";

/**
 * Worker communication protocol
 */
export type WorkerIn =
  | {
      type: "INIT";
      schemaVersion: typeof STREAM_MDX_SCHEMA_VERSION;
      initialContent?: string;
      prewarmLangs?: string[];
      themes?: CodeHighlightThemes;
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
        lazyTokenization?: {
          enabled?: boolean;
          thresholdLines?: number;
        };
        themes?: CodeHighlightThemes;
      };
      contentPolicy?: ContentPolicy;
      contentComponents?: readonly RestrictedComponentDescriptor[];
      syntax?: SyntaxRuleSpec[];
      html?: HtmlOptions;
    }
  | { type: "APPEND"; text: string }
  | { type: "FINALIZE" }
  | { type: "DEBUG_STATE" }
  | { type: "DUMP_BLOCKS" }
  | { type: "TOKENIZE_RANGE"; blockId: string; startLine: number; endLine: number; priority?: LazyTokenizationPriority }
  | { type: "SET_CREDITS"; credits: number };

export type WorkerPhase = WorkerIn["type"] | "UNKNOWN";

export interface WorkerErrorPayload {
  message: string;
  name?: string;
  stack?: string;
}

export type WorkerOut =
  | { type: "INITIALIZED"; schemaVersion: typeof STREAM_MDX_SCHEMA_VERSION; generation: number; snapshot: NodeSnapshot }
  | { type: "FINALIZED"; generation: number }
  | { type: "PATCH"; tx: number; patches: Patch[]; metrics?: PatchMetrics }
  | { type: "RESET"; reason: string }
  | { type: "METRICS"; metrics: PerformanceMetrics }
  | { type: "DUMP_BLOCKS"; blocks: Block[]; tocHeadings?: TocHeading[] }
  | {
      type: "DEBUG_STATE";
      state: {
        contentLength: number;
        contentTail: string;
        blockCount: number;
        blockTypeCounts: Record<string, number>;
        lastBlockType?: string;
        lastBlockRange?: { from: number; to: number };
        lastBlockRawTail?: string;
        hasInlineCodeHeading: boolean;
        hasCodeBlocksHeading: boolean;
        hasMediaHeading: boolean;
      };
    }
  | { type: "ERROR"; phase: WorkerPhase; error: WorkerErrorPayload; blockId?: string; meta?: Record<string, unknown>; timestamp?: number };

/**
 * Inline plugin system
 */
export interface InlinePlugin {
  id: string;
  priority: number; // lower runs earlier
  apply?: (nodes: InlineNode[]) => InlineNode[];
}

export interface RegexInlinePlugin extends InlinePlugin {
  re: RegExp; // global; must not match across newlines
  toNode: (match: RegExpExecArray) => InlineNode | InlineNode[];
  /**
   * Optional fast-path predicate. If provided and returns false for a given text node,
   * the regex is skipped for that node.
   */
  fastCheck?: (text: string) => boolean;
  /**
   * Optional streaming anticipation config. Only used when formatAnticipation.regex is enabled.
   */
  anticipation?: RegexAnticipationPattern;
}

export interface RegexAnticipationPattern {
  start: RegExp;
  end: RegExp;
  full?: RegExp;
  append: string | ((match: RegExpExecArray, content: string) => string);
  maxScanChars?: number;
}

export interface ASTInlinePlugin extends InlinePlugin {
  visit: (node: InlineNode, ctx: { replace(node: InlineNode, next: InlineNode | InlineNode[]): void }) => void;
}

/**
 * Language normalization
 */
export const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  tf: "terraform",
  py: "python",
  rb: "ruby",
  // ...extendable map
};

/**
 * Performance metrics from worker
 */
export interface PerformanceMetrics {
  tx?: number;
  timestamp?: number;
  parseMs?: number;
  parseTime: number;
  enrichMs?: number;
  diffMs?: number;
  serializeMs?: number;
  highlightTime: number;
  shikiMs?: number;
  mdxDetectMs?: number;
  patchBytes?: number;
  patchCount?: number;
  queueDepth?: number;
  blocksProduced: number;
  grammarEngine: "js" | "wasm";
  blockCountByType?: Record<string, number>;
  blockEnrichMsByType?: Record<string, number>;
  blockSizeByType?: Record<string, number>;
  highlightByLanguage?: Record<string, { timeMs: number; count: number }>;
  appendLineBatches?: number;
  appendLineTotalLines?: number;
  appendLineMaxLines?: number;
  lazyTokenization?: {
    requests: number;
    avgRangeLines: number;
    maxRangeLines: number;
    avgLatencyMs: number;
    maxLatencyMs: number;
    maxQueue: number;
  };
}

/**
 * Incremental patch protocol (initial block-level implementation).
 * These types will evolve to support subtree updates.
 */
export const PATCH_ROOT_ID = "__root__";

/** Immutable authored-source frontier for one generation-bound code owner. */
export interface CodeBlockSourceMetadata {
  readonly codeOwnerId: string;
  readonly generation: number;
  readonly revision: number;
  readonly state: "open" | "closed" | "finalized";
  readonly processedTo: number;
  readonly completeLineCount: number;
  readonly lineCount: number;
  readonly sourceRange: { readonly from: number; readonly to: number };
}

/** Cold initial/replacement transport; routine appends carry only their changed tail. */
export interface CodeBlockSnapshot extends CodeBlockSourceMetadata {
  readonly configurationRevision: number;
  readonly info: string;
  readonly language?: string;
  readonly lines: readonly CodeLineRecord[];
  readonly raw: string;
}

export interface NodeSnapshot {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: NodeSnapshot[];
  range?: { from: number; to: number };
  meta?: Record<string, unknown>;
  code?: CodeBlockSnapshot;
  table?: TableBlockSnapshot;
  paragraph?: ParagraphBlockSnapshot;
  inputSource?: { generation: number; raw: string };
}

export interface NodePath {
  blockId: string;
  nodeId?: string;
  indexPath?: number[];
}

export type PatchKind = "semantic" | "enrichment";

export interface PatchMeta {
  /**
   * Explicit correctness class for this patch.
   * - `semantic`: changes visible meaning, structure, ordering, or finalized content
   * - `enrichment`: decorates already-correct semantic output
   *
   * Ambiguous patches should default to `semantic`.
   */
  kind?: PatchKind;
  /**
   * Reserved for epoch-aware targeting and stale-patch rejection.
   * These fields are optional until the semantic-envelope workstream is complete.
   */
  streamSeq?: number;
  parseEpoch?: number;
  tx?: number;
  blockEpoch?: number;
}

export interface TocHeading {
  id: string;
  text: string;
  level: number;
  blockId: string;
}

export type Patch =
  | {
      op: "appendInputSource";
      at: NodePath;
      generation: number;
      from: number;
      text: string;
      meta?: PatchMeta;
    }
  | { op: "insertChild"; at: NodePath; index: number; node: NodeSnapshot; meta?: PatchMeta }
  | { op: "deleteChild"; at: NodePath; index: number; meta?: PatchMeta }
  | { op: "replaceChild"; at: NodePath; index: number; node: NodeSnapshot; meta?: PatchMeta }
  | { op: "setProps"; at: NodePath; props: Record<string, unknown>; meta?: PatchMeta }
  | { op: "setPropsBatch"; entries: SetPropsBatchEntry[]; meta?: PatchMeta }
  | { op: "finalize"; at: NodePath; meta?: PatchMeta }
  | { op: "reorder"; at: NodePath; from: number; to: number; count: number; meta?: PatchMeta }
  | {
      op: "appendParagraph";
      at: NodePath;
      paragraphOwnerId: string;
      generation: number;
      expectedRevision: number;
      revision: number;
      sourceAppend: string;
      fromSpan: number;
      spans: readonly ParagraphSpanRecord[];
      paragraph: ParagraphBlockSourceMetadata;
      meta?: PatchMeta;
    }
  | {
      op: "updateParagraphSpans";
      at: NodePath;
      paragraphOwnerId: string;
      generation: number;
      expectedRevision: number;
      revision: number;
      updates: readonly ParagraphSpanUpdate[];
      paragraph: ParagraphBlockSourceMetadata;
      meta?: PatchMeta;
    }
  | {
      op: "appendTableRows";
      at: NodePath;
      table: TableBlockSourceMetadata;
      expectedRevision: number;
      fromRow: number;
      rows: readonly TableRowRecord[];
      sourceAppend: string;
      meta?: PatchMeta;
    }
  | {
      op: "updateTableRows";
      at: NodePath;
      tableOwnerId: string;
      generation: number;
      expectedRevision: number;
      revision: number;
      updates: readonly TableRowIndexUpdate[];
      header?: TableHeaderRecord;
      meta?: PatchMeta;
    }
  | {
      op: "appendCode";
      at: NodePath;
      code: CodeBlockSourceMetadata;
      expectedRevision: number;
      fromLine: number;
      lines: readonly CodeLineRecord[];
      sourceAppend: string;
      meta?: PatchMeta;
    }
  | {
      op: "decorateCode";
      at: NodePath;
      codeOwnerId: string;
      generation: number;
      configurationRevision: number;
      decorations: readonly CodeLineDecorationUpdate[];
      meta?: PatchMeta;
    }
  | {
      op: "setHTML";
      at: NodePath;
      html: string;
      policy?: string;
      block?: Block;
      meta?: Record<string, unknown>;
      sanitized?: boolean;
      patchMeta?: PatchMeta;
    };

export interface PatchMetrics {
  patchCount: number;
  changedBlocks: number;
  diffTime?: number;
  parseTime?: number;
  enrichTime?: number;
  queueDepth?: number;
  patchBytes?: number;
  appendLineBatches?: number;
  appendLineTotalLines?: number;
  appendLineMaxLines?: number;
}

export interface SetPropsBatchEntry {
  at: NodePath;
  props: Record<string, unknown>;
  meta?: PatchMeta;
}

export interface CoalescingMetrics {
  inputPatchCount: number;
  outputPatchCount: number;
  coalescedCount: number;
  durationMs: number;
  setPropsCoalesced: number;
  insertChildCoalesced: number;
}
