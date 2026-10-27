import type { MarkdownConfig } from "@lezer/markdown";
import type { HtmlOptions, InlineNode, LinkDestinationOptions, MathParseOptions, SoftBreakMode, SyntaxRuleSpec } from "../types";

export interface MarkdownElement {
  readonly type: number;
  readonly from: number;
  readonly to: number;
  readonly children: readonly MarkdownElement[];
}

export interface LinkReferenceDefinition {
  href: string;
  title?: string;
  label?: string; // label as written in the source definition
}

export type LinkReferenceMap = Map<string, LinkReferenceDefinition> | Record<string, LinkReferenceDefinition>;

export interface InlineExtension {
  name: string;
  lezer: MarkdownConfig;
  toInline: (
    element: MarkdownElement,
    text: string,
    convertChildren: (children?: readonly MarkdownElement[], from?: number, to?: number) => InlineNode[]
  ) => InlineNode | InlineNode[] | null | undefined;
}

export interface InlineParserOptions {
  /**
   * Maximum number of cached inline parses to retain in LRU cache.
   * Defaults to 2000.
   */
  maxCacheEntries?: number;

  /**
   * Enable parsing `$...$` and `$$...$$` math nodes.
   * Defaults to `true`.
   */
  enableMath?: boolean;

  /** Sanitizer allowlist and tags whose content is literal rather than markdown. */
  html?: HtmlOptions;

  /**
   * Initial link reference definitions.
   */
  references?: LinkReferenceMap;

  /**
   * Additional inline extensions.
   */
    extensions?: InlineExtension[];

  /**
   * Declarative syntax rules.
   */
  syntax?: SyntaxRuleSpec[];

  /** Convert prose soft line endings to line-break nodes; defaults to preserving text. */
  softBreaks?: SoftBreakMode;

  /** Currency-safe single-dollar policy for parser-admitted math; defaults to permissive. */
  mathOptions?: MathParseOptions;

  /** Optional CommonMark-compatible preservation of authored absolute Windows destinations. */
  linkDestinations?: LinkDestinationOptions;
}

export interface InlineParseOptions {
  /**
   * Enable/disable memoization for this call.
   * Defaults to `true`.
   */
  cache?: boolean;

  /**
   * Link reference definitions for this parse call.
   * When provided, merges with or overrides parser-level references.
   */
  references?: LinkReferenceMap;

  /**
   * Authored UTF-16 offset of `content` when exact source provenance is available.
   * Provenance parsing bypasses the content-only cache so offsets cannot go stale.
   */
  sourceOffset?: number;
  /**
   * Callback invoked whenever a link reference label candidate is evaluated during inline parsing.
   */
  onAttemptedReference?: (label: string) => void;
}
