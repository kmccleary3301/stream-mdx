import assert from "node:assert/strict";
import { MarkdownRenderer } from "../src/renderer";
import { createInlineEngineWorker } from "../../markdown-v2-worker/src/engine/transport";

const renderer = new MarkdownRenderer();
const worker = createInlineEngineWorker();
renderer.attachWorker(worker);
try {
  assert.throws(
    () => renderer.append("x".repeat(1024 * 1024)),
    (error: Error) => error.name === "SourceCapacityError",
    "an oversized append must be refused before a worker is ready",
  );
  const accepted = renderer.append("safe");
  assert.equal(accepted.acceptedSourceUnits, 4, "refusing an append must not partially advance the accepted source frontier");
  assert.equal(accepted.pendingSourceUnits, 4, "only the subsequent accepted append may occupy admission capacity");
} finally {
  renderer.detachWorker();
  worker.terminate?.();
}

async function verifyQueuedFinalizeBarrier(): Promise<void> {
  const queuedRenderer = new MarkdownRenderer();
  const queuedWorker = createInlineEngineWorker();
  queuedRenderer.attachWorker(queuedWorker);
  try {
    queuedRenderer.append("all host-");
    queuedRenderer.append("accepted chunks");
    await queuedRenderer.finalize();
    const blocks = queuedRenderer.getStore().getBlocks();
    assert.equal(blocks[0]?.payload.raw, "all host-accepted chunks", "finalize completion must cover pre-ready accepted input");
    assert.equal(blocks[0]?.isFinalized, true, "finalize completion must expose committed EOF semantics");
  } finally {
    queuedRenderer.detachWorker();
    queuedWorker.terminate?.();
  }
}

async function verifyFinalizationGenerationReuse(): Promise<void> {
  const reusedRenderer = new MarkdownRenderer();
  const reusedWorker = createInlineEngineWorker();
  reusedRenderer.attachWorker(reusedWorker);
  try {
    reusedRenderer.append("first");
    const firstBarrier = reusedRenderer.finalize();
    assert.strictEqual(reusedRenderer.finalize(), firstBarrier, "one generation shares one finalization promise");
    const firstResult = await firstBarrier;
    assert.equal(firstResult.acceptedSourceUnits, 5);
    assert.equal(firstResult.committedSourceUnits, 5);

    reusedRenderer.restart();
    reusedRenderer.append("next");
    const nextBarrier = reusedRenderer.finalize();
    assert.notStrictEqual(nextBarrier, firstBarrier, "a restarted generation cannot reuse a settled finalization promise");
    assert.throws(
      () => reusedRenderer.append("late"),
      (error: unknown) => error instanceof Error && "reason" in error && error.reason === "sealed",
      "finalization seals admission before its asynchronous barrier completes",
    );
    const nextResult = await nextBarrier;
    assert.notEqual(nextResult.generation, firstResult.generation);
    assert.equal(nextResult.acceptedSourceUnits, 4);
    assert.equal(nextResult.committedSourceUnits, 4);
    assert.equal(reusedRenderer.getStore().getBlocks()[0]?.payload.raw, "next");
  } finally {
    reusedRenderer.detachWorker();
    reusedWorker.terminate?.();
  }
}

async function verifyRegexEligibilityAcrossAppendContexts(): Promise<void> {
  const reusedRenderer = new MarkdownRenderer();
  const reusedWorker = createInlineEngineWorker();
  reusedRenderer.attachWorker(reusedWorker);
  try {
    reusedRenderer.append("plain ");
    reusedRenderer.append("@reader");
    await reusedRenderer.finalize();
    const paragraph = reusedRenderer.getStore().getBlocks().find((block) => block.type === "paragraph");
    assert.equal(paragraph?.payload.raw, "plain @reader");
    assert.ok(paragraph?.payload.inline?.some((node) => node.kind === "mention" && node.handle === "reader"),
      "a negative regex check for earlier source cannot hide a later mention");
  } finally {
    reusedRenderer.detachWorker();
    reusedWorker.terminate?.();
  }
}

void verifyQueuedFinalizeBarrier().then(verifyFinalizationGenerationReuse).then(verifyRegexEligibilityAcrossAppendContexts).then(
  () => console.log("renderer source admission test passed"),
  (error) => { console.error(error); process.exitCode = 1; },
);
