import assert from "node:assert";

import type { ProtectedRange } from "../src/types";
import { detectMDX } from "../src/utils";

function runProtectedRangeTests(): void {
  const htmlContent = "<span>{x}</span>";
  const htmlRange: ProtectedRange = { from: 0, to: htmlContent.length, kind: "html-inline" };

  assert.strictEqual(detectMDX(htmlContent), true, "expected unprotected inline HTML braces to trigger MDX detection");
  assert.strictEqual(
    detectMDX(htmlContent, { protectedRanges: [htmlRange], baseOffset: 0 }),
    false,
    "expected protected inline HTML braces to be ignored",
  );

  const autolinkContent = "<https://example.com/{x}>";
  const autolinkRange: ProtectedRange = { from: 0, to: autolinkContent.length, kind: "autolink" };
  assert.strictEqual(
    detectMDX(autolinkContent, { protectedRanges: [autolinkRange], baseOffset: 0 }),
    false,
    "expected protected autolink braces to be ignored",
  );

  const mixedContent = `${htmlContent} {y}`;
  assert.strictEqual(
    detectMDX(mixedContent, { protectedRanges: [htmlRange], baseOffset: 0 }),
    true,
    "expected MDX detection when braces exist outside protected ranges",
  );
}

runProtectedRangeTests();
console.log("mdx-detection-protected test passed");
