import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { Block, Patch, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { createBlockSnapshot, PATCH_ROOT_ID, STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
import { MarkdownRenderer, StreamingMarkdown, type StreamingMarkdownHandle } from "../src/index";
import React, { act } from "react";
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
        void act(() => {
          this.dispatchEvent(initEvent);
        });
      });
    }
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
