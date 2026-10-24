import type { LookaheadDecisionTrace, LookaheadFeatureFamily, LookaheadRepairOp, LookaheadRequest, LookaheadSurface, LookaheadTerminationReason } from "./lookahead-contract";
import type { NormalizedFormatAnticipation } from "./inline-streaming";
import { analyzeMathTailShadow } from "./math-tail-shadow";
import { applyRepairOps, renderAppendedSuffix } from "./lookahead-repair";
import { LookaheadBudget } from "./lookahead-budget";

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
  decision: "accept-as-is" | "repair" | "raw";
  ops: readonly LookaheadRepairOp[];
  debugNotes: string[];
  terminationReason?: LookaheadTerminationReason;
};

type MathRepairClassification =
  | { kind: "repair"; ops: LookaheadRepairOp[]; notes: string[] }
  | { kind: "unsupported"; reason: string; notes: string[] };
export function traceFromFormatPlan(plan: InlineFormatPlan, raw: string, contextSignature: string): LookaheadDecisionTrace {
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

export function traceFromRegexPlan(plan: RegexPlan, contextSignature: string): LookaheadDecisionTrace {
  return {
    providerId: "regex-provider",
    surface: "regex",
    decision: plan.decision,
    safety: "safe",
    featureFamily: "regex-core",
    contextSignature,
    ops: plan.ops,
    appended: renderAppendedSuffix(plan.ops),
    ...(plan.terminationReason ? {
      termination: { reason: plan.terminationReason, rearmWhen: "next-byte" as const },
      downgrade: { mode: "raw" as const, reason: `lookahead ${plan.terminationReason} exhausted` },
    } : {}),
    debug: {
      strategy: plan.decision === "repair" ? "regex-append" : "no-op",
      notes: plan.debugNotes,
    },
  };
}
type MathTraceAnalysis = NonNullable<NonNullable<LookaheadDecisionTrace["analysis"]>["math"]>;

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

function buildAnalysisForFormatPlan(plan: InlineFormatPlan, raw: string): LookaheadDecisionTrace["analysis"] | undefined {
  if (plan.decision === "raw" && (
    plan.terminationReason === "budget-chars" || plan.terminationReason === "budget-newlines" ||
    plan.terminationReason === "budget-nesting" || plan.terminationReason === "budget-steps"
  )) return undefined;
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

export function planRegexLookahead(regexAppend: string | null, request: LookaheadRequest, priorOps: readonly LookaheadRepairOp[]): RegexPlan {
  if (!regexAppend) {
    return {
      decision: "accept-as-is",
      ops: [],
      debugNotes: ["no incomplete regex anticipation match"],
    };
  }
  const budget = new LookaheadBudget(request.budgets);
  const ops: LookaheadRepairOp[] = [{ kind: "append", text: regexAppend }];
  const failure = budget.checkInput(request.raw) ?? budget.checkInput(regexAppend) ?? budget.checkOps([...priorOps, ...ops]);
  if (failure) return { decision: "raw", ops: [], terminationReason: failure, debugNotes: [`lookahead ${failure} exhausted`] };
  return {
    decision: "repair",
    ops,
    debugNotes: ["regex anticipation match"],
  };
}

export function planInlineFormat(
  request: LookaheadRequest,
  anticipation: NormalizedFormatAnticipation,
  enableMath: boolean,
): InlineFormatPlan {
  if (request.raw.length > request.budgets.maxScanChars) {
    if (!request.context.provisional) {
      return { surface: "inline-format", decision: "accept-as-is", safety: "safe", ops: [], debugNotes: ["content already complete"] };
    }
    return budgetFallback("inline-format", "budget-chars");
  }
  const budget = new LookaheadBudget(request.budgets);
  const scan = scanInlineTokens(request.raw, enableMath, request.budgets.maxScanChars);
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

  const surface = hasIncompleteMathDisplay ? "math-block" : hasIncompleteMathInline ? "math-inline" : "inline-format";
  const inputFailure = budget.checkInput(request.raw, scan.maxDepth);
  if (inputFailure) return budgetFallback(surface, inputFailure);

  const mathMode = hasIncompleteMathDisplay ? "display" : "inline";
  if (hasIncompleteMath) {
    const mathPlan = planMathLookahead(request.raw, hasIncompleteMathDisplay ? "math-block" : "math-inline", mathMode, budget);
    if (mathPlan.decision !== "repair") return mathPlan;
    const outerTokens = scan.stack.filter((token) => token !== "math-inline" && token !== "math-display").reverse();
    const ops = [...mathPlan.ops, ...outerTokens.flatMap((token) => appendOpsForToken(token, request.raw, scan.mathDisplayCrossedNewline))];
    const failure = budget.checkOps(ops);
    if (failure) return budgetFallback(surface, failure);
    return {
      ...mathPlan,
      ops,
      debugNotes: [...mathPlan.debugNotes, ...outerTokens],
    };
  }

  const ops = scan.stack
    .slice()
    .reverse()
    .flatMap((token) => appendOpsForToken(token, request.raw, scan.mathDisplayCrossedNewline));
  const failure = budget.checkOps(ops);
  if (failure) return budgetFallback(surface, failure);

  return {
    surface: hasIncompleteMath ? (hasIncompleteMathDisplay ? "math-block" : "math-inline") : "inline-format",
    decision: "repair",
    safety: "safe",
    ops,
    debugNotes: scan.stack.slice().reverse(),
  };
}

function scanInlineTokens(content: string, enableMath: boolean, maxScanChars: number): { stack: TokenKind[]; mathDisplayCrossedNewline: boolean; maxDepth: number } {
  const stack: TokenKind[] = [];
  let mathDisplayOpen = false;
  let mathDisplayCrossedNewline = false;
  let maxDepth = 0;
  const scanEnd = Math.min(content.length, Math.max(0, maxScanChars));

  const toggleToken = (token: TokenKind) => {
    const last = stack[stack.length - 1];
    if (last === token) {
      stack.pop();
    } else {
      stack.push(token);
      maxDepth = Math.max(maxDepth, stack.length);
    }
  };

  const shouldOpenInlineMath = (index: number) => {
    const next = index + 1 < scanEnd ? content[index + 1] ?? "" : "";
    return !/\d/.test(next);
  };

  for (let i = 0; i < scanEnd; i += 1) {
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
    if (code === 126 && i + 1 < scanEnd && content.charCodeAt(i + 1) === 126) {
      toggleToken("strike");
      i += 1;
      continue;
    }
    if (code === 42) {
      if (i + 1 < scanEnd && content.charCodeAt(i + 1) === 42) {
        toggleToken("strong");
        i += 1;
      } else {
        toggleToken("em");
      }
      continue;
    }
    if (enableMath && code === 36) {
      if (i + 1 < scanEnd && content.charCodeAt(i + 1) === 36) {
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

  return { stack, mathDisplayCrossedNewline, maxDepth };
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
  budget: LookaheadBudget,
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

  const opsFailure = budget.checkOps(mathRepair.ops);
  if (opsFailure) return budgetFallback(surface, opsFailure);
  const repaired = applyRepairOps(raw, mathRepair.ops);
  const validation = validateMathRepairCandidate(repaired, mode);
  const validationFailure = budget.recordValidation(validation.valid);
  if (validationFailure) return budgetFallback(surface, validationFailure);
  const checkpoint = mode === "display" ? buildDisplayCheckpointCandidate(raw, mathRepair.notes) : null;
  const checkpointFailure = checkpoint ? budget.checkOps(checkpoint.ops) : undefined;
  if (checkpointFailure) return budgetFallback(surface, checkpointFailure);
  const checkpointValidation =
    checkpoint ? validateMathRepairCandidate(applyRepairOps(raw, checkpoint.ops), mode) : undefined;
  const checkpointValidationFailure = checkpointValidation ? budget.recordValidation(checkpointValidation.valid) : undefined;
  if (checkpointValidationFailure) return budgetFallback(surface, checkpointValidationFailure);

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


export function budgetFallback(surface: LookaheadSurface, reason: LookaheadTerminationReason): InlineFormatPlan {
  return {
    surface,
    decision: "raw",
    safety: "safe",
    ops: [],
    terminationReason: reason,
    downgradeReason: `lookahead ${reason} exhausted`,
    debugNotes: [`lookahead ${reason} exhausted`],
  };
}
