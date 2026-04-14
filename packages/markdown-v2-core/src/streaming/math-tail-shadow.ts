import type { LookaheadDecision, LookaheadDecisionTrace, LookaheadRepairOp, LookaheadSurface } from "./lookahead-contract";

type MathTraceAnalysis = NonNullable<NonNullable<LookaheadDecisionTrace["analysis"]>["math"]>;

export type MathShadowAnalysisInput = {
  raw: string;
  surface: Extract<LookaheadSurface, "math-inline" | "math-block">;
  decision: LookaheadDecision;
  ops: readonly LookaheadRepairOp[];
  candidateId?: "repair-candidate" | "checkpoint-candidate" | "raw-fallback" | "null-right-candidate";
  validation?: { valid: boolean; errors?: string[] };
  notes: readonly string[];
  downgradeReason?: string;
};

export type MathTailShadowReport = {
  analysis: MathTraceAnalysis;
  candidates: NonNullable<MathTraceAnalysis["candidates"]>;
  preferredCandidateId: string;
};

export function analyzeMathTailShadowReport(input: MathShadowAnalysisInput): MathTailShadowReport {
  const raw = input.raw;
  const mode = input.surface === "math-block" ? "display" : "inline";
  const family = classifyMathFamily(raw, input.surface, input.notes);
  const unsupportedReason = resolveUnsupportedReason(input.notes, input.downgradeReason, family);
  const liveCandidateId = input.candidateId ?? (input.decision === "repair" ? "repair-candidate" : "raw-fallback");
  const candidates = buildCandidates(raw, family, input, liveCandidateId);
  const preferredCandidate = candidates.find((entry) => entry.accepted) ?? candidates[candidates.length - 1]!;

  return {
    analysis: {
      mode,
      family,
      unsupportedReason,
      tokens: buildMathTokens(raw, family),
      obligations: buildMathObligations(input.ops, input.notes, input.validation, unsupportedReason),
      checkpoints: buildMathCheckpoints(input.decision, input.validation, unsupportedReason, family, candidates),
      candidates,
      comparison: {
        liveDecision: input.decision,
        preferredCandidate: preferredCandidate.id,
        differsFromLive: liveCandidateId !== preferredCandidate.id,
      },
      selectedCandidate: mapSelectedCandidate(liveCandidateId),
    },
    candidates,
    preferredCandidateId: preferredCandidate.id,
  };
}

export function analyzeMathTailShadow(input: MathShadowAnalysisInput): MathTraceAnalysis {
  return analyzeMathTailShadowReport(input).analysis;
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

  if (/&/.test(raw)) {
    return "alignment-structured";
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

function resolveUnsupportedReason(
  notes: readonly string[],
  downgradeReason: string | undefined,
  family: MathTraceAnalysis["family"],
): string | undefined {
  const noteSet = new Set(notes);
  if (noteSet.has("unsupported math environment")) {
    return downgradeReason ?? "math environments are deferred";
  }
  if (noteSet.has("unsupported math alignment family")) {
    return downgradeReason ?? "alignment math is deferred";
  }
  if (noteSet.has("unsupported \\left/\\right pair")) {
    return downgradeReason ?? "left-right math repair is deferred";
  }
  if (noteSet.has("unsupported optional-argument ambiguity")) {
    return downgradeReason ?? "optional argument math repair is deferred";
  }
  if (family === "environment-structured" && downgradeReason) {
    return downgradeReason;
  }
  if (family === "alignment-structured" && downgradeReason) {
    return downgradeReason;
  }
  if (family === "left-right-local" && downgradeReason) {
    return downgradeReason;
  }
  if (family === "optional-arg-local" && downgradeReason) {
    return downgradeReason;
  }
  return downgradeReason;
}

function buildMathTokens(raw: string, family: MathTraceAnalysis["family"]): NonNullable<MathTraceAnalysis["tokens"]> {
  const tokens: NonNullable<MathTraceAnalysis["tokens"]> = [];
  tokens.push({ kind: raw.startsWith("$$") ? "display-open" : "inline-open", text: raw.startsWith("$$") ? "$$" : "$" });

  if (family === "environment-structured") {
    tokens.push({ kind: "begin-env", text: raw.match(/\\begin\{[^}]+\}/)?.[0] ?? "unsupported math environment" });
  } else if (family === "alignment-structured") {
    tokens.push({
      kind: "alignment-op",
      text: raw.match(/\\(?:align|aligned|eqnarray|gather|multline)\b|&/)?.[0] ?? "alignment",
    });
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
  decision: LookaheadDecision,
  validation: MathShadowAnalysisInput["validation"],
  unsupportedReason: string | undefined,
  family: MathTraceAnalysis["family"],
  candidates: NonNullable<MathTraceAnalysis["candidates"]>,
): NonNullable<MathTraceAnalysis["checkpoints"]> {
  return candidates.map((candidate) => ({
    label: candidate.id,
    accepted: candidate.accepted,
    reason:
      candidate.reason ??
      unsupportedReason ??
      (!candidate.accepted && validation && !validation.valid ? validation.errors?.join("; ") ?? "validation failed" : undefined) ??
      (family === "left-right-local" && candidate.id === "null-right-candidate" && decision !== "repair"
        ? "shadow-only candidate; live path still conservative"
        : undefined),
  }));
}

function buildCandidates(
  raw: string,
  family: MathTraceAnalysis["family"],
  input: MathShadowAnalysisInput,
  liveCandidateId: string,
): NonNullable<MathTraceAnalysis["candidates"]> {
  const candidates: NonNullable<MathTraceAnalysis["candidates"]> = [];

  const liveOps = summarizeOps(input.ops);
  candidates.push({
    id: input.decision === "repair" ? "repair-candidate" : "raw-fallback",
    family,
    decision: input.decision === "repair" ? "repair" : "raw",
    supported: input.decision === "repair",
    accepted: liveCandidateId === (input.decision === "repair" ? "repair-candidate" : "raw-fallback"),
    ops: liveOps,
    reason: input.downgradeReason,
  });

  if (family === "left-right-local") {
    const leftCount = countCommand(raw, "\\left");
    const rightCount = countCommand(raw, "\\right");
    const nestedLeftPressure = leftCount - rightCount > 1;
    candidates.push({
      id: "null-right-candidate",
      family,
      decision: "repair",
      supported: !nestedLeftPressure,
      accepted: liveCandidateId === "null-right-candidate",
      ops: !nestedLeftPressure ? ["append \\right.", "close display delimiter"] : [],
      reason: nestedLeftPressure ? "nested left/right pressure exceeds Math V2A scope" : "shadow-only candidate; live path still conservative",
    });
  }

  if (family === "display-local" || family === "fixed-arity-local") {
    candidates.push({
      id: "checkpoint-candidate",
      family,
      decision: "repair",
      supported: true,
      accepted: liveCandidateId === "checkpoint-candidate",
      ops: family === "display-local" ? ["checkpoint multiline display tail", "close display delimiter"] : ["checkpoint local fixed-arity tail"],
      reason: "shadow-only checkpoint candidate",
    });
  }

  if (family === "environment-structured" || family === "alignment-structured" || family === "optional-arg-local") {
    candidates.push({
      id: "raw-fallback",
      family,
      decision: "raw",
      supported: false,
      accepted: input.decision !== "repair",
      ops: [],
      reason: resolveUnsupportedReason(input.notes, input.downgradeReason, family) ?? "unsupported family",
    });
  }

  return dedupeCandidates(candidates);
}

function mapSelectedCandidate(candidateId: string): MathTraceAnalysis["selectedCandidate"] {
  if (candidateId === "checkpoint-candidate") return "checkpoint";
  if (candidateId === "raw-fallback") return "raw";
  return "repaired";
}

function summarizeOps(ops: readonly LookaheadRepairOp[]): string[] {
  return ops.map((op) => {
    switch (op.kind) {
      case "append":
      case "close-delimiter":
        return `${op.kind}:${op.text}`;
      case "trim-tail":
        return `${op.kind}:${op.count}`;
      case "insert-empty-group":
        return op.kind;
      case "close-tag":
        return `${op.kind}:${op.tagName}`;
      case "self-close-tag":
        return op.kind;
      default:
        return op.kind satisfies never;
    }
  });
}

function dedupeCandidates(candidates: NonNullable<MathTraceAnalysis["candidates"]>): NonNullable<MathTraceAnalysis["candidates"]> {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function countCommand(raw: string, command: string): number {
  const match = raw.match(new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
  return match?.length ?? 0;
}
