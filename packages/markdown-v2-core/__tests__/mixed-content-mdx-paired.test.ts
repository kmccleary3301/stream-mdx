import assert from "node:assert";

import { extractMixedContentSegments } from "../src/mixed-content";

function parseInline(): any[] {
  return [];
}

function runMixedContentMdxPairedTest(): void {
  const input = 'Prefix <InlineChip tone="warm">Hot</InlineChip> suffix';
  const segments = extractMixedContentSegments(input, 0, parseInline, {
    mdx: { autoClose: true, maxNewlines: 2, componentAllowlist: ["InlineChip"] },
  });

  const mdxSegments = segments.filter((segment) => segment.kind === "mdx");
  assert.strictEqual(mdxSegments.length, 1, "expected one paired MDX segment");
  assert.strictEqual(
    mdxSegments[0]?.value,
    '<InlineChip tone="warm">Hot</InlineChip>',
    "expected paired MDX segment to include body and closing tag",
  );

  assert.ok(
    segments.some((segment) => segment.kind === "text" && segment.value.includes("Prefix")),
    "expected leading text segment",
  );
  assert.ok(
    segments.some((segment) => segment.kind === "text" && segment.value.includes("suffix")),
    "expected trailing text segment",
  );
}

runMixedContentMdxPairedTest();
console.log("mixed-content mdx paired test passed");
