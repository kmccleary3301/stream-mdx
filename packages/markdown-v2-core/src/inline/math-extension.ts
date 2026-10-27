import type { MarkdownConfig } from "@lezer/markdown";
import type { SingleDollarMathMode } from "../types";
import { reportUnfinishedNativeToken } from "./native-inline-state";

/**
 * Lezer markdown extension for LaTeX math syntax ($...$ and $$...$$).
 * Runs before Escape so backslashes inside math expressions (such as \\ line breaks)
 * are preserved verbatim.
 */
export function createMathExtension(singleDollar: SingleDollarMathMode = "permissive"): MarkdownConfig {
  return {
    defineNodes: ["InlineMath", "DisplayMath", "RejectedInlineMath"],
    parseInline: [
      {
        name: "Math",
        before: "Escape",
        parse(cx, next, pos) {
          if (next !== 36 /* $ */) {
            return -1;
          }

          const isDisplay = cx.char(pos + 1) === 36;
          const delimLen = isDisplay ? 2 : 1;
          let close = -1;
          let crossedInlineLine = false;

          for (let i = pos + delimLen; i < cx.end; i++) {
            const ch = cx.char(i);
            if (!isDisplay && (ch === 10 || ch === 13)) {
              crossedInlineLine = true;
              break;
            }
            if (ch === 92 /* \\ */) {
              i++;
              continue;
            }
            if (ch === 36) {
              if (isDisplay) {
                if (cx.char(i + 1) === 36) {
                  close = i;
                  break;
                }
              } else {
                close = i;
                break;
              }
            }
          }

          if (close === -1) {
            if (isDisplay || !crossedInlineLine) reportUnfinishedNativeToken(cx, pos);
            return -1;
          }
          // Math expressions must contain at least 1 character between delimiters.
          if (close === pos + delimLen) {
            return -1;
          }

          const end = close + delimLen;
          if (!isDisplay && singleDollar === "currency-safe") {
            const openingCharacter = cx.char(pos + 1);
            const closingCharacter = cx.char(close - 1);
            const openingWhitespace = openingCharacter === 32 || openingCharacter === 9 || openingCharacter === 44;
            const closingWhitespace = closingCharacter === 32 || closingCharacter === 9 || closingCharacter === 44;
            const followingCharacter = cx.char(end);
            const closesBeforeAmount = followingCharacter >= 48 && followingCharacter <= 57;
            if (openingWhitespace || openingWhitespace !== closingWhitespace || closesBeforeAmount) {
              return cx.addElement(cx.elt("RejectedInlineMath", pos, end));
            }
          }

          const nodeName = isDisplay ? "DisplayMath" : "InlineMath";
          return cx.addElement(cx.elt(nodeName, pos, end));
        },
      },
    ],
  };
}
