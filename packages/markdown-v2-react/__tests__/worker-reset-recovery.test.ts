import assert from "node:assert";
import type { Block, Patch, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { createBlockSnapshot, PATCH_ROOT_ID, STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
import { MarkdownRenderer } from "../src/renderer";

class ResetTestWorker {
  public messages: WorkerIn[] = [];
  private listeners: Array<(event: MessageEvent<WorkerOut>) => void> = [];

  addEventListener(type: string, listener: (event: MessageEvent<WorkerOut>) => void): void {
    if (type === "message") {
      this.listeners.push(listener);
    }
  }

  removeEventListener(type: string, listener: (event: MessageEvent<WorkerOut>) => void): void {
    if (type === "message") {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    }
  }

  postMessage(message: WorkerIn): void {
    this.messages.push(message);
  }

  emit(message: WorkerOut): void {
    const event = { data: message } as MessageEvent<WorkerOut>;
    this.listeners.forEach((listener) => listener(event));
  }

  terminate(): void {}
}

function buildInsertPatch(block: Block): Patch {
  return {
    op: "insertChild",
    at: { blockId: PATCH_ROOT_ID },
    index: 0,
    node: createBlockSnapshot(block),
  };
}

function makeParagraph(id: string, text: string): Block {
  return {
    id,
    type: "paragraph",
    isFinalized: true,
    payload: {
      raw: text,
      inline: [{ kind: "text", text }],
    },
  };
}

function testResetRecovery(): void {
  const renderer = new MarkdownRenderer({ plugins: { math: true, mdx: true, html: true, tables: true, callouts: true } });
  const worker = new ResetTestWorker();
  renderer.attachWorker(worker as unknown as Worker);

  worker.emit({ type: "INITIALIZED", schemaVersion: STREAM_MDX_SCHEMA_VERSION, generation: 1, snapshot: { id: PATCH_ROOT_ID, type: "__root__", inputSource: { generation: 1, raw: "Hello world" }, children: [] } });
  assert.strictEqual(renderer.getStore().getBlocks().length, 0, "store should start empty");
  let updateCount = 0;
  const unsubscribe = renderer.onUpdate(() => {
    updateCount += 1;
  });
  worker.emit({
    type: "PATCH",
    tx: 0,
    patches: [{
      op: "appendInputSource",
      at: { blockId: PATCH_ROOT_ID },
      generation: 1,
      from: "Hello world".length,
      text: "!",
    }],
  });
  renderer.flushPendingPatches();
  assert.strictEqual(updateCount, 0, "input-only source retention does not notify public block listeners");

  worker.emit({ type: "PATCH", tx: 1, patches: [buildInsertPatch(makeParagraph("a", "Hello world"))] });
  renderer.flushPendingPatches();
  const firstBlocks = renderer.getStore().getBlocks();
  assert.strictEqual(firstBlocks.length, 1, "expected one block after initial patch");
  assert.strictEqual(firstBlocks[0].payload.raw, "Hello world", "initial patch content mismatch");
  assert.strictEqual(updateCount, 1, "the following semantic block update still notifies public block listeners");

  // Simulate worker crash/reset, then re-init.
  worker.emit({ type: "RESET", reason: "simulated-crash" });
  worker.emit({ type: "INITIALIZED", schemaVersion: STREAM_MDX_SCHEMA_VERSION, generation: 2, snapshot: { id: PATCH_ROOT_ID, type: "__root__", inputSource: { generation: 2, raw: "Recovered" }, children: [] } });
  assert.strictEqual(renderer.getStore().getBlocks().length, 0, "store should clear after reset+reinit");

  worker.emit({ type: "PATCH", tx: 2, patches: [buildInsertPatch(makeParagraph("b", "Recovered"))] });
  renderer.flushPendingPatches();
  const recoveredBlocks = renderer.getStore().getBlocks();
  assert.strictEqual(recoveredBlocks.length, 1, "expected one block after recovery patch");
  assert.strictEqual(recoveredBlocks[0].payload.raw, "Recovered", "recovery patch content mismatch");
  unsubscribe();

  renderer.detachWorker();
}

testResetRecovery();
console.log("worker reset recovery test passed");
