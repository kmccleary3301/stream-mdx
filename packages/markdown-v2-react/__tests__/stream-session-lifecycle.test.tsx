import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
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
const features = { tables: true, html: false, mdx: false, math: false };
const markdown = ["| ID | Description |", "| --- | --- |", ...Array.from({ length: 60 }, (_, index) => `| Row-${index} | Description-${index} |`)].join("\n");

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * File-local deferred (Node 20 has no `Promise.withResolvers`) with the same resolve/reject
 * surface, so the iterator gates settle exactly as before.
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

async function testPendingIteratorRestart(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  const gate = deferred<void>();
  const finished = deferred<void>();
  const iterator = (async function* () {
    try {
      yield "# Before restart\n\n";
      await gate.promise;
      yield "# Cancelled source chunk\n\n";
    } finally {
      finished.resolve();
    }
  })();
  const next = iterator.next.bind(iterator);
  let pendingNext = 0;
  let maximumPendingNext = 0;
  let nextCalls = 0;
  iterator.next = (...args) => {
    nextCalls++;
    pendingNext++;
    maximumPendingNext = Math.max(maximumPendingNext, pendingNext);
    return next(...args).finally(() => { pendingNext--; });
  };
  try {
    root.render(<StreamingMarkdown ref={handle} engine="main-thread" stream={iterator} features={features} caret={false} />);
    await waitFor(() => container.textContent?.includes("Before restart") === true && pendingNext === 1,
      "real iterator enters its gated next call");
    handle.current?.restart();
    await waitFor(() => handle.current?.getState().workerReady === true && handle.current.getState().blocks.length === 0,
      "restart clears the document while next remains pending");
    const anotherIterable = { [Symbol.asyncIterator]: () => iterator };
    root.render(<StreamingMarkdown ref={handle} engine="main-thread" stream={anotherIterable}
      features={{ ...features, callouts: true }} className="changed-configuration" caret={false} />);
    await waitFor(() => Boolean(container.querySelector(".changed-configuration")) && handle.current?.getState().workerReady === true,
      "changed renderer readiness and iterable wrapper commit");
    gate.resolve();
    await finished.promise;
    await handle.current?.waitForIdle();
    assert.equal(maximumPendingNext, 1, "restart/configuration changes must not call next concurrently on the same iterator");
    assert.equal(nextCalls, 2, "an already-consumed iterator must not be restarted through another iterable wrapper");
    assert.equal(container.textContent?.includes("Cancelled source chunk"), false, "cancelled chunks do not repopulate the cleared document");
    const freshIterator = (async function* () { yield "# Fresh source\n\n"; })();
    root.render(<StreamingMarkdown ref={handle} engine="main-thread" stream={freshIterator} features={features} caret={false} />);
    await waitFor(() => container.textContent?.includes("Fresh source") === true, "a fresh iterator starts a new document");
    let factoryCalls = 0;
    const reiterableSource = {
      [Symbol.asyncIterator]() {
        const iteration = ++factoryCalls;
        return (async function* () { yield `# Reiterable source ${iteration}\n\n`; })();
      },
    };
    root.render(<StreamingMarkdown ref={handle} engine="main-thread" stream={reiterableSource} features={features} caret={false} />);
    await waitFor(() => container.textContent?.includes("Reiterable source 1") === true, "reiterable source supplies its first iterator");
    handle.current?.restart();
    await waitFor(() => container.textContent?.includes("Reiterable source 2") === true, "restart accepts a fresh actual iterator from a reiterable source");
    assert.equal(factoryCalls, 2, "each source generation acquires its actual iterator only once");
  } finally {
    root.unmount();
    gate.resolve();
    await finished.promise;
    container.remove();
  }
}

async function testRestartAfterEOF(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  const iterator = (async function* () { yield "# Completed source\n\n"; })();
  const next = iterator.next.bind(iterator);
  let nextCalls = 0;
  iterator.next = (...args) => { nextCalls++; return next(...args); };
  try {
    root.render(<StreamingMarkdown ref={handle} engine="main-thread" stream={iterator} features={features} caret="block" />);
    await waitFor(() => container.textContent?.includes("Completed source") === true && !container.querySelector(".stream-mdx-caret"),
      "the real iterator reaches finalized EOF");
    assert.equal(nextCalls, 2);
    handle.current?.restart();
    await waitFor(() => handle.current?.getState().workerReady === true && handle.current.getState().blocks.length === 0,
      "restart after EOF clears the document");
    handle.current?.append("# Imperative after restart\n\n");
    await handle.current?.finalize();
    await waitFor(() => container.textContent?.includes("Imperative after restart") === true, "imperative input works after EOF restart");
    assert.equal(nextCalls, 2, "restart after EOF must not re-enter the exhausted iterator");
    assert.equal(container.textContent?.includes("Completed source"), false);
  } finally {
    root.unmount();
    container.remove();
  }
}

async function testOpenIteratorRemoval(imperativeActivity: boolean): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  const worker = createInlineEngineWorker();
  const workerFactory = () => worker;
  const gate = deferred<void>();
  const finished = deferred<void>();
  const iterator = (async function* () {
    try {
      yield `${markdown}\n\n---\n\n`;
      await gate.promise;
    } finally {
      finished.resolve();
    }
  })();
  try {
    root.render(<StreamingMarkdown ref={handle} engine="worker" worker={workerFactory} stream={iterator}
      features={features} tableVirtualization={true} caret="block" />);
    await waitFor(() => container.querySelectorAll("tbody tr[data-row-id]").length === 60, "open iterator renders every table row");
    worker.postMessage({ type: "FINALIZE" });
    await waitFor(() => handle.current?.getState().blocks.every((block) => block.isFinalized) === true,
      "every block finalizes while the iterator remains gated");
    if (imperativeActivity) {
      handle.current?.append("\n\nIndependent imperative content\n\n");
      await waitFor(() => container.textContent?.includes("Independent imperative content") === true, "imperative append owns separate activity");
      worker.postMessage({ type: "FINALIZE" });
      await waitFor(() => handle.current?.getState().blocks.every((block) => block.isFinalized) === true,
        "real engine finalization leaves imperative session ownership untouched");
    }
    root.render(<StreamingMarkdown ref={handle} engine="worker" worker={workerFactory} className="removed-open-source"
      features={features} tableVirtualization={true} caret="block" />);
    await waitFor(() => Boolean(container.querySelector(".removed-open-source")), "open stream removal commits");
    if (imperativeActivity) {
      assert.equal(container.querySelector('[data-table-virtualized="true"]'), null, "iterator cleanup must preserve independent imperative activity");
      assert.ok(container.querySelector(".stream-mdx-caret"));
      await handle.current?.finalize();
    }
    await waitFor(() => Boolean(container.querySelector('[data-table-virtualized="true"]')) && !container.querySelector(".stream-mdx-caret"),
      "removing an open iterator releases only its activity and permits finalized table windowing");
    gate.resolve();
    await finished.promise;
    assert.ok(container.querySelector('[data-table-virtualized="true"]'), "late cancelled EOF does not reopen activity");
  } finally {
    root.unmount();
    gate.resolve();
    await finished.promise;
    worker.terminate();
    container.remove();
  }
}

try {
  const failures: unknown[] = [];
  for (const test of [testPendingIteratorRestart, testRestartAfterEOF,
    () => testOpenIteratorRemoval(false), () => testOpenIteratorRemoval(true)]) {
    try { await test(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "public stream session lifecycle regressions");
} finally {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.window.close();
}
console.log("public stream session lifecycle tests passed");