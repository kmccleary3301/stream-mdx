import type { LookaheadBudgets, LookaheadRepairOp, LookaheadTerminationReason } from "./lookahead-contract";

// Finalized content bypasses speculation. Provider timers start before scanning.
export class LookaheadBudget {
  private readonly startedAt = performance.now();
  private validationFailures = 0;

  constructor(private readonly limits: LookaheadBudgets) {}

  checkInput(raw: string, nestingDepth = 0): LookaheadTerminationReason | undefined {
    if (raw.length > this.limits.maxScanChars) return "budget-chars";
    let newlines = 0;
    let depth = 0;
    for (let i = 0; i < raw.length; i += 1) {
      const char = raw[i];
      if (char === "\n" || (char === "\r" && raw[i + 1] !== "\n")) newlines += 1;
      if (char === "\\") {
        if (raw[i + 1] === "\n" || (raw[i + 1] === "\r" && raw[i + 2] !== "\n")) newlines += 1;
        i += 1;
        continue;
      }
      if (char === "{" || char === "[" || char === "(") depth += 1;
      else if (char === "}" || char === "]" || char === ")") depth = Math.max(0, depth - 1);
      nestingDepth = Math.max(nestingDepth, depth);
    }
    if (newlines > this.limits.maxNewlines) return "budget-newlines";
    if (nestingDepth > this.limits.maxNestingDepth) return "budget-nesting";
    return this.checkTime();
  }

  checkOps(ops: readonly LookaheadRepairOp[]): LookaheadTerminationReason | undefined {
    if (ops.length > this.limits.maxSyntheticOps) return "budget-steps";
    return this.checkTime();
  }
  checkDepth(depth: number): LookaheadTerminationReason | undefined {
    return depth > this.limits.maxNestingDepth ? "budget-nesting" : this.checkTime();
  }


  recordValidation(valid: boolean): LookaheadTerminationReason | undefined {
    if (!valid) this.validationFailures += 1;
    if (this.validationFailures > this.limits.maxValidationFailures) return "validation-failed";
    return this.checkTime();
  }

  checkTime(): LookaheadTerminationReason | undefined {
    // The contract has no separate time termination code.
    return performance.now() - this.startedAt >= this.limits.maxProviderMs ? "budget-steps" : undefined;
  }
}
