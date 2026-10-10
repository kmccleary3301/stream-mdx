import { EventEmitter } from "node:events";
import type { WorkerIn, WorkerOut } from "@stream-mdx/core";

class FakeWorkerGlobal extends EventEmitter {
  onmessage: ((event: MessageEvent<WorkerIn>) => void | Promise<void>) | null = null;

  async dispatch(event: WorkerIn): Promise<void> {
    await this.onmessage?.({ data: event } as MessageEvent<WorkerIn>);
  }
}

let workerScope: FakeWorkerGlobal | null = null;
let activeQueue: WorkerOut[] | null = null;

async function waitForAsyncWorkerMessages(queue: WorkerOut[], maxWaitMs = 50): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  let lastLength = queue.length;
  let idleTicks = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (queue.length === lastLength) {
      idleTicks += 1;
    } else {
      idleTicks = 0;
      lastLength = queue.length;
    }
    if (idleTicks >= 2) {
      break;
    }
  }
}

async function ensureWorkerLoaded(): Promise<FakeWorkerGlobal> {
  workerScope = new FakeWorkerGlobal();
  (globalThis as any).self = workerScope;
  (globalThis as any).postMessage = (msg: WorkerOut) => {
    if (activeQueue) {
      activeQueue.push(msg);
      return;
    }
    // Tests only care about messages tied to the active dispatch; drop late emissions.
  };

  // Force a fresh worker module instance so each test file can own its worker scope.
  await import(`../src/worker?testHarness=${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return workerScope;
}

export interface WorkerHarness {
  send(message: WorkerIn): Promise<WorkerOut[]>;
}

export async function createWorkerHarness(): Promise<WorkerHarness> {
  const scope = await ensureWorkerLoaded();
  return {
    async send(message: WorkerIn) {
      // A real postMessage delivers every WorkerIn as its own task. Without that boundary a long
      // send loop is one job, and jsdom's WeakRef-backed node-iterator set (DOMPurify creates one
      // per sanitize) keeps every sanitized document alive until the job ends.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const queue: WorkerOut[] = [];
      activeQueue = queue;
      try {
        await scope.dispatch(message);
        if (message.type === "TOKENIZE_RANGE") {
          await waitForAsyncWorkerMessages(queue);
        }
      } finally {
        activeQueue = null;
      }
      return queue;
    },
  };
}
