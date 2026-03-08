import assert from "node:assert";

import type { Patch, WorkerOut } from "@stream-mdx/core";

import { createWorkerHarness } from "./worker-test-harness";

function readPatchMeta(
  patch: Patch,
):
  | {
      kind?: string;
      streamSeq?: number;
      parseEpoch?: number;
      tx?: number;
      blockEpoch?: number;
    }
  | undefined {
  return patch.op === "setHTML" ? patch.patchMeta : patch.meta;
}

function findPatchMessage(messages: WorkerOut[]): Extract<WorkerOut, { type: "PATCH" }> {
  const message = messages.find((candidate): candidate is Extract<WorkerOut, { type: "PATCH" }> => candidate.type === "PATCH");
  assert.ok(message, "expected worker to emit a PATCH message");
  return message;
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

  const firstAppend = findPatchMessage(await harness.send({ type: "APPEND", text: "Hello" }));
  assert.ok(firstAppend.patches.length > 0, "expected first append to emit patches");

  const insertedBlockPatch = firstAppend.patches.find(
    (patch): patch is Extract<Patch, { op: "insertChild" }> => patch.op === "insertChild" && patch.at.blockId === "__root__",
  );
  assert.ok(insertedBlockPatch, "expected first append to insert a root block");
  const insertedBlockId = insertedBlockPatch.node.id;
  const firstMeta = readPatchMeta(insertedBlockPatch);
  assert.ok(firstMeta, "expected first insert patch to have metadata");
  assert.strictEqual(firstMeta?.tx, firstAppend.tx, "patch metadata tx should match worker patch message tx");
  assert.ok(typeof firstMeta?.parseEpoch === "number" && firstMeta.parseEpoch >= 1, "expected first patch parseEpoch");
  assert.ok(typeof firstMeta?.streamSeq === "number" && firstMeta.streamSeq >= 1, "expected first patch streamSeq");
  assert.strictEqual(firstMeta?.kind, "semantic", "expected root insert to be classified as semantic");

  const secondAppend = findPatchMessage(await harness.send({ type: "APPEND", text: " world" }));
  assert.ok(secondAppend.patches.length > 0, "expected second append to emit patches");
  for (const patch of secondAppend.patches) {
    const meta = readPatchMeta(patch);
    assert.ok(meta, `expected patch metadata on ${patch.op}`);
    assert.strictEqual(meta?.tx, secondAppend.tx, `metadata tx mismatch on ${patch.op}`);
    assert.ok(typeof meta?.parseEpoch === "number" && meta.parseEpoch >= 1, `missing parseEpoch on ${patch.op}`);
    assert.ok(typeof meta?.streamSeq === "number" && meta.streamSeq >= 1, `missing streamSeq on ${patch.op}`);
    assert.ok(meta?.kind === "semantic" || meta?.kind === "enrichment", `unexpected patch kind on ${patch.op}`);
  }

  const secondSemanticBlockPatch = secondAppend.patches.find((patch) => {
    const meta = readPatchMeta(patch);
    return patch.op !== "setPropsBatch" && patch.at.blockId === insertedBlockId && meta?.kind === "semantic";
  });
  assert.ok(secondSemanticBlockPatch, "expected second append to emit a semantic patch for the existing paragraph block");
  const secondMeta = readPatchMeta(secondSemanticBlockPatch as Patch);
  assert.strictEqual(
    secondMeta?.blockEpoch,
    firstMeta?.parseEpoch,
    "semantic patches for an existing block must target the previously emitted block epoch",
  );
  assert.ok(
    typeof secondMeta?.parseEpoch === "number" && typeof firstMeta?.parseEpoch === "number" && secondMeta.parseEpoch > firstMeta.parseEpoch,
    "subsequent semantic block updates should advance parseEpoch",
  );
}

await main();
console.log("worker-patch-metadata test passed");
