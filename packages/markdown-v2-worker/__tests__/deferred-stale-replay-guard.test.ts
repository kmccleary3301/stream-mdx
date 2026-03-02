import assert from "node:assert";
import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { JSDOM } from "jsdom";

import { createWorkerHarness } from "./worker-test-harness";

function ensureDom(): void {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;
}

function applyPatchMessages(store: ReturnType<typeof createRendererStore>, messages: WorkerOut[]): void {
  for (const msg of messages) {
    if (msg.type !== "PATCH") continue;
    store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }
}

function countPatchOps(messages: WorkerOut[]): number {
  return messages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .reduce((count, msg) => count + msg.patches.length, 0);
}

function buildStressDoc(sectionCount = 42): string {
  const parts: string[] = [];
  for (let i = 0; i < sectionCount; i++) {
    parts.push(`## Section ${i}`);
    parts.push("");
    parts.push(`Paragraph ${i}: stream-driven updates should stay monotonic and deterministic.`);
    parts.push("");
    parts.push(`- Item ${i}.1 with **bold** content`);
    parts.push(`- Item ${i}.2 with inline math $x_${i} + y_${i}$`);
    parts.push("");
    parts.push("```ts");
    parts.push(`export const section${i} = () => ${i};`);
    parts.push("const values = [1, 2, 3, 4, 5];");
    parts.push("console.log(values.map((value) => value * 2).join(', '));");
    parts.push("```");
    parts.push("");
  }
  return parts.join("\n");
}

function blockSignature(block: Block): string {
  return JSON.stringify({
    id: block.id,
    type: block.type,
    isFinalized: block.isFinalized,
    raw: block.payload.raw ?? "",
    meta: block.payload.meta ?? null,
  });
}

async function runDeferredReplayGuardTest(): Promise<void> {
  ensureDom();

  const doc = buildStressDoc();
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: {
      footnotes: false,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
      formatAnticipation: true,
      liveCodeHighlighting: false,
    },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to emit INITIALIZED");
  store.reset(init.blocks);

  const preCredits = [0.22, 0.65, 0.48, 1, 0.35];
  const postCredits = [0.4, 1, 0.55, 1];
  const chunkSize = 121;

  const seenFinalized = new Map<string, string>();
  let previousStableFinalizedIds: string[] = [];

  for (let i = 0, chunk = 0; i < doc.length; i += chunkSize, chunk++) {
    const pre = preCredits[chunk % preCredits.length];
    applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: pre }));

    const append = await harness.send({ type: "APPEND", text: doc.slice(i, i + chunkSize) });
    applyPatchMessages(store, append);

    if (chunk % 2 === 0) {
      const post = postCredits[chunk % postCredits.length];
      applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: post }));
    }

    const blocks = store.getBlocks();
    const dirtyIndices: number[] = [];
    for (let idx = 0; idx < blocks.length; idx++) {
      if (!blocks[idx].isFinalized) dirtyIndices.push(idx);
    }

    assert.ok(
      dirtyIndices.length <= 1,
      `chunk=${chunk}: expected at most one dirty block, found ${dirtyIndices.length} (${dirtyIndices
        .map((idx) => `${idx}:${blocks[idx].id}:${blocks[idx].type}`)
        .join(", ")})`,
    );
    if (dirtyIndices.length === 1) {
      assert.strictEqual(dirtyIndices[0], blocks.length - 1, `chunk=${chunk}: dirty block must stay at tail`);
    }

    const finalizedCount = dirtyIndices.length === 0 ? blocks.length : dirtyIndices[0];
    const stableFinalizedIds = blocks.slice(0, finalizedCount).map((block) => block.id);

    assert.ok(
      stableFinalizedIds.length >= previousStableFinalizedIds.length,
      `chunk=${chunk}: finalized prefix regressed in length (${stableFinalizedIds.length} < ${previousStableFinalizedIds.length})`,
    );
    for (let idx = 0; idx < previousStableFinalizedIds.length; idx++) {
      assert.strictEqual(
        stableFinalizedIds[idx],
        previousStableFinalizedIds[idx],
        `chunk=${chunk}: finalized prefix order drifted at index ${idx}`,
      );
    }
    previousStableFinalizedIds = stableFinalizedIds;

    for (let idx = 0; idx < finalizedCount; idx++) {
      const block = blocks[idx];
      const signature = blockSignature(block);
      const prior = seenFinalized.get(block.id);
      if (prior === undefined) {
        seenFinalized.set(block.id, signature);
      } else {
        assert.strictEqual(prior, signature, `chunk=${chunk}: finalized block mutated after stabilization (${block.id})`);
      }
    }
  }

  applyPatchMessages(store, await harness.send({ type: "FINALIZE" }));
  const postFinalizeCredits = await harness.send({ type: "SET_CREDITS", credits: 1 });
  const postFinalizeOps = countPatchOps(postFinalizeCredits);
  assert.strictEqual(
    postFinalizeOps,
    0,
    `expected no deferred patch ops after FINALIZE, but SET_CREDITS emitted ${postFinalizeOps}`,
  );

  const finalBlocks = store.getBlocks();
  assert.ok(finalBlocks.every((block) => block.isFinalized), "all blocks must be finalized at end of stress replay run");
}

await runDeferredReplayGuardTest();
console.log("deferred stale replay guard regression test passed");
