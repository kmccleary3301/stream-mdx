import assert from "node:assert/strict";
import { createInitialSnapshot, STREAM_MDX_SCHEMA_VERSION, type WorkerOut } from "@stream-mdx/core";
import {
  STREAM_MDX_PROTOCOL_ID,
  type StreamMdxDoneEvent,
  type StreamMdxErrorEvent,
  type StreamMdxEvent,
  type StreamMdxEventBase,
  type StreamMdxInitEvent,
  type StreamMdxMetricsEvent,
  type StreamMdxPatchEvent,
  type StreamMdxSnapshotEvent,
} from "@stream-mdx/protocol";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { createSnapshotStore, type StreamMdxSnapshotStore } from "../src/index";

const STREAM_ID = "native-document-lifetime";
const ANNOUNCED_STREAM_ID = "announced-document-lifetime";
const FOREIGN_STREAM_ID = "foreign-document-lifetime";

type Initialized = Extract<WorkerOut, { type: "INITIALIZED" }>;
type WorkerPatch = Extract<WorkerOut, { type: "PATCH" }>;

type StreamMdxEventEnvelope = Pick<
  StreamMdxEventBase,
  "protocol" | "schemaVersion" | "streamId" | "generation"
>;

function eventEnvelope(generation: number, streamId: string): StreamMdxEventEnvelope {
  return {
    protocol: STREAM_MDX_PROTOCOL_ID,
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    streamId,
    generation,
  };
}

function initEvent(generation: number, shikiVersion: string, streamId = STREAM_ID): StreamMdxInitEvent {
  return { ...eventEnvelope(generation, streamId), event: "init", shikiVersion };
}

function snapshotEvent(
  initialized: Initialized,
  streamId = STREAM_ID,
  envelopeGeneration = initialized.generation,
): StreamMdxSnapshotEvent {
  return {
    ...eventEnvelope(envelopeGeneration, streamId),
    event: "snapshot",
    snapshot: initialized.snapshot,
  };
}

function patchEvent(patch: WorkerPatch, tx = patch.tx, streamId = STREAM_ID): StreamMdxPatchEvent {
  return {
    ...eventEnvelope(patch.generation, streamId),
    event: "patch",
    tx,
    patches: patch.patches,
    metrics: patch.metrics,
  };
}

function metricsEvent(generation: number, metrics: StreamMdxMetricsEvent["metrics"], streamId = STREAM_ID): StreamMdxMetricsEvent {
  return { ...eventEnvelope(generation, streamId), event: "metrics", metrics };
}

function errorEvent(generation: number, message: string, streamId = STREAM_ID): StreamMdxErrorEvent {
  return { ...eventEnvelope(generation, streamId), event: "error", message };
}

function doneEvent(
  generation: number,
  status: StreamMdxDoneEvent["status"],
  finalTx: number,
  streamId = STREAM_ID,
): StreamMdxDoneEvent {
  return { ...eventEnvelope(generation, streamId), event: "done", status, finalTx };
}

async function initialize(
  engine: MarkdownEngine,
  emitted: WorkerOut[],
  initialContent: string,
): Promise<Initialized> {
  const start = emitted.length;
  await engine.handle({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent,
    prewarmLangs: [],
  });
  const initialized = emitted.slice(start).find((message): message is Initialized => message.type === "INITIALIZED");
  assert.ok(initialized, "the public engine must emit a genuine INITIALIZED root");
  assert.equal(initialized.snapshot.inputSource?.generation, initialized.generation,
    "the captured root carries its native generation");
  return initialized;
}

async function appendPatches(engine: MarkdownEngine, emitted: WorkerOut[], text: string): Promise<WorkerPatch[]> {
  const start = emitted.length;
  await engine.handle({ type: "APPEND", text });
  return emitted.slice(start).filter((message): message is WorkerPatch => message.type === "PATCH");
}

function storeText(store: StreamMdxSnapshotStore): string {
  return store.getBlocks().map((block) => block.payload.raw).join("\n");
}

function assertContains(store: StreamMdxSnapshotStore, text: string, message: string): void {
  assert.ok(storeText(store).includes(text), message);
}

async function runSchema2GenerationAdmissionTest(): Promise<void> {
  const emitted: WorkerOut[] = [];
  const engine = new MarkdownEngine({
    post(message) {
      if (message.type === "INITIALIZED" || message.type === "PATCH") emitted.push(structuredClone(message));
    },
  });

  try {
    const g1 = await initialize(engine, emitted, "# Generation one stale root\n\n");
    const g1Patches = await appendPatches(engine, emitted, "Generation one stale append.\n\n");
    const g2 = await initialize(engine, emitted, "# Generation two current root\n\n");
    const g2Patches = await appendPatches(engine, emitted, "Generation two current append.\n\n");
    const g3 = await initialize(engine, emitted, "# Generation three successor root\n\n");
    const g3Patches = await appendPatches(engine, emitted, "Generation three successor append.\n\n");

    assert.ok(g1.generation < g2.generation && g2.generation < g3.generation,
      "one public engine must capture three successive native generations");
    assert.ok(g1Patches.length > 0 && g2Patches.length > 0,
      "both generations must provide genuine native PATCH payloads for the stale-event replay");

    const store = createSnapshotStore();
    store.applyEvents([
      initEvent(g1.generation, "generation-one-init"),
      snapshotEvent(g1),
      ...g1Patches.map((patch) => patchEvent(patch)),
      metricsEvent(g1.generation, { patchCount: 3, changedBlocks: 1, parseTime: 11 }),
      errorEvent(g1.generation, "generation-one diagnostic"),
      doneEvent(g1.generation, "error", g1Patches[g1Patches.length - 1]!.tx),
    ]);
    assertContains(store, "Generation one stale append.", "the initial genuine PATCH must publish its native source");

    store.applyEvents([
      initEvent(g2.generation, "generation-two-init"),
      snapshotEvent(g2),
    ]);
    const resetMeta = store.getMeta();
    assert.equal(resetMeta.lastTx, undefined, "accepting a new native root clears the prior transaction");
    assert.equal(resetMeta.metrics, undefined, "accepting a new native root clears prior metrics");
    assert.equal(resetMeta.error, undefined, "accepting a new native root clears a prior error");
    assert.equal(resetMeta.done, undefined, "accepting a new native root clears prior completion");

    store.setSnapshot(g2.snapshot);
    assertContains(store, "Generation two current root", "an explicit same-generation native baseline remains usable");

    const lastG2Patch = g2Patches[g2Patches.length - 1]!;
    const currentTx = 10_000 + lastG2Patch.tx;
    store.applyEvents(g2Patches.map((patch, index) =>
      patchEvent(patch, index === g2Patches.length - 1 ? currentTx : patch.tx)));
    const currentMetrics = { patchCount: 2, changedBlocks: 1, parseTime: 29 };
    store.applyEvents([
      metricsEvent(g2.generation, currentMetrics),
      errorEvent(g2.generation, "generation-two diagnostic"),
      doneEvent(g2.generation, "ok", currentTx),
    ]);

    assertContains(store, "Generation two current root", "G2 must be the current published root before stale replay");
    assertContains(store, "Generation two current append.", "G2's genuine native PATCH must publish current meaning");
    assert.equal(store.getMeta().init?.shikiVersion, "generation-two-init");
    assert.equal(store.getMeta().lastTx, currentTx);
    assert.deepEqual(store.getMeta().metrics, currentMetrics);
    assert.equal(store.getMeta().error?.message, "generation-two diagnostic");
    assert.equal(store.getMeta().done?.status, "ok");

    const staleMetrics = { patchCount: 91, changedBlocks: 17, parseTime: 991 };
    const staleEvents: StreamMdxEvent[] = [
      initEvent(g1.generation, "late-generation-one-init"),
      metricsEvent(g1.generation, staleMetrics),
      errorEvent(g1.generation, "late generation-one diagnostic"),
      doneEvent(g1.generation, "error", g1Patches[g1Patches.length - 1]!.tx),
      snapshotEvent(g1),
      ...g1Patches.map((patch) => patchEvent(patch)),
    ];
    store.applyEvents(staleEvents);

    assertContains(store, "Generation two current root", "late G1 events cannot replace the accepted G2 root");
    assertContains(store, "Generation two current append.", "late G1 events cannot remove G2's accepted PATCH meaning");
    assert.equal(storeText(store).includes("Generation one stale root"), false,
      "late G1 snapshot and PATCH payloads cannot roll the document back");
    const afterStale = store.getMeta();
    assert.equal(afterStale.init?.shikiVersion, "generation-two-init", "late G1 init cannot replace current metadata");
    assert.equal(afterStale.lastTx, currentTx, "late G1 PATCH cannot regress the transaction metadata");
    assert.deepEqual(afterStale.metrics, currentMetrics, "late G1 metrics cannot replace current metrics");
    assert.equal(afterStale.error?.message, "generation-two diagnostic", "late G1 error cannot replace current metadata");
    assert.equal(afterStale.done?.status, "ok", "late G1 done cannot replace current completion metadata");

    store.setSnapshot(g1.snapshot);
    assertContains(store, "Generation two current append.",
      "explicit stale native-baseline replacement cannot bypass the accepted generation bound");
    store.setSnapshot(g2.snapshot);
    assertContains(store, "Generation two current root", "same-generation explicit baseline replacement retains native meaning");
    assert.equal(storeText(store).includes("Generation two current append."), false,
      "the explicit G2 baseline replaces the later same-generation patch state");
    store.applyEvent(snapshotEvent(g3, FOREIGN_STREAM_ID));
    assertContains(store, "Generation two current root", "explicit baseline replacement retains the store's stream ownership");
    assert.equal(storeText(store).includes("Generation three successor root"), false,
      "a newer root from another stream cannot take over the owned store");

    const announcedStore = createSnapshotStore();
    announcedStore.applyEvent(initEvent(g2.generation, "announced-generation-two", ANNOUNCED_STREAM_ID));
    announcedStore.applyEvent(snapshotEvent(g3, ANNOUNCED_STREAM_ID));
    assertContains(announcedStore, "Generation three successor root",
      "a genuine same-stream G3 baseline may supersede an unadmitted G2 initialization");
    assert.equal(announcedStore.getMeta().init?.shikiVersion, "announced-generation-two",
      "the store retains the actual announcement without synthesizing an initialization receipt");

    const mismatchedStore = createSnapshotStore();
    mismatchedStore.applyEvent(snapshotEvent(g2, "mismatched-envelope-stream", g1.generation));
    assert.equal(storeText(mismatchedStore).includes("Generation two current root"), false,
      "a snapshot envelope/native-generation mismatch is rejected before baseline admission");
    mismatchedStore.applyEvent(snapshotEvent(g3, "valid-after-mismatch-stream"));
    assertContains(mismatchedStore, "Generation three successor root",
      "a rejected mismatched envelope cannot claim stream ownership");
    const coldReplacementBlocks = createInitialSnapshot(g3.snapshot).getBlocks();
    const coldReplacementStore = createSnapshotStore();
    const coldLastG2Patch = g2Patches[g2Patches.length - 1]!;
    const coldOwnerTx = 20_000 + coldLastG2Patch.tx;
    const coldOwnerMetrics = { patchCount: 4, changedBlocks: 2, parseTime: 39 };
    coldReplacementStore.applyEvents([
      initEvent(g2.generation, "cold-replacement-generation-two-init"),
      snapshotEvent(g2),
      ...g2Patches.map((patch, index) =>
        patchEvent(patch, index === g2Patches.length - 1 ? coldOwnerTx : patch.tx)),
      metricsEvent(g2.generation, coldOwnerMetrics),
      errorEvent(g2.generation, "cold replacement prior diagnostic"),
      doneEvent(g2.generation, "ok", coldOwnerTx),
    ]);

    coldReplacementStore.setSnapshot(coldReplacementBlocks);
    assertContains(coldReplacementStore, "Generation three successor root",
      "the public Core cold getBlocks projection becomes the replacement meaning");
    const metadataBeforeRetiredReplay = coldReplacementStore.getMeta();
    const retiredMetrics = { patchCount: 88, changedBlocks: 12, parseTime: 880 };
    coldReplacementStore.applyEvents([
      initEvent(g2.generation, "retired-generation-two-init"),
      snapshotEvent(g2),
      ...g2Patches.map((patch) => patchEvent(patch)),
      metricsEvent(g2.generation, retiredMetrics),
      errorEvent(g2.generation, "retired generation-two diagnostic"),
      doneEvent(g2.generation, "error", coldLastG2Patch.tx),
    ]);

    assertContains(coldReplacementStore, "Generation three successor root",
      "a matching retired-generation snapshot and its events cannot replace cold authored meaning");
    assert.equal(storeText(coldReplacementStore).includes("Generation two current append."), false,
      "a retired-generation patch cannot append to the cold replacement");
    assert.deepEqual(coldReplacementStore.getMeta(), metadataBeforeRetiredReplay,
      "retired-generation lifecycle events cannot rewrite generation-local metadata");

    coldReplacementStore.applyEvent(snapshotEvent(g2, FOREIGN_STREAM_ID));
    assertContains(coldReplacementStore, "Generation three successor root",
      "cold replacement preserves the store's existing stream ownership");

    assert.ok(g3Patches.length > 0, "the same public engine provides a genuine successor PATCH");
    coldReplacementStore.applyEvent(snapshotEvent(g3));
    assertContains(coldReplacementStore, "Generation three successor root",
      "a same-stream baseline newer than the retired generation can bind");
    coldReplacementStore.applyEvents(g3Patches.map((patch) => patchEvent(patch)));
    assertContains(coldReplacementStore, "Generation three successor append.",
      "the admitted successor baseline receives its actual native PATCH");
    assert.equal(coldReplacementStore.getMeta().lastTx, g3Patches[g3Patches.length - 1]!.tx,
      "the actual successor PATCH publishes its native transaction metadata");

  } finally {
    engine.dispose();
  }
}

runSchema2GenerationAdmissionTest()
  .then(() => console.log("Schema 2 generation admission test passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
