import assert from "node:assert";

import type { Patch, WorkerOut } from "@stream-mdx/core";
import { getPatchKind } from "@stream-mdx/core/perf/patch-batching";

import { createWorkerHarness } from "./worker-test-harness";

function getPatchMessages(messages: WorkerOut[]): Array<Extract<WorkerOut, { type: "PATCH" }>> {
  return messages.filter((message): message is Extract<WorkerOut, { type: "PATCH" }> => message.type === "PATCH");
}

function findDumpBlocks(messages: WorkerOut[]): Extract<WorkerOut, { type: "DUMP_BLOCKS" }> {
  const dump = messages.find((message): message is Extract<WorkerOut, { type: "DUMP_BLOCKS" }> => message.type === "DUMP_BLOCKS");
  assert.ok(dump, "expected DUMP_BLOCKS response");
  return dump;
}

function buildLargeCodeSnippet(lineCount: number): string {
  const lines = Array.from({ length: lineCount }, (_, idx) => `const value_${idx} = ${idx};`);
  return ["```js", ...lines, "```"].join("\n");
}

async function runLazyTokenizationBoundaryTest(): Promise<void> {
  const harness = await createWorkerHarness();

  await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: {
      html: true,
      mdx: false,
      math: false,
      tables: false,
      callouts: false,
      lazyTokenization: { enabled: true, thresholdLines: 10 },
    },
  });

  const snippet = buildLargeCodeSnippet(64);
  await harness.send({ type: "APPEND", text: snippet });
  await harness.send({ type: "FINALIZE" });

  const beforeDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const codeBlock = beforeDump.blocks.find((block) => block.type === "code");
  assert.ok(codeBlock, "expected finalized code block");
  assert.ok(codeBlock.isFinalized, "code block must be finalized before lazy tokenization follow-up");

  const tokenizeMessages = await harness.send({
    type: "TOKENIZE_RANGE",
    blockId: codeBlock.id,
    startLine: 0,
    endLine: 64,
    priority: "visible",
  });
  const patchMessages = getPatchMessages(tokenizeMessages);
  assert.ok(patchMessages.length > 0, "expected lazy tokenization to emit follow-up patches");

  const patches = patchMessages.flatMap((message) => message.patches as Patch[]);
  assert.ok(patches.length > 0, "expected lazy tokenization patch list");
  assert.ok(
    patches.every((patch) => getPatchKind(patch) === "enrichment"),
    `lazy tokenization after finalize must emit enrichment-only patches: ${patches.map((patch) => `${patch.op}:${getPatchKind(patch)}`).join(", ")}`,
  );
  assert.ok(
    patches.every((patch) => patch.op !== "finalize"),
    "lazy tokenization follow-up must not re-emit finalize patches",
  );

  const afterDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const updatedBlock = afterDump.blocks.find((block) => block.id === codeBlock.id);
  assert.ok(updatedBlock, "expected code block after lazy tokenization");
  assert.ok(updatedBlock.isFinalized, "lazy tokenization must not reopen finalized code blocks");
}

async function runMdxStatusBoundaryTest(): Promise<void> {
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
  assert.ok(mdxBlock.isFinalized, "mdx block must be finalized before coordinator status update");

  const staleMessages = await harness.send({
    type: "MDX_COMPILED",
    blockId: mdxBlock.id,
    compiledId: "compiled-stale",
    rawSignature: `${raw} stale`,
  });
  assert.strictEqual(getPatchMessages(staleMessages).length, 0, "stale finalized MDX update must be ignored");

  const validMessages = await harness.send({
    type: "MDX_COMPILED",
    blockId: mdxBlock.id,
    compiledId: "compiled-valid",
    rawSignature: raw,
  });
  const validPatches = getPatchMessages(validMessages).flatMap((message) => message.patches as Patch[]);
  assert.ok(validPatches.length > 0, "expected valid finalized MDX update to emit a patch");
  assert.ok(
    validPatches.every((patch) => getPatchKind(patch) === "semantic"),
    `finalized MDX status updates must remain semantic: ${validPatches.map((patch) => `${patch.op}:${getPatchKind(patch)}`).join(", ")}`,
  );

  const afterDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const updatedBlock = afterDump.blocks.find((block) => block.id === mdxBlock.id);
  assert.ok(updatedBlock, "expected finalized mdx block after valid update");
  assert.ok(updatedBlock.isFinalized, "MDX status updates must not reopen finalized blocks");
  assert.strictEqual(updatedBlock.payload.compiledMdxRef?.id, "compiled-valid", "expected compiled MDX ref after valid update");
}

async function runMdxErrorBoundaryTest(): Promise<void> {
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

  const raw = "<Preview message=\"broken\" />";
  await harness.send({ type: "APPEND", text: raw });
  await harness.send({ type: "FINALIZE" });

  const beforeDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const mdxBlock = beforeDump.blocks.find((block) => block.type === "mdx");
  assert.ok(mdxBlock, "expected finalized mdx block");
  assert.ok(mdxBlock.isFinalized, "mdx block must be finalized before coordinator error update");

  const staleMessages = await harness.send({
    type: "MDX_ERROR",
    blockId: mdxBlock.id,
    error: "stale compile failure",
    rawSignature: `${raw} stale`,
  });
  assert.strictEqual(getPatchMessages(staleMessages).length, 0, "stale finalized MDX error update must be ignored");

  const validMessages = await harness.send({
    type: "MDX_ERROR",
    blockId: mdxBlock.id,
    error: "compile failed",
    rawSignature: raw,
  });
  const validPatches = getPatchMessages(validMessages).flatMap((message) => message.patches as Patch[]);
  assert.ok(validPatches.length > 0, "expected valid finalized MDX error update to emit a patch");
  assert.ok(
    validPatches.every((patch) => getPatchKind(patch) === "semantic"),
    `finalized MDX error updates must remain semantic: ${validPatches.map((patch) => `${patch.op}:${getPatchKind(patch)}`).join(", ")}`,
  );

  const afterDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const updatedBlock = afterDump.blocks.find((block) => block.id === mdxBlock.id);
  assert.ok(updatedBlock, "expected finalized mdx block after valid error update");
  assert.ok(updatedBlock.isFinalized, "MDX error updates must not reopen finalized blocks");
  assert.strictEqual(updatedBlock.payload.compiledMdxRef?.id, undefined, "error update should clear compiled ref");
  assert.strictEqual(
    (updatedBlock.payload.meta as { mdxStatus?: string; mdxError?: string } | undefined)?.mdxStatus,
    "error",
    "expected mdx status to transition to error",
  );
}

await runLazyTokenizationBoundaryTest();
await runMdxStatusBoundaryTest();
await runMdxErrorBoundaryTest();
console.log("worker-post-finalize-boundary test passed");
