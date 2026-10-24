import assert from "node:assert";
import { PATCH_ROOT_ID, STREAM_MDX_SCHEMA_VERSION, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";

import { MarkdownRenderer } from "../src/renderer";
import { MarkdownBlocksRenderer } from "../src/renderer/blocks-renderer";
import { CodeHighlightRequestContext, type CodeHighlightRequest } from "../src/renderer/code-highlight-context";
import { CodeLineRangeView } from "../src/renderer/code-line-range";
import { getStoreResetVersion } from "../src/renderer/store-reset-version";

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(10);
  }
}

function createLazyInitMessage(initialContent: string): WorkerIn {
  return {
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent,
    prewarmLangs: [],
    docPlugins: {
      html: false,
      mdx: false,
      tables: false,
      math: false,
      outputMode: "html",
      lazyTokenization: { enabled: true, thresholdLines: 50 },
    },
  };
}

function observeWorker(worker: Worker) {
  const observation: {
    initialized: boolean;
    finalized: boolean;
    highlightPatchReceived: boolean;
    error: Error | null;
  } = {
    initialized: false,
    finalized: false,
    highlightPatchReceived: false,
    error: null,
  };
  worker.addEventListener("message", (event: MessageEvent<WorkerOut>) => {
    const message = event.data;
    if (message.type === "INITIALIZED") observation.initialized = true;
    else if (message.type === "PATCH") {
      if (message.patches.some((patch) => patch.op === "decorateCode")) {
        observation.highlightPatchReceived = true;
      }
    } else if (message.type === "FINALIZED") observation.finalized = true;
    else if (message.type === "ERROR") observation.error = new Error(message.error.message);
  });
  return observation;
}

async function testInlineWorkerNativeCodeHighlighting(): Promise<void> {
  const authoredCode = Array.from({ length: 64 }, (_, index) => `const item${index} = ${index};`).join("\n");
  const markdown = `\`\`\`ts\n${authoredCode}\n\`\`\``;
  const expectedLineCount = authoredCode.split("\n").length;
  const replacementCode = authoredCode;
  const replacementMarkdown = markdown;
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const globalKeys = ["window", "document", "HTMLElement", "Node", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"] as const;
  const previousGlobals = Object.fromEntries(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof globalKeys)[number], PropertyDescriptor | undefined>;
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: ResizeObserverStub,
  });

  const renderer = new MarkdownRenderer();
  const store = renderer.getStore();
  const worker = createInlineEngineWorker();
  const replacementWorker = createInlineEngineWorker();
  const firstEvents = observeWorker(worker);
  const replacementEvents = observeWorker(replacementWorker);
  let replacementActive = false;
  let firstRequest: CodeHighlightRequest | null = null;
  let replacementRequest: CodeHighlightRequest | null = null;
  const readFirstRequest = (): CodeHighlightRequest | null => firstRequest;
  const readReplacementRequest = (): CodeHighlightRequest | null => replacementRequest;
  const workerError = (): Error | null => firstEvents.error ?? replacementEvents.error;
  const currentCodeOwnerId = (): string | null => {
    const rootNode = store.getNode(PATCH_ROOT_ID);
    for (const childId of rootNode?.children ?? []) {
      if (store.getNode(childId)?.type === "code") return childId;
    }
    return null;
  };
  const requestCodeHighlight = (request: CodeHighlightRequest): void => {
    if (replacementActive) {
      replacementRequest = request;
    } else {
      firstRequest = request;
    }
  };
  const container = window.document.getElementById("root");
  assert.ok(container, "missing worker-backed test root container");
  let root: Root | null = null;
  try {
    renderer.getComponentRegistry().setNodePresentations({
      code: {
        wrapper: ({ children, metadata }) => React.createElement(
          "div",
          { "data-native-code-renderer": "true", "data-language": metadata.language },
          React.createElement("div", { "data-native-code-view": "true" }, children),
        ),
      },
    });
    root = createRoot(container);
    root.render(
      React.createElement(
        CodeHighlightRequestContext.Provider,
        { value: requestCodeHighlight },
        React.createElement(MarkdownBlocksRenderer, {
          blocks: [],
          componentRegistry: renderer.getComponentRegistry(),
          store,
        }),
      ),
    );

    renderer.attachWorker(worker, { skipInit: true });
    worker.postMessage(createLazyInitMessage(""));
    await waitFor(() => firstEvents.initialized || workerError() !== null, "first inline worker publishes its attached initialization");
    assert.equal(workerError(), null);
    await renderer.whenInitialized();
    renderer.append(markdown);
    await renderer.finalize();
    await waitFor(() => {
      const blockId = currentCodeOwnerId();
      const codeBlock = blockId ? store.getCodeBlock(blockId) : undefined;
      return firstEvents.finalized && codeBlock?.source.state === "finalized" && firstRequest !== null;
    }, "first inline worker publishes a finalized native code owner and requests its lazy range");
    assert.equal(workerError(), null);

    const blockId = currentCodeOwnerId();
    assert.ok(blockId, "inline worker should publish a native code owner");
    const initialCode = store.getCodeBlock(blockId);
    assert.ok(initialCode, "native code owner should be indexed from INITIALIZED");
    assert.equal(initialCode.source.state, "finalized");
    assert.equal(initialCode.source.lineCount, expectedLineCount);
    assert.equal(
      store.getCodeLines(blockId, 0, expectedLineCount).map((line) => line.text).join("\n"),
      authoredCode,
      "native source owner should preserve every authored line",
    );
    assert.ok(
      store.getCodeLines(blockId, 0, expectedLineCount).every((line) => line.decoration === undefined),
      "lazy-tokenized owner should start without highlighted lines",
    );

    renderer.attachWorker(replacementWorker, { skipInit: true });
    replacementActive = true;
    replacementWorker.postMessage(createLazyInitMessage(replacementMarkdown));
    await waitFor(() => replacementEvents.initialized || workerError() !== null, "replacement inline worker publishes its attached initialization");
    assert.equal(workerError(), null);
    await renderer.whenInitialized();
    await renderer.finalize();
    await waitFor(() => {
      const replacementOwnerId = currentCodeOwnerId();
      const codeBlock = replacementOwnerId ? store.getCodeBlock(replacementOwnerId) : undefined;
      return replacementEvents.finalized && replacementOwnerId === blockId
        && codeBlock?.source.state === "finalized" && replacementRequest !== null;
    }, "replacement inline worker finalizes the same-source native code owner");
    assert.equal(workerError(), null);
    assert.equal(currentCodeOwnerId(), blockId, "replacement worker should reuse the code owner ID");
    const replacementBeforeHighlight = store.getCodeBlock(blockId);
    assert.ok(replacementBeforeHighlight, "replacement worker should retain the native code owner");
    assert.equal(replacementBeforeHighlight.source.state, "finalized");
    assert.ok(
      store.getCodeLines(blockId, 0, expectedLineCount).every((line) => line.decoration === undefined),
      "new native owner should start without highlighted lines",
    );
    assert.equal(
      container.querySelector('[data-native-code-view] [data-line] span[style]'),
      null,
      "replacement output stays unhighlighted until a real range result arrives",
    );

    const oldRequest = readFirstRequest();
    assert.ok(oldRequest, "first worker's native range request should be captured");
    worker.postMessage({
      type: "TOKENIZE_RANGE",
      blockId: oldRequest.blockId,
      startLine: oldRequest.startLine,
      endLine: oldRequest.endLine,
      priority: oldRequest.priority,
    });
    await waitFor(
      () => firstEvents.highlightPatchReceived || workerError() !== null,
      "first inline worker should return its actual highlight patch after replacement",
    );
    assert.equal(workerError(), null);
    assert.ok(
      store.getCodeLines(blockId, 0, expectedLineCount).every((line) => line.decoration === undefined),
      "late first-worker highlighting must not decorate the replacement owner",
    );
    assert.equal(
      container.querySelector('[data-native-code-view] [data-line] span[style]'),
      null,
      "late first-worker tokens must not appear in replacement output",
    );

    const currentRequest = readReplacementRequest();
    assert.ok(currentRequest, "replacement range request should be captured");
    renderer.requestCodeHighlightRange(currentRequest);
    await waitFor(() => {
      const lines = store.getCodeLines(blockId, 0, expectedLineCount);
      return replacementEvents.highlightPatchReceived
        && lines.length === expectedLineCount
        && lines.every((line) => line.decoration?.tokens.spans.length)
        && container.querySelector('[data-native-code-view] [data-line] span[style]') !== null;
    }, "replacement owner receives real worker-highlighted code after its own lazy range");
    assert.equal(workerError(), null);

    assert.equal(container.querySelector("[data-native-code-renderer]")?.getAttribute("data-language"), "ts");
    const highlightedRows = Array.from(container.querySelectorAll("[data-native-code-view] [data-line]"));
    assert.equal(highlightedRows.length, expectedLineCount, "replacement should render every highlighted source line");
    assert.equal(
      highlightedRows.map((row) => row.textContent).join("\n"),
      replacementCode,
      "replacement code should render every authored line from its real syntax-highlighted output",
    );
    assert.ok(
      container.querySelector('[data-native-code-view] [data-line] span[style]'),
      "native code renderer should expose styled tokens from the owned line range",
    );
  } finally {
    try {
      root?.unmount();
    } finally {
      try {
        renderer.detachWorker();
      } finally {
        try {
          worker.terminate();
        } finally {
          try {
            replacementWorker.terminate();
          } finally {
            try {
              window.close();
            } finally {
              for (const key of globalKeys) {
                const descriptor = previousGlobals[key];
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
              }
            }
          }
        }
      }
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function testVisibleRangesPrecedePrefetch(): Promise<void> {
  const renderer = new MarkdownRenderer();
  const worker = createInlineEngineWorker();
  const observation = observeWorker(worker);
  const decorationOrder: string[] = [];
  worker.addEventListener("message", (event: MessageEvent<WorkerOut>) => {
    if (event.data.type !== "PATCH") return;
    for (const patch of event.data.patches) {
      if (patch.op === "decorateCode") decorationOrder.push(patch.codeOwnerId);
    }
  });

  const codeBlock = (name: string) =>
    `\`\`\`ts\n${Array.from({ length: 64 }, (_, index) => `const ${name}${index} = ${index};`).join("\n")}\n\`\`\``;
  try {
    renderer.attachWorker(worker, { skipInit: true });
    worker.postMessage(createLazyInitMessage(""));
    await waitFor(() => observation.initialized || observation.error !== null, "worker initializes for range priority test");
    assert.equal(observation.error, null);
    await renderer.whenInitialized();
    renderer.append(`${codeBlock("offscreen")}\n\n${codeBlock("visible")}`);
    await renderer.finalize();
    const codeBlocks = renderer.getStore().getBlocks().filter((block) => block.type === "code");
    assert.equal(codeBlocks.length, 2, "two code owners are available for range requests");
    const [offscreen, visible] = codeBlocks;
    assert.ok(offscreen && visible);
    const codeState = renderer.getStore().getCodeBlock(offscreen.id);
    assert.ok(codeState, "first code owner exposes its line range");
    const dom = new JSDOM('<!doctype html><html><body><div id="range-root"></div></body></html>', { pretendToBeVisual: true });
    const { window } = dom;
    const globalKeys = ["window", "document", "HTMLElement", "Node", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"] as const;
    const previousGlobals = Object.fromEntries(
      globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    ) as Record<(typeof globalKeys)[number], PropertyDescriptor | undefined>;
    Object.assign(globalThis, {
      window,
      document: window.document,
      HTMLElement: window.HTMLElement,
      Node: window.Node,
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      ResizeObserver: ResizeObserverStub,
    });
    const rangeRootElement = window.document.getElementById("range-root");
    assert.ok(rangeRootElement);
    const rangeRoot = createRoot(rangeRootElement);
    const overscanRequests: CodeHighlightRequest[] = [];
    try {
      rangeRoot.render(
        React.createElement(
          CodeHighlightRequestContext.Provider,
          { value: (request) => overscanRequests.push(request) },
          React.createElement(CodeLineRangeView, {
            store: renderer.getStore(),
            blockId: offscreen.id,
            generation: codeState.source.generation,
            resetVersion: getStoreResetVersion(renderer.getStore()),
            configurationRevision: codeState.configurationRevision,
            chunkStart: 0,
            rangeStart: 0,
            rangeEnd: 30,
            visibleStart: 10,
            visibleEnd: 20,
            renderSegments: [{
              startIndex: 0,
              endIndex: 30,
              visibleStart: 10,
              visibleEnd: 20,
              spacerBeforeHeight: 0,
            }],
          }),
        ),
      );
      await waitFor(() => overscanRequests.length > 0, "visible and overscan lines enqueue demanded decoration");
      assert.deepEqual(overscanRequests, [{
        blockId: offscreen.id,
        startLine: 0,
        endLine: 30,
        priority: "visible",
        reason: "scroll",
      }], "rendered overscan should join the visible demand before background work");
    } finally {
      rangeRoot.unmount();
      for (const key of globalKeys) {
        const descriptor = previousGlobals[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      window.close();
    }

    renderer.requestCodeHighlightRange({
      blockId: offscreen.id,
      startLine: 0,
      endLine: 64,
      priority: "prefetch",
    });
    renderer.requestCodeHighlightRange({
      blockId: visible.id,
      startLine: 0,
      endLine: 64,
      priority: "visible",
    });
    await waitFor(() => decorationOrder.length === 2 || observation.error !== null, "both range requests return decorations");
    assert.equal(observation.error, null);
    assert.deepEqual(
      decorationOrder,
      [visible.id, offscreen.id],
      "visible tokenization should be served before already-requested offscreen work",
    );
  } finally {
    renderer.detachWorker();
    worker.terminate();
  }
}

async function testVirtualizedLazyBlockCompletesInBackground(): Promise<void> {
  const lineCount = 260;
  const markdown = `\`\`\`ts\n${Array.from({ length: lineCount }, (_, index) => `const row${index} = ${index};`).join("\n")}\n\`\`\``;
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const globalKeys = ["window", "document", "HTMLElement", "Node", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"] as const;
  const previousGlobals = Object.fromEntries(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof globalKeys)[number], PropertyDescriptor | undefined>;
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: ResizeObserverStub,
  });
  const renderer = new MarkdownRenderer();
  const store = renderer.getStore();
  const worker = createInlineEngineWorker();
  const observation = observeWorker(worker);
  const requests: CodeHighlightRequest[] = [];
  const container = window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    root.render(
      React.createElement(
        CodeHighlightRequestContext.Provider,
        {
          value: (request: CodeHighlightRequest) => {
            requests.push(request);
            renderer.requestCodeHighlightRange(request);
          },
        },
        React.createElement(MarkdownBlocksRenderer, { blocks: [], componentRegistry: renderer.getComponentRegistry(), store }),
      ),
    );
    renderer.attachWorker(worker, { skipInit: true });
    worker.postMessage(createLazyInitMessage(""));
    await waitFor(() => observation.initialized || observation.error !== null, "worker initializes for virtualized lazy test");
    assert.equal(observation.error, null);
    await renderer.whenInitialized();
    renderer.append(markdown);
    await renderer.finalize();
    const lazyProgress = () => {
      const code = store.getBlocks().find((block) => block.type === "code");
      return code?.payload.meta?.lazyTokenizedUntil;
    };
    await waitFor(
      () => lazyProgress() === lineCount || observation.error !== null,
      "a virtualized lazy block must finish background tokenization after finalize",
    );
    assert.equal(observation.error, null);
    assert.ok(
      container.querySelector('[data-code-virtualized="true"]'),
      "the fixture must exercise the virtualized code view",
    );
    assert.ok(
      requests.some((request) => request.priority === "prefetch" && request.startLine === 0 && request.endLine === lineCount),
      "the full block is requested as background work, behind visible demand",
    );
  } finally {
    root.unmount();
    renderer.detachWorker();
    worker.terminate();
    window.close();
    for (const key of globalKeys) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}


await testVisibleRangesPrecedePrefetch();
await testInlineWorkerNativeCodeHighlighting();
await testVirtualizedLazyBlockCompletesInBackground();
console.log("native-code-highlight-lifecycle test passed");
