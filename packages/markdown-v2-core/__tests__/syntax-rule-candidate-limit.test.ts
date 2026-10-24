import assert from "node:assert/strict";

import { InlineParser } from "../src/inline-parser";
import type { SyntaxRuleSpec } from "../src/types";

const source = "#123456789";
const patternSource = "#[0-9]+";
const rule: SyntaxRuleSpec = {
  name: "bounded",
  pattern: { source: patternSource },
  trigger: "#",
  maxCandidateUnits: 8,
};
const parser = new InlineParser({ enableMath: false, syntax: [rule] });
const originalExec = RegExp.prototype.exec;
const originalWarn = console.warn;
let matchingExecutions = 0;
const diagnostics: string[] = [];

RegExp.prototype.exec = function (this: RegExp, input: string): RegExpExecArray | null {
  if (this.source === patternSource) matchingExecutions += 1;
  return originalExec.call(this, input);
};
console.warn = (...args: Parameters<typeof console.warn>) => diagnostics.push(args.map(String).join(" "));
try {
  const nodes = parser.parse(source, { cache: false });
  assert.deepStrictEqual(nodes, [{ kind: "text", text: source }], "oversized candidates stay literal");
  assert.equal(matchingExecutions, 0, "oversized candidates must be rejected before regex execution");
  assert.ok(diagnostics.some((diagnostic) => diagnostic.includes("bounded") && diagnostic.includes("8")),
    "oversized candidates emit a rule diagnostic");
} finally {
  RegExp.prototype.exec = originalExec;
  console.warn = originalWarn;
}

console.log("syntax rule candidate limit tests passed");
