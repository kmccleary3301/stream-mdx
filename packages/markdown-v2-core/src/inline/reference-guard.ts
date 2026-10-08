import type { MarkdownConfig } from "@lezer/markdown";
export type ReferencePredicate = (label: string) => boolean;

let currentReferencePredicate: ReferencePredicate | null = null;

export function setActiveReferencePredicate(predicate: ReferencePredicate | null): void {
  currentReferencePredicate = predicate;
}

export function getActiveReferencePredicate(): ReferencePredicate | null {
  return currentReferencePredicate;
}

function isValidAngleDestination(slice: string): boolean {
  if (!slice.startsWith("<") || !slice.endsWith(">")) {
    return false;
  }
  let backslashes = 0;
  for (let i = slice.length - 2; i >= 0 && slice[i] === "\\"; i--) {
    backslashes++;
  }
  if (backslashes % 2 !== 0) {
    return false;
  }
  const inner = slice.slice(1, -1);
  if (/[\r\n]/.test(inner)) {
    return false;
  }
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\") {
      i++;
      continue;
    }
    if (inner[i] === "<" || inner[i] === ">") {
      return false;
    }
  }
  return true;
}

function checkLinkValid(cxText: string, pos: number, end: number, linkText: string): boolean {
  const afterClose = cxText.slice(pos + 1, pos + 2);
  if (afterClose === "(") {
    const rest = cxText.slice(pos + 2, end);
    if (rest.startsWith("<")) {
      let closeAngle = -1;
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === "\\") {
          i++;
          continue;
        }
        if (rest[i] === ">") {
          closeAngle = i;
          break;
        }
      }
      if (closeAngle === -1) {
        return false;
      }
      const dest = rest.slice(0, closeAngle + 1);
      if (!isValidAngleDestination(dest)) {
        return false;
      }
    }
    return true;
  }

  const predicate = getActiveReferencePredicate();

  if (afterClose === "[") {
    const rest = cxText.slice(pos + 2, end);
    const closeBracket = rest.indexOf("]");
    if (closeBracket !== -1) {
      const ref = rest.slice(0, closeBracket);
      const label = ref.length > 0 ? ref : linkText;
      return predicate ? predicate(label) : false;
    }
    return false;
  }

  // Footnote reference candidate: [^foo]
  if (/^\^[A-Za-z0-9_-]+$/.test(linkText)) {
    return true;
  }

  // Shortcut reference link candidate: [label]
  return predicate ? predicate(linkText) : false;
}

export const referenceGuardExtension: MarkdownConfig = {
  parseInline: [
    {
      name: "ReferenceGuard",
      before: "LinkEnd",
      parse(cx, next, pos) {
        if (next !== 93) {
          return -1;
        }
        // Scan backwards for the matching active link or image opening delimiter
        const parts = (cx as unknown as { parts: Array<{ from?: number; to?: number; side?: number; type?: { resolve?: string } } | null> }).parts;
        if (!Array.isArray(parts)) {
          return -1;
        }

        for (let i = parts.length - 1; i >= 0; i--) {
          const part = parts[i];
          if (part && typeof part.from === "number" && typeof part.to === "number" && part.side && !part.type?.resolve) {
            const markLen = part.to - part.from;
            const label = cx.slice(part.from + markLen, pos);
            if (!checkLinkValid(cx.text, pos - cx.offset, cx.end - cx.offset, label)) {
              part.side = 0;
            }
            break;
          }
        }
        return -1;
      },
    },
  ],
};
