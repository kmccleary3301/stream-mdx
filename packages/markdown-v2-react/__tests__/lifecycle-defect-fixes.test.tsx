import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { Block, Patch, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { createBlockSnapshot, PATCH_ROOT_ID, STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
import { MarkdownRenderer, StreamingMarkdown, type StreamingMarkdownHandle } from "../src/index";
import React, { act } from "react";
import { makeEngine as makeTrustedEngine } from "./trusted-native-fixture";
import { workerFactory as createTrustedWorker } from "./trusted-native-fixture";
import { createRoot } from "react-dom/client";

class TestMockWorker extends EventTarget {
  public terminated = false;
  public messages: WorkerIn[] = [];
  public autoRespondInit = false;
  private generation = 0;

  postMessage(message: WorkerIn): void {
    this.messages.push(message);
    if (this.autoRespondInit && message.type === "INIT") {
      queueMicrotask(() => {
        void act(() => {
          this.acknowledgeInit();
        });
      });
    }
  }

  /** Answers the latest INIT with a schema-matching INITIALIZED snapshot of its initial content. */
  acknowledgeInit(): void {
    const message = this.messages.findLast((candidate) => candidate.type === "INIT");
    if (message?.type !== "INIT") throw new Error("acknowledgeInit requires a posted INIT");
    const block: Block | undefined = message.initialContent
      ? {
          id: "p1",
          type: "paragraph",
          isFinalized: true,
          payload: {
            raw: message.initialContent,
            inline: [{ kind: "text", text: message.initialContent }],
          },
        }
      : undefined;
    const generation = ++this.generation;
    const initEvent = new Event("message") as MessageEvent<WorkerOut>;
    Object.defineProperty(initEvent, "data", {
      value: {
        type: "INITIALIZED",
        schemaVersion: STREAM_MDX_SCHEMA_VERSION,
        generation,
        snapshot: {
          id: PATCH_ROOT_ID,
          type: "__root__",
          props: {},
          inputSource: { generation, raw: message.initialContent ?? "" },
          children: block ? [createBlockSnapshot(block)] : [],
        },
      },
    });
    this.dispatchEvent(initEvent);
  }
  emit(message: WorkerOut): void {
    const event = new Event("message") as MessageEvent<WorkerOut>;
    Object.defineProperty(event, "data", { value: message });
    this.dispatchEvent(event);
  }


  terminate(): void {
    this.terminated = true;
  }
}

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  Worker: TestMockWorker as unknown as typeof Worker,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function testFactoryWorkerTerminatedOnUnmount(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const factoryWorker = new TestMockWorker();
  let factoryCalled = 0;
  const workerFactory = () => {
    factoryCalled++;
    return factoryWorker as unknown as Worker;
  };

  try {
    await act(async () => {
      root.render(<StreamingMarkdown engine="worker" worker={workerFactory} text="Hello world" />);
    });
    await waitFor(() => factoryCalled === 1, "worker factory should be called once on mount");
    assert.strictEqual(factoryWorker.terminated, false, "worker should not be terminated while mounted");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }

  assert.strictEqual(factoryWorker.terminated, true, "factory-created worker must be terminated on unmount");

  // Contrast: borrowed (existing Worker instance) must NOT be terminated on unmount
  const borrowedContainer = document.createElement("div");
  document.body.append(borrowedContainer);
  const borrowedRoot = createRoot(borrowedContainer);
  const borrowedWorker = new TestMockWorker();

  try {
    await act(async () => {
      borrowedRoot.render(<StreamingMarkdown engine="worker" worker={borrowedWorker as unknown as Worker} text="Hello" />);
    });
    assert.strictEqual(borrowedWorker.terminated, false);
  } finally {
    await act(async () => {
      borrowedRoot.unmount();
    });
    borrowedContainer.remove();
  }

  assert.strictEqual(borrowedWorker.terminated, false, "borrowed worker instance must not be terminated on unmount");
}

async function testRemovingBlockRendererRevertsToDefault(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const worker = new TestMockWorker();
  worker.autoRespondInit = true;
  const workerFactory = () => worker as unknown as Worker;

  try {
    // 1. Render with blockRenderer override
    await act(async () => {
      root.render(
        <StreamingMarkdown
          engine="worker"
          worker={workerFactory}
          text="Test paragraph"
          blockRenderer={({ element }) => <div className="custom-block-override">{element}</div>}
        />,
      );
    });

    await waitFor(
      () => Boolean(container.querySelector(".custom-block-override")),
      "custom blockRenderer override must be rendered when prop is provided",
    );

    // 2. Re-render without blockRenderer (removed / undefined)
    await act(async () => {
      root.render(
        <StreamingMarkdown
          engine="worker"
          worker={workerFactory}
          text="Test paragraph"
          blockRenderer={undefined}
        />,
      );
    });
    await waitFor(
      () => container.querySelector(".custom-block-override") === null,
      "removing blockRenderer prop must revert to default rendering without stale override",
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}

async function testWorkerErrorEventRoutesToOnErrorAndExitsStreaming(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const worker = new TestMockWorker();
  const workerFactory = () => worker as unknown as Worker;
  const handle = React.createRef<StreamingMarkdownHandle>();
  const reportedErrors: Error[] = [];

  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          engine="worker"
          worker={workerFactory}
          text="Content awaiting initialization"
          caret="block"
          onError={(err) => {
            reportedErrors.push(err);
          }}
        />,
      );
    });

    // Status should be streaming while waiting for worker response (caret displayed)
    await waitFor(
      () => Boolean(container.querySelector(".stream-mdx-caret")),
      "status must be streaming initially (caret displayed)",
    );
    // Simulate a worker error (e.g. script 404 or crash)
    await act(async () => {
      const errorEvent = new Event("error");
      Object.defineProperty(errorEvent, "message", { value: "Worker script 404 not found" });
      worker.dispatchEvent(errorEvent);
    });

    await waitFor(() => reportedErrors.length > 0, "onError must be invoked upon worker error event");
    assert.ok(reportedErrors[0].message.includes("Worker script 404 not found"), "error message must be preserved");

    // Status must leave streaming and transition to terminal status (caret removed)
    await waitFor(() => container.querySelector(".stream-mdx-caret") === null, "status must leave streaming on worker error");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}

function insertParagraphPatch(text: string, id = "appended-paragraph", index = 0): Patch {
  return {
    op: "insertChild",
    at: { blockId: PATCH_ROOT_ID },
    index,
    node: createBlockSnapshot({
      id,
      type: "paragraph",
      isFinalized: true,
      payload: { raw: text, inline: [{ kind: "text", text }] },
    }),
  };
}

async function testAppendBeforeInitializationAckAfterRestart(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const workers: TestMockWorker[] = [];
  const handle = React.createRef<StreamingMarkdownHandle>();
  const workerFactory = () => {
    const worker = new TestMockWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  };
  const text = "Appended before the fresh INIT acknowledgement";

  try {
    await act(async () => {
      root.render(<StreamingMarkdown ref={handle} engine="worker" worker={workerFactory} />);
    });
    await waitFor(
      () => workers.length === 1 && workers[0].messages.some((message) => message.type === "INIT"),
      "initial worker INIT should be posted",
    );
    await act(async () => {
      workers[0].acknowledgeInit();
    });

    await act(async () => {
      handle.current?.restart();
    });
    await waitFor(
      () => workers.length === 2 && workers[1].messages.some((message) => message.type === "INIT"),
      "restarted worker INIT should be posted",
    );

    await act(async () => {
      handle.current?.append(text);
    });
    await act(async () => {
      workers[1].acknowledgeInit();
    });
    assert.deepEqual(
      workers[1].messages.filter((message) => message.type === "APPEND").map((message) => message.text),
      [text],
      "append before the restarted worker's INIT acknowledgement reaches that worker exactly once",
    );

    await act(async () => {
      workers[1].emit({ type: "PATCH", tx: 1, patches: [insertParagraphPatch(text)] });
    });
    await waitFor(() => container.textContent?.includes(text) ?? false, "pre-ack append should render after acknowledgement");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}

async function testRecoverableThemeInitErrorDoesNotBlockStaticText(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const worker = new TestMockWorker();
  const text = "Static text survives a recoverable theme error";
  const reportedErrors: Error[] = [];
  const workerFactory = () => worker as unknown as Worker;

  try {
    root.render(
      <StreamingMarkdown
        engine="worker"
        worker={workerFactory}
        text={text}
        onError={(error) => reportedErrors.push(error)}
      />,
    );
    await waitFor(
      () => worker.messages.some((message) => message.type === "INIT"),
      "worker INIT should be posted",
    );
    await act(async () => {
      worker.emit({
        type: "ERROR",
        phase: "INIT",
        error: { message: "Unknown code theme" },
        meta: { theme: ["not-a-theme"] },
      });
      worker.acknowledgeInit();
    });
    assert.strictEqual(reportedErrors.length, 1, "recoverable INIT errors should still reach onError");
    await waitFor(
      () => worker.messages.some((message) => message.type === "INIT" && message.initialContent === text),
      "static text should be sent after a recoverable theme error and INIT acknowledgement",
    );
    await act(async () => {
      worker.acknowledgeInit();
    });
    await waitFor(() => container.textContent?.includes(text) ?? false, "static text should render after recoverable theme error");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}

async function testSameTurnRestartFinalizeUsesFreshTrustedWorker(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  const reportedErrors: Error[] = [];
  const observedWorkers: Array<{ worker: Worker; inputs: WorkerIn[]; outputs: WorkerOut[] }> = [];
  const workerFactory = () => {
    const worker = createTrustedWorker();
    const observation = { worker, inputs: [] as WorkerIn[], outputs: [] as WorkerOut[] };
    const postMessage = worker.postMessage.bind(worker);
    Object.defineProperty(worker, "postMessage", {
      configurable: true,
      value(message: WorkerIn) {
        observation.inputs.push(message);
        postMessage(message as Parameters<typeof worker.postMessage>[0]);
      },
    });
    worker.addEventListener("message", (event: MessageEvent<WorkerOut>) => {
      observation.outputs.push(event.data);
    });
    observedWorkers.push(observation);
    return worker;
  };
  const Card: React.FC<{ value?: string; title?: string; children?: React.ReactNode }> = ({ value, children }) => (
    <span data-lifecycle-card={value}>{children ?? value}</span>
  );
  const trustedEngine = makeTrustedEngine(Card);
  const oldSource = [
    'import { Card } from "host:widgets";',
    'export const value = "old generation";',
    "",
    "<Card value={value} />",
  ].join("\n");
  const freshChunks = ["fresh first\n\n", "fresh second"];
  const render = async (text: string | undefined) => {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          engine="worker"
          worker={workerFactory}
          contentPolicy="trusted-mdx"
          engines={{ mdx: trustedEngine }}
          features={{ mdx: true }}
          text={text}
          caret={false}
          onError={(error) => reportedErrors.push(error)}
        />,
      );
    });
  };

  try {
    await render(oldSource);
    await waitFor(
      () => observedWorkers.length === 1 &&
        observedWorkers[0].outputs.some((message) => message.type === "FINALIZED") &&
        container.querySelector('[data-lifecycle-card="old generation"]') !== null,
      "the initial trusted generation renders and receives a real FINALIZED response",
      10_000,
    );
    assert.equal(observedWorkers[0].outputs.filter((message) => message.type === "FINALIZED").length, 1);

    await render(undefined);
    await act(async () => {
      handle.current?.restart();
      handle.current?.append(freshChunks[0]);
      handle.current?.append(freshChunks[1]);
      handle.current?.finalize();
      assert.throws(
        () => handle.current?.append("too late"),
        Error,
        "a queued trusted FINALIZE seals its generation before the worker attaches",
      );
    });
    assert.ok(handle.current, "the public handle remains mounted after removing old source");
    assert.equal(observedWorkers.length, 2, `restart should create a replacement worker; errors: ${reportedErrors.map((error) => error.message).join("; ")}`);
    const freshWorker = observedWorkers[1];
    assert.ok(freshWorker.inputs.some((message) => message.type === "INIT"), "the fresh worker receives INIT");
    assert.deepEqual(
      freshWorker.inputs.filter((message) => message.type === "INIT" || message.type === "APPEND" || message.type === "FINALIZE")
        .map((message) => message.type === "APPEND" ? message.text : message.type),
      ["INIT", ...freshChunks, "FINALIZE"],
      "the fresh worker receives INIT, both appends, and FINALIZE in FIFO order",
    );
    await waitFor(
      () => freshWorker.outputs.some((message) => message.type === "FINALIZED") &&
        Array.from(container.querySelectorAll("p"), (paragraph) => paragraph.textContent).join("|") === "fresh first|fresh second",
      "the real fresh worker finalizes and renders the exact authored chunks",
      10_000,
    );
    assert.equal(freshWorker.outputs.filter((message) => message.type === "FINALIZED").length, 1);
    assert.equal(container.textContent?.includes("old generation"), false);
    assert.deepEqual(
      Array.from(container.querySelectorAll("p"), (paragraph) => paragraph.textContent),
      ["fresh first", "fresh second"],
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    trustedEngine.dispose();
  }
}

async function testSameTurnRestartAppendsUseFreshTrustedGeneration(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  const workers: TestMockWorker[] = [];
  const workerFactory = () => {
    const worker = new TestMockWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  };
  const Card: React.FC<{ value?: string; title?: string; children?: React.ReactNode }> = ({ value, children }) => (
    <span data-lifecycle-card={value}>{children ?? value}</span>
  );
  const trustedEngine = makeTrustedEngine(Card);
  const appendTexts = (worker: TestMockWorker) =>
    worker.messages.filter((message) => message.type === "APPEND").map((message) => message.text);
  const freshChunks = ["fresh first\n\n", "fresh second"];
  const secondRestartChunks = ["second restart first\n\n", "second restart second"];

  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          engine="worker"
          worker={workerFactory}
          contentPolicy="trusted-mdx"
          engines={{ mdx: trustedEngine }}
          features={{ mdx: true }}
          caret={false}
        />,
      );
    });
    await waitFor(
      () => workers.length === 1 && workers[0].messages.some((message) => message.type === "INIT"),
      "initial trusted worker INIT should be posted",
    );
    await act(async () => {
      handle.current?.append("old generation");
    });
    await act(async () => {
      workers[0].acknowledgeInit();
    });
    assert.deepEqual(appendTexts(workers[0]), ["old generation"], "initial input reaches its attached worker once it acknowledges INIT");
    await act(async () => {
      workers[0].emit({ type: "PATCH", tx: 1, patches: [insertParagraphPatch("old generation", "old-generation")] });
    });
    await waitFor(
      () => container.textContent?.includes("old generation") ?? false,
      "the initial trusted generation renders before it is finalized",
    );
    await act(async () => {
      handle.current?.finalize();
    });
    assert.ok(workers[0].messages.some((message) => message.type === "FINALIZE"));
    await act(async () => {
      workers[0].emit({ type: "FINALIZED" });
    });

    await act(async () => {
      handle.current?.restart();
      assert.equal(handle.current?.getState().workerReady, false, "restart closes readiness synchronously");
      handle.current?.append(freshChunks[0]);
      handle.current?.append(freshChunks[1]);
    });
    await waitFor(
      () => workers.length === 2 && workers[1].messages.some((message) => message.type === "INIT"),
      "the fresh trusted generation attaches its worker",
    );
    await act(async () => {
      workers[1].acknowledgeInit();
    });
    assert.deepEqual(
      appendTexts(workers[1]),
      freshChunks,
      "same-turn appends transfer to the fresh generation exactly once and in order",
    );
    assert.deepEqual(
      workers[1].messages.filter((message) => message.type === "INIT" || message.type === "APPEND")
        .map((message) => message.type === "INIT" ? "INIT" : message.text),
      ["INIT", ...freshChunks],
      "the new worker receives INIT before its queued APPENDs",
    );

    await act(async () => {
      workers[1].emit({ type: "PATCH", tx: 1, patches: [insertParagraphPatch("fresh first", "fresh-first")] });
      workers[1].emit({ type: "PATCH", tx: 2, patches: [insertParagraphPatch("fresh second", "fresh-second", 1)] });
    });
    await waitFor(
      () => Array.from(container.querySelectorAll("p"), (paragraph) => paragraph.textContent)
        .join("|") === "fresh first|fresh second",
      "the fresh generation renders both authored chunks in order",
    );
    await act(async () => {
      handle.current?.finalize();
      workers[1].emit({ type: "FINALIZED" });
    });
    assert.equal(container.textContent?.includes("old generation"), false, "the prior generation is absent after restart");

    await act(async () => {
      handle.current?.restart();
      handle.current?.append("discarded pending generation");
      handle.current?.restart();
      handle.current?.append(secondRestartChunks[0]);
      handle.current?.append(secondRestartChunks[1]);
    });
    await waitFor(
      () => workers.length === 3 && workers[2].messages.some((message) => message.type === "INIT"),
      "the second restart attaches only its final worker generation",
    );
    await act(async () => {
      workers[2].acknowledgeInit();
    });
    assert.deepEqual(
      appendTexts(workers[2]),
      secondRestartChunks,
      "a second restart clears the earlier pending generation while preserving later chunks in order",
    );
    await act(async () => {
      workers[2].emit({ type: "PATCH", tx: 1, patches: [insertParagraphPatch("second restart first", "second-first")] });
      workers[2].emit({ type: "PATCH", tx: 2, patches: [insertParagraphPatch("second restart second", "second-second", 1)] });
      handle.current?.finalize();
      workers[2].emit({ type: "FINALIZED" });
    });
    await waitFor(
      () => Array.from(container.querySelectorAll("p"), (paragraph) => paragraph.textContent)
        .join("|") === "second restart first|second restart second",
      "only the latest pending generation renders after the second restart",
    );
    assert.equal(container.textContent?.includes("discarded pending generation"), false);
    assert.equal(container.textContent?.includes("old generation"), false);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    trustedEngine.dispose();
  }
}

async function testInitialAppendBeforeWorkerAttachIsQueued(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  const worker = new TestMockWorker();
  const text = "initial before attach";
  const workerFactory = () => worker as unknown as Worker;
  const AppendBeforeAttach = () => {
    React.useLayoutEffect(() => {
      handle.current?.append(text);
    }, []);
    return <StreamingMarkdown ref={handle} engine="worker" worker={workerFactory} />;
  };

  try {
    await act(async () => {
      root.render(<AppendBeforeAttach />);
    });
    await waitFor(() => worker.messages.some((message) => message.type === "INIT"), "the initial worker receives INIT");
    await act(async () => {
      worker.acknowledgeInit();
    });
    await waitFor(
      () => worker.messages.some((message) => message.type === "APPEND" && message.text === text),
      "an initial pre-attach append is queued until INIT is acknowledged",
    );
    assert.deepEqual(
      worker.messages.filter((message) => message.type === "INIT" || message.type === "APPEND")
        .map((message) => message.type === "INIT" ? "INIT" : message.text),
      ["INIT", text],
      "the initial worker receives INIT before its queued append",
    );
    await act(async () => {
      worker.emit({ type: "PATCH", tx: 1, patches: [insertParagraphPatch(text)] });
    });
    await waitFor(() => container.textContent?.includes(text) ?? false, "initial pre-attach content renders");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}

async function testNoCommitsAfterDetach(): Promise<void> {
  const worker = new TestMockWorker();
  const renderer = new MarkdownRenderer({
    performance: {
      batch: "timeout",
      flushTimeoutMs: 1000, // Long delay so flush does not run automatically before detach
    },
  });

  renderer.attachWorker(worker as unknown as Worker, { skipInit: true });

  // Simulate an incoming patch batch
  const patchBatch: Patch[] = [
    {
      type: "upsert",
      block: {
        id: "block-after-detach",
        type: "paragraph",
        isFinalized: false,
        children: [{ kind: "text", text: "Should never commit" }],
      },
    },
  ];

  const patchMessageEvent = new Event("message") as MessageEvent<WorkerOut>;
  Object.defineProperty(patchMessageEvent, "data", {
    value: {
      type: "PATCH",
      patches: patchBatch,
      tx: 1,
    },
  });
  worker.dispatchEvent(patchMessageEvent);

  // Queue should have pending patches
  assert.ok(renderer.getPendingQueueSize() > 0, "patches should be queued in scheduler");

  // Detach worker
  renderer.detachWorker();

  // Patch scheduler must have been cleared
  assert.strictEqual(renderer.getPendingQueueSize(), 0, "pending queue size must be 0 after detach");

  // Wait some time to ensure no background commit occurs
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Store must not contain the patch
  const blocks = renderer.getStore().getBlocks();
  assert.strictEqual(blocks.length, 0, "no patches must commit after detach");
}

async function main(): Promise<void> {
  try {
    await testFactoryWorkerTerminatedOnUnmount();
    await testRemovingBlockRendererRevertsToDefault();
    await testWorkerErrorEventRoutesToOnErrorAndExitsStreaming();
    await testNoCommitsAfterDetach();
    await testSameTurnRestartFinalizeUsesFreshTrustedWorker();
    await testSameTurnRestartAppendsUseFreshTrustedGeneration();
    await testInitialAppendBeforeWorkerAttachIsQueued();
    await testAppendBeforeInitializationAckAfterRestart();
    await testRecoverableThemeInitErrorDoesNotBlockStaticText();
    console.log("lifecycle defect fixes tests passed successfully");
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

await main();
