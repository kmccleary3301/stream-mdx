import assert from "node:assert/strict";
import { test } from "node:test";
import { createPreviewController } from "../index";
import type {
  CompiledPreview,
  PreviewCandidate,
  PreviewClock,
  PreviewInput,
  PreviewTransport,
} from "../index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

class TestClock implements PreviewClock {
  #time = 0;
  #nextId = 0;
  #tasks = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#time;
  }

  schedule(callback: () => void, delayMs: number): () => void {
    const id = ++this.#nextId;
    this.#tasks.set(id, { at: this.#time + delayMs, callback });
    return () => this.#tasks.delete(id);
  }

  advanceBy(delayMs: number): void {
    this.#time += delayMs;
    const due = [...this.#tasks.entries()]
      .filter(([, task]) => task.at <= this.#time)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, task] of due) {
      this.#tasks.delete(id);
      task.callback();
    }
  }
}

class RecordingTransport implements PreviewTransport {
  generations: string[] = [];
  published: PreviewCandidate[] = [];
  disposed = false;
  failRevision: string | null = null;

  beginGeneration(generation: string): void {
    this.generations.push(generation);
  }

  requested(): void {}

  async publish(candidate: PreviewCandidate, isCurrent: () => boolean): Promise<boolean> {
    if (!isCurrent()) return false;
    if (candidate.identity.revision === this.failRevision) throw new Error("frame render failure");
    this.published.push(candidate);
    return true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function project(generation: string, revision: string): PreviewInput {
  return {
    generation,
    revision,
    entry: "main.tsx",
    files: new Map([["main.tsx", `export const revision = ${JSON.stringify(revision)};`]]),
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

test("preview revisions reject stale work, preserve visible identity, coalesce, and dispose", async () => {
  const clock = new TestClock();
  const transport = new RecordingTransport();
  const staleCompilation = deferred<CompiledPreview>();
  const controller = createPreviewController({
    clock,
    transport,
    compile(input) {
      if (input.revision === "stale") return staleCompilation.promise;
      if (input.revision === "broken") return Promise.reject(new Error("syntax error"));
      return Promise.resolve({ javascript: `// ${input.revision}` });
    },
  });

  const staleRequest = controller.request(project("document-1", "stale"));
  const newestRequest = controller.request(project("document-1", "newest"));
  staleCompilation.resolve({ javascript: "// stale output" });
  await Promise.all([staleRequest, newestRequest]);
  await flushMicrotasks();
  assert.deepEqual(
    transport.published.map(({ identity }) => identity),
    [{ generation: "document-1", revision: "newest" }],
    "a completed older compile must not become visible after a newer request",
  );

  await controller.request(project("document-1", "broken"));
  assert.deepEqual(controller.getState().visible, { generation: "document-1", revision: "newest" });
  assert.deepEqual(controller.getState().error?.identity, {
    generation: "document-1",
    revision: "broken",
  });

  const nextGeneration = controller.request(project("document-2", "first"));
  assert.equal(controller.getState().visible, null, "a new generation starts without the old visible candidate");
  await nextGeneration;
  clock.advanceBy(250);
  await flushMicrotasks();
  const latestPublication = transport.published[transport.published.length - 1];
  assert.deepEqual(transport.generations, ["document-1", "document-2"]);
  assert.deepEqual(latestPublication?.identity, {
    generation: "document-2",
    revision: "first",
  });
  assert.deepEqual(controller.getState().visible, { generation: "document-2", revision: "first" });
  controller.dispose();

  const runtimeErrorTransport = new RecordingTransport();
  runtimeErrorTransport.failRevision = "render-error";
  const runtimeErrorController = createPreviewController({
    transport: runtimeErrorTransport,
    compile(input) {
      return Promise.resolve({ javascript: `// ${input.revision}` });
    },
  });
  await runtimeErrorController.request(project("document-runtime-error", "last-valid"));
  await flushMicrotasks();
  await runtimeErrorController.request(project("document-runtime-error", "render-error"));
  await flushMicrotasks();
  assert.deepEqual(runtimeErrorController.getState().visible, {
    generation: "document-runtime-error",
    revision: "last-valid",
  });
  assert.deepEqual(runtimeErrorController.getState().error?.identity, {
    generation: "document-runtime-error",
    revision: "render-error",
  });
  assert.equal(runtimeErrorController.getState().error?.message, "frame render failure");
  runtimeErrorController.dispose();

  const rateClock = new TestClock();
  const rateTransport = new RecordingTransport();
  const rateController = createPreviewController({
    clock: rateClock,
    transport: rateTransport,
    compile(input) {
      return Promise.resolve({ javascript: `// ${input.revision}` });
    },
  });
  for (let index = 1; index <= 4; index += 1) {
    await rateController.request(project("document-rate", `base-${index}`));
    await flushMicrotasks();
  }
  await rateController.request(project("document-rate", "middle"));
  await rateController.request(project("document-rate", "newest"));
  rateClock.advanceBy(1000);
  await flushMicrotasks();
  assert.deepEqual(
    rateTransport.published.map(({ identity }) => identity.revision),
    ["base-1", "base-2", "base-3", "base-4", "newest"],
  );
  rateController.dispose();

  const lateCompilation = deferred<CompiledPreview>();
  const disposalTransport = new RecordingTransport();
  let compileCalls = 0;
  const disposalController = createPreviewController({
    transport: disposalTransport,
    compile() {
      compileCalls += 1;
      return lateCompilation.promise;
    },
  });
  const lateRequest = disposalController.request(project("document-dispose", "late"));
  disposalController.dispose();
  await disposalController.request(project("document-dispose", "after-dispose"));
  lateCompilation.resolve({ javascript: "// late" });
  await lateRequest;
  await flushMicrotasks();
  assert.equal(disposalTransport.published.length, 0, "disposed controllers do not publish late compiler results");
  assert.equal(compileCalls, 1, "disposed controllers do not start more compilations");
  assert.equal(disposalTransport.disposed, true);
});
