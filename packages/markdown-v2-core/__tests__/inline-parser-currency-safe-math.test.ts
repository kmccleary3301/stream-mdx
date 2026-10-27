import assert from "node:assert/strict";

import { InlineParser } from "../src/inline-parser";

const parser = new InlineParser({ maxCacheEntries: 0, mathOptions: { singleDollar: "currency-safe" } });
const mathNodes = (source: string) => parser.parse(source, { cache: false });

assert.deepEqual(mathNodes("$5 and $10"), [{ kind: "text", text: "$5 and $10" }]);
assert.deepEqual(mathNodes("$x$"), [{ kind: "math-inline", tex: "x" }]);
assert.deepEqual(mathNodes(String.raw`\$5 and \$10`), [{ kind: "text", text: "$5 and $10" }]);
assert.deepEqual(mathNodes("$$display$$"), [{ kind: "math-display", tex: "display" }]);

for (const source of ["$ x$", "$x $", "$,x$", "$x,$", "$x$5"]) {
  assert.deepEqual(mathNodes(source), [{ kind: "text", text: source }], `${source} is rejected as single-dollar math`);
}

assert.deepEqual(
  mathNodes("$skillName$"),
  [{ kind: "math-inline", tex: "skillName" }],
  "a later dollar closes the skill-shaped token as math before any later skill-token presentation",
);

assert.equal(new InlineParser({ maxCacheEntries: 0 }).parse("$5 and $10", { cache: false })[0]?.kind, "math-inline");

console.log("Inline parser currency-safe math tests passed");
