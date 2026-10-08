import type { MarkdownConfig } from "@lezer/markdown";
import type {
  Block,
  CodeHighlightOutputMode,
  DiffKind,
  DiffLine,
  DiffLineKind,
  FormatAnticipationConfig,
  InlineNode,
  MixedContentSegment,
  NodeSnapshot,
  Patch,
  ProtectedRange,
  ThemedLine,
  TokenLineV1,
  TokenSpan,
  TokenStyle,
  WorkerIn,
  WorkerOut,
} from "@stream-mdx/core";
import type { DocumentPlugin } from "@stream-mdx/plugins";

export interface InlineExtension {
  name: string;
  [key: string]: unknown;
}

export interface EngineExtensions {
  markdown?: MarkdownConfig[];
  inline?: unknown[];
  documentPlugins?: DocumentPlugin[];
}

export interface MarkdownEngineOptions {
  post: (message: WorkerOut) => void;
  extensions?: EngineExtensions;
}

export interface InlineEngineWorkerOptions {
  extensions?: EngineExtensions;
}

export interface ServeMarkdownWorkerOptions {
  extensions?: EngineExtensions;
  scope?: unknown;
}

export type CodeHighlightingMode = "final" | "incremental" | "live";
export type WorkerMdxMode = "server" | "worker";

export interface ShikiTokenStyle {
  color?: string;
  fontStyle?: number;
}

export interface ShikiThemedToken {
  content: string;
  offset?: number;
  variants: {
    dark?: ShikiTokenStyle;
    light?: ShikiTokenStyle;
    [theme: string]: ShikiTokenStyle | undefined;
  };
}

export interface DiffCursorState {
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffLineInfo {
  kind: DiffKind;
  raw: string;
  text?: string;
  prefix?: string;
  content?: string;
  oldNo?: number | null;
  newNo?: number | null;
  hunkHeader?: boolean;
}
export interface IncrementalHighlightState {
  lang: string;
  tokenLang?: string;
  processedLength: number;
  pendingLine: string;
  highlightedLines: Array<string | null>;
  tokenLines: Array<TokenLineV1 | null>;
  diffKind: DiffLineKind[];
  oldNo: Array<number | null>;
  newNo: Array<number | null>;
  diffCursor?: DiffCursorState;
  grammarState?: unknown;
}

export interface LazyTokenizationState {
  signature: string;
  lineCount: number;
  processedLines: number;
  highlightedLines: Array<string | null>;
  tokenLines: Array<TokenLineV1 | null>;
  diffKind: DiffLineKind[];
  oldNo: Array<number | null>;
  newNo: Array<number | null>;
  diffCursor?: DiffCursorState;
  grammarState?: unknown;
  inProgressRange?: { startLine: number; endLine: number } | null;
}

export interface ContentChangeRange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

export interface MdxStatusUpdate {
  compiledRef?: { id: string };
  status: "compiled" | "error";
  error?: string;
  rawSignature?: string;
}

export interface ParseOptions {
  forceFinalize?: boolean;
}
