import { InlineContext, type MarkdownConfig } from "@lezer/markdown";
import {
  findActiveLinkDelimiter,
  reportReferenceAttempt,
  reportUnfinishedReference,
  reportUnresolvedReferenceSpan,
} from "./native-inline-state";

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
    if (inner[i] === "\\" && i + 1 < inner.length) {
      i++;
      continue;
    }
    if (inner[i] === "<" || inner[i] === ">") {
      return false;
    }
  }
  return true;
}

function checkLinkValid(
  cx: InlineContext,
  pos: number,
  end: number,
  linkText: string,
  linkFrom: number,
): boolean {
  const cxText = cx.text;
  const afterClose = cxText.slice(pos + 1, pos + 2);
  if (afterClose === "(") {
    const rest = cxText.slice(pos + 2, end);
    if (rest.startsWith("<")) {
      let closeAngle = -1;
      let crossedLine = false;
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === "\r" || rest[i] === "\n") crossedLine = true;
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
        if (!crossedLine) reportUnfinishedReference(cx, cx.offset + linkFrom);
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
    if (closeBracket === -1) {
      reportUnfinishedReference(cx, cx.offset + linkFrom);
      return false;
    }
    const ref = rest.slice(0, closeBracket);
    const label = ref.length > 0 ? ref : linkText;
    const valid = predicate ? predicate(label) : false;
    reportReferenceAttempt(
      cx,
      cx.offset + linkFrom,
      cx.offset + pos + 3 + closeBracket,
      label,
    );
    if (!valid) {
      reportUnresolvedReferenceSpan(cx, cx.offset + linkFrom, cx.offset + pos + 3 + closeBracket);
    }
    return valid;
  }

  // Footnote reference candidate: [^foo]
  if (/^\^[A-Za-z0-9_-]+$/.test(linkText)) {
    if (pos + 1 === end) reportUnfinishedReference(cx, cx.offset + linkFrom);
    return true;
  }

  // A terminal shortcut reference can still become an inline or full reference link.
  if (pos + 1 === end) reportUnfinishedReference(cx, cx.offset + linkFrom);
  const valid = predicate ? predicate(linkText) : false;
  reportReferenceAttempt(cx, cx.offset + linkFrom, cx.offset + pos + 1, linkText);
  if (!valid) {
    reportUnresolvedReferenceSpan(cx, cx.offset + linkFrom, cx.offset + pos + 1);
  }
  return valid;
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
        const active = findActiveLinkDelimiter(cx);
        if (!active) return -1;

        const markLen = active.to - active.from;
        const label = cx.slice(active.from + markLen, pos);
        const linkFrom = active.from - cx.offset;
        if (!checkLinkValid(cx, pos - cx.offset, cx.end - cx.offset, label, linkFrom)) {
          active.side = 0;
        }
        return -1;
      },
    },
  ],
};
