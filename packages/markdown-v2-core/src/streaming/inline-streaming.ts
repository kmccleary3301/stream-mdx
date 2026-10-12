import type { FormatAnticipationConfig } from "../types";
import type {
  LookaheadContainerContext,
  LookaheadDecisionTrace,
  LookaheadBudgets,
  LookaheadRepairOp,
  LookaheadRequest,
} from "./lookahead-contract";
import { planInlineFormat, planRegexLookahead, traceFromFormatPlan, traceFromRegexPlan } from "./inline-format-policy";
import { planHtmlInline, planMdxTag, planMdxExpression, traceFromPlan } from "./mixed-tag-policy";
import { applyRepairOps, renderAppendedSuffix } from "./lookahead-repair";

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
} as const satisfies LookaheadBudgets;


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
  if (anticipation.regex && (context.provisional || content.length <= request.budgets.maxScanChars)) {
    const regexPlan = planRegexLookahead(options?.regexAppend ?? null, request, repairOps);
    traces.push(traceFromRegexPlan(regexPlan, context.containerSignature));
    if (regexPlan.decision === "raw") {
      return { prepared: { kind: "raw", status: "raw", reason: "incomplete-formatting" }, trace: traces, container: context };
    }
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

