// Lezer external tokenizer for math expressions

import { ExternalTokenizer, type InputStream } from "@lezer/lr";

// Token type constants (these will be defined in the grammar)
export const INLINE_MATH_TOKEN = 1;
export const DISPLAY_MATH_TOKEN = 2;

/**
 * External tokenizer for math expressions
 * Handles both inline ($...$) and display ($$...$$) math
 */
export const MathTokenizer = new ExternalTokenizer((input: InputStream, stack) => {
  const start = input.pos;

  // Check for display math first ($$...$$) - longer pattern takes precedence
  if (input.peek(0) === 36 && input.peek(1) === 36) {
    // $$
    if (tryDisplayMath(input)) {
      input.acceptToken(DISPLAY_MATH_TOKEN);
      return;
    }
  }

  // Check for inline math ($...$)
  if (input.peek(0) === 36) {
    // $
    if (tryInlineMath(input)) {
      input.acceptToken(INLINE_MATH_TOKEN);
      return;
    }
  }
});

/**
 * Try to parse display math ($$...$$)
 */
function tryDisplayMath(input: InputStream): boolean {
  let pos = 0;

  // Must start with $$
  if (input.peek(pos) !== 36 || input.peek(pos + 1) !== 36) {
    return false;
  }
  pos += 2;

  // Look for content and closing $$
  let foundContent = false;
  let consecutiveDollar = 0;

  for (;;) {
    const char = input.peek(pos);

    if (char < 0) break; // End of input

    if (char === 36) {
      // $
      consecutiveDollar++;
      if (consecutiveDollar >= 2 && foundContent) {
        // Found closing $$
        pos++;
        input.advance(pos);
        return true;
      }
    } else {
      consecutiveDollar = 0;
      if (char !== 32 && char !== 9 && char !== 10 && char !== 13) {
        // Not whitespace
        foundContent = true;
      }
    }

    pos++;

    // Safety limit to prevent infinite loops
    if (pos > 10000) break;
  }

  return false; // No closing $$ found
}

/**
 * Try to parse inline math ($...$)
 */
function tryInlineMath(input: InputStream): boolean {
  let pos = 0;

  // Must start with single $
  if (input.peek(pos) !== 36) {
    return false;
  }

  // But not $$
  if (input.peek(pos + 1) === 36) {
    return false;
  }

  pos++;

  // Look for content and closing $
  let foundContent = false;

  for (;;) {
    const char = input.peek(pos);

    if (char < 0) break; // End of input

    if (char === 36) {
      // $
      if (foundContent) {
        // Found closing $
        pos++;
        input.advance(pos);
        return true;
      }
      // Empty math expression
      return false;
    }

    // Check for newline (inline math shouldn't span lines)
    if (char === 10 || char === 13) {
      // \n or \r
      return false;
    }

    if (char !== 32 && char !== 9) {
      // Not space or tab
      foundContent = true;
    }

    pos++;

    // Safety limit
    if (pos > 1000) break;
  }

  return false; // No closing $ found
}

/**
 * Utility to extract math content from input
 */
export function extractMathContent(input: string, isDisplay: boolean): string {
  if (isDisplay) {
    // Remove $$ from both ends
    if (input.startsWith("$$") && input.endsWith("$$")) {
      return input.slice(2, -2).trim();
    }
  } else {
    // Remove $ from both ends
    if (input.startsWith("$") && input.endsWith("$")) {
      return input.slice(1, -1).trim();
    }
  }

  return input;
}

/**
 * Validate math expression syntax (basic validation)
 */
export function validateMathExpression(content: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check for balanced braces
  let braceCount = 0;
  let bracketCount = 0;
  let parenCount = 0;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    switch (char) {
      case "{":
        braceCount++;
        break;
      case "}":
        braceCount--;
        if (braceCount < 0) {
          errors.push(`Unmatched closing brace at position ${i}`);
        }
        break;
      case "[":
        bracketCount++;
        break;
      case "]":
        bracketCount--;
        if (bracketCount < 0) {
          errors.push(`Unmatched closing bracket at position ${i}`);
        }
        break;
      case "(":
        parenCount++;
        break;
      case ")":
        parenCount--;
        if (parenCount < 0) {
          errors.push(`Unmatched closing parenthesis at position ${i}`);
        }
        break;
      case "\\":
        // Skip next character for LaTeX commands
        if (i + 1 < content.length) {
          i++;
        }
        break;
    }
  }

  // Check final balance
  if (braceCount > 0) {
    errors.push(`${braceCount} unmatched opening brace(s)`);
  }
  if (bracketCount > 0) {
    errors.push(`${bracketCount} unmatched opening bracket(s)`);
  }
  if (parenCount > 0) {
    errors.push(`${parenCount} unmatched opening parenthesis(es)`);
  }

  // Check for common LaTeX errors
  if (content.includes("\\\\\\")) {
    errors.push("Triple backslash found - possible LaTeX syntax error");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
// @ts-nocheck
