import { EventEmitter } from "node:events";
import type { WorkerIn, WorkerOut } from "@stream-mdx/core";

class FakeWorkerGlobal extends EventEmitter {
  onmessage: ((event: MessageEvent<WorkerIn>) => void | Promise<void>) | null = null;

  async dispatch(event: WorkerIn): Promise<void> {
    await this.onmessage?.({ data: event } as MessageEvent<WorkerIn>);
  }
}

let workerScope: FakeWorkerGlobal | null = null;
let workerLoaded = false;
let activeQueue: WorkerOut[] | null = null;

async function ensureWorkerLoaded(): Promise<FakeWorkerGlobal> {
  if (workerLoaded && workerScope) {
    return workerScope;
  }

  workerScope = new FakeWorkerGlobal();
  (globalThis as any).self = workerScope;
  (globalThis as any).postMessage = (msg: WorkerOut) => {
    if (activeQueue) {
      activeQueue.push(msg);
      return;
    }
    // Tests only care about messages tied to the active dispatch; drop late emissions.
  };

  await import("../src/worker");
  workerLoaded = true;
  return workerScope;
}

export interface WorkerHarness {
  send(message: WorkerIn): Promise<WorkerOut[]>;
}

export async function createWorkerHarness(): Promise<WorkerHarness> {
  const scope = await ensureWorkerLoaded();
  return {
    async send(message: WorkerIn) {
      const queue: WorkerOut[] = [];
      activeQueue = queue;
      try {
        await scope.dispatch(message);
      } finally {
        activeQueue = null;
      }
      return queue;
    },
  };
}
