import assert from "node:assert";
import fs from "node:fs/promises";

import type { WorkerOut } from "@stream-mdx/core";

import { createWorkerHarness } from "./worker-test-harness";

async function loadFixture(name: string): Promise<string> {
  return await fs.readFile(new URL(`../../../tests/regression/fixtures/${name}`, import.meta.url), "utf8");
}

async function main() {
  const harness = await createWorkerHarness();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: {
      footnotes: true,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
    },
  });
  assert.ok(initMessages.some((message) => message.type === "INITIALIZED"), "worker failed to initialize");

  await harness.send({ type: "SET_CREDITS", credits: 0 });
  const content = await loadFixture("code-huge.md");
  const appendMessages = await harness.send({ type: "APPEND", text: content });
  assert.ok(
    appendMessages.some((message) => message.type === "PATCH"),
    "expected append to emit at least one structural patch message even with zero credits",
  );

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  assert.ok(
    finalizeMessages.some((message) => message.type === "PATCH" || message.type === "FINALIZED"),
    "expected finalize to emit patch/finalized messages",
  );

  const creditRestoreMessages = await harness.send({ type: "SET_CREDITS", credits: 1 });
  const staleFlush = creditRestoreMessages.find((message): message is Extract<WorkerOut, { type: "PATCH" }> => message.type === "PATCH");
  assert.strictEqual(staleFlush, undefined, "restoring credits after FINALIZE must not flush stale deferred patches");
}

await main();
console.log("worker-finalize-clears-deferred test passed");
