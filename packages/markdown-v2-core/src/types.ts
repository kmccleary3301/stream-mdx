// Core contracts (public types) - V2 Markdown Renderer
// Based on final_spec.md architecture

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
    compiledMdxRef?: { id: string } | null; // server-compiled artifact key
    compiledMdxModule?: CompiledMdxModule | null; // inline compiled module (worker/client side)
    meta?: Record<string, unknown>; // e.g., code fence info, table align
    range?: { from: number; to: number }; // original source offsets
  };
}

export interface CompiledMdxModule {
  id: string;
  code: string;
  dependencies?: string[];
  source?: "server" | "worker";
}

export interface MixedContentSegment {
  kind: "text" | "html" | "mdx";
  value: string;
  range?: { from: number; to: number };
  inline?: InlineNode[];
  sanitized?: string;
  status?: "pending" | "compiled" | "error";
  error?: string;
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
export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "em"; children: InlineNode[] }
  | { kind: "strike"; children: InlineNode[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href?: string; title?: string; children: InlineNode[] }
  | { kind: "image"; src: string; alt?: string; title?: string }
  | { kind: "br" }
  // extensible:
  | { kind: "mention"; handle: string }
  | { kind: "citation"; id: string }
  | { kind: "math-inline"; tex: string }
  | { kind: "math-display"; tex: string }
  | { kind: "footnote-ref"; label: string; number?: number };

/**
 * Worker communication protocol
 */
export type WorkerIn =
  | {
      type: "INIT";
      initialContent?: string;
      prewarmLangs?: string[];
      docPlugins?: {
        footnotes?: boolean;
        html?: boolean;
        mdx?: boolean;
        tables?: boolean;
        callouts?: boolean;
        math?: boolean;
        formatAnticipation?: FormatAnticipationConfig;
        liveCodeHighlighting?: boolean;
        mdxComponentNames?: string[];
      };
      mdx?: { compileMode?: "server" | "worker" };
    }
  | { type: "APPEND"; text: string }
  | { type: "FINALIZE" }
  | { type: "MDX_COMPILED"; blockId: string; compiledId: string }
  | { type: "MDX_ERROR"; blockId: string; error?: string }
  | { type: "SET_CREDITS"; credits: number };

export type WorkerPhase = WorkerIn["type"] | "UNKNOWN";

export interface WorkerErrorPayload {
  message: string;
  name?: string;
  stack?: string;
}

export type WorkerOut =
  | { type: "INITIALIZED"; blocks: Block[] }
  | { type: "PATCH"; tx: number; patches: Patch[]; metrics?: PatchMetrics }
  | { type: "RESET"; reason: string }
  | { type: "METRICS"; metrics: PerformanceMetrics }
  | { type: "ERROR"; phase: WorkerPhase; error: WorkerErrorPayload; blockId?: string; meta?: Record<string, unknown>; timestamp?: number };

/**
 * Inline plugin system
 */
export interface InlinePlugin {
  id: string;
  priority: number; // lower runs earlier
  apply(nodes: InlineNode[]): InlineNode[];
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
}

/**
 * Incremental patch protocol (initial block-level implementation).
 * These types will evolve to support subtree updates.
 */
export const PATCH_ROOT_ID = "__root__";

export interface NodeSnapshot {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: NodeSnapshot[];
  range?: { from: number; to: number };
  meta?: Record<string, unknown>;
}

export interface NodePath {
  blockId: string;
  nodeId?: string;
  indexPath?: number[];
}

export type Patch =
  | { op: "insertChild"; at: NodePath; index: number; node: NodeSnapshot }
  | { op: "deleteChild"; at: NodePath; index: number }
  | { op: "replaceChild"; at: NodePath; index: number; node: NodeSnapshot }
  | { op: "setProps"; at: NodePath; props: Record<string, unknown> }
  | { op: "setPropsBatch"; entries: SetPropsBatchEntry[] }
  | { op: "finalize"; at: NodePath }
  | { op: "reorder"; at: NodePath; from: number; to: number; count: number }
  | {
      op: "appendLines";
      at: NodePath;
      startIndex: number;
      lines: string[];
      highlight?: Array<string | null>;
    }
  | {
      op: "setHTML";
      at: NodePath;
      html: string;
      policy?: string;
      block?: Block;
      meta?: Record<string, unknown>;
      sanitized?: boolean;
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
}

export interface CoalescingMetrics {
  inputPatchCount: number;
  outputPatchCount: number;
  coalescedCount: number;
  durationMs: number;
  appendLinesCoalesced: number;
  setPropsCoalesced: number;
  insertChildCoalesced: number;
}
