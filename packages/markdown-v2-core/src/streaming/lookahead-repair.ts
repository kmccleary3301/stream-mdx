import type { LookaheadRepairOp } from "./lookahead-contract";

function repairSuffix(op: LookaheadRepairOp): string {
  switch (op.kind) {
    case "append":
    case "close-delimiter":
      return op.text;
    case "insert-empty-group":
      return "{}";
    case "close-tag":
      return `</${op.tagName}>`;
    case "self-close-tag":
      return "/>";
    case "trim-tail":
      return "";
  }
}

export function applyRepairOps(raw: string, ops: readonly LookaheadRepairOp[]): string {
  let value = raw;
  for (const op of ops) {
    if (op.kind === "trim-tail") {
      if (op.count > 0) value = value.slice(0, Math.max(0, value.length - op.count));
    } else if (op.kind === "self-close-tag") {
      value = value.endsWith(">") ? `${value.slice(0, -1)}${repairSuffix(op)}` : `${value} ${repairSuffix(op)}`;
    } else {
      value += repairSuffix(op);
    }
  }
  return value;
}

export function renderAppendedSuffix(ops: readonly LookaheadRepairOp[]): string {
  let appended = "";
  for (const op of ops) appended += repairSuffix(op);
  return appended;
}
