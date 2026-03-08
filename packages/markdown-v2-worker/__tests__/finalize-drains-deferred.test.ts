import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";

import type { Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";

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
    .reduce((total, msg) => total + msg.patches.length, 0);
}

function summarizePatchOps(messages: WorkerOut[]): string {
  const ops = messages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .flatMap((msg) => msg.patches.map((patch) => patch.op));
  return ops.slice(0, 10).join(", ");
}

async function runFinalizeDrainTest(): Promise<void> {
  ensureDom();

  const fixturePath = path.resolve(process.cwd(), "../../apps/docs/app/demo/naive-bayes-classifier.mdx");
  const doc = await fs.readFile(fixturePath, "utf8");

  const harness = await createWorkerHarness();
  const store = createRendererStore();

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
      formatAnticipation: true,
    },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to emit INITIALIZED");
  store.reset(init.blocks);

  for (let idx = 0; idx < doc.length; idx += 240) {
    const chunk = doc.slice(idx, idx + 240);
    const messages = await harness.send({ type: "APPEND", text: chunk });
    applyPatchMessages(store, messages);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  const finalizePatchOps = countPatchOps(finalizeMessages);
  assert.ok(finalizePatchOps > 0, "expected FINALIZE to emit patch operations");

  const postFinalizeCredits = await harness.send({ type: "SET_CREDITS", credits: 1 });
  const postFinalizePatchOps = countPatchOps(postFinalizeCredits);
  assert.strictEqual(
    postFinalizePatchOps,
    0,
    `expected no deferred patches after FINALIZE, but SET_CREDITS emitted ${postFinalizePatchOps} patch ops (${summarizePatchOps(postFinalizeCredits)})`,
  );
}

await runFinalizeDrainTest();
console.log("finalize deferred drain regression test passed");
