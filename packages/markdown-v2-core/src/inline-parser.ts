import type { Tree } from "@lezer/common";
import type { ASTInlinePlugin, InlineNode, InlinePlugin, RegexInlinePlugin } from "./types";

export interface InlineParserOptions {
  /**
   * Maximum number of cached inline parses to retain. The inline parser is used
   * heavily during streaming; an unbounded cache can grow without limit when
   * parsing many intermediate states.
   */
  maxCacheEntries?: number;
}

export interface InlineParseOptions {
  /**
   * Enable/disable memoization for this call. For streaming (non-finalized)
   * content, caching intermediate states is typically wasteful.
   */
  cache?: boolean;
}

/**
 * Main inline parser that combines Lezer parsing with plugins
 */
export class InlineParser {
  private plugins: InlinePlugin[] = [];
  private cache = new Map<string, InlineNode[]>();
  private maxCacheEntries: number;

  constructor(options: InlineParserOptions = {}) {
    this.maxCacheEntries = Number.isFinite(options.maxCacheEntries ?? Number.NaN) ? Math.max(0, options.maxCacheEntries ?? 0) : 2000;
    // Register default plugins
    this.registerDefaultPlugins();
  }

  /**
   * Register a plugin with the parser
   */
  registerPlugin(plugin: InlinePlugin): void {
    this.plugins.push(plugin);
    // Sort by priority (lower runs earlier)
    this.plugins.sort((a, b) => a.priority - b.priority);
    // Clear cache when plugins change
    this.cache.clear();
  }

  /**
   * Parse inline content with memoization
   */
  parse(content: string, options: InlineParseOptions = {}): InlineNode[] {
    const shouldCache = options.cache !== false && this.maxCacheEntries > 0;

    if (shouldCache) {
      const cached = this.cache.get(content);
      if (cached) {
        // Refresh LRU order (Map preserves insertion order)
        this.cache.delete(content);
        this.cache.set(content, cached);
        return cached;
      }
    }

    // Parse with Lezer first
    const lezerNodes = this.parseWithLezer(content);

    // Apply plugins in order
    let result = lezerNodes;
    for (const plugin of this.plugins) {
      if ("apply" in plugin) {
        result = plugin.apply(result);
      } else if ("re" in plugin) {
        // Handle regex plugins
        result = applyRegexPlugin(result, plugin as RegexInlinePlugin);
      }
    }

    if (shouldCache) {
      // Cache result (LRU bounded).
      this.cache.set(content, result);
      while (this.cache.size > this.maxCacheEntries) {
        const oldestKey = this.cache.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        this.cache.delete(oldestKey);
      }
    }

    return result;
  }

  /**
   * Clear the memoization cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Parse with Lezer inline parser as a fallback/base layer
   * For V2, we primarily use our plugin system for better control
   */
  private parseWithLezer(content: string): InlineNode[] {
    // For now, start with plain text and let plugins handle everything
    // This avoids conflicts between Lezer's parsing and our plugin precedence
    return [{ kind: "text", text: content }];
  }

  /**
   * Convert Lezer tree to our InlineNode format (currently simplified)
   * TODO: Integrate Lezer more deeply while respecting plugin precedence
   */
  private convertLezerToInlineNodes(tree: Tree | null, content: string): InlineNode[] {
    // Simplified approach: return text and let plugins handle parsing
    // This ensures our precedence-based plugin system has full control
    return [{ kind: "text", text: content }];
  }

  /**
   * Register default plugins with proper precedence ordering
   * Lower priority numbers = higher precedence (run first)
   */
  private registerDefaultPlugins(): void {
    // Handle escaped punctuation before other plugins consume the characters
    this.registerPlugin({
      id: "escaped-character",
      priority: 0,
      re: /\\([\\`*_{}\[\]()#+\-.!>])/g,
      toNode: (match) => ({
        kind: "text",
        text: match[1],
      }),
      fastCheck: (text) => text.indexOf("\\") !== -1,
    } as RegexInlinePlugin);

    // HIGHEST PRECEDENCE: Display math first (longer pattern)
    this.registerPlugin({
      id: "math-display",
      priority: 1,
      re: /\$\$([^$]+?)\$\$/g,
      toNode: (match) => ({ kind: "math-display", tex: match[1].trim() }),
      fastCheck: (text) => text.indexOf("$$") !== -1,
    } as RegexInlinePlugin);

    // Inline math (shorter pattern, runs after display math)
    this.registerPlugin({
      id: "math-inline",
      priority: 2,
      re: /\$([^$\n]+?)\$/g, // Non-greedy to prevent spanning multiple expressions
      toNode: (match) => ({ kind: "math-inline", tex: match[1].trim() }),
      fastCheck: (text) => text.indexOf("$") !== -1,
    } as RegexInlinePlugin);

    // Code spans (high precedence to avoid conflicts with other syntax)
    this.registerPlugin({
      id: "code-spans",
      priority: 3,
      re: /`([^`\n]+?)`/g,
      toNode: (match) => ({ kind: "code", text: match[1] }),
      fastCheck: (text) => text.indexOf("`") !== -1,
    } as RegexInlinePlugin);

    // Links (before emphasis to handle [text](url) properly)
    this.registerPlugin({
      id: "links",
      priority: 4,
      re: /\[([^\]]+?)\]\(([^)]+?)\)/g,
      toNode: (match) => ({
        kind: "link",
        href: match[2].trim(),
        children: [{ kind: "text", text: match[1] }],
      }),
      fastCheck: (text) => text.indexOf("](") !== -1,
    } as RegexInlinePlugin);

    // Footnote references: [^label]
    this.registerPlugin({
      id: "footnote-refs",
      priority: 6,
      re: /\[\^([A-Za-z0-9_-]+)\]/g,
      toNode: (match) => ({ kind: "footnote-ref", label: match[1] }),
      fastCheck: (text) => text.indexOf("[^") !== -1,
    } as RegexInlinePlugin);

    // Images (similar to links but with !)
    this.registerPlugin({
      id: "images",
      priority: 5,
      re: /!\[([^\]]*?)\]\(([^)]+?)\)/g,
      toNode: (match) => ({
        kind: "image",
        src: match[2].trim(),
        alt: match[1],
      }),
      fastCheck: (text) => text.indexOf("![") !== -1,
    } as RegexInlinePlugin);

    // Strong emphasis (***text*** or **text**)
    this.registerPlugin({
      id: "strong-emphasis",
      priority: 6,
      re: /\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*/g,
      toNode: (match) => ({
        kind: "strong",
        children: [{ kind: "text", text: match[1] || match[2] }],
      }),
      fastCheck: (text) => text.indexOf("**") !== -1,
    } as RegexInlinePlugin);

    // Strikethrough (~~text~~)
    this.registerPlugin({
      id: "strikethrough",
      priority: 7,
      re: /~~([^~\n]+?)~~/g,
      toNode: (match) => ({
        kind: "strike",
        children: [{ kind: "text", text: match[1] }],
      }),
      fastCheck: (text) => text.indexOf("~~") !== -1,
    } as RegexInlinePlugin);

    // Regular emphasis (*text*)
    this.registerPlugin({
      id: "emphasis",
      priority: 8,
      re: /\*([^*\n]+?)\*/g,
      toNode: (match) => ({
        kind: "em",
        children: [{ kind: "text", text: match[1] }],
      }),
      fastCheck: (text) => text.indexOf("*") !== -1,
    } as RegexInlinePlugin);

    // Citations plugin: [^id] or @cite{...}
    this.registerPlugin({
      id: "citations",
      priority: 10,
      re: /\[\^([^\]]+)\]|@cite\{([^}]+)\}/g,
      toNode: (match) => ({ kind: "citation", id: match[1] || match[2] }),
      fastCheck: (text) => text.indexOf("@") !== -1 || text.indexOf("[^") !== -1,
    } as RegexInlinePlugin);

    // Mentions plugin: @username (lower precedence)
    this.registerPlugin({
      id: "mentions",
      priority: 15,
      re: /@([a-zA-Z0-9_]+)/g,
      toNode: (match) => ({ kind: "mention", handle: match[1] }),
      fastCheck: (text) => text.indexOf("@") !== -1,
    } as RegexInlinePlugin);
  }
}

/**
 * Helper to apply regex-based inline plugins with proper precedence
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
      const parts = splitTextByRegexWithPrecedence(node.text, plugin.re, plugin.toNode);
      result.push(...parts);
    } else if ("children" in node && Array.isArray(node.children)) {
      // Recursively apply to children
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
 * Helper to apply AST visitor plugins
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
      // Apply replacements
      for (const { replacement } of replacements) {
        if (Array.isArray(replacement)) {
          result.push(...replacement);
        } else {
          result.push(replacement);
        }
      }
    } else {
      // Recursively process children if no replacements
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

/**
 * Split text by regex with precedence-aware processing
 */
function splitTextByRegexWithPrecedence(text: string, regex: RegExp, toNode: (match: RegExpExecArray) => InlineNode | InlineNode[]): InlineNode[] {
  const result: InlineNode[] = [];
  let lastIndex = 0;
  regex.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      const beforeText = text.slice(lastIndex, match.index);
      if (beforeText) {
        result.push({ kind: "text", text: beforeText });
      }
    }

    // Add converted node(s)
    const converted = toNode(match);
    if (Array.isArray(converted)) {
      result.push(...converted);
    } else {
      result.push(converted);
    }

    lastIndex = regex.lastIndex;

    // Prevent infinite loop for zero-width matches
    if (match.index === regex.lastIndex) {
      regex.lastIndex++;
    }
  }

  // Add remaining text
  if (lastIndex < text.length) {
    const remainingText = text.slice(lastIndex);
    if (remainingText) {
      result.push({ kind: "text", text: remainingText });
    }
  }

  return result;
}

/**
 * Legacy function name for backward compatibility
 */
function splitTextByRegex(text: string, regex: RegExp, toNode: (match: RegExpExecArray) => InlineNode | InlineNode[]): InlineNode[] {
  return splitTextByRegexWithPrecedence(text, regex, toNode);
}
