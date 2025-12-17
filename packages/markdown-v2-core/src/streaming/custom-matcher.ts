// Custom streaming regex matcher to replace problematic incr-regex-package

export class CustomStreamingMatcher {
  private pattern: RegExp;
  private buffer = "";
  private possibleMatches: PossibleMatch[] = [];

  constructor(pattern: RegExp) {
    this.pattern = pattern;
  }

  addCharacter(char: string): MatchResult {
    this.buffer += char;

    const fullMatch = this.buffer.match(this.pattern);
    if (fullMatch && fullMatch.index === 0) {
      const match = {
        matched: true,
        content: fullMatch[0],
        length: fullMatch[0].length,
        isComplete: true,
      };

      this.buffer = this.buffer.slice(fullMatch[0].length);
      this.possibleMatches = [];

      return match;
    }

    const confidence = this.calculatePartialConfidence();

    return {
      matched: false,
      content: this.buffer,
      length: this.buffer.length,
      isComplete: false,
      confidence,
    };
  }

  addString(str: string): MatchResult[] {
    const results: MatchResult[] = [];

    for (const char of str) {
      const result = this.addCharacter(char);
      if (result.matched) {
        results.push(result);
      }
    }

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

  couldMatch(): boolean {
    if (this.buffer.length === 0) return true;

    const patternSource = this.pattern.source;
    const flags = this.pattern.flags;

    try {
      const partialPattern = new RegExp(`^${patternSource.replace(/\\$$/, "")}`, flags);
      const testString = this.buffer + "X".repeat(100);
      return partialPattern.test(testString);
    } catch {
      return this.isValidPrefix();
    }
  }

  reset(): void {
    this.buffer = "";
    this.possibleMatches = [];
  }

  getBuffer(): string {
    return this.buffer;
  }

  private calculatePartialConfidence(): number {
    if (this.buffer.length === 0) return 0;

    let confidence = 0.1;
    confidence += Math.min(0.4, this.buffer.length * 0.1);

    if (this.couldMatch()) {
      confidence += 0.3;
    }

    if (this.buffer.startsWith("$")) confidence += 0.2;
    if (this.buffer.startsWith("$$")) confidence += 0.3;

    return Math.min(1, confidence);
  }

  private isValidPrefix(): boolean {
    const patternStr = this.pattern.source;

    if (patternStr.includes("\\$\\$") && (this.buffer === "$" || this.buffer === "$$")) {
      return true;
    }

    if (patternStr.includes("\\$") && this.buffer === "$") {
      return true;
    }

    return false;
  }
}

export interface MatchResult {
  matched: boolean;
  content: string;
  length: number;
  isComplete: boolean;
  confidence?: number;
}

interface PossibleMatch {
  startIndex: number;
  pattern: RegExp;
  confidence: number;
}

