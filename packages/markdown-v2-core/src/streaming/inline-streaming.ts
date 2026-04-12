import type { FormatAnticipationConfig } from "../types";
import type {
  LookaheadContainerContext,
  LookaheadDecisionTrace,
  LookaheadRepairOp,
  LookaheadRequest,
  LookaheadSurface,
  LookaheadTerminationReason,
} from "./lookahead-contract";

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

const DEFAULT_CONTAINER_CONTEXT: LookaheadContainerContext = {
  blockType: "paragraph",
  ancestorTypes: [],
  listDepth: 0,
  blockquoteDepth: 0,
  insideHtml: false,
  insideMdx: false,
  segmentOrigin: "direct-inline",
  provisional: true,
  containerSignature: "paragraph|direct-inline|l0|bq0|p1",
};

export const DEFAULT_LOOKAHEAD_BUDGETS = {
  maxScanChars: 512,
  maxNewlines: 2,
  maxSyntheticOps: 6,
  maxNestingDepth: 8,
  maxValidationFailures: 1,
  maxProviderMs: 5,
} as const;

type TokenKind = "code" | "strike" | "strong" | "em" | "math-inline" | "math-display";

type InlineFormatPlan =
  | {
      surface: LookaheadSurface;
      decision: "accept-as-is";
      safety: "safe";
      ops: readonly LookaheadRepairOp[];
      debugNotes: string[];
      terminationReason?: never;
      downgradeReason?: never;
    }
  | {
      surface: LookaheadSurface;
      decision: "raw";
      safety: "safe";
      ops: readonly LookaheadRepairOp[];
      debugNotes: string[];
      terminationReason: LookaheadTerminationReason;
      downgradeReason: string;
    }
  | {
      surface: LookaheadSurface;
      decision: "repair";
      safety: "safe";
      ops: readonly LookaheadRepairOp[];
      debugNotes: string[];
      terminationReason?: never;
      downgradeReason?: never;
    };

type RegexPlan = {
  decision: "accept-as-is" | "repair";
  ops: readonly LookaheadRepairOp[];
  debugNotes: string[];
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

export function buildLookaheadContainerContext(input?: Partial<LookaheadContainerContext>): LookaheadContainerContext {
  const merged: LookaheadContainerContext = {
    ...DEFAULT_CONTAINER_CONTEXT,
    ...input,
    ancestorTypes: input?.ancestorTypes ? [...input.ancestorTypes] : DEFAULT_CONTAINER_CONTEXT.ancestorTypes,
  };
  if (!merged.containerSignature) {
    merged.containerSignature = createContainerSignature(merged);
  }
  return merged;
}

export function createContainerSignature(input: {
  blockType: string;
  ancestorTypes?: readonly string[];
  listDepth?: number;
  blockquoteDepth?: number;
  insideHtml?: boolean;
  insideMdx?: boolean;
  segmentOrigin?: "direct-inline" | "mixed-content";
  mixedSegmentKind?: "text" | "html" | "mdx";
  provisional?: boolean;
  localTextField?: string;
}): string {
  const ancestors = (input.ancestorTypes ?? []).join(">");
  return [
    input.blockType,
    ancestors || "root",
    `l${input.listDepth ?? 0}`,
    `bq${input.blockquoteDepth ?? 0}`,
    input.insideHtml ? "html1" : "html0",
    input.insideMdx ? "mdx1" : "mdx0",
    input.segmentOrigin ?? "direct-inline",
    input.mixedSegmentKind ?? "text",
    input.provisional === false ? "p0" : "p1",
    input.localTextField ?? "raw",
  ].join("|");
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

export type InlineLookaheadPrepareOptions = {
  formatAnticipation?: FormatAnticipationConfig;
  math?: boolean;
  regexAppend?: string | null;
  context?: Partial<LookaheadContainerContext>;
};

export type InlineLookaheadPrepareResult = {
  prepared: InlineStreamingPrepareResult;
  trace: LookaheadDecisionTrace[];
  container: LookaheadContainerContext;
};

export function prepareInlineStreamingContent(
  content: string,
  options?: InlineLookaheadPrepareOptions,
): InlineStreamingPrepareResult {
  return prepareInlineStreamingLookahead(content, options).prepared;
}

export function prepareInlineStreamingLookahead(
  content: string,
  options?: InlineLookaheadPrepareOptions,
): InlineLookaheadPrepareResult {
  const enableMath = options?.math !== false;
  const anticipation = normalizeFormatAnticipation(options?.formatAnticipation);
  const context = buildLookaheadContainerContext(options?.context);
  const request: LookaheadRequest = {
    surface: "inline-format",
    raw: content,
    absoluteRange: { start: 0, end: content.length },
    context,
    budgets: { ...DEFAULT_LOOKAHEAD_BUDGETS },
  };

  const traces: LookaheadDecisionTrace[] = [];
  const formatPlan = planInlineFormat(request, anticipation, enableMath);
  traces.push(traceFromFormatPlan(formatPlan, context.containerSignature));

  if (formatPlan.decision === "raw") {
    return {
      prepared: {
        kind: "raw",
        status: "raw",
        reason: formatPlan.surface === "inline-format" ? "incomplete-formatting" : "incomplete-math",
      },
      trace: traces,
      container: context,
    };
  }

  let repairOps: LookaheadRepairOp[] = [...formatPlan.ops];
  if (anticipation.regex) {
    const regexPlan = planRegexLookahead(options?.regexAppend ?? null);
    traces.push(traceFromRegexPlan(regexPlan, context.containerSignature));
    repairOps = [...repairOps, ...regexPlan.ops];
  }

  const preparedContent = applyRepairOps(content, repairOps);
  const appended = renderAppendedSuffix(repairOps);
  const status: Exclude<InlineStreamingInlineStatus, "raw"> = repairOps.length > 0 ? "anticipated" : "complete";

  return {
    prepared: {
      kind: "parse",
      status,
      content: preparedContent,
      appended,
    },
    trace: traces,
    container: context,
  };
}

function traceFromFormatPlan(plan: InlineFormatPlan, contextSignature: string): LookaheadDecisionTrace {
  return {
    providerId: "inline-format-provider",
    surface: plan.surface,
    decision: plan.decision,
    safety: plan.safety,
    contextSignature,
    ops: plan.ops,
    appended: renderAppendedSuffix(plan.ops),
    downgrade: plan.decision === "raw" ? { mode: "raw", reason: plan.downgradeReason } : undefined,
    termination:
      plan.decision === "raw"
        ? {
            reason: plan.terminationReason,
            rearmWhen: "next-byte",
          }
        : undefined,
    debug: {
      strategy: plan.decision === "repair" ? "tail-closure" : plan.decision === "raw" ? "raw-fallback" : "no-op",
      notes: plan.debugNotes,
    },
  };
}

function traceFromRegexPlan(plan: RegexPlan, contextSignature: string): LookaheadDecisionTrace {
  return {
    providerId: "regex-provider",
    surface: "regex",
    decision: plan.decision,
    safety: "safe",
    contextSignature,
    ops: plan.ops,
    appended: renderAppendedSuffix(plan.ops),
    debug: {
      strategy: plan.decision === "repair" ? "regex-append" : "no-op",
      notes: plan.debugNotes,
    },
  };
}

function planRegexLookahead(regexAppend: string | null): RegexPlan {
  if (!regexAppend) {
    return {
      decision: "accept-as-is",
      ops: [],
      debugNotes: ["no incomplete regex anticipation match"],
    };
  }
  return {
    decision: "repair",
    ops: [{ kind: "append", text: regexAppend }],
    debugNotes: ["regex anticipation match"],
  };
}

function planInlineFormat(
  request: LookaheadRequest,
  anticipation: NormalizedFormatAnticipation,
  enableMath: boolean,
): InlineFormatPlan {
  const scan = scanInlineTokens(request.raw, enableMath);
  const hasIncompleteFormatting = scan.stack.some((token) => token === "code" || token === "strike" || token === "strong" || token === "em");
  const hasIncompleteMathInline = scan.stack.includes("math-inline");
  const hasIncompleteMathDisplay = scan.stack.includes("math-display");
  const hasIncompleteMath = hasIncompleteMathInline || hasIncompleteMathDisplay;

  if (enableMath && hasIncompleteMath) {
    if (hasIncompleteMathInline && !anticipation.mathInline) {
      return {
        surface: "math-inline",
        decision: "raw",
        safety: "safe",
        ops: [],
        terminationReason: "unsupported-syntax",
        downgradeReason: "math-inline anticipation disabled",
        debugNotes: ["incomplete inline math"],
      };
    }
    if (hasIncompleteMathDisplay && !anticipation.mathBlock) {
      return {
        surface: "math-block",
        decision: "raw",
        safety: "safe",
        ops: [],
        terminationReason: "unsupported-syntax",
        downgradeReason: "math-block anticipation disabled",
        debugNotes: ["incomplete display math"],
      };
    }
  }

  if (hasIncompleteFormatting && !anticipation.inline) {
    return {
      surface: "inline-format",
      decision: "raw",
      safety: "safe",
      ops: [],
      terminationReason: "unsupported-syntax",
      downgradeReason: "inline anticipation disabled",
      debugNotes: ["incomplete formatting"],
    };
  }

  if (!hasIncompleteFormatting && !hasIncompleteMath) {
    return {
      surface: "inline-format",
      decision: "accept-as-is",
      safety: "safe",
      ops: [],
      debugNotes: ["content already complete"],
    };
  }

  const ops = scan.stack
    .slice()
    .reverse()
    .flatMap((token) => appendOpsForToken(token, request.raw, scan.mathDisplayCrossedNewline));

  return {
    surface: hasIncompleteMath ? (hasIncompleteMathDisplay ? "math-block" : "math-inline") : "inline-format",
    decision: "repair",
    safety: "safe",
    ops,
    debugNotes: scan.stack.slice().reverse(),
  };
}

function scanInlineTokens(content: string, enableMath: boolean): { stack: TokenKind[]; mathDisplayCrossedNewline: boolean } {
  const stack: TokenKind[] = [];
  let mathDisplayOpen = false;
  let mathDisplayCrossedNewline = false;

  const toggleToken = (token: TokenKind) => {
    const last = stack[stack.length - 1];
    if (last === token) {
      stack.pop();
    } else {
      stack.push(token);
    }
  };

  const shouldOpenInlineMath = (index: number) => {
    const next = content[index + 1] ?? "";
    return !/\d/.test(next);
  };

  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i);
    if (code === 10 || code === 13) {
      if (mathDisplayOpen) {
        mathDisplayCrossedNewline = true;
      }
      continue;
    }
    if (code === 96) {
      toggleToken("code");
      continue;
    }
    if (code === 126 && i + 1 < content.length && content.charCodeAt(i + 1) === 126) {
      toggleToken("strike");
      i += 1;
      continue;
    }
    if (code === 42) {
      if (i + 1 < content.length && content.charCodeAt(i + 1) === 42) {
        toggleToken("strong");
        i += 1;
      } else {
        toggleToken("em");
      }
      continue;
    }
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
        const mathInlineOpen = stack.includes("math-inline");
        if (mathInlineOpen || shouldOpenInlineMath(i)) {
          toggleToken("math-inline");
        }
      }
    }
  }

  return { stack, mathDisplayCrossedNewline };
}

function appendOpsForToken(token: TokenKind, raw: string, mathDisplayCrossedNewline: boolean): LookaheadRepairOp[] {
  switch (token) {
    case "code":
      return [{ kind: "close-delimiter", text: "`" }];
    case "strike":
      return [{ kind: "close-delimiter", text: "~~" }];
    case "strong":
      return [{ kind: "close-delimiter", text: "**" }];
    case "em":
      return [{ kind: "close-delimiter", text: "*" }];
    case "math-inline":
      return [{ kind: "close-delimiter", text: "$" }];
    case "math-display":
      if (!mathDisplayCrossedNewline) {
        return [{ kind: "close-delimiter", text: "$$" }];
      }
      return [{ kind: "append", text: raw.endsWith("\n") || raw.endsWith("\r") ? "$$" : "\n$$" }];
    default:
      return [];
  }
}

function applyRepairOps(raw: string, ops: readonly LookaheadRepairOp[]): string {
  let value = raw;
  for (const op of ops) {
    switch (op.kind) {
      case "append":
      case "close-delimiter":
        value += op.text;
        break;
      case "trim-tail":
        value = op.count > 0 ? value.slice(0, Math.max(0, value.length - op.count)) : value;
        break;
      case "insert-empty-group":
        value += "{}";
        break;
      case "close-tag":
        value += `</${op.tagName}>`;
        break;
      case "self-close-tag":
        value += " />";
        break;
      default:
        break;
    }
  }
  return value;
}

function renderAppendedSuffix(ops: readonly LookaheadRepairOp[]): string {
  let appended = "";
  for (const op of ops) {
    switch (op.kind) {
      case "append":
      case "close-delimiter":
        appended += op.text;
        break;
      case "insert-empty-group":
        appended += "{}";
        break;
      case "close-tag":
        appended += `</${op.tagName}>`;
        break;
      case "self-close-tag":
        appended += " />";
        break;
      case "trim-tail":
        break;
      default:
        break;
    }
  }
  return appended;
}
