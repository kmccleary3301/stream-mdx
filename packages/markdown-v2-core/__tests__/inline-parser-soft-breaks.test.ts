import assert from "node:assert/strict";

import { InlineParser } from "../src/inline-parser";

const input = "plain\nnext **bold\ncontinuation** `code\nblock` $$display\nmath$$ <span>raw\nhtml</span>";

const defaultNodes = new InlineParser({ maxCacheEntries: 0 }).parse(input, { cache: false });
assert.deepEqual(defaultNodes[0], { kind: "text", text: "plain\nnext " }, "soft breaks remain unchanged by default");

const nodes = new InlineParser({ maxCacheEntries: 0, softBreaks: "hard" }).parse(input, { cache: false });
assert.deepEqual(nodes.slice(0, 3), [
  { kind: "text", text: "plain" },
  { kind: "br" },
  { kind: "text", text: "next " },
]);
const bold = nodes.find((node) => node.kind === "strong");
assert.equal(bold?.kind, "strong");
if (bold?.kind === "strong") assert.deepEqual(bold.children, [
  { kind: "text", text: "bold" },
  { kind: "br" },
  { kind: "text", text: "continuation" },
]);
assert.ok(nodes.some((node) => node.kind === "code" && node.text === "code block"));
assert.ok(nodes.some((node) => node.kind === "math-display" && node.tex === "display\nmath"));
const html = nodes.find((node) => node.kind === "html" && node.tagName === "span");
assert.equal(html?.kind, "html");
if (html?.kind === "html") {
  assert.equal(html.children?.some((child) => child.kind === "br"), false, "raw HTML content does not receive soft-break conversion");
}

const hardBreakNodes = new InlineParser({ maxCacheEntries: 0, softBreaks: "hard" }).parse("hard  \nbreak", { cache: false });
assert.equal(hardBreakNodes.filter((node) => node.kind === "br").length, 1, "CommonMark hard breaks remain one break");

console.log("Inline parser soft-break tests passed");
