import assert from "node:assert";

import type { WorkerOut } from "@stream-mdx/core";

import { createWorkerHarness } from "./worker-test-harness";

function findDumpBlocks(messages: WorkerOut[]): Extract<WorkerOut, { type: "DUMP_BLOCKS" }> {
  const dump = messages.find((message): message is Extract<WorkerOut, { type: "DUMP_BLOCKS" }> => message.type === "DUMP_BLOCKS");
  assert.ok(dump, "expected DUMP_BLOCKS response");
  return dump;
}

async function main() {
  const harness = await createWorkerHarness();

  await harness.send({
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
    mdx: { compileMode: "server" },
  });

  const raw = "<Preview message=\"hello\" />";
  await harness.send({ type: "APPEND", text: raw });
  await harness.send({ type: "FINALIZE" });

  const beforeDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const mdxBlock = beforeDump.blocks.find((block) => block.type === "mdx");
  assert.ok(mdxBlock, "expected finalized mdx block");
  const blockId = mdxBlock.id;
  const pendingSegments = Array.isArray((mdxBlock.payload.meta as { mixedSegments?: Array<{ status?: string }> } | undefined)?.mixedSegments)
    ? (((mdxBlock.payload.meta as { mixedSegments?: Array<{ status?: string }> }).mixedSegments ?? []) as Array<{ status?: string }>)
    : [];
  assert.ok(
    pendingSegments.some((segment) => segment.status === "pending"),
    "expected mdx block to remain pending before coordinator result",
  );

  const staleMessages = await harness.send({
    type: "MDX_COMPILED",
    blockId,
    compiledId: "compiled-stale",
    rawSignature: `${raw} stale`,
  });
  assert.ok(!staleMessages.some((message) => message.type === "PATCH"), "stale MDX_COMPILED should be ignored");

  const staleDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const staleBlock = staleDump.blocks.find((block) => block.id === blockId);
  assert.ok(staleBlock, "expected mdx block after stale response");
  assert.strictEqual(
    staleBlock.payload.compiledMdxRef?.id,
    undefined,
    "stale MDX_COMPILED must not inject a compiled ref for the current block",
  );

  const validMessages = await harness.send({
    type: "MDX_COMPILED",
    blockId,
    compiledId: "compiled-valid",
    rawSignature: raw,
  });
  assert.ok(validMessages.some((message) => message.type === "PATCH"), "valid MDX_COMPILED should emit a patch");

  const validDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const validBlock = validDump.blocks.find((block) => block.id === blockId);
  assert.ok(validBlock, "expected mdx block after valid response");
  assert.strictEqual(validBlock.payload.compiledMdxRef?.id, "compiled-valid", "valid MDX_COMPILED should update compiled ref");

  const staleErrorMessages = await harness.send({
    type: "MDX_ERROR",
    blockId,
    error: "stale error",
    rawSignature: `${raw} stale`,
  });
  assert.ok(!staleErrorMessages.some((message) => message.type === "PATCH"), "stale MDX_ERROR should be ignored");

  const staleErrorDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const staleErrorBlock = staleErrorDump.blocks.find((block) => block.id === blockId);
  assert.ok(staleErrorBlock, "expected mdx block after stale error response");
  assert.strictEqual(
    staleErrorBlock.payload.meta?.mdxStatus,
    "compiled",
    "stale MDX_ERROR must not overwrite the current finalized MDX status",
  );

  const validErrorMessages = await harness.send({
    type: "MDX_ERROR",
    blockId,
    error: "compile failed",
    rawSignature: raw,
  });
  assert.ok(validErrorMessages.some((message) => message.type === "PATCH"), "valid MDX_ERROR should emit a patch");

  const validErrorDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const validErrorBlock = validErrorDump.blocks.find((block) => block.id === blockId);
  assert.ok(validErrorBlock, "expected mdx block after valid error response");
  assert.strictEqual(validErrorBlock.payload.compiledMdxRef?.id, undefined, "valid MDX_ERROR should clear compiled ref");
  assert.strictEqual(validErrorBlock.payload.meta?.mdxStatus, "error", "valid MDX_ERROR should update finalized status");
}

await main();
console.log("worker-mdx-status-signature-guard test passed");
