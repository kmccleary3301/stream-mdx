import assert from "node:assert";

import { extractMixedContentSegments } from "../src/mixed-content";

function parseInline(): any[] {
  return [];
}

function runMixedContentAutoCloseTest(): void {
  const input = "Text <kbd>`{:js}`";
  const segments = extractMixedContentSegments(input, 0, parseInline, {
    html: { autoClose: true, maxNewlines: 2 },
  });
  const htmlSegment = segments.find((segment) => segment.kind === "html");
  assert.ok(htmlSegment, "expected html segment with autoclose");
  assert.ok(htmlSegment?.value.includes("</kbd>"), "expected kbd autoclose to add closing tag");

  const newlineInput = "Text <kbd>`code`\n\n\nmore";
  const segments2 = extractMixedContentSegments(newlineInput, 0, parseInline, {
    html: { autoClose: true, maxNewlines: 2 },
  });
  assert.ok(
    segments2.some((segment) => segment.kind === "text" && segment.value.includes("<kbd>")),
    "expected html autoclose to stop after newline limit",
  );

  const mdxInput = "Hello <MyComp prop=\"x\"> world";
  const segments3 = extractMixedContentSegments(mdxInput, 0, parseInline, {
    mdx: { autoClose: true, maxNewlines: 2, componentAllowlist: ["MyComp"] },
  });
  const mdxSegment = segments3.find((segment) => segment.kind === "mdx");
  assert.ok(mdxSegment, "expected mdx segment with autoclose");
  assert.ok(mdxSegment?.value.includes("/>"), "expected mdx tag to self-close");

  const mdxInput2 = "Hello <Other> world";
  const segments4 = extractMixedContentSegments(mdxInput2, 0, parseInline, {
    mdx: { autoClose: true, maxNewlines: 2, componentAllowlist: ["MyComp"] },
  });
  assert.ok(
    segments4.some((segment) => segment.kind === "text" && segment.value.includes("<Other>")),
    "expected non-allowlisted mdx tag to remain text",
  );
}

runMixedContentAutoCloseTest();
console.log("mixed-content autoclose test passed");
