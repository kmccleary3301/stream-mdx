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
  contextSignature?: string;
  ops?: readonly LookaheadRepairOp[];
  appended?: string;
  validation?: {
    valid: boolean;
    errors?: string[];
  };
  downgrade?: LookaheadPlan["downgrade"];
  termination?: LookaheadPlan["termination"];
  debug?: LookaheadPlan["debug"];
}

export interface LookaheadTraceStep {
  stepIndex: number;
  mode: "chunk" | "char";
  prefixLength: number;
  rawInput: string;
  htmlPath?: string;
  telemetryPath?: string;
  decisionSummary?: {
    totalDecisions: number;
    providerCounts: Record<string, number>;
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
