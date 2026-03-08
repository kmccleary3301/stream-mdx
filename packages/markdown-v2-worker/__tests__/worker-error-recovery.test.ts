import assert from "node:assert";
import type { WorkerIn, WorkerOut } from "@stream-mdx/core";
import { createWorkerHarness } from "./worker-test-harness";

async function runWorkerErrorRecoveryTest(): Promise<void> {
  const harness = await createWorkerHarness();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true },
  });
  const init = initMessages.find((m) => m.type === "INITIALIZED") as Extract<WorkerOut, { type: "INITIALIZED" }> | undefined;
  assert.ok(init, "worker did not emit INITIALIZED message");

  const invalidAppend = { type: "APPEND", text: null } as unknown as WorkerIn;
  const errorMessages = await harness.send(invalidAppend);
  const error = errorMessages.find((m): m is Extract<WorkerOut, { type: "ERROR" }> => m.type === "ERROR");
  assert.ok(error, "expected ERROR message when APPEND payload is invalid");
  assert.strictEqual(error.phase, "APPEND", "ERROR phase should reflect the failing message type");
  assert.ok(error.error?.message, "expected ERROR payload to include a message");

  const recoveryMessages = await harness.send({ type: "APPEND", text: "Recovery line\n" });
  const recoveryPatch = recoveryMessages.find((m) => m.type === "PATCH");
  assert.ok(recoveryPatch, "worker should recover and emit PATCH after an error");
}

await runWorkerErrorRecoveryTest();
console.log("Worker error recovery test passed");
