import assert from "node:assert";
import type { Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

async function runFinalizePatchTest(): Promise<void> {
  const harness = await createWorkerHarness();

  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true },
  });
  const init = initMessages.find((m) => m.type === "INITIALIZED") as Extract<WorkerOut, { type: "INITIALIZED" }> | undefined;
  assert.ok(init, "worker did not emit INITIALIZED message");
  store.reset(init.blocks);

  const sample = ["## Heading", "", "Partial paragraph stream"].join("\n");
  const appendMessages = await harness.send({ type: "APPEND", text: sample });
  const appendPatches = appendMessages.filter((m): m is Extract<WorkerOut, { type: "PATCH" }> => m.type === "PATCH");
  assert.ok(appendPatches.length > 0, "missing patch message after append");
  for (const patchMsg of appendPatches) {
    store.applyPatches(patchMsg.patches as Patch[], { captureMetrics: false });
  }

  const dirtyBefore = store.getBlocks().filter((b) => !b.isFinalized);
  assert.ok(dirtyBefore.length > 0, "expected at least one non-finalized block prior to FINALIZE");

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  const finalizePatchMessages = finalizeMessages.filter((m): m is Extract<WorkerOut, { type: "PATCH" }> => m.type === "PATCH");
  assert.ok(finalizePatchMessages.length > 0, "FINALIZE should emit PATCH message when blocks are dirty");

  const finalizePatches = finalizePatchMessages.flatMap((msg) => msg.patches as Patch[]);
  const finalizedIds = finalizePatches
    .filter((patch) => patch?.op === "finalize" && patch?.at?.blockId)
    .map((patch) => patch.at.blockId as string)
    .sort();
  const dirtyIds = dirtyBefore.map((block) => block.id).sort();
  assert.deepStrictEqual(finalizedIds, dirtyIds, "FINALIZE patches should target only previously dirty blocks");

  for (const patchMsg of finalizePatchMessages) {
    store.applyPatches(patchMsg.patches as Patch[], { captureMetrics: false });
  }

  const finalizeAgainMessages = await harness.send({ type: "FINALIZE" });
  const secondPatch = finalizeAgainMessages.find((m) => m.type === "PATCH");
  assert.strictEqual(secondPatch, undefined, "second FINALIZE should be a no-op when all blocks finalized");
}

await runFinalizePatchTest();
console.log("Worker finalize patch test passed");
