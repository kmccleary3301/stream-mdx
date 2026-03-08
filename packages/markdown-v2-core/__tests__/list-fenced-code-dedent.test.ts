import assert from "node:assert";

import { createBlockSnapshot } from "../src/block-snapshot";
import type { Block, NodeSnapshot } from "../src/types";

function findCodeNode(snapshot: NodeSnapshot): NodeSnapshot | null {
  const stack: NodeSnapshot[] = [snapshot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.type === "code") {
      return current;
    }
    const children = current.children ?? [];
    for (let idx = children.length - 1; idx >= 0; idx -= 1) {
      stack.push(children[idx]);
    }
  }
  return null;
}

function getCodeBody(snapshot: NodeSnapshot): string {
  const codeNode = findCodeNode(snapshot);
  assert.ok(codeNode, "expected nested code node");
  const block = (codeNode.props?.block ?? undefined) as Block | undefined;
  assert.ok(block, "expected code node to carry block payload");
  const code = block?.payload?.meta?.code;
  assert.strictEqual(typeof code, "string", "expected code body in block.payload.meta.code");
  return code as string;
}

function makeListBlock(raw: string): Block {
  return {
    id: "list-block",
    type: "list",
    isFinalized: true,
    payload: {
      raw,
      meta: { ordered: false },
      range: { from: 0, to: raw.length },
    },
  };
}

function testDedentsListFenceIndentOnly() {
  const raw = ["*   ```python", "    print('nested')", "    ```"].join("\n");
  const snapshot = createBlockSnapshot(makeListBlock(raw));
  const code = getCodeBody(snapshot);
  assert.strictEqual(code, "print('nested')", "expected list fence indentation to be removed from nested code body");
}

function testPreservesIntentionalCodeIndentBeyondListIndent() {
  const raw = ["*   ```python", "        if True:", "            print('nested')", "    ```"].join("\n");
  const snapshot = createBlockSnapshot(makeListBlock(raw));
  const code = getCodeBody(snapshot);
  assert.strictEqual(code, "    if True:\n        print('nested')", "expected deeper intentional indentation to remain");
}

testDedentsListFenceIndentOnly();
testPreservesIntentionalCodeIndentBeyondListIndent();
console.log("list-fenced-code-dedent tests passed");
