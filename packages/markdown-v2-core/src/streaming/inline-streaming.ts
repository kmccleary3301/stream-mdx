import type { FormatAnticipationConfig } from "../types";
import type {
  LookaheadContainerContext,
  LookaheadDecisionTrace,
  LookaheadFeatureFamily,
  LookaheadRepairOp,
  LookaheadRequest,
  LookaheadSurface,
  LookaheadTerminationReason,
} from "./lookahead-contract";
import { analyzeMathTailShadow } from "./math-tail-shadow";

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
      mathCandidateId?: "repair-candidate" | "checkpoint-candidate" | "raw-fallback" | "null-right-candidate";
      debugNotes: string[];
      validation?: { valid: boolean; errors?: string[] };
      terminationReason?: never;
      downgradeReason?: never;
    }
  | {
      surface: LookaheadSurface;
      decision: "raw";
      safety: "safe";
      ops: readonly LookaheadRepairOp[];
      mathCandidateId?: "repair-candidate" | "checkpoint-candidate" | "raw-fallback" | "null-right-candidate";
      debugNotes: string[];
      validation?: { valid: boolean; errors?: string[] };
      terminationReason: LookaheadTerminationReason;
      downgradeReason: string;
    }
  | {
      surface: LookaheadSurface;
      decision: "repair";
      safety: "safe";
      ops: readonly LookaheadRepairOp[];
      mathCandidateId?: "repair-candidate" | "checkpoint-candidate" | "raw-fallback" | "null-right-candidate";
      debugNotes: string[];
      validation?: { valid: boolean; errors?: string[] };
      terminationReason?: never;
      downgradeReason?: never;
    };

type RegexPlan = {
  decision: "accept-as-is" | "repair";
  ops: readonly LookaheadRepairOp[];
  debugNotes: string[];
};

type MathRepairClassification =
  | { kind: "repair"; ops: LookaheadRepairOp[]; notes: string[] }
  | { kind: "unsupported"; reason: string; notes: string[] };

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

export type SurfaceLookaheadPrepareOptions = {
  context?: Partial<LookaheadContainerContext>;
  allowTags?: Iterable<string>;
  allowComponents?: Iterable<string>;
  maxNewlines?: number;
};

export type SurfaceLookaheadPrepareResult = {
  prepared: {
    kind: "parse" | "raw";
    content: string;
    status: "complete" | "anticipated" | "raw";
  };
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
  traces.push(traceFromFormatPlan(formatPlan, request.raw, context.containerSignature));

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

export function prepareSurfaceLookahead(
  surface: "html-inline" | "mdx-tag" | "mdx-expression",
  content: string,
  options?: SurfaceLookaheadPrepareOptions,
): SurfaceLookaheadPrepareResult {
  const context = buildLookaheadContainerContext({
    segmentOrigin: "mixed-content",
    mixedSegmentKind: surface === "html-inline" ? "html" : "mdx",
    ...options?.context,
  });
  const request: LookaheadRequest = {
    surface,
    raw: content,
    absoluteRange: { start: 0, end: content.length },
    context,
    budgets: {
      ...DEFAULT_LOOKAHEAD_BUDGETS,
      maxNewlines: options?.maxNewlines ?? DEFAULT_LOOKAHEAD_BUDGETS.maxNewlines,
    },
  };

  const plan =
    surface === "html-inline"
      ? planHtmlInline(request, options?.allowTags)
      : surface === "mdx-tag"
        ? planMdxTag(request, options?.allowComponents)
        : planMdxExpression(request);
  const trace = [traceFromPlan(plan, context.containerSignature)];

  if (plan.decision === "raw" || plan.decision === "surface-fallback" || plan.decision === "terminate") {
    return {
      prepared: {
        kind: "raw",
        content,
        status: "raw",
      },
      trace,
      container: context,
    };
  }

  return {
    prepared: {
      kind: "parse",
      content: applyRepairOps(content, plan.ops),
      status: plan.ops.length > 0 ? "anticipated" : "complete",
    },
    trace,
    container: context,
  };
}

function traceFromFormatPlan(plan: InlineFormatPlan, raw: string, contextSignature: string): LookaheadDecisionTrace {
  const featureFamily = resolveFeatureFamilyForFormatPlan(plan);
  return {
    providerId: "inline-format-provider",
    surface: plan.surface,
    decision: plan.decision,
    safety: plan.safety,
    featureFamily,
    contextSignature,
    ops: plan.ops,
    appended: renderAppendedSuffix(plan.ops),
    validation: plan.validation,
    analysis: buildAnalysisForFormatPlan(plan, raw),
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
    featureFamily: "regex-core",
    contextSignature,
    ops: plan.ops,
    appended: renderAppendedSuffix(plan.ops),
    debug: {
      strategy: plan.decision === "repair" ? "regex-append" : "no-op",
      notes: plan.debugNotes,
    },
  };
}

type SurfacePlan = {
  providerId: string;
  surface: LookaheadSurface;
  decision: "accept-as-is" | "repair" | "surface-fallback" | "raw" | "terminate";
  safety: "safe" | "guarded";
  ops: readonly LookaheadRepairOp[];
  debugNotes: string[];
  validation?: { valid: boolean; errors?: string[] };
  terminationReason?: LookaheadTerminationReason;
  downgradeReason?: string;
  rearmWhen?: "next-byte" | "new-delimiter" | "newline-change" | "container-change" | "finalization";
};

type MathTraceAnalysis = NonNullable<NonNullable<LookaheadDecisionTrace["analysis"]>["math"]>;

function traceFromPlan(plan: SurfacePlan, contextSignature: string): LookaheadDecisionTrace {
  return {
    providerId: plan.providerId,
    surface: plan.surface,
    decision: plan.decision,
    safety: plan.safety,
    featureFamily: resolveFeatureFamilyForSurfacePlan(plan),
    contextSignature,
    ops: plan.ops,
    appended: renderAppendedSuffix(plan.ops),
    validation: plan.validation,
    downgrade:
      plan.decision === "surface-fallback" || plan.decision === "raw"
        ? {
            mode: plan.decision === "surface-fallback" ? "surface-fallback" : "raw",
            reason: plan.downgradeReason ?? "surface fallback",
          }
        : undefined,
    termination:
      plan.decision === "terminate" || plan.terminationReason
        ? {
            reason: plan.terminationReason ?? "unsupported-syntax",
            rearmWhen: plan.rearmWhen ?? "next-byte",
          }
        : undefined,
    debug: {
      strategy: plan.providerId,
      notes: plan.debugNotes,
    },
  };
}

function resolveFeatureFamilyForFormatPlan(plan: InlineFormatPlan): LookaheadFeatureFamily {
  switch (plan.surface) {
    case "math-inline": {
      const notes = new Set(plan.debugNotes);
      if (notes.has("unsupported optional-argument ambiguity")) return "math-optional-arg-local";
      if (notes.has("unsupported math environment")) return "math-environment-structured";
      if (notes.has("unsupported math alignment family")) return "math-alignment-structured";
      if (notes.has("unsupported \\left/\\right pair")) return "math-left-right-local";
      if (notes.has("tail-local \\right. completion")) return "math-left-right-local";
      if (notes.has("fill missing \\frac groups") || notes.has("fill missing \\sqrt group")) return "math-fixed-arity-local";
      return "math-local-core";
    }
    case "math-block": {
      const notes = new Set(plan.debugNotes);
      if (notes.has("unsupported optional-argument ambiguity")) return "math-optional-arg-local";
      if (notes.has("unsupported math environment")) return "math-environment-structured";
      if (notes.has("unsupported math alignment family")) return "math-alignment-structured";
      if (notes.has("unsupported \\left/\\right pair")) return "math-left-right-local";
      if (notes.has("tail-local \\right. completion")) return "math-left-right-local";
      if (notes.has("fill missing \\frac groups") || notes.has("fill missing \\sqrt group")) return "math-fixed-arity-local";
      return "math-display-local";
    }
    default:
      return "inline-core";
  }
}

function resolveFeatureFamilyForSurfacePlan(plan: SurfacePlan): LookaheadFeatureFamily {
  switch (plan.surface) {
    case "html-inline":
      return "html-inline-allowlist";
    case "html-block":
      return "html-block-conservative";
    case "mdx-tag":
      return "mdx-tag-shell";
    case "mdx-expression":
      return "mdx-expression-conservative";
    default:
      return "inline-core";
  }
}

function buildAnalysisForFormatPlan(plan: InlineFormatPlan, raw: string): LookaheadDecisionTrace["analysis"] | undefined {
  if (plan.surface !== "math-inline" && plan.surface !== "math-block") {
    return undefined;
  }
  const surface = plan.surface;
  return {
    math: buildMathTraceAnalysis(plan, raw, surface),
  };
}

function buildMathTraceAnalysis(
  plan: InlineFormatPlan,
  raw: string,
  surface: Extract<LookaheadSurface, "math-inline" | "math-block">,
): MathTraceAnalysis {
  return analyzeMathTailShadow({
    raw,
    surface,
    decision: plan.decision,
    ops: plan.ops,
    candidateId: plan.mathCandidateId,
    validation: plan.validation,
    notes: plan.debugNotes,
    downgradeReason: plan.downgradeReason,
  });
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

  const mathMode = hasIncompleteMathDisplay ? "display" : "inline";
  if (hasIncompleteMath) {
    return planMathLookahead(request.raw, hasIncompleteMathDisplay ? "math-block" : "math-inline", mathMode);
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

function planHtmlInline(request: LookaheadRequest, allowTags?: Iterable<string>): SurfacePlan {
  const candidate = parseTagCandidate(request.raw);
  if (!candidate || candidate.kind !== "html" || candidate.openEnd === -1) {
    return {
      providerId: "html-inline-provider",
      surface: "html-inline",
      decision: "surface-fallback",
      safety: "safe",
      ops: [],
      downgradeReason: "not a valid html-inline candidate",
      debugNotes: ["html candidate parse failed"],
    };
  }
  const allowedTags = normalizeStringAllowlist(allowTags);
  if (!allowedTags.has(candidate.tagNameLower) || isLikelyBlockTag(candidate.tagNameLower)) {
    return {
      providerId: "html-inline-provider",
      surface: "html-inline",
      decision: "terminate",
      safety: "safe",
      ops: [],
      terminationReason: "unsupported-syntax",
      rearmWhen: "container-change",
      debugNotes: ["tag not allowlisted for inline html repair"],
    };
  }
  const tail = request.raw.slice(candidate.openEnd);
  if (countNewlines(tail) > request.budgets.maxNewlines) {
    return {
      providerId: "html-inline-provider",
      surface: "html-inline",
      decision: "terminate",
      safety: "guarded",
      ops: [],
      terminationReason: "budget-newlines",
      rearmWhen: "newline-change",
      debugNotes: ["newline budget exceeded"],
    };
  }
  if (candidate.isSelfClosing || hasExplicitClosingTag(request.raw, candidate.tagName)) {
    return {
      providerId: "html-inline-provider",
      surface: "html-inline",
      decision: "accept-as-is",
      safety: "safe",
      ops: [],
      debugNotes: ["html tag already complete"],
    };
  }
  return {
    providerId: "html-inline-provider",
    surface: "html-inline",
    decision: "repair",
    safety: "guarded",
    ops: [{ kind: "close-tag", tagName: candidate.tagName }],
    debugNotes: ["tail-local inline html auto-close"],
  };
}

function planMdxTag(request: LookaheadRequest, allowComponents?: Iterable<string>): SurfacePlan {
  const candidate = parseTagCandidate(request.raw);
  if (!candidate || candidate.kind !== "mdx" || candidate.openEnd === -1) {
    return {
      providerId: "mdx-tag-provider",
      surface: "mdx-tag",
      decision: "surface-fallback",
      safety: "safe",
      ops: [],
      downgradeReason: "not a valid mdx-tag candidate",
      debugNotes: ["mdx tag candidate parse failed"],
    };
  }
  const allowlist = normalizeStringAllowlist(allowComponents);
  if (!allowlist.has(candidate.tagName)) {
    return {
      providerId: "mdx-tag-provider",
      surface: "mdx-tag",
      decision: "terminate",
      safety: "safe",
      ops: [],
      terminationReason: "unsupported-syntax",
      rearmWhen: "new-delimiter",
      debugNotes: ["component not allowlisted"],
    };
  }
  const tail = request.raw.slice(candidate.openEnd);
  if (countNewlines(tail) > request.budgets.maxNewlines) {
    return {
      providerId: "mdx-tag-provider",
      surface: "mdx-tag",
      decision: "terminate",
      safety: "guarded",
      ops: [],
      terminationReason: "budget-newlines",
      rearmWhen: "newline-change",
      debugNotes: ["newline budget exceeded"],
    };
  }
  if (hasExplicitClosingTag(request.raw, candidate.tagName) || candidate.isSelfClosing) {
    return {
      providerId: "mdx-tag-provider",
      surface: "mdx-tag",
      decision: "accept-as-is",
      safety: "safe",
      ops: [],
      debugNotes: ["mdx tag already complete"],
    };
  }
  if (tail.includes("{")) {
    return {
      providerId: "mdx-tag-provider",
      surface: "mdx-tag",
      decision: "terminate",
      safety: "guarded",
      ops: [],
      terminationReason: "unsafe-repair-required",
      rearmWhen: "next-byte",
      debugNotes: ["mixed mdx tag and expression ambiguity"],
    };
  }
  return {
    providerId: "mdx-tag-provider",
    surface: "mdx-tag",
    decision: "repair",
    safety: "guarded",
    ops: [{ kind: "self-close-tag" }],
    debugNotes: ["self-close bounded mdx tag opener"],
  };
}

function planMdxExpression(request: LookaheadRequest): SurfacePlan {
  const trimmed = request.raw.trimStart();
  if (!trimmed.startsWith("{")) {
    return {
      providerId: "mdx-expression-provider",
      surface: "mdx-expression",
      decision: "surface-fallback",
      safety: "safe",
      ops: [],
      downgradeReason: "not a valid mdx-expression candidate",
      debugNotes: ["mdx expression candidate parse failed"],
    };
  }
  if (countNewlines(request.raw) > request.budgets.maxNewlines) {
    return {
      providerId: "mdx-expression-provider",
      surface: "mdx-expression",
      decision: "terminate",
      safety: "guarded",
      ops: [],
      terminationReason: "budget-newlines",
      rearmWhen: "newline-change",
      debugNotes: ["newline budget exceeded"],
    };
  }
  if (/\}/.test(trimmed)) {
    return {
      providerId: "mdx-expression-provider",
      surface: "mdx-expression",
      decision: "accept-as-is",
      safety: "safe",
      ops: [],
      debugNotes: ["mdx expression already complete"],
    };
  }
  return {
    providerId: "mdx-expression-provider",
    surface: "mdx-expression",
    decision: "terminate",
    safety: "guarded",
    ops: [],
    terminationReason: "unsupported-syntax",
    downgradeReason: "mdx expression repair is deferred",
    rearmWhen: "new-delimiter",
    debugNotes: ["mdx expression hard-stop / fallback"],
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
        value = value.endsWith(">") ? `${value.slice(0, -1)}/>` : `${value} />`;
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
        appended += "/>";
        break;
      case "trim-tail":
        break;
      default:
        break;
    }
  }
  return appended;
}

function classifyMathRepair(
  raw: string,
  mode: "inline" | "display",
): MathRepairClassification {
  if (/(?:\\begin\{(?:align|aligned|eqnarray|gather|multline)\}|\\(?:align|aligned|eqnarray|gather|multline)\b)/.test(raw)) {
    return { kind: "unsupported", reason: "alignment math is deferred", notes: ["unsupported math alignment family"] };
  }
  if (/\\begin\{/.test(raw)) {
    return { kind: "unsupported", reason: "math environments are deferred", notes: ["unsupported math environment"] };
  }
  if (/&/.test(raw)) {
    return { kind: "unsupported", reason: "alignment math is deferred", notes: ["unsupported math alignment family"] };
  }
  if (/\\[A-Za-z]+\[[^\]]*$/.test(raw)) {
    return { kind: "unsupported", reason: "optional argument math repair is deferred", notes: ["unsupported optional-argument ambiguity"] };
  }
  const leftRightRepair = buildLeftRightNullRepairOps(raw, mode);
  if (leftRightRepair.kind === "unsupported") {
    return leftRightRepair;
  }
  if (leftRightRepair.ops.length > 0) {
    return { kind: "repair", ops: leftRightRepair.ops, notes: leftRightRepair.notes };
  }
  return { kind: "repair", ops: buildMathRepairOps(raw, mode), notes: mathRepairDebugNotes(raw, mode) };
}

function planMathLookahead(
  raw: string,
  surface: Extract<LookaheadSurface, "math-inline" | "math-block">,
  mode: "inline" | "display",
): InlineFormatPlan {
  const mathRepair = classifyMathRepair(raw, mode);
  if (mathRepair.kind === "unsupported") {
    return {
      surface,
      decision: "raw",
      safety: "safe",
      ops: [],
      mathCandidateId: "raw-fallback",
      validation: { valid: false, errors: [mathRepair.reason] },
      terminationReason: "unsupported-syntax",
      downgradeReason: mathRepair.reason,
      debugNotes: mathRepair.notes,
    };
  }

  const repaired = applyRepairOps(raw, mathRepair.ops);
  const validation = validateMathRepairCandidate(repaired, mode);
  const checkpoint = mode === "display" ? buildDisplayCheckpointCandidate(raw, mathRepair.notes) : null;
  const checkpointValidation =
    checkpoint ? validateMathRepairCandidate(applyRepairOps(raw, checkpoint.ops), mode) : undefined;

  if (checkpoint && checkpointValidation?.valid && (!validation.valid || checkpoint.preferOverFullRepair)) {
    return {
      surface,
      decision: "repair",
      safety: "safe",
      ops: checkpoint.ops,
      mathCandidateId: "checkpoint-candidate",
      validation: checkpointValidation,
      debugNotes: [...mathRepair.notes, ...checkpoint.notes],
    };
  }

  if (!validation.valid) {
    return {
      surface,
      decision: "raw",
      safety: "safe",
      ops: [],
      mathCandidateId: "raw-fallback",
      validation,
      terminationReason: "validation-failed",
      downgradeReason: validation.errors?.join("; ") ?? "math repair validation failed",
      debugNotes: [...mathRepair.notes, "repair validation failed"],
    };
  }

  return {
    surface,
    decision: "repair",
    safety: "safe",
    ops: mathRepair.ops,
    mathCandidateId: "repair-candidate",
    validation,
    debugNotes: mathRepair.notes,
  };
}

function validateMathRepairCandidate(repaired: string, mode: "inline" | "display"): { valid: boolean; errors?: string[] } {
  const mathContent = extractDelimitedMathContent(repaired, mode);
  const errors: string[] = [];
  const balance = scanDelimiterBalance(mathContent);
  if (balance.openBraces > 0) errors.push(`${balance.openBraces} unmatched opening brace(s)`);
  if (balance.openBrackets > 0) errors.push(`${balance.openBrackets} unmatched opening bracket(s)`);
  if (balance.openParens > 0) errors.push(`${balance.openParens} unmatched opening parenthesis(es)`);
  if (/(?:^|[^\\])(?:\^|_)$/.test(mathContent)) {
    errors.push("dangling script operator");
  }
  const trailingControlFragment = mathContent.match(/(?:\\[A-Za-z]+|\\)$/)?.[0];
  if (trailingControlFragment && !isAllowlistedCompleteControlWord(trailingControlFragment)) {
    errors.push(`incomplete control word: ${trailingControlFragment}`);
  }
  if (countMissingRequiredGroups(mathContent, "\\frac", 2) > 0) {
    errors.push("missing required \\frac group");
  }
  if (countMissingRequiredGroups(mathContent, "\\sqrt", 1) > 0) {
    errors.push("missing required \\sqrt group");
  }
  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

function extractDelimitedMathContent(repaired: string, mode: "inline" | "display"): string {
  if (mode === "display" && repaired.startsWith("$$") && repaired.endsWith("$$")) {
    return repaired.slice(2, -2).trim();
  }
  if (mode === "inline" && repaired.startsWith("$") && repaired.endsWith("$")) {
    return repaired.slice(1, -1).trim();
  }
  return repaired;
}

function buildMathRepairOps(raw: string, mode: "inline" | "display"): LookaheadRepairOp[] {
  const ops: LookaheadRepairOp[] = [];
  const trailingControlFragment = raw.match(/(?:\\[A-Za-z]+|\\)$/);
  if (trailingControlFragment) {
    const controlWord = trailingControlFragment[0];
    if (!isAllowlistedCompleteControlWord(controlWord)) {
      ops.push({ kind: "trim-tail", count: controlWord.length });
    }
  }

  const danglingOperator = raw.match(/(?:\^|_)$/);
  if (danglingOperator) {
    ops.push({ kind: "insert-empty-group" });
  }

  const missingFracGroups = countMissingRequiredGroups(raw, "\\frac", 2);
  for (let i = 0; i < missingFracGroups; i += 1) {
    ops.push({ kind: "insert-empty-group" });
  }
  const missingSqrtGroups = countMissingRequiredGroups(raw, "\\sqrt", 1);
  for (let i = 0; i < missingSqrtGroups; i += 1) {
    ops.push({ kind: "insert-empty-group" });
  }

  const balance = scanDelimiterBalance(raw);
  for (let i = 0; i < balance.openParens; i += 1) ops.push({ kind: "append", text: ")" });
  for (let i = 0; i < balance.openBrackets; i += 1) ops.push({ kind: "append", text: "]" });
  for (let i = 0; i < balance.openBraces; i += 1) ops.push({ kind: "append", text: "}" });
  if (mode === "display" && /[\r\n]/.test(raw) && !(raw.endsWith("\n") || raw.endsWith("\r"))) {
    ops.push({ kind: "append", text: "\n" });
  }
  ops.push(mode === "display" ? { kind: "close-delimiter", text: "$$" } : { kind: "close-delimiter", text: "$" });
  return ops;
}

function buildLeftRightNullRepairOps(
  raw: string,
  mode: "inline" | "display",
): MathRepairClassification {
  const leftCount = countCommandOccurrences(raw, "\\left");
  const rightCount = countCommandOccurrences(raw, "\\right");
  if (leftCount === 0 && rightCount === 0) {
    return { kind: "repair", ops: [], notes: [] };
  }
  if (rightCount > leftCount) {
    return { kind: "unsupported", reason: "left-right math repair is deferred", notes: ["unsupported \\left/\\right pair"] };
  }
  if (leftCount - rightCount !== 1 || leftCount > 1) {
    return { kind: "unsupported", reason: "left-right math repair is deferred", notes: ["unsupported \\left/\\right pair"] };
  }
  if (!/\\left\s*(?:[\(\[\{\|.]|\\[A-Za-z]+)/.test(raw)) {
    return { kind: "unsupported", reason: "left-right math repair is deferred", notes: ["unsupported \\left/\\right pair"] };
  }
  const ops: LookaheadRepairOp[] = [];
  const balance = scanDelimiterBalance(raw);
  // Do not synthesize ordinary paren/bracket closers here: the narrow V2A
  // contract closes a single dangling \left... pair with \right. only.
  for (let i = 0; i < balance.openBraces; i += 1) ops.push({ kind: "append", text: "}" });
  if (mode === "display" && /[\r\n]/.test(raw) && !(raw.endsWith("\n") || raw.endsWith("\r"))) {
    ops.push({ kind: "append", text: "\n" });
  }
  ops.push({ kind: "append", text: "\\right." });
  ops.push(mode === "display" ? { kind: "close-delimiter", text: "$$" } : { kind: "close-delimiter", text: "$" });
  return {
    kind: "repair",
    ops,
    notes: ["tail-local \\right. completion", "close unmatched tail delimiters", mode === "display" ? "close display math delimiter" : "close inline math delimiter"],
  };
}

function buildDisplayCheckpointCandidate(
  raw: string,
  notes: readonly string[],
): { ops: LookaheadRepairOp[]; notes: string[]; preferOverFullRepair: boolean } | null {
  if (!raw.startsWith("$$") || !/[\r\n]/.test(raw)) {
    return null;
  }
  if (notes.includes("tail-local \\right. completion")) {
    return null;
  }

  const body = raw.slice(2);
  const lastNewline = body.lastIndexOf("\n");
  if (lastNewline <= 0) {
    return null;
  }

  const checkpointBody = body.slice(0, lastNewline);
  const trailingLine = body.slice(lastNewline + 1);
  if (!checkpointBody.trim() || !trailingLine.trim()) {
    return null;
  }
  if (!isUnstableDisplayTail(trailingLine)) {
    return null;
  }

  const checkpointRaw = `$$${checkpointBody}`;
  const trimCount = raw.length - checkpointRaw.length;
  if (trimCount <= 0) {
    return null;
  }

  const ops: LookaheadRepairOp[] = [{ kind: "trim-tail", count: trimCount }];
  if (!(checkpointRaw.endsWith("\n") || checkpointRaw.endsWith("\r"))) {
    ops.push({ kind: "append", text: "\n" });
  }
  ops.push({ kind: "close-delimiter", text: "$$" });

  return {
    ops,
    notes: ["select display-local checkpoint candidate", "close display math delimiter"],
    preferOverFullRepair: true,
  };
}

function isUnstableDisplayTail(raw: string): boolean {
  const trimmed = raw.trimEnd();
  if (!trimmed) return false;
  const balance = scanDelimiterBalance(trimmed);
  if (balance.openParens > 0 || balance.openBrackets > 0 || balance.openBraces > 0) {
    return true;
  }
  const trailingControlWord = trimmed.match(/(?:\\[A-Za-z]+|\\)$/)?.[0];
  if (trailingControlWord && !isAllowlistedCompleteControlWord(trailingControlWord)) {
    return true;
  }
  if (/(?:^|[^\\])(?:\^|_)$/.test(trimmed)) {
    return true;
  }
  if (countMissingRequiredGroups(trimmed, "\\frac", 2) > 0) {
    return true;
  }
  if (countMissingRequiredGroups(trimmed, "\\sqrt", 1) > 0) {
    return true;
  }
  return false;
}

function mathRepairDebugNotes(raw: string, mode: "inline" | "display"): string[] {
  const notes: string[] = [];
  if (/(?:\\[A-Za-z]+|\\)$/.test(raw)) notes.push("trim trailing control-word fragment");
  if (/(?:\^|_)$/.test(raw)) notes.push("insert empty group for dangling script operator");
  if (countMissingRequiredGroups(raw, "\\frac", 2) > 0) notes.push("fill missing \\frac groups");
  if (countMissingRequiredGroups(raw, "\\sqrt", 1) > 0) notes.push("fill missing \\sqrt group");
  const balance = scanDelimiterBalance(raw);
  if (balance.openParens || balance.openBrackets || balance.openBraces) notes.push("close unmatched tail delimiters");
  notes.push(mode === "display" ? "close display math delimiter" : "close inline math delimiter");
  return notes;
}

function countMissingRequiredGroups(raw: string, command: string, requiredGroups: number): number {
  if (!raw.includes(command)) return 0;
  const lastIndex = raw.lastIndexOf(command);
  if (lastIndex === -1) return 0;
  const suffix = raw.slice(lastIndex + command.length);
  let groups = 0;
  for (let i = 0; i < suffix.length; i += 1) {
    if (suffix[i] === "{") groups += 1;
  }
  return Math.max(0, requiredGroups - groups);
}

function scanDelimiterBalance(raw: string): { openBraces: number; openBrackets: number; openParens: number } {
  let openBraces = 0;
  let openBrackets = 0;
  let openParens = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "{") openBraces += 1;
    else if (char === "}") openBraces = Math.max(0, openBraces - 1);
    else if (char === "[") openBrackets += 1;
    else if (char === "]") openBrackets = Math.max(0, openBrackets - 1);
    else if (char === "(") openParens += 1;
    else if (char === ")") openParens = Math.max(0, openParens - 1);
  }
  return { openBraces, openBrackets, openParens };
}

function isAllowlistedCompleteControlWord(controlWord: string): boolean {
  return (
    controlWord === "\\frac" ||
    controlWord === "\\sqrt" ||
    controlWord === "\\sum" ||
    controlWord === "\\prod" ||
    controlWord === "\\int" ||
    controlWord === "\\left" ||
    controlWord === "\\right"
  );
}

function countCommandOccurrences(raw: string, command: string): number {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw.match(new RegExp(escaped, "g"))?.length ?? 0;
}

type TagCandidate =
  | { kind: "html" | "mdx"; tagName: string; tagNameLower: string; openEnd: number; isSelfClosing: boolean }
  | null;

function parseTagCandidate(raw: string): TagCandidate {
  const match = raw.match(/^<([A-Za-z][\w:-]*)([^<>]*?)\/?>/);
  if (!match) return null;
  const tagName = match[1] ?? "";
  const openEnd = match[0]?.length ?? -1;
  return {
    kind: isLikelyMdxComponent(tagName) ? "mdx" : "html",
    tagName,
    tagNameLower: tagName.toLowerCase(),
    openEnd,
    isSelfClosing: match[0].endsWith("/>"),
  };
}

function hasExplicitClosingTag(raw: string, tagName: string): boolean {
  return new RegExp(`</\\s*${escapeRegExp(tagName)}\\s*>`, "i").test(raw);
}

function normalizeStringAllowlist(value?: Iterable<string>): Set<string> {
  const set = new Set<string>();
  if (!value) return set;
  for (const entry of value) {
    if (entry) set.add(entry);
    if (entry) set.add(entry.toLowerCase());
  }
  return set;
}

function isLikelyBlockTag(tagNameLower: string): boolean {
  return new Set(["div", "section", "article", "aside", "header", "footer", "main", "nav", "p", "ul", "ol", "li", "table"]).has(
    tagNameLower,
  );
}

function countNewlines(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLikelyMdxComponent(tagName: string): boolean {
  const first = tagName.charAt(0);
  return first.toUpperCase() === first && first.toLowerCase() !== first;
}
