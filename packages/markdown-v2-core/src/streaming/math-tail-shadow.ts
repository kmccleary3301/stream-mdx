import type { LookaheadDecisionTrace, LookaheadRepairOp, LookaheadSurface } from "./lookahead-contract";

type MathTraceAnalysis = NonNullable<NonNullable<LookaheadDecisionTrace["analysis"]>["math"]>;

export type MathShadowAnalysisInput = {
  raw: string;
  surface: Extract<LookaheadSurface, "math-inline" | "math-block">;
  decision: LookaheadDecisionTrace["decision"];
  ops: readonly LookaheadRepairOp[];
  validation?: { valid: boolean; errors?: string[] };
  notes: readonly string[];
  downgradeReason?: string;
};

export function analyzeMathTailShadow(input: MathShadowAnalysisInput): MathTraceAnalysis {
  const raw = input.raw;
  const mode = input.surface === "math-block" ? "display" : "inline";
  const family = classifyMathFamily(raw, input.surface, input.notes);
  const unsupportedReason = resolveUnsupportedReason(input.notes, input.downgradeReason);

  return {
    mode,
    family,
    unsupportedReason,
    tokens: buildMathTokens(raw, family),
    obligations: buildMathObligations(input.ops, input.notes, input.validation, unsupportedReason),
    checkpoints: buildMathCheckpoints(input.decision, input.validation, unsupportedReason),
    selectedCandidate: input.decision === "repair" ? "repaired" : "raw",
  };
}

function classifyMathFamily(
  raw: string,
  surface: Extract<LookaheadSurface, "math-inline" | "math-block">,
  notes: readonly string[],
): MathTraceAnalysis["family"] {
  const noteSet = new Set(notes);

  if (/(?:\\begin\{(?:align|aligned|eqnarray|gather|multline)\}|\\(?:align|aligned|eqnarray|gather|multline)\b)/.test(raw)) {
    return "alignment-structured";
  }

  if (
    noteSet.has("unsupported math environment") ||
    /\\begin\{[^}]+\}/.test(raw) ||
    /\\end\{[^}]+\}/.test(raw)
  ) {
    return "environment-structured";
  }

  if (noteSet.has("unsupported \\left/\\right pair") || /\\left\b|\\right\b/.test(raw)) {
    return "left-right-local";
  }

  if (noteSet.has("unsupported optional-argument ambiguity") || /\\[A-Za-z]+\[[^\]]*$/.test(raw)) {
    return "optional-arg-local";
  }

  if (/\\(?:frac|sqrt)\b/.test(raw)) {
    return "fixed-arity-local";
  }

  if (surface === "math-block" && /[\r\n]/.test(raw)) {
    return "display-local";
  }

  return "local-core";
}

function resolveUnsupportedReason(notes: readonly string[], downgradeReason?: string): string | undefined {
  const noteSet = new Set(notes);
  if (noteSet.has("unsupported math environment")) return downgradeReason ?? "math environments are deferred";
  if (noteSet.has("unsupported \\left/\\right pair")) return downgradeReason ?? "left-right math repair is deferred";
  if (noteSet.has("unsupported optional-argument ambiguity")) return downgradeReason ?? "optional argument math repair is deferred";
  return downgradeReason;
}

function buildMathTokens(raw: string, family: MathTraceAnalysis["family"]): NonNullable<MathTraceAnalysis["tokens"]> {
  const tokens: NonNullable<MathTraceAnalysis["tokens"]> = [];
  tokens.push({ kind: raw.startsWith("$$") ? "display-open" : "inline-open", text: raw.startsWith("$$") ? "$$" : "$" });

  if (family === "environment-structured") {
    tokens.push({ kind: "begin-env", text: raw.match(/\\begin\{[^}]+\}/)?.[0] ?? "unsupported math environment" });
  } else if (family === "alignment-structured") {
    tokens.push({ kind: "alignment-op", text: raw.match(/\\(?:align|aligned|eqnarray|gather|multline)\b/)?.[0] ?? "alignment" });
  } else if (family === "left-right-local") {
    if (/\\left\b/.test(raw)) tokens.push({ kind: "left", text: raw.match(/\\left\b/)?.[0] ?? "\\left" });
    if (/\\right\b/.test(raw)) tokens.push({ kind: "right", text: raw.match(/\\right\b/)?.[0] ?? "\\right" });
  } else if (family === "optional-arg-local") {
    tokens.push({ kind: "optional-arg-open", text: raw.match(/\\[A-Za-z]+\[/)?.[0] ?? "optional-arg" });
  } else if (family === "fixed-arity-local") {
    const command = raw.match(/\\(?:frac|sqrt)\b/)?.[0];
    if (command) tokens.push({ kind: "command", text: command });
  }

  const trailingControlWord = raw.match(/\\[A-Za-z]+$/)?.[0];
  if (trailingControlWord) {
    tokens.push({ kind: "control-word-tail", text: trailingControlWord });
  }

  return tokens;
}

function buildMathObligations(
  ops: readonly LookaheadRepairOp[],
  notes: readonly string[],
  validation: MathShadowAnalysisInput["validation"],
  unsupportedReason?: string,
): NonNullable<MathTraceAnalysis["obligations"]> {
  const obligations: NonNullable<MathTraceAnalysis["obligations"]> = [];
  const noteSet = new Set(notes);

  if (unsupportedReason) {
    obligations.push({ kind: "unsupported-family", detail: unsupportedReason });
  }
  if (ops.some((op) => op.kind === "trim-tail")) {
    obligations.push({ kind: "trim-tail", detail: "trim incomplete trailing control word" });
  }
  const emptyGroups = ops.filter((op) => op.kind === "insert-empty-group").length;
  if (emptyGroups > 0) {
    obligations.push({ kind: "missing-group", detail: `insert ${emptyGroups} empty group(s)` });
  }
  const closeDelimiters = ops.filter((op) => op.kind === "close-delimiter" || op.kind === "append");
  if (closeDelimiters.length > 0) {
    obligations.push({ kind: "close-delimiter", detail: `append ${closeDelimiters.length} delimiter/balance op(s)` });
  }
  if (noteSet.has("close unmatched tail delimiters")) {
    obligations.push({ kind: "balance-tail", detail: "close unmatched tail delimiters" });
  }
  if (noteSet.has("fill missing \\frac groups")) {
    obligations.push({ kind: "missing-group", detail: "fill missing \\frac groups" });
  }
  if (noteSet.has("fill missing \\sqrt group")) {
    obligations.push({ kind: "missing-group", detail: "fill missing \\sqrt group" });
  }
  if (validation && !validation.valid) {
    obligations.push({ kind: "validate", detail: validation.errors?.join("; ") ?? "validation failed" });
  }

  return obligations;
}

function buildMathCheckpoints(
  decision: LookaheadDecisionTrace["decision"],
  validation: MathShadowAnalysisInput["validation"],
  unsupportedReason?: string,
): NonNullable<MathTraceAnalysis["checkpoints"]> {
  return [
    {
      label: unsupportedReason ? "unsupported-family" : "current-plan",
      accepted: decision === "repair" || decision === "accept-as-is",
      reason:
        unsupportedReason ??
        (validation && !validation.valid ? validation.errors?.join("; ") ?? "validation failed" : undefined),
    },
  ];
}
