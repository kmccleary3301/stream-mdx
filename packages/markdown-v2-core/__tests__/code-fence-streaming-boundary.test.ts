import assert from "node:assert";

import { extractCodeLines, stripCodeFence } from "../src/code-highlighting";

function testIgnoresTrailingPartialClosingFenceDuringStreaming(): void {
  const raw = ["```js", "const value = 1;", "`"].join("\n");
  const stripped = stripCodeFence(raw);
  assert.strictEqual(stripped.hadFence, true, "expected fenced block to be detected");
  assert.strictEqual(stripped.code, "const value = 1;", "expected trailing partial closing fence to be excluded from code");
  assert.deepStrictEqual(extractCodeLines(raw), ["const value = 1;"], "expected extracted code lines to ignore partial closing fence");
}

function testPreservesBacktickLineWhenNotAtEofStreamingBoundary(): void {
  const raw = ["```js", "const value = 1;", "`", "more", ""].join("\n");
  const stripped = stripCodeFence(raw);
  assert.strictEqual(
    stripped.code,
    ["const value = 1;", "`", "more", ""].join("\n"),
    "expected regular code content to be preserved when the backtick line is not the EOF streaming boundary",
  );
}

testIgnoresTrailingPartialClosingFenceDuringStreaming();
testPreservesBacktickLineWhenNotAtEofStreamingBoundary();
console.log("code-fence-streaming-boundary tests passed");
