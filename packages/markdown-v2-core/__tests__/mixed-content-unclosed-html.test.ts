import assert from "node:assert";

import { extractMixedContentSegments } from "../src/mixed-content";

function parseInline(): any[] {
  return [];
}

function runMixedContentUnclosedHtmlTest(): void {
  // This previously triggered an infinite loop in `splitByTagSegments` because the opening
  // `<kbd>` tag had no closing tag yet (a common streaming scenario).
  const input = "Append <kbd>codeblock";
  const segments = extractMixedContentSegments(input, 0, parseInline);
  assert.ok(Array.isArray(segments) && segments.length > 0, "expected segments output");
  assert.ok(segments.some((segment) => segment.kind === "text" && segment.value.includes("<kbd>")), "expected unclosed tag to remain as text");

  // Ensure we also handle nested/unclosed non-void tags without hanging.
  const nestedInput = "Prefix <div><span>value";
  const nestedSegments = extractMixedContentSegments(nestedInput, 0, parseInline);
  assert.ok(nestedSegments.some((segment) => segment.kind === "text" && segment.value.includes("<div>")), "expected nested unclosed tags to remain as text");
}

runMixedContentUnclosedHtmlTest();
console.log("mixed-content-unclosed-html test passed");
