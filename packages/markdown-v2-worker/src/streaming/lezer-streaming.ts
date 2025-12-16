// Lezer-native streaming implementation using built-in incremental parsing

import type { Input, SyntaxNode, Tree } from "@lezer/common";
import type { LRParser as Parser } from "@lezer/lr";
import type { MarkdownPlugin } from "@stream-mdx/plugins";
import { globalPluginRegistry } from "@stream-mdx/plugins";

/**
 * Lezer-native streaming input that handles incremental content
 */
export class StreamingInput implements Input {
  private content: string;

  constructor(initialContent = "") {
    this.content = initialContent;
  }

  /**
   * Append new content to the stream
   */
  append(newContent: string): void {
    this.content += newContent;
  }

  /**
   * Replace content from position with new content
   */
  replace(from: number, to: number, newContent: string): void {
    this.content = this.content.slice(0, from) + newContent + this.content.slice(to);
  }

  // Input interface implementation
  get(pos: number): number {
    return pos >= this.content.length ? -1 : this.content.charCodeAt(pos);
  }

  lineAfter(pos: number): string {
    const lineEnd = this.content.indexOf("\n", pos);
    return lineEnd < 0 ? this.content.slice(pos) : this.content.slice(pos, lineEnd);
  }

  read(from: number, to: number): string {
    return this.content.slice(from, to);
  }

  // Some Lezer parsers expect chunk() for faster substring access
  chunk(from: number): string {
    return this.content.slice(from);
  }

  clip(at: number): Input {
    const clipped = new StreamingInput(this.content.slice(0, at));
    return clipped;
  }

  get length(): number {
    return this.content.length;
  }
}

/**
 * Lezer-native streaming parser with plugin support
 */
export class LezerStreamingParser {
  private parser: Parser;
  private input: StreamingInput;
  private currentTree: Tree | null = null;
  private plugins: MarkdownPlugin[] = [];

  constructor(parser: Parser, initialContent = "") {
    this.parser = parser;
    this.input = new StreamingInput(initialContent);
    this.plugins = globalPluginRegistry.getAllByPriority();

    // Initial parse
    this.reparse();
  }

  /**
   * Append content and incrementally reparse
   */
  appendContent(content: string): StreamingParseResult {
    const startPos = this.input.length;
    this.input.append(content);

    // Use Lezer's incremental parsing
    const fragments = this.currentTree ? this.currentTree.fragments : undefined;
    const newTree = this.parser.parse(this.getContent(), fragments);

    const result: StreamingParseResult = {
      addedContent: content,
      addedRange: { from: startPos, to: this.input.length },
      tree: newTree,
      changed: newTree !== this.currentTree,
      pluginMatches: this.extractPluginMatches(newTree, startPos),
    };

    this.currentTree = newTree;
    return result;
  }

  /**
   * Replace content range and incrementally reparse
   */
  replaceContent(from: number, to: number, content: string): StreamingParseResult {
    this.input.replace(from, to, content);

    // Lezer handles incremental reparsing automatically
    const fragments = this.currentTree ? this.currentTree.fragments : undefined;
    const newTree = this.parser.parse(this.getContent(), fragments);

    const result: StreamingParseResult = {
      addedContent: content,
      addedRange: { from, to: from + content.length },
      tree: newTree,
      changed: newTree !== this.currentTree,
      pluginMatches: this.extractPluginMatches(newTree, from),
    };

    this.currentTree = newTree;
    return result;
  }

  /**
   * Get current parse tree
   */
  getTree() {
    return this.currentTree;
  }

  /**
   * Get current input content
   */
  getContent(): string {
    return this.input.read(0, this.input.length);
  }

  /**
   * Force full reparse
   */
  reparse(): StreamingParseResult {
    const newTree = this.parser.parse(this.getContent());

    const result: StreamingParseResult = {
      addedContent: this.getContent(),
      addedRange: { from: 0, to: this.input.length },
      tree: newTree,
      changed: true,
      pluginMatches: this.extractPluginMatches(newTree, 0),
    };

    this.currentTree = newTree;
    return result;
  }

  /**
   * Extract plugin matches from parse tree
   */
  private extractPluginMatches(tree: Tree | null, startPos = 0): PluginMatch[] {
    const matches: PluginMatch[] = [];

    if (!tree) return matches;

    // Walk the tree and find plugin-relevant nodes
    const cursor = tree.cursor();

    do {
      const node = cursor.node;
      if (!node) continue;

      const nodeText = this.input.read(node.from, node.to);

      // Check if this node matches any plugin patterns
      for (const plugin of this.plugins) {
        if (this.nodeMatchesPlugin(node, nodeText, plugin)) {
          matches.push({
            plugin: plugin.name,
            node,
            content: nodeText,
            range: { from: node.from, to: node.to },
            isNew: node.from >= startPos,
          });
        }
      }
    } while (cursor.next());

    return matches;
  }

  /**
   * Check if a tree node matches a plugin
   */
  private nodeMatchesPlugin(node: SyntaxNode, content: string, plugin: MarkdownPlugin): boolean {
    // This would be customized based on the actual node types from the grammar
    // For now, using simple pattern matching

    try {
      return plugin.patterns.full.test(content);
    } catch {
      return false;
    }
  }
}

/**
 * Result of streaming parse operation
 */
export interface StreamingParseResult {
  /** Content that was added/changed */
  addedContent: string;

  /** Range that was modified */
  addedRange: { from: number; to: number };

  /** New parse tree */
  tree: Tree;

  /** Whether the tree actually changed */
  changed: boolean;

  /** Plugin matches found in the new content */
  pluginMatches: PluginMatch[];
}

/**
 * A plugin match found in the parse tree
 */
export interface PluginMatch {
  /** Plugin that matched */
  plugin: string;

  /** Parse tree node */
  node: SyntaxNode;

  /** Matched content */
  content: string;

  /** Position range */
  range: { from: number; to: number };

  /** Whether this is a new match (in recently added content) */
  isNew: boolean;
}

/**
 * Create a streaming parser with plugin support
 */
export function createStreamingParser(parser: Parser, initialContent = ""): LezerStreamingParser {
  return new LezerStreamingParser(parser, initialContent);
}
