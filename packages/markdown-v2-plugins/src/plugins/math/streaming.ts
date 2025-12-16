// Streaming handler for math expressions using custom streaming matcher

import { BaseIncrementalMatchHandler, type CompleteMatchResult, type PartialMatchResult } from "../base";
import { extractMathContent, validateMathExpression } from "./tokenizer";

/**
 * Streaming handler for inline math ($...$)
 */
export class MathInlineStreamingHandler extends BaseIncrementalMatchHandler {
  constructor() {
    // Pattern for inline math: $content$ (no newlines)
    super(/\$([^$\n\r]+?)\$/);
  }

  checkPartialMatch(content: string): PartialMatchResult {
    this.currentContent = content;

    // Reset and test incrementally
    this.incrementalMatcher.reset();

    // Feed characters into the custom matcher; consider any buffer progression a potential partial
    let hasPartialMatch = false;
    for (const char of content) {
      const result = this.incrementalMatcher.addCharacter(char);
      if (!result.matched) {
        // As long as the buffer could lead to a match, treat as partial
        hasPartialMatch = this.incrementalMatcher.couldMatch();
      } else {
        hasPartialMatch = true;
      }
    }

    // Special cases for math
    if (content === "$") {
      return {
        hasPartialMatch: true,
        type: "inline-math",
        confidence: 0.8,
        expectedNext: ["any math character"],
        likelyToComplete: true,
      };
    }

    if (content.startsWith("$") && !content.endsWith("$")) {
      // Check if we're building valid math content
      const mathContent = content.slice(1);
      const hasValidMathChars = /[a-zA-Z0-9\\{}\[\]()_^+\-*/=<>!.,\s]/.test(mathContent);

      return {
        hasPartialMatch: hasPartialMatch && hasValidMathChars,
        type: "inline-math",
        confidence: this.calculateMathConfidence(content),
        expectedNext: ["$", "\\", "math symbols"],
        likelyToComplete: !content.includes("\n"),
      };
    }

    return {
      hasPartialMatch,
      type: hasPartialMatch ? "inline-math" : null,
      confidence: hasPartialMatch ? this.calculateConfidence(content) : 0,
    };
  }

  completeMatch(content: string): CompleteMatchResult {
    const startTime = performance.now();

    try {
      // Test full pattern
      const match = content.match(/\$([^$\n\r]+?)\$/);

      if (!match) {
        return {
          success: false,
          content,
          metadata: {
            start: 0,
            end: content.length,
            plugin: "math-inline",
            type: "inline-math",
            data: { error: "No valid inline math pattern found" },
          },
          processingTime: performance.now() - startTime,
        };
      }

      const mathContent = extractMathContent(match[0], false);
      const validation = validateMathExpression(mathContent);

      return {
        success: validation.valid,
        content: match[0],
        metadata: {
          start: match.index || 0,
          end: (match.index || 0) + match[0].length,
          plugin: "math-inline",
          type: "inline-math",
          data: {
            tex: mathContent,
            raw: match[0],
            valid: validation.valid,
            errors: validation.errors,
          },
        },
        processingTime: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        content,
        metadata: {
          start: 0,
          end: content.length,
          plugin: "math-inline",
          type: "inline-math",
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
        },
        processingTime: performance.now() - startTime,
      };
    }
  }

  protected getMinimumLength(): number {
    return 3; // $x$
  }

  private calculateMathConfidence(content: string): number {
    if (!content.startsWith("$")) return 0;

    const mathContent = content.slice(1);

    // Higher confidence for LaTeX commands
    if (mathContent.includes("\\")) return 0.9;

    // Medium confidence for math symbols
    if (/[_^{}[\]()]/.test(mathContent)) return 0.7;

    // Basic confidence for alphanumeric
    if (/[a-zA-Z0-9]/.test(mathContent)) return 0.5;

    return 0.3;
  }
}

/**
 * Streaming handler for display math ($$...$$)
 */
export class MathDisplayStreamingHandler extends BaseIncrementalMatchHandler {
  constructor() {
    // Pattern for display math: $$content$$ (multiline allowed)
    super(/\$\$([\s\S]*?(?:\$(?!\$)[^$]*?)*?)\$\$/);
  }

  checkPartialMatch(content: string): PartialMatchResult {
    this.currentContent = content;

    // Reset and test incrementally
    this.incrementalMatcher.reset();

    // Feed characters into the custom matcher; consider any buffer progression a potential partial
    let hasPartialMatch = false;
    for (const char of content) {
      const result = this.incrementalMatcher.addCharacter(char);
      if (!result.matched) {
        hasPartialMatch = this.incrementalMatcher.couldMatch();
      } else {
        hasPartialMatch = true;
      }
    }

    // Special cases for display math
    if (content === "$$") {
      return {
        hasPartialMatch: true,
        type: "display-math",
        confidence: 0.9,
        expectedNext: ["any math character", "newline"],
        likelyToComplete: true,
      };
    }

    if (content.startsWith("$$") && !content.endsWith("$$")) {
      const mathContent = content.slice(2);
      const hasValidContent = mathContent.trim().length > 0;

      return {
        hasPartialMatch: hasPartialMatch,
        type: "display-math",
        confidence: this.calculateDisplayMathConfidence(content),
        expectedNext: ["$$", "\\", "math symbols", "newline"],
        likelyToComplete: hasValidContent,
      };
    }

    return {
      hasPartialMatch,
      type: hasPartialMatch ? "display-math" : null,
      confidence: hasPartialMatch ? this.calculateConfidence(content) : 0,
    };
  }

  completeMatch(content: string): CompleteMatchResult {
    const startTime = performance.now();

    try {
      // Test full pattern with multiline support
      const match = content.match(/\$\$([\s\S]*?(?:\$(?!\$)[^$]*?)*?)\$\$/);

      if (!match) {
        return {
          success: false,
          content,
          metadata: {
            start: 0,
            end: content.length,
            plugin: "math-display",
            type: "display-math",
            data: { error: "No valid display math pattern found" },
          },
          processingTime: performance.now() - startTime,
        };
      }

      const mathContent = extractMathContent(match[0], true);
      const validation = validateMathExpression(mathContent);
      const isMultiline = mathContent.includes("\n");

      return {
        success: validation.valid,
        content: match[0],
        metadata: {
          start: match.index || 0,
          end: (match.index || 0) + match[0].length,
          plugin: "math-display",
          type: "display-math",
          multiline: isMultiline,
          data: {
            tex: mathContent,
            raw: match[0],
            valid: validation.valid,
            errors: validation.errors,
            multiline: isMultiline,
          },
        },
        processingTime: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        content,
        metadata: {
          start: 0,
          end: content.length,
          plugin: "math-display",
          type: "display-math",
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
        },
        processingTime: performance.now() - startTime,
      };
    }
  }

  protected getMinimumLength(): number {
    return 5; // $$x$$
  }

  private calculateDisplayMathConfidence(content: string): number {
    if (!content.startsWith("$$")) return 0;

    const mathContent = content.slice(2);

    // Very high confidence for matrix/align environments
    if (/\\begin\{/.test(mathContent)) return 0.95;

    // High confidence for LaTeX commands
    if (mathContent.includes("\\")) return 0.85;

    // Medium confidence for multi-line content
    if (mathContent.includes("\n")) return 0.75;

    // Medium confidence for math symbols
    if (/[_^{}[\]()]/.test(mathContent)) return 0.65;

    // Basic confidence for any content
    if (mathContent.trim().length > 0) return 0.5;

    return 0.3;
  }
}
