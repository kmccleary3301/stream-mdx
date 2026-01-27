import assert from "node:assert";

import type { DiffBlock, Patch, WorkerOut } from "@stream-mdx/core";
import { applyPatchBatch, createInitialSnapshot } from "@stream-mdx/core";

import { createWorkerHarness } from "./worker-test-harness";

async function runDiffBlocksTest(): Promise<void> {
  const harness = await createWorkerHarness();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: ["typescript"],
    docPlugins: {
      footnotes: false,
      html: false,
      mdx: false,
      tables: false,
      callouts: false,
      codeHighlighting: "final",
      outputMode: "tokens",
      emitHighlightTokens: true,
      emitDiffBlocks: true,
      liveTokenization: false,
    },
  });
  const init = initMessages.find((msg) => msg.type === "INITIALIZED") as Extract<WorkerOut, { type: "INITIALIZED" }> | undefined;
  assert.ok(init, "worker did not emit INITIALIZED message");
  const snapshot = createInitialSnapshot(init.blocks ?? []);

  const diffContent = [
    "```diff",
    "diff --git a/foo.ts b/foo.ts",
    "index 123..456 100644",
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -1,1 +1,1 @@",
    "-const a = 1;",
    "+const a = 2;",
    "```",
    "",
  ].join("\n");

  const appendMessages = await harness.send({ type: "APPEND", text: diffContent });
  for (const message of appendMessages) {
    if (message.type === "PATCH") {
      applyPatchBatch(snapshot, message.patches as Patch[]);
    }
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  for (const message of finalizeMessages) {
    if (message.type === "PATCH") {
      applyPatchBatch(snapshot, message.patches as Patch[]);
    }
  }

  const codeBlock = snapshot.blocks.find((block) => block.type === "code");
  assert.ok(codeBlock, "expected a code block in snapshot");
  const diffBlocks = (codeBlock.payload?.meta as { diffBlocks?: DiffBlock[] } | undefined)?.diffBlocks;
  assert.ok(Array.isArray(diffBlocks) && diffBlocks.length > 0, "expected diffBlocks to be emitted");

  const [first] = diffBlocks;
  assert.strictEqual(first?.filePath, "foo.ts");
  assert.strictEqual(first?.language, "typescript");
  assert.strictEqual(first?.additions, 1);
  assert.strictEqual(first?.deletions, 1);

  const addLine = first?.lines.find((line) => line.kind === "add");
  const delLine = first?.lines.find((line) => line.kind === "del");
  assert.ok(addLine, "expected add line in diff block");
  assert.ok(delLine, "expected del line in diff block");
  assert.strictEqual(addLine?.raw, "+const a = 2;");
  assert.strictEqual(delLine?.raw, "-const a = 1;");

  const addTokens = addLine?.tokens ? addLine.tokens.map((token) => token.content).join("") : "";
  const delTokens = delLine?.tokens ? delLine.tokens.map((token) => token.content).join("") : "";
  assert.strictEqual(addTokens, "const a = 2;");
  assert.strictEqual(delTokens, "const a = 1;");
}

await runDiffBlocksTest();
console.log("worker-diff-blocks test passed");
