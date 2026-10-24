import type { LookaheadDecisionTrace, LookaheadFeatureFamily, LookaheadRepairOp, LookaheadRequest, LookaheadSurface, LookaheadTerminationReason } from "./lookahead-contract";
import { renderAppendedSuffix } from "./lookahead-repair";
import { LookaheadBudget } from "./lookahead-budget";

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

export function traceFromPlan(plan: SurfacePlan, contextSignature: string): LookaheadDecisionTrace {
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

export function planHtmlInline(request: LookaheadRequest, allowTags?: Iterable<string>): SurfacePlan {
  const budget = new LookaheadBudget(request.budgets);
  const oversized = oversizedPlan(request, "html-inline-provider");
  if (oversized) return oversized;
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
  const failure = budget.checkInput(request.raw) ?? budget.checkDepth(tagNestingDepth(request.raw)) ?? budget.checkOps([{ kind: "close-tag", tagName: candidate.tagName }]);
  if (failure) return budgetFallback(request.surface, "html-inline-provider", failure);
  return {
    providerId: "html-inline-provider",
    surface: "html-inline",
    decision: "repair",
    safety: "guarded",
    ops: [{ kind: "close-tag", tagName: candidate.tagName }],
    debugNotes: ["tail-local inline html auto-close"],
  };
}

export function planMdxTag(request: LookaheadRequest, allowComponents?: Iterable<string>): SurfacePlan {
  const budget = new LookaheadBudget(request.budgets);
  const oversized = oversizedPlan(request, "mdx-tag-provider");
  if (oversized) return oversized;
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
  const failure = budget.checkInput(request.raw) ?? budget.checkDepth(tagNestingDepth(request.raw)) ?? budget.checkOps([{ kind: "self-close-tag" }]);
  if (failure) return budgetFallback(request.surface, "mdx-tag-provider", failure);
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

export function planMdxExpression(request: LookaheadRequest): SurfacePlan {
  const budget = new LookaheadBudget(request.budgets);
  const oversized = oversizedPlan(request, "mdx-expression-provider");
  if (oversized) return oversized;
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
  const failure = budget.checkInput(request.raw);
  if (failure) return budgetFallback(request.surface, "mdx-expression-provider", failure);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLikelyMdxComponent(tagName: string): boolean {
  const first = tagName.charAt(0);
  return first.toUpperCase() === first && first.toLowerCase() !== first;
}

function budgetFallback(surface: LookaheadSurface, providerId: string, reason: LookaheadTerminationReason): SurfacePlan {
  return {
    surface,
    providerId,
    decision: "raw",
    safety: "guarded",
    ops: [],
    terminationReason: reason,
    downgradeReason: `lookahead ${reason} exhausted`,
    debugNotes: [`lookahead ${reason} exhausted`],
  };
}

function tagNestingDepth(raw: string): number {
  let depth = 0;
  let maximum = 0;
  for (const match of raw.matchAll(/<\/?[A-Za-z][^<>]*>/g)) {
    const tag = match[0];
    if (tag.startsWith("</")) depth = Math.max(0, depth - 1);
    else if (!tag.endsWith("/>")) depth += 1;
    maximum = Math.max(maximum, depth);
  }
  return maximum;
}

function oversizedPlan(request: LookaheadRequest, providerId: string): SurfacePlan | undefined {
  if (request.raw.length <= request.budgets.maxScanChars) return undefined;
  if (request.context.provisional) {
    return budgetFallback(request.surface, providerId, "budget-chars");
  }
  return {
    surface: request.surface, providerId, decision: "accept-as-is", safety: "safe", ops: [],
    debugNotes: [request.surface === "html-inline" ? "html tag already complete" :
      request.surface === "mdx-tag" ? "mdx tag already complete" : "mdx expression already complete"],
  };
}
