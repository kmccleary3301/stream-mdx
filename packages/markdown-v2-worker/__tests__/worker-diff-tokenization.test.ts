import assert from "node:assert";

import { applyPatchBatch, createInitialSnapshot, type Patch, type WorkerOut } from "@stream-mdx/core";

import { createWorkerHarness } from "./worker-test-harness";

async function runDiffTokenizationTest(): Promise<void> {
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
      codeHighlighting: "incremental",
      outputMode: "tokens",
    },
  });
  const init = initMessages.find((msg) => msg.type === "INITIALIZED") as Extract<WorkerOut, { type: "INITIALIZED" }> | undefined;
  assert.ok(init, "worker did not emit INITIALIZED message");
  const snapshot = createInitialSnapshot(init.blocks ?? []);

  const firstChunk = ["```diff ts", "@@ -1,1 +1,1 @@", "-const a = 1;", ""].join("\n");
  const firstMessages = await harness.send({ type: "APPEND", text: firstChunk });
  const firstPatchMessages = firstMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  for (const message of firstPatchMessages) {
    applyPatchBatch(snapshot, message.patches as Patch[]);
  }

  const secondChunk = ["+const a = 2;", "```", ""].join("\n");
  const appendMessages = await harness.send({ type: "APPEND", text: secondChunk });
  const patchMessages = appendMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  for (const message of patchMessages) {
    applyPatchBatch(snapshot, message.patches as Patch[]);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  const finalizePatches = finalizeMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  for (const message of finalizePatches) {
    applyPatchBatch(snapshot, message.patches as Patch[]);
  }

  const target = Array.from(snapshot.nodes.values()).find((node) => node.type === "code-line" && node.props?.text === "+const a = 2;");
  assert.ok(target, "expected diff code line to be present in snapshot");

  assert.strictEqual(target.props?.diffKind, "add");
  assert.strictEqual(target.props?.newNo, 1);
  assert.strictEqual(target.props?.oldNo ?? null, null);

  const tokenLine = target.props?.tokens as { spans: Array<{ t: string }> } | undefined;
  const tokenText = tokenLine ? tokenLine.spans.map((span) => span.t).join("") : "";
  assert.strictEqual(tokenText, "+const a = 2;", "expected tokens to reconstruct full diff line");
}

await runDiffTokenizationTest();
console.log("worker-diff-tokenization test passed");
