import type { MarkdownConfig } from "@lezer/markdown";
import type { InlineNode } from "../types";

export interface MarkdownElement {
  readonly type: number;
  readonly from: number;
  readonly to: number;
  readonly children: readonly MarkdownElement[];
}

export interface LinkReferenceDefinition {
  href: string;
  title?: string;
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

  /**
   * Initial link reference definitions.
   */
  references?: LinkReferenceMap;

  /**
   * Additional inline extensions.
   */
  extensions?: InlineExtension[];
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
   * Callback invoked whenever a link reference label candidate is evaluated during inline parsing.
   */
  onAttemptedReference?: (label: string) => void;
}
