import assert from "node:assert";

import type { Block, Patch } from "@stream-mdx/core";

import { createRendererStore } from "../src/renderer/store";

function createCodeBlock(): Block {
  return {
    id: "code-block",
    type: "code",
    isFinalized: true,
    payload: {
      raw: ["alpha()", "beta()"].join("\n"),
      meta: { lang: "ts" },
    },
  };
}

async function main() {
  const store = createRendererStore([createCodeBlock()]);
  const before = store.getNode("code-block");
  assert.ok(before, "expected code block node to exist");
  assert.deepStrictEqual(before.children, ["code-block::line:0", "code-block::line:1"]);

  store.applyPatches([
    {
      op: "appendLines",
      at: { blockId: "code-block", nodeId: "code-block" },
      startIndex: 1,
      lines: ["gamma()"],
    } satisfies Patch,
  ]);

  const after = store.getNode("code-block");
  assert.ok(after, "expected code block node to exist after guard");
  assert.deepStrictEqual(
    after.children,
    ["code-block::line:0", "code-block::line:1"],
    "non-tail appendLines should be rejected without mutating code children",
  );

  const counters = store.getDebugCounters();
  assert.strictEqual(counters.appendLineGuardRejected, 1, "expected append guard rejection to be recorded");

  const violations = store.getInvariantViolations();
  assert.ok(
    violations.some((message) => message.includes("appendLines guard rejected:code-block")),
    "expected invariant diagnostics to record the rejected appendLines patch",
  );
}

await main();
console.log("append-lines-guard test passed");
