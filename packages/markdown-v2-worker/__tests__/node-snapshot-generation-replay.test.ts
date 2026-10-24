import assert from "node:assert";
import type { Worker } from "node:worker_threads";

import { createInitialSnapshot, PATCH_ROOT_ID, STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
import type { Block, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { compileMarkdownSnapshot, createWorkerThread } from "../src/node/index";

type InitializedMessage = Extract<WorkerOut, { type: "INITIALIZED" }>;
type PatchMessage = Extract<WorkerOut, { type: "PATCH" }>;
type FinalizedMessage = Extract<WorkerOut, { type: "FINALIZED" }>;

const OLD_TEXT = "# Old semantics\n\n";
const OLD_HEADING_TEXT = "Old semantics";
const CURRENT_TEXT = "# Current semantics";
const CURRENT_HEADING_TEXT = "Current semantics";

function hasGenericHeadingSemanticPatch(message: PatchMessage, headingText: string): boolean {
  return message.patches.some((patch) => {
    if (
      (patch.op !== "insertChild" && patch.op !== "replaceChild") ||
      patch.meta?.kind !== "semantic" ||
      patch.at.blockId !== PATCH_ROOT_ID ||
      patch.node.type !== "heading"
    ) {
      return false;
    }
    const block = patch.node.props?.block as Block | undefined;
    return block?.type === "heading" && block.payload.meta?.headingText === headingText;
  });
}

interface CapturedAppend {
  initialized: InitializedMessage;
  headingPatch: PatchMessage;
  finalized: FinalizedMessage;
}

/**
 * Node 20 lacks Promise.withResolvers; keep this worker-event deferred compatible with the package runtime.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function captureAppendedHeading(worker: Worker): Promise<CapturedAppend> {
  const { promise, resolve, reject } = deferred<CapturedAppend>();
  let initialized: InitializedMessage | null = null;
  let headingPatch: PatchMessage | null = null;
  let finalizeSent = false;
  let settled = false;

  const cleanup = () => {
    worker.off("message", onMessage);
    worker.off("error", onError);
    worker.off("exit", onExit);
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const send = (message: WorkerIn) => {
    try {
      worker.postMessage(message);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const onError = (error: Error) => fail(error);
  const onExit = (code: number) => fail(new Error(`Worker exited before the append/finalize fixture completed (code ${code})`));
  const onMessage = (message: WorkerOut) => {
    if (message.type === "ERROR") {
      fail(new Error(`Worker error (${message.phase}): ${message.error.message}`));
      return;
    }
    if (message.type === "RESET") {
      fail(new Error(`Worker reset during append/finalize fixture: ${message.reason}`));
      return;
    }
    if (message.type === "INITIALIZED") {
      initialized = message;
      send({ type: "APPEND", text: OLD_TEXT });
      return;
    }
    if (
      message.type === "PATCH" &&
      initialized &&
      message.generation === initialized.generation &&
      hasGenericHeadingSemanticPatch(message, OLD_HEADING_TEXT)
    ) {
      headingPatch = message;
      finalizeSent = true;
      send({ type: "FINALIZE" });
      return;
    }
    if (
      message.type === "FINALIZED" &&
      initialized &&
      finalizeSent &&
      message.generation === initialized.generation
    ) {
      if (!headingPatch) {
        fail(new Error("The append/finalize fixture finalized without an appended semantic heading patch"));
        return;
      }
      settled = true;
      cleanup();
      resolve({ initialized, headingPatch, finalized: message });
    }
  };

  worker.on("message", onMessage);
  worker.on("error", onError);
  worker.on("exit", onExit);
  send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
  });
  return promise;
}

async function runNodeSnapshotGenerationReplayTest(): Promise<void> {
  const worker = createWorkerThread();
  try {
    const oldRun = await captureAppendedHeading(worker);
    assert.equal(oldRun.initialized.snapshot.inputSource?.generation, oldRun.initialized.generation);
    assert.equal(oldRun.initialized.snapshot.inputSource?.raw, "");
    assert.equal(oldRun.headingPatch.generation, oldRun.initialized.generation, "the saved semantic patch must retain its observed wire generation");
    assert.equal(oldRun.finalized.generation, oldRun.initialized.generation);

    let currentInitialization: InitializedMessage | null = null;
    let currentBaselineHeading: Block | null = null;
    let currentFinalized: FinalizedMessage | null = null;
    let replayedOldMessage = false;
    let armed = true;
    const replayAtCurrentFinalize = (message: WorkerOut) => {
      if (!armed) return;
      if (message.type === "INITIALIZED") {
        currentInitialization = message;
        currentBaselineHeading = createInitialSnapshot(message.snapshot).getBlocks().find((block) =>
          block.type === "heading" && block.payload.meta?.headingText === CURRENT_HEADING_TEXT
        ) ?? null;
        return;
      }
      if (
        message.type === "FINALIZED" &&
        currentInitialization &&
        message.generation === currentInitialization.generation
      ) {
        currentFinalized = message;
        armed = false;
        worker.off("message", replayAtCurrentFinalize);
        replayedOldMessage = true;
        // Replay the complete actual PATCH message, unchanged, at the external EventEmitter boundary.
        worker.emit("message", oldRun.headingPatch);
      }
    };

    worker.prependListener("message", replayAtCurrentFinalize);
    const result = await compileMarkdownSnapshot({
      text: CURRENT_TEXT,
      init: { prewarmLangs: [] },
      worker,
    });

    assert.ok(currentInitialization, "the second public compile must emit INITIALIZED");
    assert.ok(currentBaselineHeading, "the current INITIALIZED snapshot must contain its current heading");
    assert.ok(currentFinalized, "the second public compile must emit FINALIZED");
    assert.ok(replayedOldMessage, "the saved old PATCH must be replayed immediately before forwarding the current FINALIZED");
    assert.equal(currentInitialization.snapshot.inputSource?.generation, currentInitialization.generation);
    assert.equal(currentInitialization.snapshot.inputSource?.raw, CURRENT_TEXT, "the current baseline must be the observed current document");
    assert.notEqual(currentInitialization.generation, oldRun.initialized.generation, "the current baseline must belong to another observed generation");
    assert.equal(currentBaselineHeading.payload.raw, CURRENT_TEXT);
    assert.equal(currentBaselineHeading.payload.meta?.headingText, CURRENT_HEADING_TEXT);
    assert.equal(currentFinalized.generation, currentInitialization.generation);
    assert.equal(result.fromCache, false, "the provided worker compile must bypass snapshot cache");

    assert.deepStrictEqual(result.blocks.map((block) => block.type), ["heading"], "the returned snapshot must contain only the current heading");
    const [heading] = result.blocks;
    assert.ok(heading);
    assert.deepStrictEqual(
      {
        raw: heading.payload.raw,
        range: heading.payload.range,
        metadata: heading.payload.meta,
        isFinalized: heading.isFinalized,
      },
      {
        raw: CURRENT_TEXT,
        range: { from: 0, to: 19 },
        metadata: {
          lezerNodeType: "ATXHeading1",
          headingLevel: 1,
          headingText: "Current semantics",
          headingId: "current-semantics",
        },
        isFinalized: true,
      },
      "the returned block must retain the exact current raw source, range and heading metadata",
    );
  } finally {
    await worker.terminate();
  }
}

await runNodeSnapshotGenerationReplayTest();
console.log("Node snapshot generation replay test passed");
