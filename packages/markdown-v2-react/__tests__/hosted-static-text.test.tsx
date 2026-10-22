import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import type { Block, SyntaxRuleSpec, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { MarkdownRenderer, StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { createWorkerThread } from "@stream-mdx/worker/node";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

const hostedBundle = new URL("../../markdown-v2-worker/dist/hosted/markdown-worker.js", import.meta.url);
if (!existsSync(hostedBundle)) {
  execSync("npm run build:hosted", { cwd: fileURLToPath(new URL("../../markdown-v2-worker", import.meta.url)), stdio: "inherit" });
}

const TransportEvent = Event;
// Only adapts native worker_threads events; the shipped hosted bundle performs every parse and patch.
class HostedWorker extends EventTarget {
  readonly thread = createWorkerThread();
  readonly input: WorkerIn[] = [];
  readonly output: WorkerOut[] = [];
  private heldMessages: WorkerOut[] = [];
  private heldInitialization: { heading: string; replacementSource: string } | null = null;
  private heldInitErrors: WorkerOut[] = [];
  private holdNextInitError = false;
  private failNextInitialization = false;

  constructor() {
    super();
    this.thread.on("message", (data: WorkerOut) => {
      this.output.push(data);
      if (this.holdNextInitError && data.type === "ERROR" && data.phase === "INIT") {
        this.holdNextInitError = false;
        this.heldInitErrors.push(data);
        return;
      }

      const initializedHeading = data.type === "INITIALIZED"
        ? (data.snapshot.children?.[0]?.props?.block as Block | undefined)?.payload.raw
        : undefined;
      if (this.heldMessages.length > 0 ||
        (this.heldInitialization !== null && this.heldInitialization.heading === initializedHeading)) {
        this.heldMessages.push(data);
        return;
      }
      this.deliver(data);
    });
    this.thread.on("error", (error) => { throw error; });
  }
  private deliver(data: WorkerOut): void {
    const event = new TransportEvent("message");
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
  holdInitializationUntilReplacement(heading: string, replacementSource: string): void {
    this.heldInitialization = { heading, replacementSource };
  }
  hasHeldInitialization(): boolean {
    return this.heldMessages[0]?.type === "INITIALIZED";
  }
  postMessage(message: WorkerIn) {
    this.input.push(message);
    const failInitialization = this.failNextInitialization && message.type === "INIT";
    if (failInitialization) this.failNextInitialization = false;
    this.thread.postMessage(failInitialization ? { ...message, schemaVersion: -1 } : message);
    if (message.type === "INIT" && this.heldInitErrors.length > 0) {
      const errors = this.heldInitErrors;
      this.heldInitErrors = [];
      for (const error of errors) this.deliver(error);
    }
    if (this.heldInitialization !== null && message.type === "INIT" && message.initialContent === this.heldInitialization.replacementSource) {
      this.heldInitialization = null;
      const heldMessages = this.heldMessages;
      this.heldMessages = [];
      for (const held of heldMessages) this.deliver(held);
    }
  }
  holdInitErrorUntilReplacement(): void {
    this.holdNextInitError = true;
  }
  failNextInitializationSchema(): void {
    this.failNextInitialization = true;
  }
  hasHeldInitializationError(): boolean {
    return this.heldInitErrors.some((message) => message.type === "ERROR" && message.phase === "INIT");
  }
  terminate() { return this.thread.terminate(); }
  asBrowserWorker(): Worker { return this as unknown as Worker; }
}


const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Worker: NodeWorker,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
};
const previousGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const features = { tables: true, html: true, mdx: false, math: false };
const source = (count: number, name: string) => [`# ${name}`, "", "| ID | Metric | Status | Description | Latency | Memory |", "| --- | --- | --- | --- | --- | --- |",
  ...Array.from({ length: count }, (_, index) => `| PK-${String(index).padStart(4, "0")} | metric.${index} | Normal | Partition ${index}${index % 5 === 0 ? "<br>Second observation<br>Third observation" : ""} | 1ms | 48MB |`)].join("\n");

/**
 * File-local deferred (Node 20 has no `Promise.withResolvers`) with the same resolve/reject
 * surface, so the posted worker message settles the barrier exactly as before.
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

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const orderedWorker = new HostedWorker();
const orderedRenderer = new MarkdownRenderer({ plugins: features });
let initializationReady = false;
try {
  orderedRenderer.attachWorker(orderedWorker.asBrowserWorker());
  const readiness = orderedRenderer.whenInitialized().then(() => {
    initializationReady = true;
  });
  orderedRenderer.append("# Queued before initialization ACK\n\n");
  orderedRenderer.finalize();
  assert.strictEqual(initializationReady, false,
    "queued commands do not publish readiness before INITIALIZED");
  assert.deepStrictEqual(orderedWorker.input.map((message) => message.type), ["INIT"],
    "stream commands remain queued until the matching initialization ACK");
  await waitFor(() => orderedWorker.input.length === 3, "matching ACK releases queued commands");
  assert.deepStrictEqual(
    orderedWorker.input.map((message) => message.type),
    ["INIT", "APPEND", "FINALIZE"],
    "accepted streaming commands retain FIFO order behind INIT",
  );
  await readiness;
  assert.strictEqual(initializationReady, true, "matching initialization ACK publishes readiness");
  await waitFor(() => {
    const blocks = orderedRenderer.getStore().getBlocks();
    return blocks.some((block) => block.payload.raw.includes("Queued before initialization ACK"))
      && blocks.every((block) => block.isFinalized);
  }, "pre-ACK append and finalize are applied after initialization");
} finally {
  orderedRenderer.detachWorker();
  await orderedWorker.terminate();
}
{
  const worker = new HostedWorker();
  const detachedRenderer = new MarkdownRenderer({ plugins: features });
  let currentRenderer: MarkdownRenderer | undefined;
  try {
    worker.holdInitErrorUntilReplacement();
    worker.failNextInitializationSchema();
    detachedRenderer.attachWorker(worker.asBrowserWorker());
    const detachedReadiness = assert.rejects(
      detachedRenderer.whenInitialized(),
      /Worker detached before initialization completed/,
    );
    await waitFor(() => worker.hasHeldInitializationError(), "real worker emits and holds the detached INIT error");
    detachedRenderer.detachWorker();
    await detachedReadiness;

    currentRenderer = new MarkdownRenderer({ plugins: features });
    currentRenderer.attachWorker(worker.asBrowserWorker());
    const readiness = currentRenderer.whenInitialized();
    currentRenderer.append("# Current initialization owner\n\n");
    currentRenderer.finalize();
    await readiness;
    await waitFor(() => {
      const blocks = currentRenderer?.getStore().getBlocks() ?? [];
      return blocks.some((block) => block.payload.raw.includes("Current initialization owner"))
        && blocks.every((block) => block.isFinalized);
    }, "new renderer initializes, appends, and finalizes after the detached INIT error");
    assert.ok(currentRenderer.getStore().getBlocks().some(
      (block) => block.payload.raw === "# Current initialization owner",
    ));
  } finally {
    detachedRenderer.detachWorker();
    currentRenderer?.detachWorker();
    await worker.terminate();
  }
}


try {
  const worker = new HostedWorker();
  const renderer = new MarkdownRenderer({ plugins: features });
  renderer.attachWorker(worker.asBrowserWorker());
  try {
    // Queue full INIT before the initial empty attach ACK, then a second full INIT while the first is in flight.
    const firstSource = source(250, "First FIFO document");
    const secondSource = source(500, "Second FIFO document");
    const first = renderer.renderStatic(firstSource);
    const second = renderer.renderStatic(secondSource);
    const [firstBlocks, secondBlocks] = await Promise.all([first, second]);
    assert.equal(firstBlocks[0].payload.raw, "# First FIFO document", "empty attach ACK cannot resolve full-content waiter");
    assert.equal(secondBlocks[0].payload.raw, "# Second FIFO document", "full-content ACKs resolve FIFO owners");
    renderer.finalize();
    await waitFor(() => renderer.getStore().getBlocks().some((block) => block.type === "table") && renderer.getStore().getBlocks().every((block) => block.isFinalized), "real hosted FIFO replacement finalizes");
    assert.equal(renderer.getStore().getBlocks()[0].payload.raw, "# Second FIFO document");
    assert.equal(worker.input.filter((message) => message.type === "APPEND").length, 0);
    assert.ok(renderer.getStore().getBlocks().find((block) => block.type === "table")?.payload.raw.includes("PK-0499"));
    const ownSource = source(250, "Reattached owner document");
    worker.holdInitializationUntilReplacement("Cancelled detached document", ownSource);
    const cancelled = renderer.renderStatic(source(500, "Cancelled detached document"));
    const rejection = assert.rejects(cancelled);
    await waitFor(() => worker.hasHeldInitialization(), "detached static operation has a received but withheld ACK");
    renderer.detachWorker();
    await rejection;
    const reusedRenderer = new MarkdownRenderer({ plugins: features });
    reusedRenderer.attachWorker(worker.asBrowserWorker());
    try {
      const ownBlocks = await reusedRenderer.renderStatic(ownSource);
      assert.equal(ownBlocks[0]?.payload.raw, "# Reattached owner document",
        "pending detached INIT acknowledgment cannot resolve the new attachment's full-content promise");
      reusedRenderer.finalize();
      await waitFor(() => reusedRenderer.getStore().getBlocks().every((block) => block.isFinalized),
        "reused hosted worker finalizes its current document");
      assert.equal(reusedRenderer.getStore().getBlocks()[0]?.payload.raw, "# Reattached owner document");
    } finally {
      reusedRenderer.detachWorker();
    }
    const managedRenderer = new MarkdownRenderer({ plugins: features });
    managedRenderer.attachWorker(worker.asBrowserWorker(), { skipInit: true });
    try {
      const beforeManagedRestart = worker.input.length;
      managedRenderer.append("\n\nExternally managed continuation\n\n");
      managedRenderer.restart();
      assert.equal(worker.input.slice(beforeManagedRestart).some((message) => message.type === "INIT"), false,
        "managed restart leaves caller-initialized hosted worker state untouched");
    } finally {
      managedRenderer.detachWorker();
    }
  } finally {
    renderer.detachWorker();
    await worker.terminate();
  }

  const hosted = new HostedWorker();
  const factory = hosted.asBrowserWorker();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  try {
    const initial = source(250, "Initial consumer document");
    root.render(<StreamingMarkdown ref={handle} engine="worker" worker={factory} text={initial} features={features} tableVirtualization={true} caret={false} />);
    await waitFor(() => Boolean(container.querySelector('[data-table-virtualized="true"]')), "250-row hosted consumer windows");
    const start = hosted.input.length;
    const replacement = source(500, "Final consumer document");
    root.render(<StreamingMarkdown ref={handle} engine="worker" worker={factory} text={replacement} features={features} tableVirtualization={true} caret={false} />);
    await waitFor(() => container.querySelector("h1")?.textContent === "Final consumer document" && Boolean(container.querySelector('[data-table-virtualized="true"]')), "500-row hosted replacement commits finalized window");
    const messages = hosted.input.slice(start);
    assert.equal(messages.filter((message) => message.type === "INIT").length, 1, "static replacement uses one full INIT");
    assert.equal(messages.find((message) => message.type === "INIT")?.initialContent, replacement);
    assert.equal(messages.some((message) => message.type === "APPEND"), false, "static replacement does not repeatedly append/reparse growing tables");
    assert.ok(handle.current?.getState().blocks.every((block) => block.isFinalized));
    assert.ok(container.querySelectorAll("tbody tr[data-row-id]").length < 100);
    const viewport = container.querySelector<HTMLDivElement>('[data-table-virtualized="true"]');
    assert.ok(viewport);
    // JSDOM has no layout; native production layout is measured separately in the browser proof.
    Object.defineProperty(viewport, "clientHeight", { value: 600 });
    Object.defineProperty(viewport, "scrollHeight", { value: 20000 });
    viewport.scrollTop = 100000;
    viewport.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    await waitFor(() => container.textContent?.includes("PK-0499") === true, "last replacement record is reachable");

    const obsolete = source(250, "Obsolete in-flight consumer document");
    const latest = source(500, "Latest in-flight consumer document");
    const beforeRapid = hosted.input.length;
    // Hold the real worker's obsolete ACK until replacement INIT is sent, so the
    // pending-generation race does not depend on worker speed or polling timing.
    // Subsequent transport messages are released in their original FIFO order.
    hosted.holdInitializationUntilReplacement("Obsolete in-flight consumer document", latest);
    root.render(<StreamingMarkdown ref={handle} engine="worker" worker={factory} text={obsolete} features={features} tableVirtualization={true} caret={false} />);
    await waitFor(() => hosted.input.slice(beforeRapid).some((message) => message.type === "INIT" && message.initialContent === obsolete), "obsolete INIT is genuinely in flight");
    await waitFor(() => hosted.hasHeldInitialization(), "obsolete INITIALIZED is received but held before replacement");
    root.render(<StreamingMarkdown ref={handle} engine="worker" worker={factory} text={latest} features={features} tableVirtualization={true} caret={false} />);
    await waitFor(() => container.querySelector("h1")?.textContent === "Latest in-flight consumer document" && Boolean(container.querySelector('[data-table-virtualized="true"]')), "latest rapid replacement owns finalization");
    assert.equal(hosted.input.slice(beforeRapid).filter((message) => message.type === "FINALIZE").length, 1, "stale static generation cannot finalize replacement");
    assert.equal(container.textContent?.includes("Obsolete in-flight consumer document"), false);

    const syntax: SyntaxRuleSpec[] = [{ name: "invalid", pattern: { source: "[unclosed(" } }, { name: "ticket", pattern: { source: "#([A-Z]+-\\d+)" }, attrs: { id: 1 } }];
    root.render(<StreamingMarkdown ref={handle} engine="worker" worker={factory} text={`# Recoverable rules\n\n#ABC-123\n\n${replacement}`}
      features={features} syntax={syntax} inlineComponents={{ ticket: ({ id }: { id?: string }) => <span data-ticket={id}>{id}</span> }} tableVirtualization={true} caret={false} />);
    await waitFor(() => Boolean(container.querySelector('[data-ticket="ABC-123"]')) && Boolean(container.querySelector('[data-table-virtualized="true"]')),
      "recoverable invalid syntax rule does not consume full INIT acknowledgement or prevent finalization");
    assert.ok(handle.current?.getState().blocks.every((block) => block.isFinalized));
    const teardownErrors: Error[] = [];
    const pendingSource = source(500, "Unmounted pending source");
    const beforeUnmount = hosted.input.length;
    root.render(<StreamingMarkdown ref={handle} engine="worker" worker={factory} text={pendingSource} features={features}
      onError={(error) => teardownErrors.push(error)} tableVirtualization={true} caret={false} />);
    await waitFor(() => hosted.input.slice(beforeUnmount).some((message) => message.type === "INIT" && message.initialContent === pendingSource),
      "unmount occurs with a real hosted static INIT pending");
    root.unmount();
    const barrier = deferred<void>();
    const barrierListener = (event: Event) => {
      if ((event as MessageEvent<WorkerOut>).data.type === "DEBUG_STATE") barrier.resolve();
    };
    hosted.addEventListener("message", barrierListener);
    hosted.postMessage({ type: "DEBUG_STATE" });
    await barrier.promise;
    hosted.removeEventListener("message", barrierListener);
    assert.equal(teardownErrors.length, 0, "cancelled static rejection cannot call a consumer callback after unmount");
    assert.equal(hosted.input.slice(beforeUnmount).some((message) => message.type === "FINALIZE"), false,
      "unmounted static generation cannot finalize its pending document");
  } finally {
    root.unmount();
    await hosted.terminate();
    container.remove();
  }
} finally {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.window.close();
}
console.log("hosted static text consumer tests passed");