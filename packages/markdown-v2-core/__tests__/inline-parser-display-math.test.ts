import assert from "node:assert";

import { InlineParser } from "../src/inline-parser";

async function main() {
  const parser = new InlineParser({ maxCacheEntries: 0 });

  // Regression: escaped-character splitting of `\\` inside `$$...$$` used to prevent
  // the display-math plugin from matching, leaving stray `$` tokens behind.
  // Also ensure we tolerate whitespace/newlines immediately after opening `$$` and
  // immediately before closing `$$` (common in real markdown).
  const input = "Before $$\n  a \\\\ b\n$$ after";
  const nodes = parser.parse(input, { cache: false });

  const displayNodes = nodes.filter((node) => node.kind === "math-display");
  assert.strictEqual(displayNodes.length, 1, "expected $$...$$ to parse as a single math-display node");

  const display = displayNodes[0] as Extract<(typeof nodes)[number], { kind: "math-display" }>;
  assert.ok(display.tex.includes("\\\\"), "expected TeX newline `\\\\` to be preserved inside display math");

  const textWithDollars = nodes.filter((node) => node.kind === "text" && node.text.includes("$"));
  assert.strictEqual(textWithDollars.length, 0, "expected no stray $ tokens after display math parsing");

  console.log("Inline parser display-math regression test passed");
}

await main();
