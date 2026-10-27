import { GFM, type MarkdownConfig, type MarkdownExtension, type MarkdownParser, parser as baseParser } from "@lezer/markdown";
import { LezerInlineConverter } from "./inline/lezer-converter";
import { createMathExtension } from "./inline/math-extension";
import { HtmlCommentCompatibility } from "./inline/html-extension";
import { FtpAutolink } from "./inline/ftp-autolink-extension";
import { compileRegexPluginToExtension, compileSyntaxRuleToExtension, createDefaultRegexPlugins } from "./inline/plugin-adapter";
import { finalizeNativeInlineBoundary, parseNativeInlineSettlement, type InlineParserSettlement } from "./inline/native-inline-state";
import type { InlineExtension, InlineParseOptions, InlineParserOptions, LinkReferenceMap, MarkdownElement } from "./inline/types";
import { normalizeLinkLabel } from "./inline/reference-collector";
import {
  getActiveReferencePredicate,
  referenceGuardExtension,
  setActiveReferencePredicate,
} from "./inline/reference-guard";
import type { ASTInlinePlugin, HtmlOptions, InlineNode, InlinePlugin, LinkDestinationOptions, MathParseOptions, RegexInlinePlugin, SoftBreakMode, SyntaxRuleSpec } from "./types";

export type { InlineParserOptions, InlineParseOptions, InlineExtension, LinkReferenceDefinition, LinkReferenceMap } from "./inline/types";

/** Native block classification for document plugins that lack engine node metadata. */
export function isNativeHtmlBlock(content: string): boolean {
  const node = baseParser.parse(content).topNode.firstChild;
  return Boolean(node && ["HTMLBlock", "CommentBlock", "ProcessingInstructionBlock"].includes(node.name) &&
    node.to === content.trimEnd().length);
}

function ensureGlobal(pattern: RegExp): RegExp {
  if (pattern.global) return pattern;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function findLastMatch(pattern: RegExp, value: string): RegExpExecArray | null {
  const re = ensureGlobal(pattern);
  let match: RegExpExecArray | null = null;
  let next: RegExpExecArray | null;
  while ((next = re.exec(value)) !== null) {
    match = next;
  }
  return match;
}

function findMatchAfter(pattern: RegExp, value: string, startIndex: number): RegExpExecArray | null {
  const re = ensureGlobal(pattern);
  re.lastIndex = Math.max(0, startIndex);
  return re.exec(value);
}

function isSamePattern(a: RegExp, b: RegExp): boolean {
  return a.source === b.source && a.flags === b.flags;
}

function countMatches(pattern: RegExp, value: string): number {
  const re = ensureGlobal(pattern);
  let count = 0;
  while (re.exec(value)) {
    count += 1;
  }
  return count;
}

/**
 * Main inline parser that combines Lezer parsing with extensions and plugins.
 */
export class InlineParser {
  private plugins: InlinePlugin[] = [];
  private regexPlugins: RegexInlinePlugin[] = [];
  private astPlugins: ASTInlinePlugin[] = [];
  private extensions: InlineExtension[] = [];
  private syntaxRules: SyntaxRuleSpec[] = [];
  private syntaxRuleExtensions = new WeakMap<InlineExtension, SyntaxRuleSpec>();
  private cache = new Map<string, { nodes: InlineNode[]; attemptedReferences: string[] }>();
  private activeAttemptedReferenceCollector: Set<string> | null = null;
  private lastAttemptedReferences = new Set<string>();
  private maxCacheEntries: number;
  private enableMath: boolean;
  private softBreaks: SoftBreakMode;
  private mathOptions?: MathParseOptions;
  private linkDestinations?: LinkDestinationOptions;
  private references?: LinkReferenceMap;
  private html?: HtmlOptions;
  private lezerParser!: MarkdownParser;
  private converter!: LezerInlineConverter;
  private customInlineParserNames = new Set<string>();
  private inlineSettlements = new Map<string, InlineParserSettlement>();
  private defaultInlineExtensions = new WeakSet<InlineExtension>();

  constructor(options: InlineParserOptions = {}) {
    this.maxCacheEntries = Number.isFinite(options.maxCacheEntries ?? Number.NaN)
      ? Math.max(0, options.maxCacheEntries ?? 0)
      : 2000;
    this.enableMath = options.enableMath !== false;
    this.softBreaks = options.softBreaks ?? "preserve";
    this.references = options.references;
    this.html = options.html;
    this.mathOptions = options.mathOptions;
    this.linkDestinations = options.linkDestinations;

    if (options.extensions) {
      this.extensions.push(...options.extensions);
    }
    if (options.syntax) {
      for (const rule of options.syntax) {
        this.syntaxRules.push(rule);
        const extension = compileSyntaxRuleToExtension(rule);
        this.syntaxRuleExtensions.set(extension, rule);
        this.extensions.push(extension);
      }
    }

    // Register default mention and citation plugins
    for (const plugin of createDefaultRegexPlugins()) {
      this.registerPlugin(plugin);
      const extension = this.extensions[this.extensions.length - 1];
      if (extension) this.defaultInlineExtensions.add(extension);
    }

    this.rebuildParser();
  }

  /**
   * Set link reference definitions map.
   */
  setReferences(references: LinkReferenceMap | undefined): void {
    this.references = references;
    this.cache.clear();
    if (this.converter) {
      this.converter.setReferences(references);
    }
  }

  /**
   * Get link reference definitions map.
   */
  getReferences(): LinkReferenceMap | undefined {
    return this.references;
  }

  /**
   * Start collecting reference labels attempted during inline parsing.
   */
  startCollectingAttemptedReferences(): Set<string> {
    const set = new Set<string>();
    this.activeAttemptedReferenceCollector = set;
    return set;
  }

  /**
   * Stop collecting reference labels and return the collected set.
   */
  stopCollectingAttemptedReferences(): Set<string> {
    const set = this.activeAttemptedReferenceCollector ?? new Set<string>();
    this.activeAttemptedReferenceCollector = null;
    return set;
  }

  /**
   * Get reference labels attempted during the most recent parse call.
   */
  getLastAttemptedReferences(): ReadonlySet<string> {
    return this.lastAttemptedReferences;
  }

  /**
   * Register a plugin with the parser.
   */
  registerPlugin(plugin: InlinePlugin): void {
    this.plugins.push(plugin);
    this.plugins.sort((a, b) => a.priority - b.priority);

    if ("re" in plugin && typeof (plugin as RegexInlinePlugin).re?.exec === "function") {
      const regexPlugin = plugin as RegexInlinePlugin;
      this.regexPlugins.push(regexPlugin);
      this.regexPlugins.sort((a, b) => a.priority - b.priority);
      const ext = compileRegexPluginToExtension(regexPlugin);
      this.extensions.push(ext);
    } else if ("visit" in plugin || "apply" in plugin) {
      this.astPlugins.push(plugin as ASTInlinePlugin);
    }

    this.rebuildParser();
  }

  /**
   * Register an InlineExtension directly.
   */
  registerExtension(extension: InlineExtension): void {
    this.extensions.push(extension);
    this.rebuildParser();
  }
  /**
   * Register a declarative SyntaxRuleSpec.
   */
  registerSyntaxRule(rule: SyntaxRuleSpec): void {
    this.syntaxRules.push(rule);
    const extension = compileSyntaxRuleToExtension(rule);
    this.syntaxRuleExtensions.set(extension, rule);
    this.extensions.push(extension);
    this.rebuildParser();
  }

  private rebuildParser(): void {
    const lezerConfigs: (MarkdownConfig | readonly MarkdownExtension[])[] = [
      GFM,
      FtpAutolink,
      referenceGuardExtension,
      HtmlCommentCompatibility,
    ];

    if (this.enableMath) {
      lezerConfigs.push(createMathExtension(this.mathOptions?.singleDollar ?? "permissive"));
    }
    const extensionsByName: Record<string, InlineExtension> = {};
    this.customInlineParserNames.clear();
    this.inlineSettlements.clear();
    const unsupportedInlineParserNames = new Set<string>();
    for (const ext of this.extensions) {
      lezerConfigs.push(ext.lezer);
      const nodeNames = ext.lezer.defineNodes;
      const settlementNodeNames = new Set<string>();
      if (nodeNames) {
        for (const node of nodeNames) {
          const name = typeof node === "string" ? node : node.name;
          extensionsByName[name] = ext;
          settlementNodeNames.add(name);
        }
      }

      for (const inlineParser of ext.lezer.parseInline ?? []) {
        const name = inlineParser.name;
        this.customInlineParserNames.add(name);
        let settlement: InlineParserSettlement | undefined;
        if (this.defaultInlineExtensions.has(ext)) {
          settlement = {
            nodeNames: settlementNodeNames,
            extendsAtEOF: ext.name === "mentions",
          };
        } else {
          const rule = this.syntaxRuleExtensions.get(ext);
          if (rule?.anticipation && rule.anticipation.open.length > 0 &&
              rule.anticipation.close.length > 0 && rule.content === undefined) {
            settlement = { nodeNames: settlementNodeNames, extendsAtEOF: true };
          }
        }

        if (unsupportedInlineParserNames.has(name)) continue;
        if (settlement) this.inlineSettlements.set(name, settlement);
        else {
          this.inlineSettlements.delete(name);
          unsupportedInlineParserNames.add(name);
        }
      }
    }

    this.lezerParser = baseParser.configure(lezerConfigs);
    this.converter = new LezerInlineConverter({
      nodeSet: this.lezerParser.nodeSet,
      references: this.references,
      extensionsByName,
      html: this.html,
      softBreaks: this.softBreaks,
      linkDestinations: this.linkDestinations,
    });
    this.cache.clear();
  }

  /**
   * Parse inline content with memoization.
   */
  parse(content: string, options: InlineParseOptions = {}): InlineNode[] {
    const hasCustomRefs = options.references !== undefined;
    const sourceOffset = Number.isSafeInteger(options.sourceOffset) && (options.sourceOffset as number) >= 0
      ? options.sourceOffset
      : undefined;
    const shouldCache = options.cache !== false && this.maxCacheEntries > 0 && !hasCustomRefs && sourceOffset === undefined &&
      options.matchedBareAnchorOffsets === undefined;
    if (shouldCache) {
      const cached = this.cache.get(content);
      if (cached) {
        // Refresh LRU order
        this.cache.delete(content);
        this.cache.set(content, cached);
        this.lastAttemptedReferences = new Set(cached.attemptedReferences);
        if (this.activeAttemptedReferenceCollector) {
          for (const ref of cached.attemptedReferences) {
            this.activeAttemptedReferenceCollector.add(ref);
          }
        }
        if (options.onAttemptedReference) {
          for (const ref of cached.attemptedReferences) {
            options.onAttemptedReference(ref);
          }
        }
        return cached.nodes;
      }
    }

    // If call-specific references provided, update converter temporarily
    const effectiveRefs = hasCustomRefs ? options.references : this.references;
    const prevPredicate = getActiveReferencePredicate();
    const attemptedInThisParse = new Set<string>();
    setActiveReferencePredicate((rawLabel: string) => {
      const key = normalizeLinkLabel(rawLabel);
      attemptedInThisParse.add(key);
      if (this.activeAttemptedReferenceCollector) {
        this.activeAttemptedReferenceCollector.add(key);
      }
      if (options.onAttemptedReference) {
        options.onAttemptedReference(key);
      }
      if (!effectiveRefs) return false;
      if (effectiveRefs instanceof Map) return effectiveRefs.has(key);
      return Object.prototype.hasOwnProperty.call(effectiveRefs, key);
    });

    let elements: MarkdownElement[];
    let result: InlineNode[];

    try {
      if (hasCustomRefs) {
        this.converter.setReferences(options.references);
      }

      elements = this.lezerParser.parseInline(content, 0) as unknown as MarkdownElement[];
      result = this.converter.convert(elements, content, 0, content.length, sourceOffset, true, options.matchedBareAnchorOffsets);

      if (hasCustomRefs) {
        this.converter.setReferences(this.references);
      }
    } finally {
      setActiveReferencePredicate(prevPredicate);
    }
    // Apply any AST plugins in registered priority order
    for (const plugin of this.astPlugins) {
      if (typeof plugin.apply === "function") {
        result = plugin.apply(result);
      } else if (typeof plugin.visit === "function") {
        result = applyASTPlugin(result, plugin);
      }
    }

    this.lastAttemptedReferences = attemptedInThisParse;
    if (shouldCache) {
      this.cache.set(content, {
        nodes: result,
        attemptedReferences: Array.from(attemptedInThisParse),
      });
      while (this.cache.size > this.maxCacheEntries) {
        const oldestKey = this.cache.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        this.cache.delete(oldestKey);
      }
    }

    return result;
  }

  /** Parses once with native inline tokens and converts only a safe source prefix. */
  parseSettledPrefix(content: string): {
    settledTo: number;
    nodes: InlineNode[];
    attemptedReferences: ReadonlySet<string>;
  } {
    const attemptedReferences = new Set<string>();
    if (this.astPlugins.length > 0) {
      this.lastAttemptedReferences = attemptedReferences;
      return { settledTo: 0, nodes: [], attemptedReferences };
    }

    const previousPredicate = getActiveReferencePredicate();
    setActiveReferencePredicate((rawLabel: string) => {
      const key = normalizeLinkLabel(rawLabel);
      if (!this.references) return false;
      if (this.references instanceof Map) return this.references.has(key);
      return Object.prototype.hasOwnProperty.call(this.references, key);
    });

    try {
      const native = parseNativeInlineSettlement(
        this.lezerParser,
        content,
        this.customInlineParserNames,
        this.inlineSettlements,
      );
      const htmlSafeTo = this.converter.findUnsettledHtmlScopeStart(native.elements, content, native.settledTo);
      const settledTo = finalizeNativeInlineBoundary(content, native.elements, htmlSafeTo);
      for (const attempt of native.referenceAttempts) {
        if (attempt.to > settledTo) continue;
        const key = normalizeLinkLabel(attempt.label);
        attemptedReferences.add(key);
        this.activeAttemptedReferenceCollector?.add(key);
      }
      const nodes = settledTo > 0 ? this.converter.convert(native.elements, content, 0, settledTo) : [];
      this.lastAttemptedReferences = attemptedReferences;
      return { settledTo, nodes, attemptedReferences };
    } finally {
      setActiveReferencePredicate(previousPredicate);
    }
  }

  /**
   * Streaming regex anticipation helper. Returns an append string if a plugin
   * declares an incomplete match at the end of the buffer.
   */
  getRegexAnticipationAppend(content: string): string | null {
    if (!content || (this.regexPlugins.length === 0 && this.syntaxRules.length === 0)) {
      return null;
    }

    for (const regexPlugin of this.regexPlugins) {
      const anticipation = regexPlugin.anticipation;
      if (!anticipation) continue;

      const maxScanChars = Number.isFinite(anticipation.maxScanChars ?? Number.NaN)
        ? Math.max(1, anticipation.maxScanChars ?? 0)
        : 240;
      const scan = content.slice(Math.max(0, content.length - maxScanChars));
      if (regexPlugin.fastCheck && !regexPlugin.fastCheck(scan)) {
        continue;
      }

      const lastStart = findLastMatch(anticipation.start, scan);
      if (!lastStart) continue;

      if (isSamePattern(anticipation.start, anticipation.end)) {
        const occurrences = countMatches(anticipation.start, scan);
        if (occurrences % 2 === 0) {
          continue;
        }
      } else {
        const startIndex = lastStart.index + lastStart[0].length;
        const hasEnd = Boolean(findMatchAfter(anticipation.end, scan, startIndex));
        if (hasEnd) continue;
      }

      const appendValue =
        typeof anticipation.append === "function" ? anticipation.append(lastStart, content) : anticipation.append;
      if (!appendValue) continue;

      return appendValue;
    }
    for (const rule of this.syntaxRules) {
      if (!rule.anticipation) continue;
      const { open, close } = rule.anticipation;
      const lastOpen = content.lastIndexOf(open);
      if (lastOpen === -1) continue;
      const afterOpen = content.slice(lastOpen + open.length);
      if (open === close) {
        let count = 0;
        let idx = content.indexOf(open);
        while (idx !== -1) {
          count++;
          idx = content.indexOf(open, idx + open.length);
        }
        if (count % 2 === 0) continue;
      } else if (afterOpen.includes(close)) {
        continue;
      }
      // Complete only the missing suffix after an unmatched opener.
      for (let len = close.length - 1; len > 0; len--) {
        if (afterOpen.endsWith(close.slice(0, len))) {
          return close.slice(len);
        }
      }
      return close;
    }
    return null;
  }

  /**
   * Clear the memoization cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Helper to apply regex-based inline plugins with proper precedence.
 * Kept for backwards compatibility.
 */
export function applyRegexPlugin(nodes: InlineNode[], plugin: RegexInlinePlugin): InlineNode[] {
  const result: InlineNode[] = [];
  const fastCheck = typeof plugin.fastCheck === "function" ? plugin.fastCheck : null;

  for (const node of nodes) {
    if (node.kind === "text") {
      if (fastCheck && !fastCheck(node.text)) {
        result.push(node);
        continue;
      }
      const parts = splitTextByRegex(node.text, plugin.re, plugin.toNode);
      result.push(...parts);
    } else if ("children" in node && Array.isArray(node.children)) {
      result.push({
        ...node,
        children: applyRegexPlugin(node.children, plugin),
      });
    } else {
      result.push(node);
    }
  }

  return result;
}

/**
 * Helper to apply AST visitor plugins.
 */
export function applyASTPlugin(nodes: InlineNode[], plugin: ASTInlinePlugin): InlineNode[] {
  const result: InlineNode[] = [];

  for (const node of nodes) {
    const replacements: Array<{ original: InlineNode; replacement: InlineNode | InlineNode[] }> = [];

    plugin.visit(node, {
      replace(original, replacement) {
        replacements.push({ original, replacement });
      },
    });

    if (replacements.length > 0) {
      for (const { replacement } of replacements) {
        if (Array.isArray(replacement)) {
          result.push(...replacement);
        } else {
          result.push(replacement);
        }
      }
    } else {
      if ("children" in node && Array.isArray(node.children)) {
        result.push({
          ...node,
          children: applyASTPlugin(node.children, plugin),
        });
      } else {
        result.push(node);
      }
    }
  }

  return result;
}

function splitTextByRegex(
  text: string,
  regex: RegExp,
  toNode: (match: RegExpExecArray) => InlineNode | InlineNode[],
): InlineNode[] {
  const result: InlineNode[] = [];
  let lastIndex = 0;
  regex.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const beforeText = text.slice(lastIndex, match.index);
      if (beforeText) {
        result.push({ kind: "text", text: beforeText });
      }
    }

    const converted = toNode(match);
    if (Array.isArray(converted)) {
      result.push(...converted);
    } else {
      result.push(converted);
    }

    lastIndex = regex.lastIndex;
    if (match.index === regex.lastIndex) {
      regex.lastIndex++;
    }
  }

  if (lastIndex < text.length) {
    const remainingText = text.slice(lastIndex);
    if (remainingText) {
      result.push({ kind: "text", text: remainingText });
    }
  }

  return result;
}
