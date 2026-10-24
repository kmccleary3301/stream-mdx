import assert from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { EngineCompatibilityError, StreamingMarkdown } from "../src/streaming-markdown";
import type { StreamingMarkdownHandle, StreamingMarkdownProps } from "../src/streaming-markdown";
import type { WorkerIn, WorkerOut } from "@stream-mdx/core";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { MarkdownRenderer } from "../src/renderer";

const validEngineMode: StreamingMarkdownProps["engine"] = "main";
// @ts-expect-error The removed engine mode must remain a public type error.
const retiredEngineMode: StreamingMarkdownProps["engine"] = "main-thread";
void validEngineMode;
void retiredEngineMode;


async function setupDom(): Promise<Window & typeof globalThis> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  (globalThis as any).window = window;
  (globalThis as any).document = window.document;
  (globalThis as any).HTMLElement = window.HTMLElement;
  (globalThis as any).Node = window.Node;
  (globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
  (globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  return window as unknown as Window & typeof globalThis;
}

function waitForMutation(container: HTMLElement, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new (container.ownerDocument.defaultView as any).MutationObserver(() => {
      if (predicate()) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
  });
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}
async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  diagnostics?: readonly string[][],
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const details = diagnostics ? ` (${diagnostics.map((messages) => messages.join(",")).join(" / ")})` : "";
          reject(new Error(`${message}${details}`));
        }, 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function rejectsRetiredEngineMode(): void {
  assert.throws(
    () => renderToStaticMarkup(
      <StreamingMarkdown engine={"main-thread" as unknown as StreamingMarkdownProps["engine"]} />,
    ),
    /engine="main-thread" has been removed; use engine="main" instead/,
  );
}

rejectsRetiredEngineMode();


async function runMainThreadEngineSmokeTest(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const root = createRoot(container!);

  // Step 1: Initial streaming render with provisional paragraph
  root.render(
    <StreamingMarkdown
      engine="main"
      text={"# Main Thread Engine Heading\n\nInitial provisional paragraph."}
    />,
  );

  await waitForMutation(container!, () => {
    return (
      Boolean(container!.querySelector("h1")) &&
      (container!.textContent?.includes("Initial provisional paragraph.") ?? false)
    );
  });

  const heading1 = container!.querySelector("h1");
  assert.ok(heading1, "expected <h1> to be rendered on main-thread engine");
  assert.strictEqual(heading1.textContent?.trim(), "Main Thread Engine Heading");

  // Step 2: Replace the document through the public text prop.
  root.render(
    <StreamingMarkdown
      engine="main"
      text={"# Replacement engine heading\n\nReplacement paragraph reaching the DOM."}
    />,
  );

  await waitForMutation(container!, () => {
    return container!.textContent?.includes("Replacement paragraph reaching the DOM.") ?? false;
  });

  assert.strictEqual(container.querySelectorAll("h1").length, 1, "text replacement must not duplicate headings");
  assert.strictEqual(container.querySelector("h1")?.textContent?.trim(), "Replacement engine heading");
  assert.strictEqual(container.textContent?.includes("Main Thread Engine Heading"), false, "old heading must be gone");
  assert.strictEqual(container.textContent?.includes("Initial provisional paragraph."), false, "old paragraph must be gone");
  assert.strictEqual(container.querySelectorAll("p").length, 1, "only the replacement paragraph remains");

  // Step 3: Clean unmount
  root.unmount();
}

await runMainThreadEngineSmokeTest();
async function runAutoBootstrapBeforeWorkerReadiness(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: class {},
  });
  let workerFactoryCalls = 0;
  class NeverReadyWorker extends EventTarget implements Worker {
    onmessage: Worker["onmessage"] = null;
    onmessageerror: Worker["onmessageerror"] = null;
    onerror: Worker["onerror"] = null;
    postMessage: Worker["postMessage"] = () => {};
    terminate(): void {}
  }
  try {
    root.render(
      <StreamingMarkdown
        text="Short authored paragraph."
        worker={() => {
          workerFactoryCalls++;
          return new NeverReadyWorker();
        }}
        prewarmLangs={["python"]}
      />,
    );
    await waitForCondition(
      () => container.querySelector("p")?.textContent === "Short authored paragraph.",
      "auto must publish native paragraph DOM without waiting for a worker factory or language prewarm",
    );
    assert.equal(workerFactoryCalls, 0, "short auto messages do not start a worker");
  } finally {
    root.unmount();
    container.remove();
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
    window.close();
  }
}

await runAutoBootstrapBeforeWorkerReadiness();

async function runAutoBootstrapUnitLimit(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const handle = createRef<StreamingMarkdownHandle>();
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  try {
    root.render(<StreamingMarkdown ref={handle} />);
    await waitForCondition(
      () => handle.current?.getState().workerReady === true,
      "auto inline owner did not become ready",
    );
    const attemptedSource = "😀".repeat(2048) + "x";
    assert.throws(
      () => handle.current!.append(attemptedSource),
      (error) => error instanceof EngineCompatibilityError,
      "auto must reject an append atomically when takeover cannot create a worker",
    );
    await delay(30);
    assert.equal(container.textContent, "", "a refused append must not publish any of its source");
    assert.deepEqual(handle.current!.getState().blocks, [], "a refused append must leave no accepted blocks");
  } finally {
    root.unmount();
    container.remove();
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
    window.close();
  }
}

await runAutoBootstrapUnitLimit();

interface RecordingWorker {
  worker: Worker;
  commands: WorkerIn[];
  isReady(): boolean;
}

function createRecordingWorker(initDelayMs: number): RecordingWorker {
  const worker = createInlineEngineWorker();
  const commands: WorkerIn[] = [];
  const originalPostMessage = worker.postMessage.bind(worker);
  let isReady = false;
  worker.addEventListener("message", (event) => {
    if ((event as MessageEvent<WorkerOut>).data.type === "INITIALIZED") isReady = true;
  });
  worker.postMessage = ((message: unknown) => {
    const command = message as WorkerIn;
    commands.push(command);
    if (command.type === "INIT" && initDelayMs > 0) {
      setTimeout(() => originalPostMessage(message), initDelayMs);
    } else {
      originalPostMessage(message);
    }
  }) as Worker["postMessage"];
  return { worker, commands, isReady: () => isReady };
}
interface GatedRecordingWorker extends RecordingWorker {
  releaseInitialization(): void;
}

function createGatedRecordingWorker(): GatedRecordingWorker {
  const worker = createInlineEngineWorker();
  const commands: WorkerIn[] = [];
  const originalPostMessage = worker.postMessage.bind(worker);
  let initialized = false;
  let pendingInitialization: unknown = null;
  worker.addEventListener("message", (event) => {
    if ((event as MessageEvent<WorkerOut>).data.type === "INITIALIZED") initialized = true;
  });
  worker.postMessage = ((message: unknown) => {
    const command = message as WorkerIn;
    commands.push(command);
    if (command.type === "INIT") pendingInitialization = message;
    else originalPostMessage(message);
  }) as Worker["postMessage"];
  return {
    worker,
    commands,
    isReady: () => initialized,
    releaseInitialization() {
      assert.notEqual(pendingInitialization, null, "the takeover INIT is waiting at the gate");
      const message = pendingInitialization;
      pendingInitialization = null;
      originalPostMessage(message);
    },
  };
}


function sourceFromWorkerCommands(commands: readonly WorkerIn[]): string {
  let source = "";
  for (const command of commands) {
    if (command.type === "INIT") source = command.initialContent ?? "";
    else if (command.type === "APPEND") source += command.text;
  }
  return source;
}

async function runAutoWorkerTakeover(): Promise<void> {
  const window = await setupDom();
  const autoContainer = window.document.getElementById("root");
  assert.ok(autoContainer);
  const autoRoot = createRoot(autoContainer);
  const autoHandle = createRef<StreamingMarkdownHandle>();
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: class {},
  });

  const bootstrapHeading = "# Bootstrap prefix\n\n";
  const prefixBody = "bootstrap-token ".repeat(512);
  const prefix = `${bootstrapHeading}${prefixBody.slice(0, 4096 - bootstrapHeading.length)}`;
  assert.equal(prefix.length, 4096);
  const suffix = "\n\n# Taken-over suffix\n\nAccepted suffix source.";
  const expectedSource = prefix + suffix;
  let releaseSuffix!: () => void;
  const suffixPermission = new Promise<void>((resolve) => {
    releaseSuffix = resolve;
  });
  async function* autoInput(): AsyncGenerator<string> {
    yield prefix;
    await suffixPermission;
    yield suffix;
  }

  let factoryCalls = 0;
  let autoRecorder: RecordingWorker | null = null;
  const zeroBlockCommits: number[] = [];
  let observer: MutationObserver | null = null;
  try {
    autoRoot.render(
      <StreamingMarkdown
        ref={autoHandle}
        className="markdown-renderer"
        engine="auto"
        worker={() => {
          factoryCalls++;
          autoRecorder = createRecordingWorker(150);
          return autoRecorder.worker;
        }}
        stream={autoInput()}
      />,
    );
    await waitForCondition(
      () => autoContainer.querySelector("h1")?.textContent === "Bootstrap prefix" &&
        (autoContainer.querySelector("p")?.textContent?.includes("bootstrap-token") ?? false),
      "auto bootstrap content was not published before the source crossed the takeover limit",
    );
    assert.equal(factoryCalls, 0, "short bootstrap source does not create the caller worker");
    const stableRendererRoot = autoContainer.querySelector(".markdown-renderer");
    assert.ok(stableRendererRoot, "the public renderer root is mounted");
    const bootstrapHeadingNode = autoContainer.querySelector("h1");
    const bootstrapParagraphNode = autoContainer.querySelector("p");
    assert.ok(bootstrapHeadingNode && bootstrapParagraphNode);
    observer = new window.MutationObserver(() => {
      if (autoContainer.querySelectorAll("h1,h2,h3,h4,h5,h6,p,blockquote,ul,ol,table,pre,hr").length === 0) {
        zeroBlockCommits.push(Date.now());
      }
    });
    observer.observe(autoContainer, { childList: true, subtree: true, characterData: true });

    releaseSuffix();
    await waitForCondition(
      () => factoryCalls === 1 && autoRecorder?.commands.some((command) => command.type === "INIT") === true,
      "overflow did not start a replacement worker",
    );
    assert.equal(autoRecorder!.isReady(), false, "the replacement worker remains unready during its delayed INIT");
    assert.equal(autoContainer.querySelector("h1"), bootstrapHeadingNode);
    assert.equal(autoContainer.querySelector("p"), bootstrapParagraphNode);
    assert.equal(autoContainer.querySelector(".markdown-renderer"), stableRendererRoot);
    assert.ok(autoContainer.textContent?.includes("bootstrap-token"), "the bootstrap projection stays visible while INIT is delayed");

    await waitForCondition(
      () => autoRecorder!.isReady() &&
        autoContainer.querySelector("h1:nth-of-type(2)")?.textContent === "Taken-over suffix" &&
        (autoContainer.textContent?.includes("Accepted suffix source.") ?? false),
      "the replacement worker did not commit the complete stream",
    );
    assert.equal(autoContainer.querySelector("h1"), bootstrapHeadingNode,
      "takeover preserves the existing heading node after worker commit");
    const autoFinalization = await autoHandle.current!.finalize();
    assert.equal(autoFinalization.acceptedSourceUnits, expectedSource.length);
    assert.equal(autoFinalization.committedSourceUnits, expectedSource.length);
    await delay(30);
    observer.disconnect();
    observer = null;
    assert.equal(autoContainer.querySelector(".markdown-renderer"), stableRendererRoot,
      "takeover preserves the public renderer root node");
    assert.deepEqual(zeroBlockCommits, [], "takeover never renders an empty block projection");

    const autoHtml = autoContainer.innerHTML;
    const autoSource = sourceFromWorkerCommands(autoRecorder!.commands);
    assert.equal(autoSource, expectedSource, "takeover preserves the accepted source order");
    assert.equal(autoSource.length, expectedSource.length, "takeover preserves the accepted UTF-16 unit total");

    const workerContainer = window.document.createElement("div");
    window.document.body.append(workerContainer);
    const workerRoot = createRoot(workerContainer);
    const workerHandle = createRef<StreamingMarkdownHandle>();
    let workerRecorder: RecordingWorker | null = null;
    try {
      workerRoot.render(
        <StreamingMarkdown
          ref={workerHandle}
          className="markdown-renderer"
          engine="worker"
          worker={() => {
            workerRecorder = createRecordingWorker(0);
            return workerRecorder.worker;
          }}
          stream={(async function* () {
            yield prefix;
            yield suffix;
          })()}
        />,
      );
      await waitForCondition(
        () => workerContainer.querySelector("h1:nth-of-type(2)")?.textContent === "Taken-over suffix" &&
          (workerContainer.textContent?.includes("Accepted suffix source.") ?? false),
        "worker-only mode did not render the comparison stream",
      );
      const workerFinalization = await workerHandle.current!.finalize();
      assert.equal(workerFinalization.acceptedSourceUnits, expectedSource.length);
      assert.equal(workerFinalization.committedSourceUnits, expectedSource.length);
      assert.equal(autoHtml, workerContainer.innerHTML, "auto takeover matches worker-only final DOM");
      const workerSource = sourceFromWorkerCommands(workerRecorder!.commands);
      assert.equal(workerSource, expectedSource, "worker-only mode consumes the same source order");
      assert.equal(workerSource.length, expectedSource.length, "worker-only mode consumes the same UTF-16 unit total");
    } finally {
      workerRoot.unmount();
      workerContainer.remove();
    }
  } finally {
    observer?.disconnect();
    autoRoot.unmount();
    autoContainer.remove();
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
    window.close();
  }
}

await runAutoWorkerTakeover();
async function runAutoStaticRenderParity(): Promise<void> {
  const text = `${"x".repeat(4096)}\n\n# Beyond bootstrap\n\nStatic tail.`;
  const autoRenderer = new MarkdownRenderer({ performance: { batch: "microtask" } });
  const workerRenderer = new MarkdownRenderer({ performance: { batch: "microtask" } });
  const autoWorker = createInlineEngineWorker();
  const worker = createInlineEngineWorker();
  const autoMessages: string[] = [];
  const workerMessages: string[] = [];
  autoWorker.addEventListener("message", (event) => autoMessages.push((event as MessageEvent<WorkerOut>).data.type));
  worker.addEventListener("message", (event) => workerMessages.push((event as MessageEvent<WorkerOut>).data.type));
  autoRenderer.attachWorker(autoWorker, { bootstrap: true });
  workerRenderer.attachWorker(worker);
  try {
    await withTimeout(
      Promise.all([autoRenderer.whenInitialized(), workerRenderer.whenInitialized()]),
      "auto/worker renderer initialization timed out",
    );
    const [autoBlocks, workerBlocks] = await withTimeout(
      Promise.all([autoRenderer.renderStatic(text), workerRenderer.renderStatic(text)]),
      "auto/worker renderStatic timed out",
    );
    assert.ok(
      autoBlocks.some((block) => block.payload.raw.includes("# Beyond bootstrap")),
      "auto renderStatic must resolve with content beyond the bootstrap limit",
    );
    assert.deepEqual(
      autoBlocks.map((block) => [block.type, block.payload.raw]),
      workerBlocks.map((block) => [block.type, block.payload.raw]),
    );
    const [autoFinalization, workerFinalization] = await withTimeout(
      Promise.all([autoRenderer.finalize(), workerRenderer.finalize()]),
      "auto/worker finalization timed out",
      [autoMessages, workerMessages],
    );
    assert.equal(autoFinalization.acceptedSourceUnits, 0);
    assert.equal(autoFinalization.committedSourceUnits, 0);
    assert.equal(workerFinalization.acceptedSourceUnits, 0);
    assert.equal(workerFinalization.committedSourceUnits, 0);
  } finally {
    autoRenderer.detachWorker();
    workerRenderer.detachWorker();
    autoWorker.terminate();
    worker.terminate();
  }
}

await runAutoStaticRenderParity();
async function runAutoWorkerTakeoverCapacityWaiter(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const handle = createRef<StreamingMarkdownHandle>();
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: class {},
  });
  let recorder: GatedRecordingWorker | null = null;
  let pulledChunks = 0;
  let finished = false;
  const errors: Error[] = [];
  async function* input(): AsyncGenerator<string> {
    pulledChunks++;
    yield "a".repeat(65_536);
    pulledChunks++;
    yield "b".repeat(65_536);
    pulledChunks++;
    yield "c".repeat(65_536);
    finished = true;
  }
  try {
    root.render(
      <StreamingMarkdown
        ref={handle}
        engine="auto"
        worker={() => {
          recorder = createGatedRecordingWorker();
          return recorder.worker;
        }}
        stream={input()}
        onError={(error) => errors.push(error)}
      />,
    );
    await waitForCondition(
      () => recorder?.commands.some((command) => command.type === "INIT") === true && pulledChunks === 2,
      "the first two 65,536-unit chunks did not reach the gated takeover",
    );
    assert.equal(recorder!.isReady(), false, "takeover initialization remains gated");
    assert.equal(pulledChunks, 2, "the iterator waits for capacity before pulling its third chunk");

    recorder!.releaseInitialization();
    await waitForCondition(
      () => pulledChunks === 3 && finished,
      "takeover initialization did not release the capacity waiter to consume another chunk",
    );
    const result = await handle.current!.finalize();
    assert.equal(result.acceptedSourceUnits, 196_608);
    assert.equal(result.committedSourceUnits, 196_608);
    assert.deepEqual(errors, []);
  } finally {
    root.unmount();
    container.remove();
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
    window.close();
  }
}

await runAutoWorkerTakeoverCapacityWaiter();



async function runAutoBootstrapResetFailureIsolation(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const handle = createRef<StreamingMarkdownHandle>();
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: class {},
  });
  const takeoverWorkers: RecordingWorker[] = [];
  const errors: Error[] = [];
  const trailingMarker = "Replacement trailing marker.";
  const replacement = `# Replacement title\n\n${"replacement body ".repeat(500)}\n\n${trailingMarker}`;
  const workerFactory = () => {
    const recorder = createRecordingWorker(0);
    takeoverWorkers.push(recorder);
    return recorder.worker;
  };
  try {
    root.render(
      <StreamingMarkdown
        ref={handle}
        engine="auto"
        worker={workerFactory}
        onError={(error) => errors.push(error)}
      />,
    );
    await waitForCondition(
      () => handle.current?.getState().workerReady === true,
      "auto bootstrap worker did not become ready",
    );
    handle.current!.append("first bootstrap ".repeat(500));
    assert.equal(takeoverWorkers.length, 1, "the first overflow starts a takeover lease");
    assert.deepEqual(takeoverWorkers[0]!.commands, [], "the takeover waits for the first bootstrap projection");

    flushSync(() => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          engine="auto"
          worker={workerFactory}
          text={replacement}
          onError={(error) => errors.push(error)}
        />,
      );
    });
    await waitForCondition(
      () => container.textContent?.includes(trailingMarker) ?? false,
      "replacement trailing content did not commit after a stale takeover failure",
    );
    assert.equal(takeoverWorkers.length, 1, "the complete auto static replacement does not start a second takeover worker");
    assert.deepEqual(errors, [], "a stale bootstrap projection failure must not report an error for replacement text");
  } finally {
    root.unmount();
    container.remove();
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
    window.close();
  }
}

await runAutoBootstrapResetFailureIsolation();


async function runCallbackUpdateDuringStream(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const handle = createRef<StreamingMarkdownHandle>();
  try {
    flushSync(() => {
      root.render(<StreamingMarkdown ref={handle} engine="main" onError={() => {}} />);
    });
    const deadline = Date.now() + 10000;
    while (!handle.current?.getState().workerReady) {
      assert.ok(Date.now() < deadline, "inline engine did not become ready");
      await delay(5);
    }
    handle.current.append("# Retained heading\n\nBefore callback update.\n\n");
    await waitForMutation(container, () => container.textContent?.includes("Before callback update.") ?? false);
    flushSync(() => {
      root.render(<StreamingMarkdown ref={handle} engine="main" onError={() => {}} />);
    });
    await delay(30);
    handle.current?.append("After callback update.");
    await handle.current?.finalize();
    await waitForMutation(container, () => container.textContent?.includes("After callback update.") ?? false);
    assert.strictEqual(container.querySelector("h1")?.textContent, "Retained heading");
    assert.ok(container.textContent?.includes("Before callback update."));
  } finally {
    root.unmount();
  }
}

await runCallbackUpdateDuringStream();
console.log("main-thread engine smoke test passed");
