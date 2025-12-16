// Math context tracker for Lezer incremental parsing

import { ContextTracker, type Stack } from "@lezer/lr";

/**
 * Math parsing context state
 */
export interface MathContext {
  /** Whether we're currently inside math */
  inMath: boolean;

  /** Type of math context */
  mathType: "inline" | "display" | null;

  /** Nesting depth for braces/brackets */
  depth: number;

  /** Position where math started */
  startPos: number;

  /** Whether the math is complete */
  isComplete: boolean;

  /** Error state if math is malformed */
  hasError: boolean;
}

/**
 * Token constants (these should match the grammar)
 */
const MATH_TOKENS = {
  INLINE_MATH: 1,
  DISPLAY_MATH: 2,
  DOLLAR: 3,
  DOUBLE_DOLLAR: 4,
  OPEN_BRACE: 5,
  CLOSE_BRACE: 6,
  OPEN_BRACKET: 7,
  CLOSE_BRACKET: 8,
  OPEN_PAREN: 9,
  CLOSE_PAREN: 10,
  BACKSLASH: 11,
  NEWLINE: 12,
};

/**
 * Context tracker for math expressions
 */
export const mathContextTracker = new ContextTracker<MathContext>({
  start: {
    inMath: false,
    mathType: null,
    depth: 0,
    startPos: -1,
    isComplete: false,
    hasError: false,
  },

  shift(context: MathContext, term: number, stack: Stack): MathContext {
    const pos = stack.pos;

    switch (term) {
      case MATH_TOKENS.INLINE_MATH:
        if (!context.inMath) {
          // Starting inline math
          return {
            ...context,
            inMath: true,
            mathType: "inline",
            startPos: pos,
            isComplete: false,
            hasError: false,
          };
        }
        if (context.mathType === "inline") {
          // Ending inline math
          return {
            ...context,
            inMath: false,
            mathType: null,
            isComplete: true,
          };
        }
        break;

      case MATH_TOKENS.DISPLAY_MATH:
        if (!context.inMath) {
          // Starting display math
          return {
            ...context,
            inMath: true,
            mathType: "display",
            startPos: pos,
            isComplete: false,
            hasError: false,
          };
        }
        if (context.mathType === "display") {
          // Ending display math
          return {
            ...context,
            inMath: false,
            mathType: null,
            isComplete: true,
          };
        }
        break;

      case MATH_TOKENS.OPEN_BRACE:
      case MATH_TOKENS.OPEN_BRACKET:
      case MATH_TOKENS.OPEN_PAREN:
        if (context.inMath) {
          return {
            ...context,
            depth: context.depth + 1,
          };
        }
        break;

      case MATH_TOKENS.CLOSE_BRACE:
      case MATH_TOKENS.CLOSE_BRACKET:
      case MATH_TOKENS.CLOSE_PAREN:
        if (context.inMath) {
          const newDepth = Math.max(0, context.depth - 1);
          return {
            ...context,
            depth: newDepth,
            hasError: context.hasError || newDepth < 0, // Unmatched closing
          };
        }
        break;

      case MATH_TOKENS.NEWLINE:
        if (context.inMath && context.mathType === "inline") {
          // Inline math shouldn't span lines
          return {
            ...context,
            hasError: true,
          };
        }
        break;
    }

    return context;
  },

  reduce(context: MathContext, term: number): MathContext {
    // Handle reductions (when parsing rules complete)
    switch (term) {
      case MATH_TOKENS.INLINE_MATH:
      case MATH_TOKENS.DISPLAY_MATH:
        if (context.inMath && context.depth > 0) {
          // Math ended with unmatched braces/brackets
          return {
            ...context,
            hasError: true,
          };
        }
        break;
    }

    return context;
  },

  // reuse and hash left out for simplicity; default behavior applies
});

// Helper functions
type LezerNodeLike = { type?: { name?: string } } | null | undefined;

function nodeContainsMath(node: LezerNodeLike): boolean {
  const mathNodeTypes = ["InlineMath", "DisplayMath"];
  const typeName = node?.type?.name;
  return typeof typeName === "string" && mathNodeTypes.includes(typeName);
}

function getNodeMathContext(_node: LezerNodeLike): MathContext | null {
  return null;
}

function contextsEqual(a: MathContext, b: MathContext): boolean {
  return a.inMath === b.inMath && a.mathType === b.mathType && a.depth === b.depth && a.hasError === b.hasError;
}

/**
 * Utility functions for working with math context
 */
export const MathContextUtils = {
  /**
   * Check if current context allows math to start
   */
  canStartMath(context: MathContext): boolean {
    return !context.inMath && !context.hasError;
  },

  /**
   * Check if current context is inside math
   */
  isInMath(context: MathContext): boolean {
    return context.inMath;
  },

  /**
   * Check if current context has balanced brackets
   */
  isBalanced(context: MathContext): boolean {
    return context.depth === 0;
  },

  /**
   * Check if math context has errors
   */
  hasErrors(context: MathContext): boolean {
    return context.hasError;
  },

  /**
   * Get math type from context
   */
  getMathType(context: MathContext): "inline" | "display" | null {
    return context.mathType;
  },

  /**
   * Create error context
   */
  createErrorContext(baseContext: MathContext): MathContext {
    return {
      ...baseContext,
      hasError: true,
    };
  },

  /**
   * Reset context to initial state
   */
  resetContext(): MathContext {
    return {
      inMath: false,
      mathType: null,
      depth: 0,
      startPos: -1,
      isComplete: false,
      hasError: false,
    };
  },
} as const;
