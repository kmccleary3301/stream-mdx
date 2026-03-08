import assert from "node:assert";

import { applyPatchBatch, createInitialSnapshot, type Patch, type WorkerOut } from "@stream-mdx/core";
import { createWorkerHarness } from "./worker-test-harness";

async function collectTokenLines(): Promise<Array<{ index: number; tokens: unknown }>> {
  const harness = await createWorkerHarness();
  const content = ["```ts", "const alpha = 1;", "const beta = 2;", "```"].join("\n");

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: content,
    prewarmLangs: ["typescript"],
    docPlugins: {
      footnotes: false,
      html: false,
      mdx: false,
      tables: false,
      callouts: false,
      math: false,
      codeHighlighting: "final",
      outputMode: "tokens",
      emitHighlightTokens: true,
      liveTokenization: false,
    },
  });

  const init = initMessages.find((msg) => msg.type === "INITIALIZED") as Extract<WorkerOut, { type: "INITIALIZED" }> | undefined;
  assert.ok(init, "worker did not emit INITIALIZED message");

  const snapshot = createInitialSnapshot(init.blocks ?? []);
  const initPatches = initMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  for (const message of initPatches) {
    applyPatchBatch(snapshot, message.patches as Patch[]);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  const finalizePatches = finalizeMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  for (const message of finalizePatches) {
    applyPatchBatch(snapshot, message.patches as Patch[]);
  }

  const tokenLines = Array.from(snapshot.nodes.values())
    .filter((node) => node.type === "code-line")
    .map((node) => {
      const index = typeof node.props?.index === "number" ? (node.props.index as number) : 0;
      const tokens = node.props?.tokens ?? null;
      return { index, tokens };
    })
    .sort((a, b) => a.index - b.index);

  assert.ok(tokenLines.length > 0, "expected at least one tokenized code line");
  return tokenLines;
}

async function runTokenDeterminismTest(): Promise<void> {
  const first = await collectTokenLines();
  const second = await collectTokenLines();
  assert.deepStrictEqual(second, first, "token output should be deterministic across runs");
}

await runTokenDeterminismTest();
console.log("worker token determinism test passed");
