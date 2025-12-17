// Lezer-native streaming handler for math expressions

import { BaseIncrementalMatchHandler, type CompleteMatchResult, type PartialMatchResult, type PluginContext } from "../base";
import { extractMathContent, validateMathExpression } from "./tokenizer";

/**
 * Lezer-native streaming handler for math expressions
 */
export class LezerMathStreamingHandler extends BaseIncrementalMatchHandler {
  private mathType: "inline" | "display";

  constructor(mathType: "inline" | "display") {
    // Pattern is now handled by Lezer grammar, this is for compatibility
    const pattern = mathType === "inline" ? /\$([^$\n\r]+?)\$/ : /\$\$([\s\S]*?(?:\$(?!\$)[^$]*?)*?)\$\$/;

    super(pattern);
    this.mathType = mathType;
  }

  checkPartialMatch(content: string, context?: PluginContext): PartialMatchResult {
    // In the current build, we do not rely on renderer-side math contexts here.
    // Streaming confidence is derived from a conservative prefix check.
    if (this.couldStartMath(content)) {
      return {
        hasPartialMatch: true,
        type: `${this.mathType}-math`,
        confidence: 0.8,
        expectedNext: ["math content"],
        likelyToComplete: true,
      };
    }

    return {
      hasPartialMatch: false,
      type: null,
      confidence: 0,
    };
  }

  completeMatch(content: string, context?: PluginContext): CompleteMatchResult {
    const startTime = performance.now();

    try {
      // Extract math content based on type
      const pattern = this.mathType === "inline" ? /\$([^$\n\r]+?)\$/ : /\$\$([\s\S]*?(?:\$(?!\$)[^$]*?)*?)\$\$/;

      const match = content.match(pattern);

      if (!match) {
        return this.createFailureResult(content, "No valid math pattern found", startTime);
      }

      const mathContent = extractMathContent(match[0], this.mathType === "display");
      const validation = validateMathExpression(mathContent);

      return {
        success: validation.valid,
        content: match[0],
        metadata: {
          start: match.index || 0,
          end: (match.index || 0) + match[0].length,
          plugin: `math-${this.mathType}`,
          type: `${this.mathType}-math`,
          multiline: this.mathType === "display" && mathContent.includes("\n"),
          data: {
            tex: mathContent,
            raw: match[0],
            valid: validation.valid,
            errors: validation.errors,
            mathType: this.mathType,
          },
        },
        processingTime: performance.now() - startTime,
      };
    } catch (error) {
      return this.createFailureResult(content, error instanceof Error ? error.message : String(error), startTime);
    }
  }

  protected getMinimumLength(): number {
    return this.mathType === "inline" ? 3 : 5; // $x$ or $$x$$
  }

  /**
   * Check if content could start a math expression
   */
  private couldStartMath(content: string): boolean {
    if (this.mathType === "inline") {
      return content === "$" || (content.startsWith("$") && !content.startsWith("$$"));
    }
    return content === "$$" || content.startsWith("$$");
  }

  /**
   * Create a failure result
   */
  private createFailureResult(content: string, error: string, startTime: number): CompleteMatchResult {
    return {
      success: false,
      content,
      metadata: {
        start: 0,
        end: content.length,
        plugin: `math-${this.mathType}`,
        type: `${this.mathType}-math`,
        data: { error },
      },
      processingTime: performance.now() - startTime,
    };
  }
}

/**
 * Lezer-native inline math streaming handler
 */
export class LezerInlineMathStreamingHandler extends LezerMathStreamingHandler {
  constructor() {
    super("inline");
  }
}

/**
 * Lezer-native display math streaming handler
 */
export class LezerDisplayMathStreamingHandler extends LezerMathStreamingHandler {
  constructor() {
    super("display");
  }
}
