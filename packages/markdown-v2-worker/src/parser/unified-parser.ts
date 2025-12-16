// Unified parser that combines Lezer streaming with context tracking

import type { SyntaxNode, Tree } from "@lezer/common";
import type { LRParser as Parser } from "@lezer/lr";
import type { MarkdownPlugin } from "@stream-mdx/plugins";
import { globalPluginRegistry } from "@stream-mdx/plugins";
import type { MathContext } from "../contexts/math-tracker";
import { LezerStreamingParser } from "../streaming/lezer-streaming";

/**
 * Unified markdown parser with streaming support and context tracking
 */
export class UnifiedMarkdownParser {
  private streamingParser: LezerStreamingParser;
  private plugins: MarkdownPlugin[];
  private contextState: MathContext;

  constructor(lezerParser: Parser, initialContent = "") {
    this.streamingParser = new LezerStreamingParser(lezerParser, initialContent);
    this.plugins = globalPluginRegistry.getAllByPriority();
    this.contextState = {
      inMath: false,
      mathType: null,
      depth: 0,
      startPos: -1,
      isComplete: false,
      hasError: false,
    };
  }

  /**
   * Parse markdown content with streaming support
   */
  parseContent(content: string): UnifiedParseResult {
    const startTime = performance.now();

    // Use streaming parser for incremental parsing
    const streamingResult = this.streamingParser.appendContent(content);

    // Update context tracking based on parse tree
    this.updateContextFromTree(streamingResult.tree);

    // Extract plugin-specific elements
    const pluginElements = this.extractPluginElements(streamingResult.tree);

    // Validate context consistency
    const contextValid = this.validateContext();

    return {
      tree: streamingResult.tree,
      content: this.streamingParser.getContent(),
      pluginElements,
      contextState: this.contextState,
      valid: contextValid && streamingResult.changed,
      performance: {
        parseTime: performance.now() - startTime,
        streamingTime: 0, // Included in parseTime
        contextTime: 0, // Included in parseTime
      },
      changed: streamingResult.changed,
      addedRange: streamingResult.addedRange,
    };
  }

  /**
   * Replace content in a specific range
   */
  replaceContent(from: number, to: number, newContent: string): UnifiedParseResult {
    const startTime = performance.now();

    const streamingResult = this.streamingParser.replaceContent(from, to, newContent);
    this.updateContextFromTree(streamingResult.tree);
    const pluginElements = this.extractPluginElements(streamingResult.tree);
    const contextValid = this.validateContext();

    return {
      tree: streamingResult.tree,
      content: this.streamingParser.getContent(),
      pluginElements,
      contextState: this.contextState,
      valid: contextValid,
      performance: {
        parseTime: performance.now() - startTime,
        streamingTime: 0,
        contextTime: 0,
      },
      changed: streamingResult.changed,
      addedRange: streamingResult.addedRange,
    };
  }

  /**
   * Get current parse tree
   */
  getTree(): Tree | null {
    return this.streamingParser.getTree();
  }

  /**
   * Get current content
   */
  getContent(): string {
    return this.streamingParser.getContent();
  }

  /**
   * Get current context state
   */
  getContext(): MathContext {
    return this.contextState;
  }

  /**
   * Force full reparse
   */
  reparse(): UnifiedParseResult {
    const startTime = performance.now();

    const streamingResult = this.streamingParser.reparse();
    this.contextState = {
      inMath: false,
      mathType: null,
      depth: 0,
      startPos: -1,
      isComplete: false,
      hasError: false,
    }; // Reset context
    this.updateContextFromTree(streamingResult.tree);
    const pluginElements = this.extractPluginElements(streamingResult.tree);
    const contextValid = this.validateContext();

    return {
      tree: streamingResult.tree,
      content: this.streamingParser.getContent(),
      pluginElements,
      contextState: this.contextState,
      valid: contextValid,
      performance: {
        parseTime: performance.now() - startTime,
        streamingTime: 0,
        contextTime: 0,
      },
      changed: true,
      addedRange: { from: 0, to: this.streamingParser.getContent().length },
    };
  }

  /**
   * Update context state based on parse tree
   */
  private updateContextFromTree(tree: Tree): void {
    // No-op for now; parsing context is maintained by the parser during integration
    void tree;
  }

  /**
   * Extract plugin-relevant elements from parse tree
   */
  private extractPluginElements(tree: Tree | null): PluginElement[] {
    const elements: PluginElement[] = [];

    if (!tree) return elements;

    const cursor = tree.cursor();

    do {
      const node = cursor.node;
      if (!node) continue;
      const content = this.streamingParser.getContent().slice(node.from, node.to);

      // Check each plugin for matches
      for (const plugin of this.plugins) {
        if (this.nodeMatchesPlugin(node, plugin)) {
          elements.push({
            plugin: plugin.name,
            node,
            content,
            range: { from: node.from, to: node.to },
            type: node.type.name,
            valid: this.validatePluginElement(plugin, content),
          });
        }
      }
    } while (cursor.next());

    return elements;
  }

  /**
   * Check if a node matches a plugin
   */
  private nodeMatchesPlugin(node: SyntaxNode, plugin: MarkdownPlugin): boolean {
    const mathPluginTypes = ["InlineMath", "DisplayMath"];

    if (plugin.name.includes("math")) {
      return mathPluginTypes.includes(node.type.name);
    }

    // For other plugins, use pattern matching
    try {
      const content = this.streamingParser.getContent().slice(node.from, node.to);
      return plugin.patterns.full.test(content);
    } catch {
      return false;
    }
  }

  /**
   * Validate a plugin element
   */
  private validatePluginElement(plugin: MarkdownPlugin, content: string): boolean {
    try {
      // For math plugins, use the streaming handler validation
      if (plugin.name.includes("math")) {
        const result = plugin.streamingHandler.completeMatch(content);
        return result.success;
      }

      // For other plugins, basic pattern validation
      return plugin.patterns.full.test(content);
    } catch {
      return false;
    }
  }

  /**
   * Validate overall context consistency
   */
  private validateContext(): boolean {
    // Check if math context is in a valid state
    if (this.contextState.inMath && this.contextState.hasError) {
      return false;
    }

    // Check for unbalanced brackets in math
    if (this.contextState.inMath && this.contextState.depth > 0) {
      return false;
    }

    return true;
  }
}

/**
 * Result of unified parsing operation
 */
export interface UnifiedParseResult {
  /** Parse tree from Lezer */
  tree: Tree;

  /** Full content */
  content: string;

  /** Plugin elements found in content */
  pluginElements: PluginElement[];

  /** Current context state */
  contextState: MathContext;

  /** Whether the parse is valid */
  valid: boolean;

  /** Performance metrics */
  performance: {
    parseTime: number;
    streamingTime: number;
    contextTime: number;
  };

  /** Whether content changed from last parse */
  changed: boolean;

  /** Range that was modified */
  addedRange: { from: number; to: number };
}

/**
 * A plugin element found in the parse tree
 */
export interface PluginElement {
  /** Plugin that handles this element */
  plugin: string;

  /** Parse tree node */
  node: SyntaxNode;

  /** Element content */
  content: string;

  /** Position range */
  range: { from: number; to: number };

  /** Node type name */
  type: string;

  /** Whether the element is valid */
  valid: boolean;
}

/**
 * Create a unified parser instance
 */
export function createUnifiedParser(lezerParser: Parser, initialContent?: string): UnifiedMarkdownParser {
  return new UnifiedMarkdownParser(lezerParser, initialContent);
}
