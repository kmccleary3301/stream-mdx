export type LookaheadSurface =
  | "inline-format"
  | "regex"
  | "math-inline"
  | "math-block"
  | "html-inline"
  | "html-block"
  | "mdx-tag"
  | "mdx-expression";

export type LookaheadSafety = "safe" | "guarded" | "unsafe";

export type LookaheadDecision =
  | "accept-as-is"
  | "repair"
  | "safe-prefix"
  | "surface-fallback"
  | "raw"
  | "terminate";

export type LookaheadTerminationReason =
  | "budget-chars"
  | "budget-newlines"
  | "budget-nesting"
  | "budget-steps"
  | "validation-failed"
  | "no-progress"
  | "unsupported-syntax"
  | "container-instability"
  | "protected-range-conflict"
  | "unsafe-repair-required"
  | "surface-mismatch";

export type LookaheadDowngradeMode = "raw" | "safe-prefix" | "surface-fallback";

export type LookaheadSupportStatus = "implemented" | "bounded" | "hard-stop-only" | "deferred";

export type LookaheadFeatureFamily =
  | "inline-core"
  | "regex-core"
  | "math-local-core"
  | "math-fixed-arity-local"
  | "math-left-right-local"
  | "math-display-local"
  | "math-optional-arg-local"
  | "math-environment-structured"
  | "math-alignment-structured"
  | "html-inline-allowlist"
  | "html-block-conservative"
  | "mdx-tag-shell"
  | "mdx-expression-conservative";

export type LookaheadSmokeStatus = "promoted" | "eligible" | "targeted-only" | "never";

export interface LookaheadSupportDescriptor {
  surface: LookaheadSurface;
  status: LookaheadSupportStatus;
  smokeEligible: boolean;
  smokePromoted: boolean;
  notes: readonly string[];
}

export interface LookaheadFeatureRegistryEntry {
  id: string;
  surface: LookaheadSurface;
  featureFamily: LookaheadFeatureFamily;
  status: LookaheadSupportStatus;
  smoke: LookaheadSmokeStatus;
  notes: readonly string[];
}

export const LOOKAHEAD_SUPPORT_MATRIX: readonly LookaheadSupportDescriptor[] = [
  {
    surface: "inline-format",
    status: "implemented",
    smokeEligible: true,
    smokePromoted: false,
    notes: ["delimiter closure for emphasis, strong, strike, and inline code"],
  },
  {
    surface: "regex",
    status: "implemented",
    smokeEligible: false,
    smokePromoted: false,
    notes: ["adapter around bounded regex append logic"],
  },
  {
    surface: "math-inline",
    status: "bounded",
    smokeEligible: true,
    smokePromoted: true,
    notes: [
      "supports trailing control-word trim, dangling script repair, bounded delimiter closure, and missing groups for \\frac/\\sqrt",
      "unsupported families hard-stop / fallback",
    ],
  },
  {
    surface: "math-block",
    status: "bounded",
    smokeEligible: true,
    smokePromoted: false,
    notes: [
      "same bounded subset as inline math when repair remains tail-local and validates cleanly",
      "unsupported environments, optional arguments, and left/right families hard-stop / fallback",
    ],
  },
  {
    surface: "html-inline",
    status: "bounded",
    smokeEligible: true,
    smokePromoted: true,
    notes: ["allowlisted inline-tag auto-close only", "newline and ambiguity budgets terminate conservatively"],
  },
  {
    surface: "html-block",
    status: "hard-stop-only",
    smokeEligible: false,
    smokePromoted: false,
    notes: ["block-style html remains conservative; no speculative block capture"],
  },
  {
    surface: "mdx-tag",
    status: "bounded",
    smokeEligible: true,
    smokePromoted: true,
    notes: ["allowlisted inline mdx tag self-close only", "mixed expression ambiguity terminates conservatively"],
  },
  {
    surface: "mdx-expression",
    status: "hard-stop-only",
    smokeEligible: false,
    smokePromoted: false,
    notes: ["explicit hard-stop / fallback policy for V1", "no broad expression healing or child synthesis"],
  },
] as const;

export const LOOKAHEAD_SUPPORT_MATRIX_BY_SURFACE: Readonly<Record<LookaheadSurface, LookaheadSupportDescriptor>> = Object.freeze(
  Object.fromEntries(LOOKAHEAD_SUPPORT_MATRIX.map((entry) => [entry.surface, entry])) as Record<LookaheadSurface, LookaheadSupportDescriptor>,
);

export const LOOKAHEAD_FEATURE_REGISTRY: readonly LookaheadFeatureRegistryEntry[] = [
  {
    id: "inline-core",
    surface: "inline-format",
    featureFamily: "inline-core",
    status: "implemented",
    smoke: "eligible",
    notes: ["delimiter closure for emphasis, strong, strike, and inline code"],
  },
  {
    id: "regex-core",
    surface: "regex",
    featureFamily: "regex-core",
    status: "implemented",
    smoke: "targeted-only",
    notes: ["adapter around bounded regex append logic"],
  },
  {
    id: "math-local-core",
    surface: "math-inline",
    featureFamily: "math-local-core",
    status: "bounded",
    smoke: "promoted",
    notes: ["tail control-word trim, scripts, delimiter closure, and bounded local math repair"],
  },
  {
    id: "math-fixed-arity-local-inline",
    surface: "math-inline",
    featureFamily: "math-fixed-arity-local",
    status: "bounded",
    smoke: "promoted",
    notes: ["allowlisted missing-group repair for \\frac and \\sqrt in inline math"],
  },
  {
    id: "math-fixed-arity-local-block",
    surface: "math-block",
    featureFamily: "math-fixed-arity-local",
    status: "bounded",
    smoke: "eligible",
    notes: ["same allowlisted missing-group repair when display math remains local and validates"],
  },
  {
    id: "math-display-local",
    surface: "math-block",
    featureFamily: "math-display-local",
    status: "bounded",
    smoke: "eligible",
    notes: ["bounded display math when repair remains tail-local and validation-safe"],
  },
  {
    id: "math-left-right-local",
    surface: "math-inline",
    featureFamily: "math-left-right-local",
    status: "deferred",
    smoke: "never",
    notes: ["post-V1 candidate for narrow null-delimiter completion only"],
  },
  {
    id: "math-left-right-local-block",
    surface: "math-block",
    featureFamily: "math-left-right-local",
    status: "deferred",
    smoke: "never",
    notes: ["post-V1 candidate for narrow null-delimiter completion in display math"],
  },
  {
    id: "math-optional-arg-local",
    surface: "math-inline",
    featureFamily: "math-optional-arg-local",
    status: "deferred",
    smoke: "never",
    notes: ["optional-argument repair remains a post-V1 decision gate"],
  },
  {
    id: "math-environment-structured",
    surface: "math-block",
    featureFamily: "math-environment-structured",
    status: "hard-stop-only",
    smoke: "never",
    notes: ["environments classify and terminate conservatively"],
  },
  {
    id: "math-alignment-structured",
    surface: "math-block",
    featureFamily: "math-alignment-structured",
    status: "hard-stop-only",
    smoke: "never",
    notes: ["alignment-like structures remain unsupported and targeted-only"],
  },
  {
    id: "html-inline-allowlist",
    surface: "html-inline",
    featureFamily: "html-inline-allowlist",
    status: "bounded",
    smoke: "promoted",
    notes: ["allowlisted inline tag auto-close only"],
  },
  {
    id: "html-block-conservative",
    surface: "html-block",
    featureFamily: "html-block-conservative",
    status: "hard-stop-only",
    smoke: "targeted-only",
    notes: ["block HTML remains conservative and non-optimistic"],
  },
  {
    id: "mdx-tag-shell",
    surface: "mdx-tag",
    featureFamily: "mdx-tag-shell",
    status: "bounded",
    smoke: "promoted",
    notes: ["bounded allowlisted inline shell preview only"],
  },
  {
    id: "mdx-expression-conservative",
    surface: "mdx-expression",
    featureFamily: "mdx-expression-conservative",
    status: "hard-stop-only",
    smoke: "targeted-only",
    notes: ["hard-stop / fallback only; no broad expression healing"],
  },
] as const;

export type LookaheadRepairOp =
  | { kind: "append"; text: string }
  | { kind: "trim-tail"; count: number }
  | { kind: "insert-empty-group" }
  | { kind: "close-tag"; tagName: string }
  | { kind: "self-close-tag" }
  | { kind: "close-delimiter"; text: string };

export interface LookaheadContainerContext {
  blockType: string;
  ancestorTypes: readonly string[];
  listDepth: number;
  blockquoteDepth: number;
  insideHtml: boolean;
  insideMdx: boolean;
  segmentOrigin: "direct-inline" | "mixed-content";
  mixedSegmentKind?: "text" | "html" | "mdx";
  provisional: boolean;
  localTextField?: string;
  containerSignature: string;
}

export interface LookaheadBudgets {
  maxScanChars: number;
  maxNewlines: number;
  maxSyntheticOps: number;
  maxNestingDepth: number;
  maxValidationFailures: number;
  maxProviderMs: number;
}

export interface LookaheadRequest {
  surface: LookaheadSurface;
  raw: string;
  absoluteRange: { start: number; end: number };
  context: LookaheadContainerContext;
  budgets: LookaheadBudgets;
  previousAttempt?: {
    decision: LookaheadDecision;
    terminationReason?: LookaheadTerminationReason;
    validationFailures: number;
  };
}

export interface LookaheadPlan {
  providerId: string;
  decision: LookaheadDecision;
  safety: LookaheadSafety;
  ops: readonly LookaheadRepairOp[];
  parseMode: { kind: "full" } | { kind: "safe-prefix"; length: number };
  downgrade?: {
    mode: LookaheadDowngradeMode;
    reason: string;
  };
  termination?: {
    reason: LookaheadTerminationReason;
    rearmWhen: "next-byte" | "new-delimiter" | "newline-change" | "container-change" | "finalization";
  };
  debug?: {
    strategy: string;
    notes?: string[];
  };
}

export interface LookaheadProvider {
  id: string;
  surface: LookaheadSurface;
  priority: number;
  maxSafety: LookaheadSafety;
  supports(req: LookaheadRequest): boolean;
  plan(req: LookaheadRequest): LookaheadPlan;
}

export interface LookaheadDecisionTrace {
  providerId: string;
  surface: LookaheadSurface;
  decision: LookaheadDecision;
  safety: LookaheadSafety;
  featureFamily?: LookaheadFeatureFamily;
  contextSignature?: string;
  ops?: readonly LookaheadRepairOp[];
  appended?: string;
  validation?: {
    valid: boolean;
    errors?: string[];
  };
  analysis?: {
    math?: {
      mode: "inline" | "display";
      family:
        | "local-core"
        | "fixed-arity-local"
        | "left-right-local"
        | "optional-arg-local"
        | "display-local"
        | "environment-structured"
        | "alignment-structured"
        | "unknown";
      unsupportedReason?: string;
      tokens?: Array<{
        kind:
          | "control-word"
          | "brace-open"
          | "brace-close"
          | "bracket-open"
          | "bracket-close"
          | "paren-open"
          | "paren-close"
          | "script-op"
          | "left"
          | "right"
          | "begin-env"
          | "end-env"
          | "align-sep"
          | "text";
        text: string;
      }>;
      obligations?: Array<{
        kind: "close-group" | "fill-required-arg" | "fill-script" | "close-math-fence" | "unsupported-family";
        detail: string;
      }>;
      checkpoints?: Array<{
        label: string;
        accepted: boolean;
      }>;
      selectedCandidate?: "full" | "checkpoint" | "raw";
    };
  };
  downgrade?: LookaheadPlan["downgrade"];
  termination?: LookaheadPlan["termination"];
  debug?: LookaheadPlan["debug"];
}

export interface LookaheadTraceFocus {
  surface?: LookaheadSurface;
  featureFamily?: LookaheadFeatureFamily;
  pattern?: string;
  startOffset?: number;
  windowBefore?: number;
  windowAfter?: number;
}

export interface LookaheadTraceStep {
  stepIndex: number;
  mode: "chunk" | "char";
  prefixLength: number;
  rawInput: string;
  focus?: LookaheadTraceFocus;
  htmlPath?: string;
  telemetryPath?: string;
  decisionSummary?: {
    totalDecisions: number;
    providerCounts: Record<string, number>;
    surfaceCounts: Record<string, number>;
    featureFamilyCounts: Record<string, number>;
    terminationCounts: Record<string, number>;
    downgradeCounts: Record<string, number>;
    blocksWithNoDecision: string[];
  };
  diffFromPrevious?: {
    rawDeltaChars: number;
    htmlChanged: boolean;
    blockIdsChanged: string[];
    firstDecisionChangeBlockId: string | null;
  };
  state?: Record<string, unknown>;
  blocks?: Array<{
    id: string;
    type: string;
    isFinalized: boolean;
    rawLength: number;
    inlineStatus?: unknown;
    inlineContainerSignature?: string;
    inlineLookaheadInvalidated?: string;
    inlineLookahead?: LookaheadDecisionTrace[];
    mixedLookahead?: LookaheadDecisionTrace[];
    mixedSegmentKinds?: string[];
  }>;
}
