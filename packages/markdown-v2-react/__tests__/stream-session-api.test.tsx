import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { SourceCapacityError, StreamSessionError, StreamingMarkdown, type StreamingMarkdownHandle } from "../src";

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  Worker: NodeWorker,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
};
const previousGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

const container = dom.window.document.getElementById("root");
assert.ok(container, "missing render root");
const root = createRoot(container);
const handle = createRef<StreamingMarkdownHandle>();
const workers: Worker[] = [];
const workerFactory = (): Worker => {
  const worker = createInlineEngineWorker();
  workers.push(worker as unknown as Worker);
  return worker as unknown as Worker;
};

try {
  await act(async () => {
    root.render(<StreamingMarkdown ref={handle} engine="worker" worker={workerFactory} />);
  });
  await waitFor(() => handle.current?.getState().workerReady === true, "initial public session did not initialize");

  const previousGenerationHandle = handle.current;
  assert.ok(previousGenerationHandle, "the initial public session handle is mounted");
  await act(async () => {
    previousGenerationHandle.restart();
  });
  await waitFor(
    () => handle.current !== previousGenerationHandle && handle.current?.getState().workerReady === true,
    "restart did not publish the next public session handle",
  );

  assert.throws(
    () => previousGenerationHandle.append("stale generation"),
    (error: unknown) => error instanceof StreamSessionError && error.reason === "stale-generation",
    "a retained handle from an ended generation must not append into its replacement",
  );
  const currentSession = handle.current;
  assert.ok(currentSession, "the replacement public session handle is mounted");
  const firstAppend = currentSession.append("safe");
  assert.deepEqual(firstAppend, {
    acceptedSourceUnits: 4,
    pendingSourceUnits: 4,
    shouldPause: false,
  }, "append reports the accepted session frontier and pending source units");
  assert.throws(
    () => currentSession.append("x".repeat(262_145)),
    (error: unknown) => error instanceof SourceCapacityError,
    "an oversized chunk is rejected at the public append seam",
  );
  assert.equal(currentSession.append("tail").acceptedSourceUnits, 8,
    "a rejected chunk leaves the accepted session frontier unchanged");
  await assert.rejects(
    currentSession.waitForCapacity({ units: 262_145 }),
    (error: unknown) => error instanceof SourceCapacityError,
    "capacity waits reject requests larger than the hard limit",
  );
  const abortedWait = new AbortController();
  abortedWait.abort();
  await assert.rejects(
    currentSession.waitForCapacity({ units: 0, signal: abortedWait.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
    "capacity waits honor their abort signal",
  );

  const pressured = currentSession.append("p".repeat(65_536));
  assert.equal(pressured.acceptedSourceUnits, 65_544);
  assert.equal(pressured.shouldPause, true, "the soft admission threshold requests a wait");
  const endedGenerationWait = currentSession.waitForCapacity({ units: 0 });
  const staleWaitAssertion = assert.rejects(
    endedGenerationWait,
    (error: unknown) => error instanceof StreamSessionError && error.reason === "stale-generation",
    "capacity waiters from a replaced generation reject instead of hanging",
  );
  await act(async () => {
    currentSession.restart();
  });
  await staleWaitAssertion;
  await waitFor(
    () => handle.current !== currentSession && handle.current?.getState().workerReady === true,
    "restart did not publish the next public session handle",
  );

  const finalSession = handle.current;
  assert.ok(finalSession, "the final public session handle is mounted");
  const finalAppend = finalSession.append("final");
  const finalization = finalSession.finalize();
  assert.strictEqual(finalSession.finalize(), finalization,
    "repeated finalize calls share the generation's promise");
  assert.throws(
    () => finalSession.append("late"),
    (error: unknown) => error instanceof StreamSessionError && error.reason === "sealed",
    "finalize seals the session before its promise resolves",
  );
  const finalizationResult = await finalization;
  assert.ok(Number.isSafeInteger(finalizationResult.generation), "finalization reports its native generation");
  assert.equal(finalizationResult.acceptedSourceUnits, finalAppend.acceptedSourceUnits);
  assert.equal(finalizationResult.committedSourceUnits, finalAppend.acceptedSourceUnits,
    "finalize resolves after previously accepted source commits");


  const disposedHandle = handle.current;
  assert.ok(disposedHandle, "the replacement public session handle is mounted");
  await act(async () => {
    root.unmount();
  });
  assert.throws(
    () => disposedHandle.append("after disposal"),
    (error: unknown) => error instanceof StreamSessionError && error.reason === "disposed",
    "a retained handle must report disposed use after unmount",
  );
} finally {
  for (const worker of workers) worker.terminate();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.window.close();
}

console.log("public stream session API tests passed");
