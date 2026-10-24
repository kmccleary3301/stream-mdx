import assert from "node:assert/strict";

import {
  STREAM_MDX_SCHEMA_VERSION,
  applyPatchBatch,
  createBlockSnapshot,
  createInitialSnapshot,
  type Block,
  type Patch,
  type WorkerOut,
} from "@stream-mdx/core";
import { getPatchKind } from "@stream-mdx/core/perf/patch-batching";
import { coalescePatchesLinear, coalescePatchesQuadratic } from "@stream-mdx/core/perf/patch-coalescing";
import { createWorkerHarness } from "./worker-test-harness";

function assertNoErrors(messages: readonly WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "ERROR") {
      assert.fail(`worker ${message.phase} failed: ${message.error.message}`);
    }
  }
}

async function main(): Promise<void> {
  const source = [
    "```ts",
    "const first = 1;",
    "const second = first + 1;",
    "```",
    "",
    "- finalized list item",
    "",
  ].join("\n");
  const harness = await createWorkerHarness();
  const initMessages = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: source,
    prewarmLangs: [],
    docPlugins: {
      codeHighlighting: "final",
      lazyTokenization: { enabled: true, thresholdLines: 1 },
    },
  });
  assertNoErrors(initMessages);
  const initialized = initMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
  assert.ok(initialized, "worker must initialize the code and list fixture");

  const finalizedMessages = await harness.send({ type: "FINALIZE" });
  assertNoErrors(finalizedMessages);
  assert.ok(finalizedMessages.some((message) => message.type === "FINALIZED"), "worker must finalize the fixture");

  const dumpMessages = await harness.send({ type: "DUMP_BLOCKS" });
  assertNoErrors(dumpMessages);
  const dump = dumpMessages.find((message): message is Extract<WorkerOut, { type: "DUMP_BLOCKS" }> => message.type === "DUMP_BLOCKS");
  assert.ok(dump, "worker must expose its finalized cold blocks");
  const workerCode = dump.blocks.find((block) => block.type === "code");
  const list = dump.blocks.find((block) => block.type === "list");
  assert.ok(workerCode, "worker must publish a canonical root code block");
  assert.ok(list, "worker must publish a canonical root list block");

  // Cold materialized code snapshots retain the audited lazy-code metadata contract.
  // Live native code instead decorates through the non-coalescable decorateCode opcode.
  const code: Block = {
    ...workerCode,
    payload: {
      ...workerCode.payload,
      meta: {
        ...workerCode.payload.meta,
        code: "const first = 1;\nconst second = first + 1;\n",
        lazyTokenization: true,
        lazyTokenizedUntil: 0,
      },
    },
  };
  const rootSnapshot = {
    ...initialized.snapshot,
    children: dump.blocks.map((block) => createBlockSnapshot(block.id === code.id ? code : block)),
  };
  const listSnapshot = rootSnapshot.children.find((node) => node.id === list.id);
  assert.ok(listSnapshot?.children?.some((child) => child.type === "list-item"), "worker snapshot must contain a nonempty root list");

  const createFinalDocument = () => createInitialSnapshot(rootSnapshot);
  const sourceDocument = createFinalDocument();
  const sourceBlocks = sourceDocument.getBlocks();
  const consumerCode = sourceBlocks.find((block) => block.type === "code");
  const consumerList = sourceBlocks.find((block) => block.type === "list");
  assert.ok(consumerCode, "Core cold export must retain the legacy code block");
  assert.ok(consumerList, "Core cold export must retain the worker list block");
  assert.equal(consumerCode.isFinalized, true, "worker code source must be finalized before replay");
  assert.equal(consumerList.isFinalized, true, "worker list source must be finalized before replay");

  const decoratedCode: Block = {
    ...consumerCode,
    payload: {
      ...consumerCode.payload,
      meta: { ...consumerCode.payload.meta, lazyTokenizedUntil: 1 },
    },
  };
  const patches: Patch[] = [
    {
      op: "setProps",
      at: { blockId: consumerCode.id },
      props: { block: decoratedCode },
      meta: { kind: "enrichment" },
    },
    {
      op: "setProps",
      at: { blockId: consumerList.id },
      props: { isFinalized: false },
      meta: { kind: "semantic" },
    },
  ];
  const transforms = [
    ["raw", patches],
    ["linear", coalescePatchesLinear(patches)],
    ["quadratic", coalescePatchesQuadratic(patches)],
  ] as const;

  for (const [name, transformed] of transforms) {
    const document = createFinalDocument();
    const beforeCode = document.getBlocks().find((block) => block.id === consumerCode.id);
    const beforeList = document.getBlocks().find((block) => block.id === consumerList.id);
    assert.ok(beforeCode?.isFinalized && beforeList?.isFinalized, `${name}: replay must start from fresh finalized worker state`);

    applyPatchBatch(document, transformed.filter((patch) => getPatchKind(patch) === "semantic"));

    const afterCode = document.getBlocks().find((block) => block.id === consumerCode.id);
    const afterList = document.getBlocks().find((block) => block.id === consumerList.id);
    assert.ok(afterCode && afterList, `${name}: consumer blocks must remain present`);
    assert.equal(afterCode.id, consumerCode.id, `${name}: code identity must remain stable`);
    assert.equal(afterCode.payload.raw, consumerCode.payload.raw, `${name}: canonical code source must remain stable`);
    assert.equal(afterList.id, consumerList.id, `${name}: list identity must remain stable`);
    assert.equal(afterList.payload.raw, consumerList.payload.raw, `${name}: canonical list source must remain stable`);
    assert.equal(afterList.isFinalized, false, `${name}: consumer must observe the semantic root-list reopen`);
  }
}

await main();
