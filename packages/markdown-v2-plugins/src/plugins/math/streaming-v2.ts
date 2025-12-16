// Lezer-native streaming handler for math expressions

import { type MathContext, MathContextUtils } from "@stream-mdx/react/contexts/math-tracker";
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
    // With Lezer, partial matching is handled by the parser itself
    // We just need to provide confidence based on current state

    const mathContext = this.extractMathContext(context);

    if (mathContext && MathContextUtils.isInMath(mathContext)) {
      const currentMathType = MathContextUtils.getMathType(mathContext);

      if (currentMathType === this.mathType) {
        // We're in the right type of math context
        return {
          hasPartialMatch: true,
          type: `${this.mathType}-math`,
          confidence: this.calculateLezerConfidence(mathContext, content),
          expectedNext: this.getExpectedNext(mathContext),
          likelyToComplete: !MathContextUtils.hasErrors(mathContext),
        };
      }
    }

    // Check if we're starting a new math expression
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
      const mathContext = this.extractMathContext(context);

      return {
        success: validation.valid && (!mathContext || !MathContextUtils.hasErrors(mathContext)),
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
            contextValid: !mathContext || !MathContextUtils.hasErrors(mathContext),
            balanced: !mathContext || MathContextUtils.isBalanced(mathContext),
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
   * Extract math context from plugin context
   */
  private extractMathContext(context?: PluginContext): MathContext | null {
    if (!context || !context.parseState) return null;

    // This would extract the math context from Lezer's parse state
    // For now, return null as the exact implementation depends on Lezer integration
    return null;
  }

  /**
   * Calculate confidence based on Lezer context
   */
  private calculateLezerConfidence(mathContext: MathContext, content: string): number {
    let confidence = 0.5; // Base confidence

    // Higher confidence if we're properly balanced
    if (MathContextUtils.isBalanced(mathContext)) {
      confidence += 0.2;
    }

    // Higher confidence for LaTeX commands
    if (content.includes("\\")) {
      confidence += 0.2;
    }

    // Lower confidence if we have errors
    if (MathContextUtils.hasErrors(mathContext)) {
      confidence -= 0.3;
    }

    // Higher confidence for longer, more structured content
    const lengthBonus = Math.min(0.2, content.length / 50);
    confidence += lengthBonus;

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Get expected next characters based on context
   */
  private getExpectedNext(mathContext: MathContext): string[] {
    const expected: string[] = [];

    if (this.mathType === "inline") {
      expected.push("$"); // Closing dollar
    } else {
      expected.push("$$"); // Closing double dollar
    }

    // Always expect math symbols
    expected.push("\\", "{", "}", "^", "_", "math symbols");

    // For display math, newlines are allowed
    if (this.mathType === "display") {
      expected.push("newline");
    }

    return expected;
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
