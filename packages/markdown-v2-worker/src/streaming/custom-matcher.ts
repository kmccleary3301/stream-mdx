// Custom streaming regex matcher to replace problematic incr-regex-package

/**
 * Custom streaming pattern matcher
 */
export class CustomStreamingMatcher {
  private pattern: RegExp;
  private buffer = "";
  private possibleMatches: PossibleMatch[] = [];

  constructor(pattern: RegExp) {
    this.pattern = pattern;
  }

  /**
   * Add character to buffer and check for matches
   */
  addCharacter(char: string): MatchResult {
    this.buffer += char;

    // Check for complete matches
    const fullMatch = this.buffer.match(this.pattern);
    if (fullMatch && fullMatch.index === 0) {
      const match = {
        matched: true,
        content: fullMatch[0],
        length: fullMatch[0].length,
        isComplete: true,
      };

      // Clean up buffer
      this.buffer = this.buffer.slice(fullMatch[0].length);
      this.possibleMatches = [];

      return match;
    }

    // Check for partial matches
    const confidence = this.calculatePartialConfidence();

    return {
      matched: false,
      content: this.buffer,
      length: this.buffer.length,
      isComplete: false,
      confidence,
    };
  }

  /**
   * Add string to buffer and check for matches
   */
  addString(str: string): MatchResult[] {
    const results: MatchResult[] = [];

    for (const char of str) {
      const result = this.addCharacter(char);
      if (result.matched) {
        results.push(result);
      }
    }

    // If no complete matches, return the final partial state
    if (results.length === 0 && this.buffer.length > 0) {
      results.push({
        matched: false,
        content: this.buffer,
        length: this.buffer.length,
        isComplete: false,
        confidence: this.calculatePartialConfidence(),
      });
    }

    return results;
  }

  /**
   * Check if current buffer could lead to a match
   */
  couldMatch(): boolean {
    if (this.buffer.length === 0) return true;

    // Create a test pattern that matches the start of our full pattern
    const patternSource = this.pattern.source;
    const flags = this.pattern.flags;

    try {
      // Create partial pattern by making the rest optional
      const partialPattern = new RegExp(`^${patternSource.replace(/\$$/, "")}`, flags);
      const testString = this.buffer + "X".repeat(100); // Add potential completion
      return partialPattern.test(testString);
    } catch {
      // Fallback: check if buffer is a prefix of any potential match
      return this.isValidPrefix();
    }
  }

  /**
   * Reset the matcher
   */
  reset(): void {
    this.buffer = "";
    this.possibleMatches = [];
  }

  /**
   * Get current buffer content
   */
  getBuffer(): string {
    return this.buffer;
  }

  /**
   * Calculate confidence for partial matches
   */
  private calculatePartialConfidence(): number {
    if (this.buffer.length === 0) return 0;

    let confidence = 0.1; // Base confidence

    // Higher confidence for longer buffers
    confidence += Math.min(0.4, this.buffer.length * 0.1);

    // Higher confidence if buffer matches start of pattern
    if (this.couldMatch()) {
      confidence += 0.3;
    }

    // Special case for common patterns
    if (this.buffer.startsWith("$")) confidence += 0.2;
    if (this.buffer.startsWith("$$")) confidence += 0.3;

    return Math.min(1, confidence);
  }

  /**
   * Check if current buffer is a valid prefix
   */
  private isValidPrefix(): boolean {
    const patternStr = this.pattern.source;

    // Simple prefix checking for common patterns
    if (patternStr.includes("\\$\\$") && (this.buffer === "$" || this.buffer === "$$")) {
      return true;
    }

    if (patternStr.includes("\\$") && this.buffer === "$") {
      return true;
    }

    return false;
  }
}

/**
 * Result of streaming match attempt
 */
export interface MatchResult {
  /** Whether a complete match was found */
  matched: boolean;

  /** Content that was matched or current buffer */
  content: string;

  /** Length of match or buffer */
  length: number;

  /** Whether this is a complete match */
  isComplete: boolean;

  /** Confidence that this will become a match (0-1) */
  confidence?: number;
}

/**
 * Possible partial match tracking
 */
interface PossibleMatch {
  startIndex: number;
  pattern: RegExp;
  confidence: number;
}
