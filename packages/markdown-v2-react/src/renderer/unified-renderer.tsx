// Unified renderer that connects Lezer parsing to React components

import type { SyntaxNode, Tree, TreeCursor } from "@lezer/common";
import React from "react";
import type { UnifiedMarkdownParser, UnifiedParseResult } from "../parser/unified-parser";
import type { MarkdownPlugin } from "../plugins/base";
import { globalPluginRegistry } from "../plugins/registry";

/**
 * Unified markdown renderer with streaming support
 */
export class UnifiedMarkdownRenderer {
  private parser: UnifiedMarkdownParser;
  private plugins: MarkdownPlugin[];

  constructor(parser: UnifiedMarkdownParser) {
    this.parser = parser;
    this.plugins = globalPluginRegistry.getAllByPriority();
  }

  /**
   * Render markdown content to React components
   */
  render(content?: string): RenderResult {
    const startTime = performance.now();

    // Parse if new content provided
    let parseResult: UnifiedParseResult;
    if (content !== undefined) {
      parseResult = this.parser.parseContent(content);
    } else {
      // Use existing parse tree
      parseResult = {
        tree: this.parser.getTree(),
        content: this.parser.getContent(),
        pluginElements: [],
        contextState: this.parser.getContext(),
        valid: true,
        performance: { parseTime: 0, streamingTime: 0, contextTime: 0 },
        changed: false,
        addedRange: { from: 0, to: 0 },
      };
    }

    // Render the parse tree to React components
    const reactElements = this.renderTree(parseResult.tree, parseResult.content);

    return {
      elements: reactElements,
      parseResult,
      renderTime: performance.now() - startTime,
      valid: parseResult.valid,
    };
  }

  /**
   * Render parse tree to React elements
   */
  private renderTree(tree: Tree | null, content: string): React.ReactElement[] {
    if (!tree) return [];

    const elements: React.ReactElement[] = [];
    const cursor = tree.cursor();

    do {
      const node = cursor.node;

      // Skip if this node is inside another node we've already handled
      if (this.isNestedNode(cursor)) {
        continue;
      }

      const element = this.renderNode(node, content);
      if (element) {
        elements.push(element);
      }
    } while (cursor.next());

    return elements;
  }

  /**
   * Render a single parse tree node
   */
  private renderNode(node: SyntaxNode, content: string): React.ReactElement | null {
    const nodeContent = content.slice(node.from, node.to);
    const key = `${node.type.name}-${node.from}-${node.to}`;

    // Find matching plugin
    const matchingPlugin = this.findPluginForNode(node);

    if (matchingPlugin) {
      // Use plugin renderer
      const PluginRenderer = matchingPlugin.renderer;
      return <PluginRenderer key={key} content={nodeContent} node={node} range={{ from: node.from, to: node.to }} type={node.type.name} />;
    }

    // Handle standard markdown nodes
    return this.renderStandardNode(node, nodeContent, key);
  }

  /**
   * Find the appropriate plugin for a node
   */
  private findPluginForNode(node: SyntaxNode): MarkdownPlugin | null {
    for (const plugin of this.plugins) {
      if (this.nodeMatchesPlugin(node, plugin)) {
        return plugin;
      }
    }
    return null;
  }

  /**
   * Check if a node matches a plugin
   */
  private nodeMatchesPlugin(node: SyntaxNode, plugin: MarkdownPlugin): boolean {
    // Math plugin types
    const mathTypes = ["InlineMath", "DisplayMath"];
    if (plugin.name.includes("math") && mathTypes.includes(node.type.name)) {
      return true;
    }

    // Add other plugin type checks here as needed
    return false;
  }

  /**
   * Render standard markdown nodes without plugins
   */
  private renderStandardNode(node: SyntaxNode, content: string, key: string): React.ReactElement {
    switch (node.type.name) {
      case "ATXHeading":
        return this.renderHeading(content, key);
      case "Paragraph":
        return <p key={key}>{this.renderInlineContent(node, content)}</p>;
      case "FencedCodeBlock":
        return (
          <pre key={key}>
            <code>{this.extractCodeContent(content)}</code>
          </pre>
        );
      case "IndentedCodeBlock":
        return (
          <pre key={key}>
            <code>{content}</code>
          </pre>
        );
      case "Blockquote":
        return <blockquote key={key}>{this.renderInlineContent(content)}</blockquote>;
      case "BulletList":
        return <ul key={key}>{this.renderListItems(content)}</ul>;
      case "OrderedList":
        return <ol key={key}>{this.renderListItems(content)}</ol>;
      default:
        return (
          <div key={key} data-type={node.type.name}>
            {content}
          </div>
        );
    }
  }

  /**
   * Render heading with appropriate level
   */
  private renderHeading(content: string, key: string): React.ReactElement {
    const level = this.getHeadingLevel(content);
    const headingContent = content.replace(/^#+\s*/, "").trim();

    const HeadingTag = `h${level}` as keyof JSX.IntrinsicElements;
    return React.createElement(HeadingTag, { key }, headingContent);
  }

  /**
   * Get heading level from content
   */
  private getHeadingLevel(content: string): number {
    const match = content.match(/^(#{1,6})/);
    return match ? match[1].length : 1;
  }

  /**
   * Render inline content (handling nested elements)
   */
  private renderInlineContent(content: string): React.ReactNode {
    // For now, return plain text
    // TODO: Handle nested inline elements (emphasis, links, etc.)
    return content.replace(/^[>#\-*+\d\.)\s]*/, "").trim();
  }

  /**
   * Render list items
   */
  private renderListItems(content: string): React.ReactElement[] {
    const items: React.ReactElement[] = [];

    // Simple list item splitting (would be improved with proper cursor traversal)
    const lines = content.split("\n").filter((line) => line.trim());

    lines.forEach((line, index) => {
      const itemContent = line.replace(/^[\s\-*+\d\.)\s]*/, "").trim();
      const lineKey = `${key}-item-${index}-${itemContent.length}`;
      items.push(<li key={lineKey}>{itemContent}</li>);
    });

    return items;
  }

  /**
   * Extract code content from fenced code block
   */
  private extractCodeContent(content: string): string {
    return content
      .replace(/^```[^\n]*\n/, "")
      .replace(/\n```$/, "")
      .trim();
  }

  /**
   * Check if a node is nested inside another handled node
   */
  private isNestedNode(cursor: TreeCursor): boolean {
    // Simple check - this would be more sophisticated in practice
    return false;
  }

  /**
   * Get parser instance
   */
  getParser(): UnifiedMarkdownParser {
    return this.parser;
  }

  /**
   * Update content and re-render
   */
  updateContent(content: string): RenderResult {
    return this.render(content);
  }

  /**
   * Replace content range and re-render
   */
  replaceRange(from: number, to: number, newContent: string): RenderResult {
    this.parser.replaceContent(from, to, newContent);
    return this.render();
  }
}

/**
 * Result of rendering operation
 */
export interface RenderResult {
  /** Rendered React elements */
  elements: React.ReactElement[];

  /** Parse result from unified parser */
  parseResult: UnifiedParseResult;

  /** Time spent rendering */
  renderTime: number;

  /** Whether the render is valid */
  valid: boolean;
}

/**
 * React component for rendering markdown with the unified system
 */
export interface UnifiedMarkdownProps {
  /** Markdown content to render */
  content: string;

  /** Parser instance (optional, will create if not provided) */
  parser?: UnifiedMarkdownParser;

  /** Additional className */
  className?: string;

  /** Callback for parse results */
  onParseResult?: (result: UnifiedParseResult) => void;
}

export const UnifiedMarkdown: React.FC<UnifiedMarkdownProps> = ({ content, parser: providedParser, className = "", onParseResult }) => {
  const [renderer, setRenderer] = React.useState<UnifiedMarkdownRenderer | null>(null);
  const [renderResult, setRenderResult] = React.useState<RenderResult | null>(null);

  // Initialize renderer
  React.useEffect(() => {
    if (providedParser) {
      setRenderer(new UnifiedMarkdownRenderer(providedParser));
    }
  }, [providedParser]);

  // Render content
  React.useEffect(() => {
    if (renderer && content !== undefined) {
      const result = renderer.render(content);
      setRenderResult(result);

      if (onParseResult) {
        onParseResult(result.parseResult);
      }
    }
  }, [renderer, content, onParseResult]);

  if (!renderResult) {
    return <div className={className}>Loading...</div>;
  }

  return <div className={`unified-markdown ${className}`}>{renderResult.elements}</div>;
};

/**
 * Create a unified renderer instance
 */
export function createUnifiedRenderer(parser: UnifiedMarkdownParser): UnifiedMarkdownRenderer {
  return new UnifiedMarkdownRenderer(parser);
}
