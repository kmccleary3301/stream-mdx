import type { MarkdownConfig } from "@lezer/markdown";
import { reportUnfinishedNativeToken } from "./native-inline-state";

/**
 * Lezer markdown extension for LaTeX math syntax ($...$ and $$...$$).
 * Runs before Escape so backslashes inside math expressions (such as \\ line breaks)
 * are preserved verbatim.
 */
export function createMathExtension(): MarkdownConfig {
  return {
    defineNodes: ["InlineMath", "DisplayMath"],
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
          const nodeName = isDisplay ? "DisplayMath" : "InlineMath";
          return cx.addElement(cx.elt(nodeName, pos, end));
        },
      },
    ],
  };
}
