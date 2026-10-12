import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownRenderer } from "../src/renderer";
import { resolveWorkerSetup, useWorkerSession } from "../src/worker-session";
import type { WorkerFactories } from "../src/worker-session";
import type { MarkdownEngineMode, StreamingMarkdownProps } from "../src/streaming-markdown";

// Real Worker boundary: no engine or React module replacement.
class FakeWorker extends EventTarget implements Worker {
  onmessage: Worker["onmessage"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  onerror: Worker["onerror"] = null;
  terminations = 0;
  commands = 0;
  postMessage: Worker["postMessage"] = () => {
    this.commands++;
  };
  terminate(): void {
    this.terminations++;
  }
}

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
};
const previousGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function ownershipLifecycle(kind: "url" | "factory" | "default" | "inline" | "borrowed", managedWorker: boolean): Promise<void> {
  const created: FakeWorker[] = [];
  let releases = 0;
  let inlineCalls = 0;
  let urlCalls = 0;
  let available = true;
  let completeInline: ((worker: Worker) => void) | undefined;
  const factories: WorkerFactories = {
    available: () => available,
    fromUrl: () => { urlCalls++; const worker = new FakeWorker(); created.push(worker); return worker; },
    defaultWorker: () => { const worker = new FakeWorker(); created.push(worker); return worker; },
    releaseDefault: () => { releases++; },
    inline: () => { inlineCalls++; return new Promise<Worker>((resolve) => { completeInline = resolve; }); },
  };
  const borrowed = new FakeWorker();
  const source: StreamingMarkdownProps["worker"] = kind === "url" ? new URL("https://example.test/worker.js")
    : kind === "factory" ? () => { const worker = new FakeWorker(); created.push(worker); return worker; }
    : kind === "borrowed" ? borrowed : undefined;
  const engine: MarkdownEngineMode = kind === "inline" ? "main-thread" : "worker";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let ready = false;
  let unmounted = false;
  let committedSession = -1;
  const errors: Error[] = [];
  function Session({ session, renderer }: { session: number; renderer: MarkdownRenderer }) {
    const onErrorRef = useRef((error: Error) => { errors.push(error); });
    const state = useWorkerSession({ renderer, workerSource: source, engine, session, managedWorker,
      onErrorRef, debug: false, factories });
    ready = state.workerReady;
    committedSession = session;
    return null;
  }
  try {
    root.render(<Session session={0} renderer={new MarkdownRenderer({})} />);
    if (kind === "inline") {
      await waitFor(() => inlineCalls === 1, "inline setup starts");
      const worker = new FakeWorker(); created.push(worker); completeInline?.(worker);
    }
    await waitFor(() => ready, "session attaches worker");
    const first = kind === "borrowed" ? borrowed : created[0];
    assert.equal(first.commands, managedWorker ? 0 : 1, "management controls INIT, not lifetime");
    ready = false;
    root.render(<Session session={1} renderer={new MarkdownRenderer({})} />);
    if (kind === "inline" && !managedWorker) {
      await waitFor(() => inlineCalls === 2, "unmanaged restart creates a fresh inline worker");
      const worker = new FakeWorker(); created.push(worker); completeInline?.(worker);
    }
    await waitFor(() => committedSession === 1 && ready, "restart attaches the next renderer");
    assert.equal(first.terminations, kind === "borrowed" || managedWorker ? 0 : 1,
      "managed restart reuses its worker; unmanaged restart disposes owned workers");
    root.unmount();
    unmounted = true;
    for (const worker of created) assert.equal(worker.terminations, 1, "every created worker terminates exactly once");
    assert.equal(borrowed.terminations, 0, "borrowed workers never terminate");
    assert.equal(releases, kind === "default" ? created.length : 0, "default worker release matches ownership");
    assert.equal(urlCalls, kind === "url" ? created.length : 0);
    assert.deepEqual(errors, []);
  } finally {
    if (!unmounted) root.unmount();
    container.remove();
  }
  if (managedWorker) {
    let cancelled = false;
    const pendingWorker = new FakeWorker();
    const cancelledLease = await resolveWorkerSetup("auto", () => {
      cancelled = true;
      return pendingWorker;
    }, () => cancelled, factories, true);
    assert.equal(cancelledLease, null, "cancelled managed setup never attaches");
    assert.equal(pendingWorker.terminations, 1, "cancelled owned managed factory worker terminates once");
    const borrowedLease = await resolveWorkerSetup("auto", borrowed, () => true, factories, true);
    assert.equal(borrowedLease, null);
    assert.equal(borrowed.terminations, 0, "cancelled borrowed setup preserves caller lifetime");
    return;
  }

  // Cancel setup while the real inline factory boundary is pending.
  available = false;
  const cancelledContainer = document.createElement("div");
  document.body.append(cancelledContainer);
  const cancelledRoot = createRoot(cancelledContainer);
  let factoryStarted = false;
  factories.inline = () => {
    factoryStarted = true;
    return new Promise<Worker>((resolve) => { completeInline = resolve; });
  };
  function CancelledSession() {
    const onErrorRef = useRef((error: Error) => { errors.push(error); });
    const rendererRef = useRef(new MarkdownRenderer({}));
    useWorkerSession({ renderer: rendererRef.current, workerSource: source, engine: "auto", session: 0,
      managedWorker, onErrorRef, debug: false, factories });
    return null;
  }
  cancelledRoot.render(<CancelledSession />);
  await waitFor(() => factoryStarted, "auto fallback starts pending inline setup");
  cancelledRoot.unmount();
  const lateWorker = new FakeWorker();
  completeInline?.(lateWorker);
  await waitFor(() => lateWorker.terminations === 1, "cancelled setup releases its late owned worker");
  assert.equal(lateWorker.commands, 0, "cancelled setup never attaches or initializes");
  assert.deepEqual(errors, []);
  cancelledContainer.remove();
}

async function managedBoundaryErrors(): Promise<void> {
  const forbiddenCases: Array<{ source: StreamingMarkdownProps["worker"]; engine: MarkdownEngineMode }> = [
    { source: undefined, engine: "auto" },
    { source: undefined, engine: "worker" },
    { source: new URL("https://example.test/worker.js"), engine: "auto" },
    { source: "/worker.js", engine: "worker" },
    { source: new FakeWorker(), engine: "main-thread" },
    { source: () => new FakeWorker(), engine: "main-thread" },
  ];
  for (const { source, engine } of forbiddenCases) {
    let factoryCalls = 0;
    const factories: WorkerFactories = {
      available: () => true,
      fromUrl: () => { factoryCalls++; return new FakeWorker(); },
      defaultWorker: () => { factoryCalls++; return new FakeWorker(); },
      releaseDefault: () => { factoryCalls++; },
      inline: async () => { factoryCalls++; return new FakeWorker(); },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const errors: Error[] = [];
    let ready = false;
    function InvalidSession() {
      const onErrorRef = useRef((error: Error) => { errors.push(error); });
      const rendererRef = useRef(new MarkdownRenderer({}));
      ready = useWorkerSession({ renderer: rendererRef.current, workerSource: source, engine, session: 0,
        managedWorker: true, onErrorRef, debug: false, factories }).workerReady;
      return null;
    }
    try {
      root.render(<InvalidSession />);
      await waitFor(() => errors.length === 1, "invalid managed source reaches onError");
      assert.match(errors[0].message, /managedWorker requires a caller-initialized Worker instance or worker factory/);
      assert.equal(ready, false, "invalid managed configuration never becomes ready");
      assert.equal(factoryCalls, 0, "managed validation precedes all creation and fallback");
    } finally {
      root.unmount();
      container.remove();
    }
  }
  let inlineCalls = 0;
  const worker = new FakeWorker();
  const unavailable: WorkerFactories = {
    available: () => false,
    fromUrl: () => worker,
    defaultWorker: () => worker,
    releaseDefault: () => {},
    inline: async () => { inlineCalls++; return worker; },
  };
  assert.throws(() => resolveWorkerSetup("auto", () => worker, () => false, unavailable, true),
    /inline fallback is not supported/);
  const failingFactory: WorkerFactories = { ...unavailable, available: () => true };
  assert.throws(() => resolveWorkerSetup("auto", () => { throw new Error("caller factory failed"); },
    () => false, failingFactory, true), /inline fallback is not supported/);
  assert.equal(inlineCalls, 0, "managed auto never bypasses caller initialization with inline fallback");
}

try {
  await managedBoundaryErrors();
  let inlineCalls = 0;
  const synchronousWorker = new FakeWorker();
  const synchronousFactories: WorkerFactories = {
    available: () => true,
    fromUrl: () => synchronousWorker,
    defaultWorker: () => synchronousWorker,
    releaseDefault: () => {},
    inline: async () => { throw new Error("available worker must not load inline engine"); },
  };
  const synchronousLease = resolveWorkerSetup("worker", () => synchronousWorker, () => false, synchronousFactories);
  assert.ok(synchronousLease && !(synchronousLease instanceof Promise),
    "available worker setup stays synchronous before input effects");
  synchronousLease.dispose();
  assert.equal(synchronousWorker.terminations, 1);
  const unavailableFactories: WorkerFactories = {
    available: () => false,
    fromUrl: () => { throw new Error("unavailable worker must not be constructed"); },
    defaultWorker: () => { throw new Error("unavailable default worker must not be constructed"); },
    releaseDefault: () => { throw new Error("no default lease exists"); },
    inline: async () => { inlineCalls++; return new FakeWorker(); },
  };
  assert.throws(() => resolveWorkerSetup("worker", undefined, () => false, unavailableFactories),
    /Worker is not supported/);
  assert.equal(inlineCalls, 0, "worker mode never falls back");
  const fallback = await resolveWorkerSetup("auto", undefined, () => false, unavailableFactories);
  assert.ok(fallback);
  assert.equal(inlineCalls, 1, "auto mode falls back when workers are unavailable");
  fallback.dispose();
  fallback.dispose();
  for (const managed of [true, false]) {
    for (const kind of ["url", "factory", "default", "inline", "borrowed"] as const) {
      if (managed && kind !== "factory" && kind !== "borrowed") continue;
      await ownershipLifecycle(kind, managed);
    }
  }
} finally {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.window.close();
}
console.log("worker session ownership lifecycle tests passed");
