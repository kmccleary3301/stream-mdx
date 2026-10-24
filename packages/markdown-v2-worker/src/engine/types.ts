import type { MarkdownConfig } from "@lezer/markdown";
import type {
  Block,
  DiffKind,
  DiffLineKind,
  InlineExtension,
  TokenLineV1,
  SyntaxExtensionDescriptor,
  WorkerOut,
} from "@stream-mdx/core";
import type { DocumentPlugin } from "@stream-mdx/plugins";

export type { InlineExtension, SyntaxRuleSpec, SyntaxExtensionDescriptor, ContainerExtensionSpec, HtmlOptions } from "@stream-mdx/core";

export interface EngineExtensions {
  markdown?: MarkdownConfig[];
  inline?: InlineExtension[];
  documentPlugins?: DocumentPlugin[];
  syntax?: SyntaxExtensionDescriptor;
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
  /** Undefined before a valid hunk; zero is retained after that side is exhausted. */
  oldRemaining?: number;
  newRemaining?: number;
  /** First source line of the current unified-diff file, when known. */
  fileStartLine?: number;
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


export interface ParseOptions {
  forceFinalize?: boolean;
  firstChangedPos?: number;
  previousBlocks?: Block[];
  sourceOffset?: number;
  /** Nested reparses of one document keep the document's heading slug counts. */
  continueHeadingIds?: boolean;
  admitRootCodeOwners?: boolean;
  admitRootTableOwners?: boolean;
  admitRootParagraphOwners?: boolean;
}
