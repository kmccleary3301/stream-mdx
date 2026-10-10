import assert from "node:assert";
import { parser } from "@lezer/markdown";

import { extractCodeLines, stripCodeFence } from "../src/code-highlighting";
import { createBlockSnapshot } from "../src/block-snapshot";

function testIgnoresTrailingPartialClosingFenceDuringStreaming(): void {
  const raw = ["```js", "const value = 1;", "`"].join("\n");
  const stripped = stripCodeFence(raw);
  assert.strictEqual(stripped.hadFence, true, "expected fenced block to be detected");
  assert.strictEqual(stripped.code, "const value = 1;\n`", "public extraction must preserve unclosed code");
  assert.deepStrictEqual(extractCodeLines(raw), ["const value = 1;", "`"]);
  const snapshot = createBlockSnapshot({ id: "streaming-code", type: "code", isFinalized: false, payload: { raw } });
  assert.deepStrictEqual(snapshot.children?.map((child) => child.props?.text), ["const value = 1;"], "provisional rendering hides the partial closer");
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

function testFenceContentAcrossStreamingAndFinalization(): void {
  for (const opening of ["```", "~~~", "````", "~~~~"]) {
    for (const tail of ["`", "``", "~", "~~", "```", "~~~", "    `", "    ~"]) {
      const raw = `${opening}js\nconst value = 1;\n${tail}`;
      const node = parser.parse(raw).topNode.firstChild;
      assert.ok(node);
      assert.strictEqual(node.name, "FencedCode");
      const parserCode = node.getChildren("CodeText").map((child) => raw.slice(child.from, child.to)).join("\n");
      const closesFence = tail[0] === opening[0] && tail.length >= opening.length && !tail.startsWith(" ");
      const finalizedCode = closesFence ? "const value = 1;" : `const value = 1;\n${tail}`;
      assert.strictEqual(parserCode, finalizedCode, `parser content for ${JSON.stringify(raw)}`);
      const isPartialCloser = !tail.startsWith(" ") && tail[0] === opening[0] && tail.length < opening.length;
      const streamingCode = isPartialCloser ? "const value = 1;" : finalizedCode;
      assert.strictEqual(stripCodeFence(raw).code, finalizedCode, "public default must preserve unclosed content");
      assert.deepStrictEqual(extractCodeLines(raw), finalizedCode.split("\n"));
      for (const isFinalized of [false, true]) {
        const expected = isFinalized ? finalizedCode : streamingCode;
        const snapshot = createBlockSnapshot({
          id: "fence-boundary",
          type: "code",
          isFinalized,
          payload: { raw },
        });
        assert.deepStrictEqual(snapshot.children?.map((child) => child.props?.text), expected.split("\n"));
      }
    }
  }

  assert.strictEqual(stripCodeFence("~~~\n`").code, "`", "backticks in tilde fences are code");
  for (const marker of ["`", "~"]) {
    for (const newline of ["\n", "\r\n", "\r"]) {
      const raw = `${marker.repeat(3)}${newline}value${newline}${marker}${newline}`;
      const snapshot = createBlockSnapshot({ id: "newline-code", type: "code", isFinalized: false, payload: { raw } });
      assert.deepStrictEqual(snapshot.children?.map((child) => child.props?.text), ["value", marker, ""], "newline commits a partial marker as code");
    }
  }
}

testIgnoresTrailingPartialClosingFenceDuringStreaming();
testPreservesBacktickLineWhenNotAtEofStreamingBoundary();
testFenceContentAcrossStreamingAndFinalization();
console.log("code-fence-streaming-boundary tests passed");
