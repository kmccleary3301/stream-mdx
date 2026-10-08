import assert from "node:assert";

import { JSDOM } from "jsdom";

import { findMissingRequiredTextFragments } from "../../../scripts/regression/utils";

// The HTML regression harness validates fixture text fragments against the
// rendered DOM text of the regression root, never the serialized HTML string:
// syntax highlighting splits source lines into per-token <span>s, so matching
// raw HTML is incidental to the highlighter markup and fails for any validly
// highlighted block. These cases pin both directions of that contract - text
// that is present in the DOM passes even when the HTML splits it, and text that
// is genuinely absent is still reported.

/** DOM text of a regression root wrapping `html` - the exact signal the harness reads. */
function renderedText(html: string): string {
  const dom = new JSDOM(`<div id="regression-root">${html}</div>`);
  const root = dom.window.document.getElementById("regression-root");
  assert.ok(root, "test wrapper must render the regression root");
  return root.textContent ?? "";
}

function main(): void {
  // Shiki splits `const value = 1;` across two adjacent token spans.
  const splitAcrossTokens =
    '<pre class="shiki"><code><span class="line" data-line="1"><span style="color:#c678dd">const</span><span style="color:#abb2bf"> value = 1;</span></span></code></pre>';
  assert.equal(
    splitAcrossTokens.includes("const value = 1;"),
    false,
    "raw HTML is not a valid oracle: contiguous source text never appears inside tokenized spans",
  );
  assert.deepEqual(
    findMissingRequiredTextFragments(["const value = 1;"], renderedText(splitAcrossTokens)),
    [],
    "DOM text keeps tokenized source contiguous",
  );

  // Fragments that span highlighted lines keep their newline verbatim.
  const multiLine =
    '<pre class="shiki"><code><span class="line" data-line="1">let total = 2;</span>\n<span class="line" data-line="2">echo "nested"</span></code></pre>';
  const multiLineText = renderedText(multiLine);
  assert.deepEqual(
    findMissingRequiredTextFragments(['2;\necho "nested"'], multiLineText),
    [],
    "newlines between shiki line spans stay in the DOM text",
  );
  assert.deepEqual(
    findMissingRequiredTextFragments(['2;echo "nested"'], multiLineText),
    ['2;echo "nested"'],
    "whitespace is not normalized away, so a newline-free fragment does not match",
  );

  // Genuinely missing text still fails.
  const partial = renderedText('<pre class="shiki"><code><span class="line">echo "nested"</span></code></pre>');
  assert.deepEqual(
    findMissingRequiredTextFragments(['const value = 1;', 'echo "nested"', "export const answer = 42;"], partial),
    ['const value = 1;', "export const answer = 42;"],
    "fragments absent from the DOM text are reported",
  );

  // A root that never rendered fails every fragment.
  assert.deepEqual(
    findMissingRequiredTextFragments(["Alpha", "answer = 42"], null),
    ["Alpha", "answer = 42"],
    "a missing regression root fails every required fragment",
  );

  console.log("required-text-fragments oracle test passed");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
