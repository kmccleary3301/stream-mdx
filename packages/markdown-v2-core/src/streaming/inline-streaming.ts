export type InlineStreamingInlineStatus = "complete" | "anticipated" | "raw";

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
  options?: { formatAnticipation?: boolean; math?: boolean },
): InlineStreamingPrepareResult {
  const enableAnticipation = Boolean(options?.formatAnticipation);
  const enableMath = options?.math !== false;

  // Fast parity checks (avoid regex allocations on hot path).
  let dollarCount = 0;
  let backtickCount = 0;
  let starCount = 0;
  let doubleStarCount = 0;
  let tildePairCount = 0;

  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    // '$'
    if (code === 36) {
      dollarCount += 1;
      continue;
    }
    // '`'
    if (code === 96) {
      backtickCount += 1;
      continue;
    }
    // '*'
    if (code === 42) {
      if (i + 1 < content.length && content.charCodeAt(i + 1) === 42) {
        doubleStarCount += 1;
        starCount += 2;
        i += 1;
      } else {
        starCount += 1;
      }
      continue;
    }
    // '~'
    if (code === 126) {
      if (i + 1 < content.length && content.charCodeAt(i + 1) === 126) {
        tildePairCount += 1;
        i += 1;
      }
    }
  }

  const hasIncompleteMath = enableMath && dollarCount % 2 !== 0;
  if (hasIncompleteMath) {
    // Math anticipation is tabled (we do not append "$" / "$$" yet).
    return { kind: "raw", status: "raw", reason: "incomplete-math" };
  }

  const hasIncompleteCode = backtickCount % 2 !== 0;
  const hasIncompleteStrong = doubleStarCount % 2 !== 0;
  const singleStarCount = starCount - doubleStarCount * 2;
  const hasIncompleteEmphasis = singleStarCount % 2 !== 0;
  const hasIncompleteStrike = tildePairCount % 2 !== 0;

  const hasAnyIncomplete = hasIncompleteCode || hasIncompleteStrong || hasIncompleteEmphasis || hasIncompleteStrike;
  if (!hasAnyIncomplete) {
    return { kind: "parse", status: "complete", content, appended: "" };
  }

  if (!enableAnticipation) {
    return { kind: "raw", status: "raw", reason: "incomplete-formatting" };
  }

  let appended = "";
  if (hasIncompleteCode) appended += "`";
  if (hasIncompleteStrike) appended += "~~";
  if (hasIncompleteStrong && hasIncompleteEmphasis) appended += "***";
  else if (hasIncompleteStrong) appended += "**";
  else if (hasIncompleteEmphasis) appended += "*";

  return { kind: "parse", status: "anticipated", content: content + appended, appended };
}
