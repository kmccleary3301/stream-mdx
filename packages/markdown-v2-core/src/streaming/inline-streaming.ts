import type { FormatAnticipationConfig } from "../types";

export type InlineStreamingInlineStatus = "complete" | "anticipated" | "raw";

export type NormalizedFormatAnticipation = {
  inline: boolean;
  mathInline: boolean;
  mathBlock: boolean;
  html: boolean;
  mdx: boolean;
  regex: boolean;
};

const DEFAULT_FORMAT_ANTICIPATION: NormalizedFormatAnticipation = {
  inline: false,
  mathInline: false,
  mathBlock: false,
  html: false,
  mdx: false,
  regex: false,
};

export function normalizeFormatAnticipation(input?: FormatAnticipationConfig): NormalizedFormatAnticipation {
  if (input === true) {
    return { ...DEFAULT_FORMAT_ANTICIPATION, inline: true };
  }
  if (!input) {
    return { ...DEFAULT_FORMAT_ANTICIPATION };
  }
  return {
    inline: input.inline ?? false,
    mathInline: input.mathInline ?? false,
    mathBlock: input.mathBlock ?? false,
    html: input.html ?? false,
    mdx: input.mdx ?? false,
    regex: input.regex ?? false,
  };
}

export type InlineStreamingPrepareResult =
  | {
      kind: "raw";
      status: "raw";
      reason: "incomplete-math" | "incomplete-formatting";
    }
  | {
      kind: "parse";
      status: Exclude<InlineStreamingInlineStatus, "raw">;
      content: string;
      appended: string;
    };

export function prepareInlineStreamingContent(
  content: string,
  options?: { formatAnticipation?: FormatAnticipationConfig; math?: boolean },
): InlineStreamingPrepareResult {
  const enableMath = options?.math !== false;
  const anticipation = normalizeFormatAnticipation(options?.formatAnticipation);
  const enableInlineAnticipation = anticipation.inline;
  const enableMathInlineAnticipation = anticipation.mathInline;
  const enableMathBlockAnticipation = anticipation.mathBlock;

  type TokenKind = "code" | "strike" | "strong" | "em" | "math-inline" | "math-display";
  const stack: TokenKind[] = [];
  const toggleToken = (token: TokenKind) => {
    const last = stack[stack.length - 1];
    if (last === token) {
      stack.pop();
    } else {
      stack.push(token);
    }
  };

  let mathDisplayOpen = false;
  let mathDisplayCrossedNewline = false;

  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 10 || code === 13) {
      if (mathDisplayOpen) {
        mathDisplayCrossedNewline = true;
      }
      continue;
    }
    // '`'
    if (code === 96) {
      toggleToken("code");
      continue;
    }
    // '~'
    if (code === 126 && i + 1 < content.length && content.charCodeAt(i + 1) === 126) {
      toggleToken("strike");
      i += 1;
      continue;
    }
    // '*'
    if (code === 42) {
      if (i + 1 < content.length && content.charCodeAt(i + 1) === 42) {
        toggleToken("strong");
        i += 1;
      } else {
        toggleToken("em");
      }
      continue;
    }
    // '$'
    if (enableMath && code === 36) {
      if (i + 1 < content.length && content.charCodeAt(i + 1) === 36) {
        toggleToken("math-display");
        if (mathDisplayOpen) {
          mathDisplayOpen = false;
          mathDisplayCrossedNewline = false;
        } else {
          mathDisplayOpen = true;
          mathDisplayCrossedNewline = false;
        }
        i += 1;
      } else {
        toggleToken("math-inline");
      }
    }
  }

  const hasIncompleteFormatting = stack.some((token) => token === "code" || token === "strike" || token === "strong" || token === "em");
  const hasIncompleteMathInline = stack.includes("math-inline");
  const hasIncompleteMathDisplay = stack.includes("math-display");
  const hasIncompleteMath = hasIncompleteMathInline || hasIncompleteMathDisplay;

  if (enableMath && hasIncompleteMath) {
    if (hasIncompleteMathInline && !enableMathInlineAnticipation) {
      return { kind: "raw", status: "raw", reason: "incomplete-math" };
    }
    if (hasIncompleteMathDisplay && (!enableMathBlockAnticipation || mathDisplayCrossedNewline)) {
      return { kind: "raw", status: "raw", reason: "incomplete-math" };
    }
  }

  if (hasIncompleteFormatting && !enableInlineAnticipation) {
    return { kind: "raw", status: "raw", reason: "incomplete-formatting" };
  }

  if (!hasIncompleteFormatting && !hasIncompleteMath) {
    return { kind: "parse", status: "complete", content, appended: "" };
  }

  const appendForToken = (token: TokenKind) => {
    switch (token) {
      case "code":
        return "`";
      case "strike":
        return "~~";
      case "strong":
        return "**";
      case "em":
        return "*";
      case "math-inline":
        return "$";
      case "math-display":
        return "$$";
      default:
        return "";
    }
  };

  const appended = stack
    .slice()
    .reverse()
    .map((token) => appendForToken(token))
    .join("");

  return { kind: "parse", status: "anticipated", content: content + appended, appended };
}
